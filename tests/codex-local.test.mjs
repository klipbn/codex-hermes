import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { reconcileDaemon, readState, tick, enqueue, drain } from '../watcher/codex-watch.ts';

let LocalDiscovery;
try { ({ LocalDiscovery } = await import('../watcher/codex-local.ts')); }
catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const id = '01900000-0000-7000-8000-000000000001';
const oldId = '01900000-0000-7000-8000-000000000002';
const at = '2026-10-17T09:00:00.000Z';
const record = (type, payload) => JSON.stringify({ timestamp: at, type, payload }) + '\n';
const event = (type, extra = {}) => record('event_msg', { type, turn_id: 'current', ...extra });

async function fixture(t) {
    assert.ok(LocalDiscovery, 'Local CLI discovery must be available');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-local-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, 'codex'), base = join(root, 'state');
    await mkdir(join(home, 'sessions'), { recursive: true });
    await mkdir(join(home, 'thread-writer-locks'));
    const path = join(home, 'sessions', `rollout-${id}.jsonl`);
    const db = new DatabaseSync(join(home, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, source TEXT, originator TEXT, cwd TEXT, title TEXT, model TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER)');
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run(id, 'cli', 'codex-tui', '/work/demo', 'Original \u0442\u0435\u043a\u0441\u0442', 'current-model', path, 1792227600, 1792227600);
    insert.run(oldId, 'cli', 'codex-tui', '/work/demo', 'Old session', null, path, 1792227600, 1792227600);
    t.after(() => db.close());
    // An old file on disk is not a live writer observation.
    await writeFile(join(home, 'thread-writer-locks', `${oldId}.lock`), '');
    await writeFile(path, record('session_meta', { id, source: 'cli', originator: 'codex-tui' }) +
        event('task_complete', { turn_id: 'old', last_agent_message: 'Old answer' }) +
        event('task_started', { started_at: 1792227600 }));
    let owners = `p123\nf46\nn${home}/thread-writer-locks/${id}.lock\n`;
    const command = async (name) => name === 'ps' ? '123 ttys001 /opt/bin/codex\n456 ?? /opt/bin/codex\n' : owners;
    return { home, base, path, db, discovery: new LocalDiscovery(home, command), command,
        setOwners: value => { owners = value; } };
}

test('an empty daemon still lists a live embedded session and delivers only its new completion', async t => {
    const f = await fixture(t);
    const snapshot = await f.discovery.snapshot();
    assert.deepEqual(snapshot.map(s => s.thread.id), [id]);
    await reconcileDaemon(f.base, snapshot);
    let state = await readState(f.base, id);
    assert.equal(state.status, 'busy');
    assert.equal(state.active.id, 'current');
    assert.equal(state.local.historyAvailable, true);
    assert.equal(state.daemon, undefined);
    assert.equal((await readdir(join(f.base, 'outbox'))).length, 0);
    const control = spawnSync('python3', ['-c', `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('control', sys.argv[1])
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)
print(control.handle_cx())
`, new URL('../codex-control/__init__.py', import.meta.url).pathname], {
        env: { ...process.env, CODEX_HERMES_BASE_DIR: f.base, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8',
    });
    assert.equal(control.status, 0, control.stderr);
    assert.match(control.stdout, /sessions: 1/);
    assert.match(control.stdout, /BUSY/);
    await appendFile(f.path, event('task_complete', { last_agent_message: 'Done <\u0434\u0430> & checked',
        started_at: 1792227600, completed_at: 1792227610, duration_ms: 10000 }));
    await reconcileDaemon(f.base, await f.discovery.snapshot());
    await reconcileDaemon(f.base, await f.discovery.snapshot());
    state = await readState(f.base, id);
    assert.equal(state.status, 'idle');
    assert.equal(state.turns.at(-1).summary, 'Done <\u0434\u0430> & checked');
    assert.equal(state.turns.at(-1).testsAvailable, false);
    assert.equal(state.turns.at(-1).durationMs, 10000);
    const sent = [];
    await tick(f.base, true, async notice => sent.push(notice));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].turn.id, 'current');
});

test('failed discovery preserves observations; only a successful empty scan unloads local sessions', async t => {
    const f = await fixture(t);
    await reconcileDaemon(f.base, await f.discovery.snapshot());
    await reconcileDaemon(f.base, [], Date.now(), { daemon: true, local: false });
    assert.equal((await readState(f.base, id)).status, 'busy');
    await appendFile(f.path, '{incomplete');
    assert.equal((await f.discovery.snapshot())[0].thread.status.type, 'active');
    await appendFile(f.path, '\n');
    // A damaged record makes only this session unknown instead of failing every local session.
    assert.equal((await f.discovery.snapshot())[0].thread.status.type, 'unknown');
    await writeFile(f.path, event('task_started'));
    f.setOwners('');
    await reconcileDaemon(f.base, await f.discovery.snapshot());
    assert.equal((await readState(f.base, id)).status, 'unloaded');
});

test('the Codex session name is preferred over the first prompt', async t => {
    const f = await fixture(t);
    f.db.exec('ALTER TABLE threads ADD COLUMN name TEXT');
    f.db.prepare('UPDATE threads SET name=? WHERE id=?').run('[TRG-1] - Named \u0441\u0435\u0441\u0441\u0438\u044f', id);
    assert.equal((await f.discovery.snapshot())[0].thread.name, '[TRG-1] - Named \u0441\u0435\u0441\u0441\u0438\u044f');
    f.db.prepare('UPDATE threads SET name=NULL WHERE id=?').run(id);
    assert.equal((await f.discovery.snapshot())[0].thread.name, 'Original \u0442\u0435\u043a\u0441\u0442');
});

test('switching between local and daemon observations does not duplicate completed turns', async t => {
    const f = await fixture(t);
    let snapshot = await f.discovery.snapshot();
    await reconcileDaemon(f.base, snapshot.map(row => ({ ...row, observationSource: 'daemon' })));
    await appendFile(f.path, event('task_complete', { last_agent_message: 'New completion' }));
    snapshot = await f.discovery.snapshot();
    await reconcileDaemon(f.base, snapshot);
    await reconcileDaemon(f.base, snapshot.map(row => ({ ...row, observationSource: 'daemon' })));
    assert.equal((await readState(f.base, id)).turns.length, 2);
    assert.equal((await readdir(join(f.base, 'outbox'))).length, 1);
    assert.deepEqual(await f.discovery.snapshot(() => {}, new Set([id])), []);
});

test('local scans reject child sessions and unrelated processes even if they share a terminal originator', async t => {
    const f = await fixture(t);
    f.db.prepare('UPDATE threads SET source=? WHERE id=?').run('{"subAgent":{}}', id);
    assert.deepEqual(await f.discovery.snapshot(), []);
    f.db.prepare('UPDATE threads SET source=? WHERE id=?').run('cli', id);
    f.setOwners(`p456\nn${f.home}/thread-writer-locks/${id}.lock\np999\nn${f.home}/thread-writer-locks/${oldId}.lock\n`);
    assert.deepEqual(await f.discovery.snapshot(), []);
});

test('a bounded tail without lifecycle evidence stays unknown and a completion needs no cached start', async t => {
    const f = await fixture(t);
    await writeFile(f.path, record('response_item', { type: 'message', role: 'assistant', content: 'x'.repeat(5 * 1024 * 1024) }));
    let rows = await f.discovery.snapshot();
    assert.equal(rows[0].thread.status.type, 'unknown');
    assert.deepEqual(rows[0].turns, []);
    await appendFile(f.path, event('task_complete', { last_agent_message: 'Finished', started_at: 1792227600, completed_at: 1792227610 }));
    rows = await f.discovery.snapshot();
    assert.equal(rows[0].thread.status.type, 'idle');
    assert.equal(rows[0].turns[0].durationMs, null);
});

test('unsupported index and journals outside Codex sessions are unavailable instead of empty', async t => {
    const f = await fixture(t);
    f.db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(join(f.home, 'state_5.sqlite'), id);
    await assert.rejects(f.discovery.snapshot(), /outside the sessions directory/);
    f.db.exec('DROP TABLE threads');
    await assert.rejects(f.discovery.snapshot(), /Unsupported local session index/);
});

test('the final journal is read when a known terminal closes between polls', async t => {
    const f = await fixture(t);
    await reconcileDaemon(f.base, await f.discovery.snapshot());
    await appendFile(f.path, event('task_complete', { last_agent_message: 'Finished before closing' }));
    f.setOwners('');
    await reconcileDaemon(f.base, await f.discovery.snapshot());
    const state = await readState(f.base, id);
    assert.equal(state.status, 'unloaded');
    assert.equal(state.turns.at(-1).summary, 'Finished before closing');
    assert.equal((await readdir(join(f.base, 'outbox'))).length, 1);
    assert.deepEqual(await f.discovery.snapshot(), []);
});

test('local lifecycle polling preserves hook-confirmed permission waiting until the hook resumes work', async t => {
    const f = await fixture(t);
    await reconcileDaemon(f.base, await f.discovery.snapshot());
    await enqueue(f.base, { session_id: id, turn_id: 'current', hook_event_name: 'PermissionRequest' });
    await drain(f.base);
    await reconcileDaemon(f.base, await f.discovery.snapshot());
    assert.equal((await readState(f.base, id)).status, 'waiting');
    await enqueue(f.base, { session_id: id, turn_id: 'current', hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    await drain(f.base);
    await reconcileDaemon(f.base, await f.discovery.snapshot());
    assert.equal((await readState(f.base, id)).status, 'busy');
});

test('the worker discovers embedded sessions when its daemon is unavailable and reports local health', async t => {
    const f = await fixture(t);
    const bin = join(f.home, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'ps'), '#!/bin/sh\nprintf "123 ttys001 /opt/bin/codex\\n"\n', { mode: 0o700 });
    const owners = `p123\nn${f.home}/thread-writer-locks/${id}.lock\n`;
    await writeFile(join(bin, 'lsof'), `#!/bin/sh\ncat <<'END'\n${owners}END\n`, { mode: 0o700 });
    const child = spawn(process.execPath, ['--experimental-strip-types', new URL('../watcher/codex-watch.ts', import.meta.url).pathname, 'run'], {
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, CODEX_HOME: f.home,
            CODEX_HERMES_BASE_DIR: f.base, CODEX_HERMES_SEND: '0', CODEX_HERMES_DISCOVERY: '1',
            CODEX_HERMES_SOCKET: join(f.home, 'missing.sock') }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
    let health;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
        try { health = JSON.parse(await readFile(join(f.base, 'watcher.json'), 'utf8')); break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(health, stderr || 'Worker heartbeat unavailable');
    assert.equal(health.daemon.connected, false);
    assert.equal(health.local.available, true);
    assert.equal(health.local.sessions, 1);
    assert.equal((await readState(f.base, id)).status, 'busy');
});

test('macOS discovery falls back to system lsof when launchd PATH omits it', { skip: process.platform !== 'darwin' }, async t => {
    const f = await fixture(t);
    const preload = join(f.home, 'process-boundary.mjs');
    const owners = `p123\nn${f.home}/thread-writer-locks/${id}.lock\n`;
    await writeFile(preload, `
import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
child.execFile = (name, args, options, done) => {
    if (name === 'ps') done(null, '123 ttys001 /opt/bin/codex\\n', '');
    else if (name === 'lsof') done(Object.assign(new Error('missing'), { code: 'ENOENT' }), '', '');
    else if (name === '/usr/sbin/lsof') done(null, ${JSON.stringify(owners)}, '');
    else throw new Error('Unexpected process');
};
syncBuiltinESMExports();
`);
    const script = `import {LocalDiscovery} from ${JSON.stringify(new URL('../watcher/codex-local.ts', import.meta.url).href)};
console.log((await new LocalDiscovery(process.argv[1]).snapshot()).length);`;
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--import', preload,
        '--input-type=module', '-e', script, f.home], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '1');
});
