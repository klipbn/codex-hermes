/** Read-only discovery of terminal-owned sessions outside the shared daemon. */
import { execFile } from 'node:child_process';
import { open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { terminalThread } from './codex-daemon.ts';

type Dict = Record<string, any>;
type Command = (name: string, args: string[]) => Promise<string>;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_READ = 4 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;

const command: Command = (name, args) => new Promise((resolve, reject) => {
    const run = (executable: string) => execFile(executable, args, { timeout: 5000, maxBuffer: MAX_READ, encoding: 'utf8' }, (error, stdout, stderr) => {
        // launchd commonly omits /usr/sbin from PATH.
        if (error?.code === 'ENOENT' && executable === 'lsof' && process.platform === 'darwin') {
            run('/usr/sbin/lsof'); return;
        }
        // lsof also returns 1 when a selected process exits or has no matching descriptors.
        if (error && !(name === 'lsof' && error.code === 1 && !stderr.trim())) {
            reject(new Error('Local CLI process scan unavailable')); return;
        }
        resolve(stdout);
    });
    run(name);
});

function writerIds(output: string, pids: Set<string>, directory: string): Set<string> {
    const ids = new Set<string>();
    let selected = false;
    for (const line of output.split('\n')) {
        if (line.startsWith('p')) selected = pids.has(line.slice(1));
        if (!selected || !line.startsWith('n')) continue;
        const path = line.slice(1), name = basename(path);
        if (dirname(path) === directory && name.endsWith('.lock') && UUID.test(name.slice(0, -5))) ids.add(name.slice(0, -5));
    }
    return ids;
}

const seconds = (value: unknown, fallback: number | null = null): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

/** Read a bounded tail; only lifecycle events establish outcomes, never file modification time. */
async function journal(path: string, row: Dict): Promise<Dict> {
    const file = await open(path, 'r');
    try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error('Local journal is not a regular file');
        const offset = Math.max(0, stat.size - MAX_READ);
        const buffer = Buffer.alloc(Math.min(stat.size, MAX_READ));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        let data = buffer.subarray(0, bytesRead).toString('utf8');
        if (offset) data = data.slice(data.indexOf('\n') + 1);
        // A writer may be halfway through appending a JSON record.
        data = data.slice(0, data.lastIndexOf('\n') + 1);
        const turns = new Map<string, Dict>();
        let state = 'unknown', active: string | null = null;
        let model = row.model, updatedAt = row.updated_at;
        for (const line of data.split('\n')) {
            if (!line) continue;
            if (Buffer.byteLength(line) > MAX_LINE) { state = 'unknown'; continue; }
            const record = JSON.parse(line), p = record.payload;
            if (!p || typeof p !== 'object') continue;
            if (record.type === 'session_meta' && p.id !== row.id) throw new Error('Local journal identity mismatch');
            const at = Date.parse(record.timestamp) / 1000;
            if (!Number.isFinite(at)) continue;
            if (record.type === 'turn_context' && typeof p.model === 'string') model = p.model;
            if (record.type !== 'event_msg') continue;
            if (!['task_started', 'task_complete', 'task_failed', 'turn_aborted'].includes(p.type)) continue;
            if (typeof p.turn_id !== 'string' || !p.turn_id) { state = 'unknown'; continue; }
            updatedAt = at;
            if (p.type === 'task_started') {
                active = p.turn_id; state = 'active';
                turns.set(p.turn_id, { id: p.turn_id, status: 'inProgress', startedAt: seconds(p.started_at, at), items: [] });
            } else {
                const previous = turns.get(p.turn_id);
                const status = p.type === 'task_complete' ? 'completed' : p.type === 'task_failed' ? 'failed' : 'interrupted';
                turns.set(p.turn_id, { id: p.turn_id, status, startedAt: seconds(p.started_at, previous?.startedAt ?? null),
                    completedAt: seconds(p.completed_at, at), durationMs: seconds(p.duration_ms),
                    items: typeof p.last_agent_message === 'string'
                        ? [{ type: 'agentMessage', phase: 'final_answer', text: p.last_agent_message.slice(0, 6000) }] : [] });
                if (!active || active === p.turn_id) { active = null; state = status === 'failed' ? 'systemError' : 'idle'; }
            }
            if (turns.size > 30) turns.delete(turns.keys().next().value!);
        }
        return { thread: { id: row.id, source: row.source, originator: row.originator, cwd: row.cwd,
            name: row.title, model, createdAt: row.created_at, updatedAt, status: { type: state } },
            turns: [...turns.values()], observationSource: 'local' };
    } finally { await file.close(); }
}

export class LocalDiscovery {
    private home: string;
    private run: Command;
    private previous = new Map<string, Dict>();
    constructor(home: string, run: Command = command) { this.home = home; this.run = run; }

    private async readRows(rows: Dict[], exclude: Set<string>, progress: () => void): Promise<Dict[]> {
        const current = new Map(rows.filter(row => ['cli', 'vscode'].includes(row.source) && terminalThread(row))
            .map(row => [row.id, row]));
        const closing = [...this.previous.values()].filter(row => !current.has(row.id) && !exclude.has(row.id));
        if (!current.size && !closing.length) { this.previous = current; return []; }
        const directory = await realpath(join(this.home, 'sessions'));
        const snapshot = [];
        for (const row of [...current.values(), ...closing]) {
            const path = await realpath(row.rollout_path);
            if (!path.startsWith(directory + sep)) throw new Error('Local journal is outside the sessions directory');
            const value = await journal(path, row);
            if (!current.has(row.id)) value.thread.status = { type: 'notLoaded' };
            snapshot.push(value);
            progress();
        }
        this.previous = current;
        return snapshot;
    }

    async snapshot(progress = () => {}, exclude = new Set<string>()): Promise<Dict[]> {
        const output = await this.run('ps', ['-axo', 'pid=,tty=,comm=']);
        progress();
        const pids = new Set<string>();
        for (const line of output.split('\n')) {
            const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
            if (match && !['??', '?', '-'].includes(match[2]) && basename(match[3]) === 'codex') pids.add(match[1]);
        }
        if (!pids.size) return this.readRows([], exclude, progress);
        if (pids.size > 100) throw new Error('Too many terminal processes');
        const files = await this.run('lsof', ['-nP', '-a', '-p', [...pids].join(','), '-Fpn']);
        progress();
        const home = await realpath(this.home);
        const ids = [...writerIds(files, pids, join(home, 'thread-writer-locks'))].filter(id => !exclude.has(id));
        if (!ids.length) return this.readRows([], exclude, progress);
        const names = (await readdir(home)).filter(name => /^state_\d+\.sqlite$/.test(name))
            .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
        if (!names.length) throw new Error('Local session index unavailable');
        // Lazy import keeps optional SQLite support out of hooks and daemon-only operation.
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(join(home, names[0]), { readOnly: true });
        let rows: Dict[];
        try {
            db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
            const columns = new Set((db.prepare('PRAGMA table_info(threads)').all() as Dict[]).map(row => row.name));
            for (const name of ['id', 'source', 'cwd', 'rollout_path']) {
                if (!columns.has(name)) throw new Error('Unsupported local session index');
            }
            const fields = ['id', 'source', 'cwd', 'rollout_path', 'originator', 'title', 'model', 'created_at', 'updated_at']
                .map(name => columns.has(name) ? name : `NULL AS ${name}`).join(',');
            rows = db.prepare(`SELECT ${fields} FROM threads WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Dict[];
        } finally { db.close(); }
        progress();
        if (rows.length !== ids.length) throw new Error('Local session metadata is incomplete');
        return this.readRows(rows, exclude, progress);
    }
}
