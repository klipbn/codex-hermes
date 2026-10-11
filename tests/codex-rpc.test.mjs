import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { ReadOnlyRpc, daemonSnapshot } from '../watcher/codex-daemon.ts';

function frame(text, opcode = 1, final = true) {
    const data = Buffer.from(text);
    const head = Buffer.alloc(data.length < 126 ? 2 : 4);
    head[0] = (final ? 128 : 0) | opcode;
    head[1] = data.length < 126 ? data.length : 126;
    if (data.length >= 126) head.writeUInt16BE(data.length, 2);
    return Buffer.concat([head, data]);
}
function socket(handler) {
    return new Duplex({ read() {}, write(buffer, _, done) {
        try {
            assert.ok(buffer[1] & 128, 'client frames must be masked');
            const size = (buffer[1] & 127) === 126 ? buffer.readUInt16BE(2) : buffer[1] & 127;
            const offset = (buffer[1] & 127) === 126 ? 4 : 2;
            const mask = buffer.subarray(offset, offset + 4);
            const data = Buffer.from(buffer.subarray(offset + 4, offset + 4 + size));
            for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
            handler.call(this, buffer[0] & 15, data);
            done();
        } catch(e) { done(e); }
    } });
}

test('RPC reads fragmented responses, answers pong, and rejects control methods', async () => {
    let pong = false;
    const stream = socket(function(opcode, data) {
        if (opcode === 10) { pong = data.toString() === 'ping'; return; }
        const req = JSON.parse(data);
        const result = JSON.stringify({ id: req.id, result: { data: ['\u0441\u0435\u0441\u0441\u0438\u044f'] } });
        const frames = Buffer.concat([frame('ping', 9), frame(result.slice(0, 12), 1, false), frame(result.slice(12), 0)]);
        this.push(frames.subarray(0, 3)); this.push(frames.subarray(3));
    });
    const rpc = new ReadOnlyRpc(stream);
    try {
        assert.deepEqual(await rpc.request('thread/loaded/list'), { data: ['\u0441\u0435\u0441\u0441\u0438\u044f'] });
        assert.equal(pong, true);
        await assert.rejects(rpc.request('turn/start'), /Only read-only methods are allowed/);
    } finally { rpc.close(); }
});

test('snapshot includes code-mode terminals and excludes desktop and monitor-origin subagents', async () => {
    const threads = {
        cli: { id: 'cli', source: 'vscode', originator: 'codex-tui' },
        'code-mode': { id: 'code-mode', source: 'vscode', originator: 'codex_hermes_monitor' },
        child: { id: 'child', source: { subAgent: { thread_spawn: { parent_thread_id: 'code-mode', depth: 1 } } },
            originator: 'codex_hermes_monitor' },
        desktop: { id: 'desktop', source: 'vscode', originator: 'Codex Desktop' },
    };
    const stream = socket(function(_, data) {
        const req = JSON.parse(data); let result;
        if (req.method === 'thread/loaded/list') result = req.params.cursor
            ? { data: ['code-mode', 'child', 'desktop'], nextCursor: null } : { data: ['cli'], nextCursor: 'page2' };
        else if (req.method === 'thread/read') result = { thread: threads[req.params.threadId] };
        else { assert.ok(['cli', 'code-mode'].includes(req.params.threadId)); result = { data: [{ id: 'turn', status: 'inProgress' }] }; }
        this.push(frame(JSON.stringify({ id: req.id, result })));
    });
    const rpc = new ReadOnlyRpc(stream);
    try {
        const snapshot = await daemonSnapshot(rpc);
        assert.deepEqual(snapshot.map(row => row.thread.id), ['cli', 'code-mode']);
        assert.deepEqual(snapshot.map(row => row.turns[0].id), ['turn', 'turn']);
    } finally { rpc.close(); }
});
