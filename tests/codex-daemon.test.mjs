import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
let watch;
try { watch = await import('../watcher/codex-watch.ts'); } catch(e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}
async function fixture(t) {
    assert.ok(watch, 'A watcher with daemon discovery is required');
    const base = await mkdtemp(join(tmpdir(), 'codex-discovery-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    return base;
}
const thread = (id = 'terminal-one', extra = {}) => ({ id, source: 'vscode', originator: 'codex-tui',
    name: '\u0420\u0435\u0430\u043b\u044c\u043d\u0430\u044f \u0437\u0430\u0434\u0430\u0447\u0430', cwd: '/work/project', status: { type: 'active', activeFlags: [] }, ...extra });
const turn = (id, status, text = '\u0413\u043e\u0442\u043e\u0432\u043e') => ({ id, status, startedAt: 1791321000,
    completedAt: status === 'inProgress' ? null : 1791321100, durationMs: 100000,
    items: [{ type: 'agentMessage', phase: 'final_answer', text }] });

test('ordinary source=vscode terminal sessions are visible without hooks; desktop is excluded', async t => {
    const base = await fixture(t);
    await watch.reconcileDaemon(base, [
        { thread: thread(), turns: [turn('t1', 'inProgress')] },
        { thread: thread('terminal-two', { source: 'cli', originator: 'codex_cli_rs' }), turns: [] },
        { thread: thread('desktop', { originator: 'Codex Desktop' }), turns: [] },
    ]);
    assert.equal((await watch.readState(base, 'terminal-one')).status, 'busy');
    assert.equal((await watch.readState(base, 'terminal-two')).title, '\u0420\u0435\u0430\u043b\u044c\u043d\u0430\u044f \u0437\u0430\u0434\u0430\u0447\u0430');
    assert.equal(await watch.readState(base, 'desktop'), null);
    assert.equal((await readdir(join(base, 'outbox'))).length, 0);
});

test('connection history is silent and new completion notifies exactly once', async t => {
    const base = await fixture(t);
    await watch.reconcileDaemon(base, [{ thread: thread(), turns: [turn('old', 'completed'), turn('current', 'inProgress')] }]);
    assert.equal((await readdir(join(base, 'outbox'))).length, 0);
    const snapshot = [{ thread: thread('terminal-one', { status: { type: 'idle' } }),
        turns: [turn('old', 'completed'), turn('current', 'completed', '\u0418\u0441\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043e')] }];
    await watch.reconcileDaemon(base, snapshot);
    await watch.reconcileDaemon(base, snapshot);
    const state = await watch.readState(base, 'terminal-one');
    assert.equal(state.status, 'idle');
    assert.equal(state.turns.length, 2);
    assert.equal(state.turns.at(-1).summary, '\u0418\u0441\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043e');
    assert.equal(state.turns.at(-1).testsAvailable, false);
    assert.equal((await readdir(join(base, 'outbox'))).length, 1);
});

test('approval waiting is visible and notifies on transitions; unloading is not completion', async t => {
    const base = await fixture(t);
    await watch.reconcileDaemon(base, [{ thread: thread(), turns: [] }]);
    await watch.reconcileDaemon(base, [{ thread: thread('terminal-one', { status: { type: 'active', activeFlags: ['waitingOnApproval'] } }), turns: [] }]);
    assert.equal((await watch.readState(base, 'terminal-one')).status, 'waiting');
    assert.equal((await readdir(join(base, 'outbox'))).length, 1);
    await watch.reconcileDaemon(base, []);
    assert.equal((await watch.readState(base, 'terminal-one')).status, 'unloaded');
    assert.equal((await readdir(join(base, 'outbox'))).length, 1);
});

test('turns/list failure does not treat old summaries as new after recovery', async t => {
    const base = await fixture(t);
    await watch.reconcileDaemon(base, [{ thread: thread(), turns: null }]);
    await watch.reconcileDaemon(base, [{ thread: thread(), turns: [turn('old', 'completed')] }]);
    assert.equal((await readdir(join(base, 'outbox'))).length, 0);
});

test('hooks and daemon do not duplicate completions or erase test results', async t => {
    const base = await fixture(t);
    await watch.reconcileDaemon(base, [{ thread: thread(), turns: [] }]);
    for (const event of [
        { hook_event_name: 'UserPromptSubmit' },
        { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'cmd', tool_input: { command: 'npm test' } },
        { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'cmd', tool_input: { command: 'npm test' }, tool_response: { exit_code: 1 } },
        { hook_event_name: 'Stop', last_assistant_message: '\u0422\u0435\u0441\u0442 \u0443\u043f\u0430\u043b' },
    ]) await watch.enqueue(base, { ...event, session_id: 'terminal-one', turn_id: 'current' });
    await watch.drain(base);
    await watch.reconcileDaemon(base, [{ thread: thread(), turns: [turn('current', 'completed')] }]);
    const s = await watch.readState(base, 'terminal-one');
    assert.equal(s.turns.length, 1);
    assert.equal(s.turns[0].testCounts.failed, 1);
    assert.equal((await readdir(join(base, 'outbox'))).length, 1);
});

test('model and activity timestamps come from the API and are not replaced by heartbeat', async t => {
    const base = await fixture(t);
    const data = { thread: thread('terminal-one', { model: 'gpt-6-astra', createdAt: 1791320000, updatedAt: 1791321000 }),
        turns: [turn('old', 'completed'), turn('active', 'inProgress')] };
    await watch.reconcileDaemon(base, [data]);
    const state = await watch.readState(base, 'terminal-one');
    assert.equal(state.model, 'gpt-6-astra');
    assert.equal(state.active.model, 'gpt-6-astra');
    assert.equal(state.lastActivityAt, new Date(1791321000000).toISOString());
    assert.equal(state.turns[0].model, null, 'the current model must not be assigned to old history');
    await watch.reconcileDaemon(base, [{ ...data, thread: { ...data.thread, model: null } }], Date.now()+60000);
    const refreshed = await watch.readState(base, 'terminal-one');
    assert.equal(refreshed.model, 'gpt-6-astra');
    assert.equal(refreshed.lastActivityAt, state.lastActivityAt);
});

test('daemon error summaries retain Unicode external errors and use English notification labels', async t => {
    const base = await fixture(t);
    const externalError = '\u041e\u0448\u0438\u0431\u043a\u0430 <connection> & retry';
    await watch.reconcileDaemon(base, [{ thread: thread(), turns: [turn('current', 'inProgress')] }]);
    await watch.reconcileDaemon(base, [{ thread: thread(), turns: [{ ...turn('current', 'failed'),
        items: [], error: { message: externalError } }] }]);
    const state = await watch.readState(base, 'terminal-one');
    assert.equal(state.turns[0].summary, externalError);
    assert.equal(state.turns[0].outcome, 'error');
    const delivered = [];
    await watch.sendNotification({ level: 'error', state, turn: state.turns[0] }, {
        rich: async () => { throw new Error('offline'); },
        fallback: async html => delivered.push(html),
    });
    assert.equal(delivered.length, 1);
    assert.ok(delivered[0].includes('❌ Error · Codex'));
    assert.ok(delivered[0].includes(externalError.replace('<connection>', '&lt;connection&gt;').replace('& retry', '&amp; retry')));
});
