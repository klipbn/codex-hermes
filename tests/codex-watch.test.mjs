import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const path = new URL('../watcher/codex-watch.ts', import.meta.url);
let watcher;
try { watcher = await import(path.href); } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}
async function fixture(t) {
    assert.ok(watcher, 'Codex watcher must be implemented');
    const base = await mkdtemp(join(tmpdir(), 'codex-hermes-test-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    return base;
}
function event(name, extra = {}) {
    return { hook_event_name: name, session_id: 'session-one', cwd: '/work/demo',
        turn_id: 'turn-one', model: 'test-model', ...extra };
}
async function deliver(base, ...events) {
    for (const e of events) await watcher.enqueue(base, e);
    await watcher.drain(base);
    return watcher.readState(base, 'session-one');
}

test('stores turns, final responses, models, and explicit unavailable metrics', async t => {
    const base = await fixture(t);
    const state = await deliver(base, event('SessionStart'),
        event('UserPromptSubmit', { prompt: '\u0418\u0441\u043f\u0440\u0430\u0432\u044c <\u043e\u0448\u0438\u0431\u043a\u0443>' }),
        event('Stop', { last_assistant_message: '\u0418\u0441\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043e & \u043f\u0440\u043e\u0432\u0435\u0440\u0435\u043d\u043e' }));
    assert.equal(state.status, 'idle');
    assert.equal(state.title, '\u0418\u0441\u043f\u0440\u0430\u0432\u044c <\u043e\u0448\u0438\u0431\u043a\u0443>');
    assert.equal(state.turns.length, 1);
    assert.equal(state.turns[0].summary, '\u0418\u0441\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043e & \u043f\u0440\u043e\u0432\u0435\u0440\u0435\u043d\u043e');
    assert.equal(state.turns[0].model, 'test-model');
    assert.equal(state.turns[0].cost, null);
    assert.equal(state.turns[0].diff, null);
    assert.equal((await readdir(join(base, 'outbox'))).length, 1);
    assert.equal((await stat(join(base, 'sessions'))).mode & 0o777, 0o700);
});

test('duplicate Stop does not duplicate turns or notices; new turns reset tests', async t => {
    const base = await fixture(t);
    const stop = event('Stop', { last_assistant_message: '\u0433\u043e\u0442\u043e\u0432\u043e' });
    await deliver(base, event('UserPromptSubmit'), stop, stop);
    const state = await deliver(base, event('UserPromptSubmit', { turn_id: 'turn-two' }),
        event('Stop', { turn_id: 'turn-two', last_assistant_message: '\u0435\u0449\u0451 \u0433\u043e\u0442\u043e\u0432\u043e' }));
    assert.equal(state.turns.length, 2);
    assert.equal((await readdir(join(base, 'outbox'))).length, 2);
    assert.deepEqual(state.turns[1].tests, []);
});

test('tests without exit codes and unfinished tests never become passed', async t => {
    const base = await fixture(t);
    const tool = (name, id, response) => event(name, { tool_name: 'Bash', tool_use_id: id,
        tool_input: { command: 'npm test' }, tool_response: response });
    const state = await deliver(base, event('UserPromptSubmit'),
        tool('PreToolUse', 'a'), tool('PostToolUse', 'a', { exit_code: 0 }),
        tool('PreToolUse', 'b'), tool('PostToolUse', 'b', { exit_code: 1 }),
        tool('PreToolUse', 'c'), tool('PostToolUse', 'c', 'all fine'),
        tool('PreToolUse', 'd'), event('Stop'));
    assert.deepEqual(state.turns[0].tests.map(x => x.status), ['passed', 'failed', 'unknown', 'unknown']);
    assert.deepEqual(state.turns[0].testCounts, { passed: 1, failed: 1, unknown: 2 });
});

test('permission waits, PostToolUse resumes, and Interrupt does not imply success', async t => {
    const base = await fixture(t);
    let state = await deliver(base, event('UserPromptSubmit'), event('PermissionRequest', { tool_name: 'Bash' }));
    assert.equal(state.status, 'waiting');
    state = await deliver(base, event('PostToolUse', { tool_use_id: 'a', tool_name: 'Bash' }));
    assert.equal(state.status, 'busy');
    state = await deliver(base, event('Interrupt'));
    assert.equal(state.turns[0].outcome, 'interrupted');
    state = await deliver(base, event('SessionEnd'));
    assert.equal(state.status, 'closed');
});

test('parallel hooks are retained and sessions are not merged by PID', async t => {
    const base = await fixture(t);
    await deliver(base, event('UserPromptSubmit'));
    await Promise.all(Array.from({ length: 30 }, (_, i) => watcher.enqueue(base,
        event('PreToolUse', { tool_use_id: `tool-${i}`, tool_name: 'read' }))));
    await watcher.enqueue(base, event('UserPromptSubmit', { session_id: 'session-two' }));
    await watcher.drain(base);
    assert.equal((await watcher.readState(base, 'session-one')).active.tools.read, 30);
    assert.equal((await watcher.readState(base, 'session-two')).status, 'busy');
});

test('does not execute input or escape state root and continues after corrupt events', async t => {
    const base = await fixture(t);
    await watcher.enqueue(base, event('SessionStart', { session_id: '../../escape' }));
    await writeFile(join(base, 'events', '000-invalid.json'), '{bad');
    await watcher.enqueue(base, event('UserPromptSubmit'));
    await watcher.drain(base);
    assert.equal((await watcher.readState(base, 'session-one')).status, 'busy');
    assert.ok((await readdir(join(base, 'sessions'))).every(x => /^[a-f0-9]+\.json$/.test(x)));
});

test('hook CLI emits no decisions even with invalid stdin', async t => {
    await fixture(t);
    const result = spawnSync(process.execPath, ['--experimental-strip-types', path.pathname, 'hook'],
        { input: '{bad', encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
});

test('a stalled state read exits for supervisor recovery and a replacement reclaims the lock', async t => {
    const base = await fixture(t);
    await deliver(base, event('UserPromptSubmit'), event('Stop'));
    await writeFile(join(base, 'control.json'), '{}');
    const preload = join(base, 'stalled-read.mjs');
    await writeFile(preload, `
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        import { join } from 'node:path';
        const original = fs.readFile;
        fs.readFile = (path, ...args) => {
            if (String(path) === join(process.env.CODEX_HERMES_BASE_DIR, 'control.json')) {
                console.error('Simulated stalled state read');
                return new Promise(() => {});
            }
            return original(path, ...args);
        };
        syncBuiltinESMExports();
    `);
    const env = { ...process.env, CODEX_HERMES_BASE_DIR: base,
        CODEX_HERMES_DISCOVERY: '0', CODEX_HERMES_SEND: '0', CODEX_HERMES_STALL_TIMEOUT_MS: '1000' };
    const stalled = spawnSync(process.execPath, ['--experimental-strip-types', '--import', preload, path.pathname, 'run'],
        { env, encoding: 'utf8', timeout: 3000 });
    assert.match(stalled.stderr, /Simulated stalled state read/);
    assert.equal(stalled.error, undefined);
    assert.equal(stalled.status, 1, 'a stalled worker must exit so its supervisor can restart it');
    assert.equal(stalled.stdout, '');
    assert.match(stalled.stderr, /no progress.*exiting for supervisor restart/);
    const replacement = spawnSync(process.execPath, ['--experimental-strip-types', path.pathname, 'once'],
        { env, encoding: 'utf8', timeout: 3000 });
    assert.equal(replacement.status, 0, replacement.stderr);
    assert.equal((await watcher.readState(base, 'session-one')).turns.length, 1);
    assert.equal(JSON.parse(await readFile(join(base, 'watcher.json'), 'utf8')).sendEnabled, false);
    assert.ok(!(await readdir(base)).includes('worker.lock'));
});

test('state processing refreshes the deadline while a long batch keeps making progress', async t => {
    const base = await fixture(t);
    for (let i = 0; i < 12; i++) await watcher.enqueue(base,
        event('SessionStart', { session_id: `session-${i}` }));
    await watcher.drain(base);
    const preload = join(base, 'slow-reads.mjs');
    await writeFile(preload, `
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        import { setTimeout } from 'node:timers/promises';
        const original = fs.readFile;
        fs.readFile = async (...args) => {
            await setTimeout(100);
            return original(...args);
        };
        syncBuiltinESMExports();
    `);
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--import', preload, path.pathname, 'once'],
        { env: { ...process.env, CODEX_HERMES_BASE_DIR: base, CODEX_HERMES_SEND: '0',
            CODEX_HERMES_DISCOVERY: '0', CODEX_HERMES_STALL_TIMEOUT_MS: '500' },
        encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const health = JSON.parse(await readFile(join(base, 'watcher.json'), 'utf8'));
    assert.equal(health.sendEnabled, false);
    assert.equal((await readdir(join(base, 'sessions'))).length, 12);
});

test('notifications escape HTML and limit long text without truncating tags', async t => {
    const base = await fixture(t);
    const state = await deliver(base, event('UserPromptSubmit', { prompt: '<script>' }),
        event('Stop', { last_assistant_message: '<&>'.repeat(10000) }));
    const { rich, fallback } = watcher.renderNotification({ level: 'done', state, turn: state.turns[0] });
    assert.ok(rich.includes('&lt;script&gt;'));
    assert.ok(!rich.includes('<script>'));
    assert.ok(fallback.length <= 4000);
    assert.ok(fallback.endsWith('</i>'));
});

test('rich transport failure falls back to a complete HTML message', async t => {
    await fixture(t);
    let fallback = '';
    await watcher.sendNotification({ level: 'done', state: { title: '<\u0442\u0435\u0441\u0442>', sessionID: 's' }, turn: {} }, {
        rich: async () => { throw new Error('timeout'); },
        fallback: async html => { fallback = html; },
    });
    assert.ok(fallback.startsWith('<b>📝 &lt;\u0442\u0435\u0441\u0442&gt;</b>'));
    assert.ok(fallback.endsWith('</i>'));
});

test('mute and send=0 drop notices without sending; failures retain retries', async t => {
    const base = await fixture(t);
    let sent = 0;
    const sender = async () => { sent++; };
    await deliver(base, event('UserPromptSubmit'), event('Stop'));
    await watcher.tick(base, false, sender);
    assert.equal(sent, 0);
    await deliver(base, event('UserPromptSubmit', { turn_id: 'two' }), event('Stop', { turn_id: 'two' }));
    await writeFile(join(base, 'control.json'), JSON.stringify({ muteUntil: '2099-01-01T00:00:00Z' }));
    await watcher.tick(base, true, sender);
    assert.equal(sent, 0);
    assert.equal((await readdir(join(base, 'outbox'))).length, 0);
    await writeFile(join(base, 'control.json'), '{}');
    await deliver(base, event('UserPromptSubmit', { turn_id: 'three' }), event('Stop', { turn_id: 'three' }));
    await watcher.tick(base, true, async () => { throw new Error('offline'); });
    assert.equal((await readdir(join(base, 'outbox'))).length, 1);
    await watcher.tick(base, true, sender, Date.now() + 61000);
    assert.equal(sent, 1);
});

test('reminders are limited to three and stop after completion', async t => {
    const base = await fixture(t);
    await deliver(base, event('UserPromptSubmit'), event('PermissionRequest'));
    const notices = [];
    const now = Date.now();
    for (let i = 1; i <= 5; i++) await watcher.tick(base, true, async n => notices.push(n.level), now + i * 601000);
    assert.equal(notices.filter(x => x === 'reminder').length, 3);
    await deliver(base, event('Stop'));
    await watcher.tick(base, true, async n => notices.push(n.level), now + 3600000);
    assert.equal(notices.filter(x => x === 'reminder').length, 3);
});

test('more than ten parallel tests do not duplicate counts', async t => {
    const base = await fixture(t);
    await deliver(base, event('UserPromptSubmit'));
    for (const phase of ['PreToolUse', 'PostToolUse']) {
        for (let i = 0; i < 12; i++) await watcher.enqueue(base, event(phase, {
            tool_name: 'Bash', tool_use_id: `test-${i}`, tool_input: { command: 'pytest' }, tool_response: { exit_code: 0 },
        }));
    }
    const s = await deliver(base, event('Stop'));
    assert.deepEqual(s.turns[0].testCounts, { passed: 12, failed: 0, unknown: 0 });
    assert.equal(s.turns[0].tests.length, 10);
});

test('corrupt state does not prevent processing other sessions', async t => {
    const base = await fixture(t);
    await deliver(base, event('SessionStart'));
    const [name] = await readdir(join(base, 'sessions'));
    await writeFile(join(base, 'sessions', name), '{}');
    await deliver(base, event('UserPromptSubmit'));
    assert.equal((await watcher.readState(base, 'session-one')).status, 'busy');
});

test('notifications use English labels and Moscow 24-hour dates while preserving Unicode payloads', () => {
    const title = '\u0417\u0430\u0434\u0430\u0447\u0430 <one>';
    const summary = '\u0413\u043e\u0442\u043e\u0432\u043e & checked';
    const state = { title, project: 'demo', sessionID: 's' };
    const cases = [
        ['done', 'done', 'Completed'], ['error', 'error', 'Error'],
        ['permission', undefined, 'Awaiting approval'], ['reminder', undefined, 'Still awaiting approval'],
        ['done', 'interrupted', 'Turn interrupted'],
    ];
    for (const [level, outcome, label] of cases) {
        const rendered = watcher.renderNotification({ level, at: '2026-10-11T14:05:00Z', state,
            turn: { outcome, summary, durationMs: 14000 } });
        for (const html of Object.values(rendered)) {
            assert.ok(html.includes(label), html);
            assert.ok(html.includes(title.replace('<one>', '&lt;one&gt;')));
            assert.ok(html.includes(summary.replace('&', '&amp;')));
            assert.ok(html.includes('Sunday, 11 October 2026 at 17:05 MSK'), html);
            assert.ok(html.includes('Cost / tokens: unavailable'));
        }
        assert.ok(rendered.rich.includes('Summary'));
        assert.ok(rendered.rich.includes('Tests'));
    }
    const approval = watcher.renderNotification({ level: 'permission', state });
    assert.ok(approval.rich.includes('Approve the action in your Codex terminal.'));
});

test('CLI help and generated profile comments use English', () => {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', path.pathname, 'help'],
        { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.startsWith('Usage: node --experimental-strip-types codex-watch.ts'));
    assert.ok(watcher.profileConfig().startsWith('# Profile for codex -p codex-hermes only'));
});
