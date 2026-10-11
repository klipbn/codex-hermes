/** Read-only JSON-RPC over WebSocket on the standard Codex daemon Unix socket. */
import { request as httpRequest } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Duplex } from 'node:stream';

type Dict = Record<string, any>;
const MAX = 8 * 1024 * 1024;
const METHODS = new Set(['initialize', 'thread/loaded/list', 'thread/read', 'thread/turns/list']);
export function terminalThread(t: Dict): boolean {
    return t.source === 'cli' || t.originator === 'codex-tui' || t.originator === 'codex_cli_rs';
}
export class ReadOnlyRpc {
    private buffer = Buffer.alloc(0);
    private fragments: Buffer[] = [];
    private fragmentBytes = 0;
    private id = 0;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    private socket: Duplex;
    closed = false;
    constructor(socket: Duplex, initial = Buffer.alloc(0)) {
        this.socket = socket;
        socket.on('data', data => {
            try { this.consume(Buffer.from(data)); } catch { this.close(); }
        });
        socket.on('error', () => this.close());
        socket.on('close', () => this.close());
        if (initial.length) this.consume(initial);
    }
    private frame(data: Buffer, opcode = 1) {
        const mask = randomBytes(4);
        const size = data.length;
        const header = Buffer.alloc(size < 126 ? 2 : size <= 65535 ? 4 : 10);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | (size < 126 ? size : size <= 65535 ? 126 : 127);
        if (size >= 126 && size <= 65535) header.writeUInt16BE(size, 2);
        if (size > 65535) header.writeBigUInt64BE(BigInt(size), 2);
        const body = Buffer.from(data);
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        this.socket.write(Buffer.concat([header, mask, body]));
    }
    private consume(data: Buffer) {
        this.buffer = Buffer.concat([this.buffer, data]);
        if (this.buffer.length > MAX) throw new Error('Response too large');
        while (this.buffer.length >= 2) {
            const first = this.buffer[0], second = this.buffer[1];
            let size = second & 127, offset = 2;
            if (second & 128 || first & 0x70) throw new Error('Invalid server frame');
            if (size === 126) {
                if (this.buffer.length < 4) return;
                size = this.buffer.readUInt16BE(2); offset = 4;
            } else if (size === 127) {
                if (this.buffer.length < 10) return;
                const n = this.buffer.readBigUInt64BE(2);
                if (n > BigInt(MAX)) throw new Error('Frame too large');
                size = Number(n); offset = 10;
            }
            if (size > MAX || this.buffer.length < offset + size) return;
            const payload = this.buffer.subarray(offset, offset + size);
            this.buffer = this.buffer.subarray(offset + size);
            const opcode = first & 15;
            if (opcode === 8) { this.close(); return; }
            if (opcode === 9) { this.frame(payload, 10); continue; }
            if (opcode === 10) continue;
            if (![0, 1].includes(opcode)) throw new Error('Invalid opcode');
            if ((opcode === 0) !== (this.fragments.length > 0)) throw new Error('Invalid fragmentation');
            this.fragments.push(payload);
            this.fragmentBytes += payload.length;
            if (this.fragmentBytes > MAX) throw new Error('JSON too large');
            if (!(first & 128)) continue;
            const message = JSON.parse(Buffer.concat(this.fragments).toString('utf8'));
            this.fragments = []; this.fragmentBytes = 0;
            const waiter = this.pending.get(message.id);
            if (waiter) {
                clearTimeout(waiter.timer); this.pending.delete(message.id);
                if (message.error) waiter.reject(new Error('Codex rejected a read-only request'));
                else waiter.resolve(message.result);
            }
            // Do not answer approval requests or subscribe to control operations.
        }
    }
    request(method: string, params: Dict = {}): Promise<any> {
        if (!METHODS.has(method)) return Promise.reject(new Error('Only read-only methods are allowed'));
        if (this.closed) return Promise.reject(new Error('Connection closed'));
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex request timed out')); }, 5000);
            this.pending.set(id, { resolve, reject, timer });
            this.frame(Buffer.from(JSON.stringify({ id, method, params })));
        });
    }
    initialized() { this.frame(Buffer.from(JSON.stringify({ method: 'initialized', params: {} }))); }
    close() {
        if (this.closed) return;
        this.closed = true;
        this.socket.destroy();
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Connection closed')); }
        this.pending.clear();
    }
}
export async function connectDaemon(socketPath = process.env.CODEX_HERMES_SOCKET ||
    join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'app-server-control/app-server-control.sock')) {
    const rpc = await new Promise<ReadOnlyRpc>((resolve, reject) => {
        const key = randomBytes(16).toString('base64');
        const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        const req = httpRequest({ socketPath, path: '/', headers: { Host: 'localhost', Upgrade: 'websocket',
            Connection: 'Upgrade', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
        const timer = setTimeout(() => req.destroy(new Error('Connection timed out')), 3000);
        req.on('error', () => { clearTimeout(timer); reject(new Error('Codex daemon unavailable')); });
        req.on('response', res => { clearTimeout(timer); res.destroy(); reject(new Error('WebSocket upgrade rejected')); });
        req.on('upgrade', (res, socket, head) => {
            clearTimeout(timer);
            if (res.statusCode !== 101 || res.headers['sec-websocket-accept'] !== expected) {
                socket.destroy(); reject(new Error('Invalid WebSocket handshake')); return;
            }
            resolve(new ReadOnlyRpc(socket, head));
        });
        req.end();
    });
    try {
        await rpc.request('initialize', { clientInfo: { name: 'codex_hermes_monitor', version: '1.3.0' },
            capabilities: { experimentalApi: true } });
        rpc.initialized();
        return rpc;
    } catch(e) { rpc.close(); throw e; }
}
export async function daemonSnapshot(rpc: ReadOnlyRpc): Promise<Dict[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
        const page = await rpc.request('thread/loaded/list', { limit: 100, cursor });
        if (!Array.isArray(page.data)) throw new Error('Invalid session list');
        ids.push(...page.data);
        cursor = page.nextCursor || null;
        if (ids.length > 1000) throw new Error('Too many sessions');
    } while (cursor);
    const snapshot = [];
    for (const id of ids) {
        const { thread } = await rpc.request('thread/read', { threadId: id, includeTurns: false });
        if (!thread || !terminalThread(thread)) continue;
        let turns = null;
        try {
            const page = await rpc.request('thread/turns/list', { threadId: id, limit: 30, sortDirection: 'desc', itemsView: 'summary' });
            if (Array.isArray(page.data)) turns = page.data;
        } catch { /* Status remains available even when history is unsupported. */ }
        snapshot.push({ thread, turns });
    }
    return snapshot;
}
