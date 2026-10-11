/** Codex CLI → Hermes v1.3.1. Uses only node:* modules, Node 22.13+ (--experimental-strip-types).
 * hook makes no decisions or network calls; run is the only state writer.
 * Release history is in CHANGELOG.md next to this file.
 */
import { mkdir, chmod, readFile, writeFile, rename, readdir, stat, unlink, open } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { connectDaemon, daemonSnapshot, terminalThread } from './codex-daemon.ts';
import type { ReadOnlyRpc } from './codex-daemon.ts';

export const WATCHER_VERSION = '1.3.1';
type Dict = Record<string, any>;
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd'];
const LIMIT = 2 * 1024 * 1024;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const text = (s: unknown, n = 2000) => typeof s === 'string' ? s.slice(0, n) : '';
const object = (v: unknown): Dict => v && typeof v === 'object' && !Array.isArray(v) ? v as Dict : {};
const stamp = () => new Date().toISOString();
const baseDir = () => resolve(process.env.CODEX_HERMES_BASE_DIR || join(homedir(), '.cache/codex-hermes'));
export function numberEnv(name: string, fallback: number, min = 1): number {
    const n = Number(process.env[name]);
    return process.env[name]?.trim() && Number.isFinite(n) && n >= min ? n : fallback;
}
async function dirs(base: string) {
    for (const path of [base, ...['events', 'sessions', 'outbox'].map(x => join(base, x))]) {
        await mkdir(path, { recursive: true, mode: 0o700 });
        await chmod(path, 0o700);
    }
}
async function atomic(path: string, value: unknown) {
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
        await rename(tmp, path);
    } finally { await unlink(tmp).catch(() => {}); }
}
async function json(path: string): Promise<Dict | null> {
    try {
        if ((await stat(path)).size > LIMIT) return null;
        const value = JSON.parse(await readFile(path, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch { return null; }
}
export async function readState(base: string, id: string): Promise<Dict | null> {
    const s = await json(join(base, 'sessions', `${digest(id)}.json`));
    return s?.schemaVersion === 1 && s.sessionID === id && Array.isArray(s.turns) &&
        Array.isArray(s.pending) && Array.isArray(s.recentEvents) ? s : null;
}

/** Keep only required fields: no full tool outputs or transcripts. */
export async function enqueue(base: string, input: unknown) {
    const e = object(input);
    await dirs(base);
    if (!EVENTS.includes(e.hook_event_name) || typeof e.session_id !== 'string' || !e.session_id || e.session_id.length > 256) return;
    const toolInput = object(e.tool_input);
    const response = object(e.tool_response);
    let exitCode = Number.isInteger(response.exit_code) ? response.exit_code : null;
    // Codex shell tools may return model-facing text instead of an object.
    if (typeof e.tool_response === 'string') {
        const match = e.tool_response.match(/(?:^|\n)(?:Process exited with code|Exit code:)\s*(-?\d+)\s*(?:\n|$)/);
        if (match) exitCode = Number(match[1]);
    }
    const normalized = {
        id: randomUUID(), at: stamp(), event: e.hook_event_name,
        sessionID: e.session_id, turnID: text(e.turn_id, 256),
        directory: text(e.cwd, 4096), model: text(e.model, 200),
        prompt: text(e.prompt, 200), summary: text(e.last_assistant_message, 6000),
        tool: text(e.tool_name, 200), callID: text(e.tool_use_id, 256),
        command: text(toolInput.command, 2000), exitCode,
    };
    const name = `${Date.now()}-${process.hrtime.bigint().toString().padStart(22, '0')}-${normalized.id}.json`;
    await atomic(join(base, 'events', name), normalized);
}
function newTurn(e: Dict): Dict {
    return { id: e.turnID || e.id, startedAt: e.at, model: e.model || null,
        tools: {}, tests: [], pendingTests: {}, testCounts: { passed: 0, failed: 0, unknown: 0 },
        cost: null, tokensIn: null, tokensOut: null, diff: null, seen: [] };
}
function isTest(command: string) {
    return /(?:^|[\s;&|])(?:pytest|py\.test|jest|vitest)(?:\s|$)|\b(?:npm|pnpm|yarn|bun|cargo|go)\s+(?:run\s+)?test\b|\bpython\S*\s+-m\s+(?:pytest|unittest)\b|\bnode\b[^\n]*\s--test\b/.test(command);
}
function addNotice(s: Dict, level: string, key: string, turn?: Dict) {
    s.pending.push({ id: digest(`${s.sessionID}:${key}`), at: s.updatedAt, level,
        state: { sessionID: s.sessionID, title: s.title, project: s.project, status: s.status },
        turn: turn || null });
}
function finish(s: Dict, e: Dict, outcome: string) {
    if (!s.active) return;
    const turn = s.active;
    for (const test of Object.values(turn.pendingTests) as Dict[]) {
        test.status = 'unknown';
        turn.testCounts.unknown++;
        turn.tests.push(test);
    }
    turn.tests = turn.tests.slice(-10);
    delete turn.pendingTests;
    turn.finishedAt = e.at;
    turn.durationMs = Math.max(0, Date.parse(e.at) - Date.parse(turn.startedAt));
    turn.outcome = outcome;
    turn.summary = e.summary || (outcome === 'interrupted' ? 'Turn interrupted.' : 'No final response received.');
    delete turn.seen;
    s.turns = [...s.turns, turn].slice(-30);
    s.lastSummary = turn.summary;
    s.active = null;
    s.waitingSince = null;
    s.status = outcome === 'done' ? 'idle' : 'interrupted';
    addNotice(s, outcome === 'done' ? 'done' : 'error', `turn:${turn.id}`, turn);
}
function reduce(previous: Dict | null, e: Dict): Dict {
    const s = previous || { schemaVersion: 1, source: 'codex', sessionID: e.sessionID,
        title: '', project: '', directory: '', status: 'unknown', turns: [], active: null,
        pending: [], recentEvents: [], startedAt: e.at };
    if (s.recentEvents.includes(e.id)) return s;
    s.updatedAt = e.at;
    if (e.directory) { s.directory = e.directory; s.project = basename(e.directory); }
    if (e.model) s.model = e.model;
    s.recentEvents = [...s.recentEvents, e.id].slice(-200);
    if (e.event === 'SessionStart') {
        if (!s.active) s.status = 'idle';
    } else if (e.event === 'SessionEnd') {
        finish(s, e, 'interrupted');
        s.status = 'closed';
    } else if (['Stop', 'Interrupt'].includes(e.event)) {
        if (!s.turns.some((t: Dict) => t.id === e.turnID)) {
            if (!s.active && e.event === 'Stop') s.active = newTurn(e);
            if (!e.turnID || s.active?.id === e.turnID) finish(s, e, e.event === 'Stop' ? 'done' : 'interrupted');
        }
    } else {
        // Late events from a completed turn do not revive the session.
        if (e.turnID && s.turns.some((t: Dict) => t.id === e.turnID)) return s;
        if (s.active && e.turnID && s.active.id !== e.turnID) finish(s, e, 'interrupted');
        if (!s.active) s.active = newTurn(e);
        const turn = s.active;
        if (e.model) turn.model = e.model;
        if (e.event === 'UserPromptSubmit') {
            if (!s.title && e.prompt.trim()) s.title = e.prompt.trim().replace(/\s+/g, ' ');
            s.status = 'busy';
            s.waitingSince = null;
        } else if (e.event === 'PermissionRequest') {
            s.status = 'waiting';
            if (!s.waitingSince) {
                s.waitingSince = e.at;
                s.reminders = 0;
                addNotice(s, 'permission', `permission:${e.id}`);
            }
        } else {
            s.status = 'busy';
            s.waitingSince = null;
            const key = `${e.event}:${e.callID || e.id}`;
            if (turn.seen.includes(key)) return s;
            turn.seen = [...turn.seen, key].slice(-2000);
            if (e.event === 'PreToolUse') {
                turn.tools[e.tool || 'unknown'] = (turn.tools[e.tool || 'unknown'] || 0) + 1;
            }
            if (e.tool === 'Bash' && isTest(e.command)) {
                const testID = e.callID || e.id;
                let test = turn.pendingTests[testID];
                if (!test) {
                    if (Object.keys(turn.pendingTests).length >= 100) {
                        turn.testsTruncated = true;
                        return s;
                    }
                    test = { id: e.callID || e.id, command: e.command, status: 'running', exitCode: null, startedAt: e.at };
                    turn.pendingTests[testID] = test;
                }
                if (e.event === 'PostToolUse' && test.status === 'running') {
                    test.exitCode = e.exitCode;
                    test.status = e.exitCode === null ? 'unknown' : e.exitCode === 0 ? 'passed' : 'failed';
                    test.durationMs = Math.max(0, Date.parse(e.at) - Date.parse(test.startedAt));
                    turn.testCounts[test.status]++;
                    turn.tests = [...turn.tests, test].slice(-10);
                    delete turn.pendingTests[testID];
                }
            }
        }
    }
    return s;
}
async function flushNotices(base: string, path: string, s: Dict) {
    for (const notice of s.pending) await atomic(join(base, 'outbox', `${notice.id}.json`), notice);
    if (s.pending.length) { s.pending = []; await atomic(path, s); }
}

/** The first snapshot establishes history without sending old summaries. */
export async function reconcileDaemon(base: string, snapshot: Dict[], now = Date.now()) {
    await dirs(base);
    const observed = new Set<string>();
    const iso = new Date(now).toISOString();
    for (const { thread: t, turns } of snapshot) {
        if (!t || typeof t.id !== 'string' || !terminalThread(t)) continue;
        observed.add(t.id);
        const s = await readState(base, t.id) || reduce(null, { id: randomUUID(), at: iso,
            event: 'SessionStart', sessionID: t.id, directory: text(t.cwd, 4096) });
        const previousStatus = s.status;
        const initialized = s.daemon?.turnsInitialized === true;
        const alreadyObserved = !!s.daemon;
        if (t.name || t.preview) s.title = text(t.name || t.preview, 200).replace(/\s+/g, ' ');
        if (t.cwd) { s.directory = text(t.cwd, 4096); s.project = basename(s.directory); }
        s.updatedAt = iso;
        const timestamp = (n: unknown) => typeof n === 'number' && Number.isFinite(n) ? new Date(n * 1000).toISOString() : null;
        if (typeof t.model === 'string' && t.model.trim()) s.model = text(t.model, 200);
        s.sessionCreatedAt = timestamp(t.createdAt) || s.sessionCreatedAt || null;
        s.lastActivityAt = timestamp(t.updatedAt) || s.lastActivityAt || null;
        if (Array.isArray(turns)) {
            const ordered = [...turns].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
            for (const turn of ordered) {
                if (!turn.id || s.turns.some((old: Dict) => old.id === turn.id)) continue;
                if (turn.status === 'inProgress') {
                    if (!s.active || s.active.id !== turn.id) {
                        s.active = newTurn({ turnID: turn.id, at: timestamp(turn.startedAt) || iso });
                        s.active.testsAvailable = false;
                    }
                    if (s.model) s.active.model = s.model;
                    continue;
                }
                if (!['completed', 'failed', 'interrupted'].includes(turn.status)) continue;
                const active = s.active?.id === turn.id ? s.active : null;
                const messages = (turn.items || []).filter((i: Dict) => i.type === 'agentMessage');
                const answer = messages.filter((i: Dict) => i.phase === 'final_answer').at(-1) || messages.at(-1);
                const completed: Dict = { ...(active || {}), id: turn.id,
                    startedAt: timestamp(turn.startedAt), finishedAt: timestamp(turn.completedAt) || iso,
                    durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : null,
                    outcome: turn.status === 'completed' ? 'done' : turn.status === 'failed' ? 'error' : 'interrupted',
                    summary: text(answer?.text || turn.error?.message || 'Codex did not provide a summary.', 6000),
                    tests: active?.tests || [], testCounts: active?.testCounts || null,
                    testsAvailable: active ? active.testsAvailable !== false : false,
                    model: active?.model || null, cost: null, tokensIn: null, tokensOut: null, diff: null };
                if (completed.testsAvailable) {
                    for (const test of Object.values(active?.pendingTests || {}) as Dict[]) {
                        test.status = 'unknown'; completed.tests.push(test); completed.testCounts.unknown++;
                    }
                    completed.tests = completed.tests.slice(-10);
                }
                delete completed.pendingTests; delete completed.seen;
                s.turns = [...s.turns, completed].slice(-30);
                s.lastSummary = completed.summary;
                if (active) s.active = null;
                if (initialized) addNotice(s, completed.outcome === 'done' ? 'done' : 'error', `turn:${turn.id}`, completed);
            }
        }
        const flags = t.status?.activeFlags || [];
        s.status = t.status?.type === 'active'
            ? (flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput') ? 'waiting' : 'busy')
            : ({ idle: 'idle', notLoaded: 'unloaded', systemError: 'error' } as Dict)[t.status?.type] || 'unknown';
        if (s.status === 'waiting') {
            if (previousStatus !== 'waiting') {
                s.waitingSince = iso; s.reminders = 0;
                if (alreadyObserved) addNotice(s, 'permission', `permission:${iso}`);
            }
        } else s.waitingSince = null;
        s.daemon = { observedAt: iso, turnsInitialized: initialized || Array.isArray(turns),
            historyAvailable: Array.isArray(turns), originator: t.originator || t.source };
        const path = join(base, 'sessions', `${digest(t.id)}.json`);
        await atomic(path, s); await flushNotices(base, path, s);
    }
    for (const name of (await readdir(join(base, 'sessions'))).filter(x => x.endsWith('.json'))) {
        const path = join(base, 'sessions', name), s = await json(path);
        if (s?.daemon && !observed.has(s.sessionID) && s.status !== 'closed' && s.status !== 'unloaded') {
            s.status = 'unloaded'; s.updatedAt = iso; s.waitingSince = null;
            await atomic(path, s);
        }
    }
}

/** Call only from the single worker. A crash between state and outbox writes is recoverable. */
export async function drain(base: string) {
    await dirs(base);
    for (const name of (await readdir(join(base, 'events'))).filter(x => x.endsWith('.json')).sort()) {
        const path = join(base, 'events', name);
        const e = await json(path);
        if (!e || !EVENTS.includes(e.event) || typeof e.sessionID !== 'string' || !e.id) {
            await unlink(path); continue;
        }
        const statePath = join(base, 'sessions', `${digest(e.sessionID)}.json`);
        const s = reduce(await readState(base, e.sessionID), e);
        await atomic(statePath, s);
        await flushNotices(base, statePath, s);
        await unlink(path);
    }
}

function escaped(s: unknown, max: number) {
    // Limit escaped text on complete characters without splitting entities.
    let out = '';
    for (const c of String(s ?? '')) {
        const part = ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Dict)[c] || c;
        if (out.length + part.length > max) return out + '…';
        out += part;
    }
    return out;
}
export function renderNotification(n: Dict): { rich: string; fallback: string } {
    const s = n.state, turn = n.turn || {};
    const title = escaped(`📝 ${s.title || s.project || 'Codex'}`, 200);
    const label = n.level === 'permission' ? '🔐 Awaiting approval' : n.level === 'reminder'
        ? '⏰ Still awaiting approval' : turn.outcome === 'interrupted' ? '⏹ Turn interrupted' : turn.outcome === 'error' ? '❌ Error' : '✅ Completed';
    const status = `${label} · Codex · ${escaped(s.project, 160)}`;
    const summary = escaped(turn.summary || 'Approve the action in your Codex terminal.', 1700);
    const counts = turn.testCounts;
    const tests = counts && turn.testsAvailable !== false ? `✅ ${counts.passed} · ❌ ${counts.failed} · ❔ ${counts.unknown}` : 'unavailable';
    const duration = typeof turn.durationMs === 'number' ? `${Math.round(turn.durationMs / 1000)} s` : 'unavailable';
    const meta = `⏱ ${duration} · Model: ${escaped(turn.model, 150) || 'unavailable'}\nCost / tokens: unavailable`;
    const date = escaped(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow',
        dateStyle: 'full', timeStyle: 'short', hour12: false }).format(new Date(n.at || Date.now())) + ' MSK', 180);
    return {
        rich: `<h3>${title}</h3><p>${status}</p><details open><summary>🧠 Summary</summary><p>${summary.replace(/\n/g, '<br>')}</p></details>` +
            `<details><summary>📦 Diff</summary><p>Unavailable: hooks do not provide a full diff.</p></details>` +
            `<details><summary>🧪 Tests · ${tests}</summary><p>Details: /cxtests ${escaped(s.sessionID, 256)}</p></details>` +
            `<details><summary>📊 Details</summary><p>${meta.replace(/\n/g, '<br>')}</p></details><footer>${date}</footer>`,
        fallback: `<b>${title}</b>\n${status}\n\n${summary}\n\n<blockquote expandable>📦 Diff: unavailable</blockquote>\n` +
            `<blockquote expandable>🧪 Tests · ${tests}\n/cxtests ${escaped(s.sessionID, 256)}</blockquote>\n${meta}\n<i>${date}</i>`,
    };
}

function run(args: string[], timeout = 30000): Promise<string> {
    return new Promise((resolve, reject) => execFile(args[0], args.slice(1),
        { timeout, maxBuffer: LIMIT, encoding: 'utf8' }, (error, stdout) => error ? reject(new Error('External command failed')) : resolve(stdout)));
}
export async function sendNotification(n: Dict, transport?: {
    rich: (html: string) => Promise<boolean>; fallback: (html: string) => Promise<void>;
}) {
    const rendered = renderNotification(n);
    const delivery = transport || { rich: sendRich, fallback: async (html: string) => {
        await run(['hermes', 'send', '--to', 'telegram', '--quiet', html], numberEnv('CODEX_HERMES_CMD_TIMEOUT_MS', 30000));
    } };
    if (['done', 'error'].includes(n.level) && process.env.CODEX_HERMES_TG_RICH !== '0') {
        try { if (await delivery.rich(rendered.rich)) return; } catch { /* Fallback is required. */ }
    }
    await delivery.fallback(rendered.fallback);
}
async function sendRich(html: string) {
    let token = process.env.CODEX_HERMES_TG_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
    if (!token) {
        try {
            const env = await readFile(join(process.env.HERMES_HOME || join(homedir(), '.hermes'), '.env'), 'utf8');
            token = env.match(/^\s*TELEGRAM_BOT_TOKEN\s*=\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') || '';
        } catch { /* Ordinary hermes send resolves the recipient itself. */ }
    }
    if (!token) return false;
    let chat = process.env.CODEX_HERMES_TG_CHAT_ID || '';
    if (!chat) {
        const result = JSON.parse(await run(['hermes', 'send', '--list', 'telegram', '--json']));
        const target = result?.platforms?.telegram?.[0];
        chat = String(target?.id ?? target?.chat_id ?? '');
    }
    if (!chat) return false;
    const response = await fetch(`https://api.telegram.org/bot${token}/sendRichMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, rich_message: { html } }),
        signal: AbortSignal.timeout(numberEnv('CODEX_HERMES_TG_TIMEOUT_MS', 15000)),
    });
    return response.ok && (await response.json() as Dict)?.ok === true;
}
export async function tick(base: string, send = process.env.CODEX_HERMES_SEND === '1',
    deliver: (n: Dict) => Promise<void> = sendNotification, now = Date.now(), daemonHealth: Dict = {}) {
    await dirs(base);
    const control = await json(join(base, 'control.json')) || {};
    const disabled = Array.isArray(control.disabledLevels) ? control.disabledLevels : [];
    const enabled = (process.env.CODEX_HERMES_NOTIFY ?? 'done,permission,reminder,error').split(',');
    const muted = Date.parse(control.muteUntil || '') > now;
    const retention = numberEnv('CODEX_HERMES_STATE_RETENTION_HOURS', 168) * 3600000;
    for (const name of (await readdir(join(base, 'sessions'))).filter(x => x.endsWith('.json'))) {
        const path = join(base, 'sessions', name);
        const s = await json(path);
        if (!s || s.schemaVersion !== 1 || !Array.isArray(s.pending)) continue;
        await flushNotices(base, path, s);
        if (now - Date.parse(s.updatedAt) > retention) { await unlink(path); continue; }
        const minutes = numberEnv('CODEX_HERMES_WAITING_REMINDER_MIN', 10, 0);
        if (s.status === 'waiting' && minutes > 0 && s.reminders < 3 &&
            now - Date.parse(s.waitingSince) >= minutes * 60000 * (s.reminders + 1)) {
            s.reminders++;
            addNotice(s, 'reminder', `reminder:${s.waitingSince}:${s.reminders}`);
            await atomic(path, s);
            await flushNotices(base, path, s);
        }
    }
    let failures = 0;
    for (const name of (await readdir(join(base, 'outbox'))).filter(x => x.endsWith('.json')).sort()) {
        const path = join(base, 'outbox', name);
        const n = await json(path);
        // Disabled events are not sent retroactively when enabled.
        if (!n || !send || muted || disabled.includes(n.level) || !enabled.includes(n.level) || now - Date.parse(n.at) > 3600000) {
            await unlink(path); continue;
        }
        if (n.nextAttempt && now < n.nextAttempt) continue;
        try { await deliver(n); await unlink(path); } catch {
            failures++;
            n.attempts = (n.attempts || 0) + 1;
            if (n.attempts >= 3) await unlink(path);
            else { n.nextAttempt = now + 30000 * n.attempts; await atomic(path, n); }
        }
    }
    await atomic(join(base, 'watcher.json'), { version: WATCHER_VERSION, pid: process.pid,
        heartbeatAt: stamp(), sendEnabled: send, muteUntil: control.muteUntil || null,
        disabledLevels: disabled, deliveryFailures: failures, daemon: daemonHealth });
}

export function hooksConfig(script = fileURLToPath(import.meta.url), node = process.execPath) {
    const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    const command = `${quote(node)} --experimental-strip-types ${quote(script)} hook`;
    return { hooks: Object.fromEntries(EVENTS.map(event => [event, [{ hooks: [{ type: 'command', command, timeout: 3 }] }]])) };
}
export function profileConfig() {
    const config = hooksConfig();
    return '# Profile for codex -p codex-hermes only\n' +
        Object.entries(config.hooks).map(([event, groups]) =>
            `\n[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(groups[0].hooks[0].command)}\ntimeout = 3\n`).join('');
}
async function acquire(base: string) {
    await dirs(base);
    const path = join(base, 'worker.lock');
    for (let i = 0; i < 2; i++) {
        try {
            const fd = await open(path, 'wx', 0o600);
            await fd.writeFile(JSON.stringify({ pid: process.pid }));
            await fd.close();
            return async () => { await unlink(path).catch(() => {}); };
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
            const lock = await json(path);
            if (!lock) {
                // Another worker has not written its PID yet.
                if (Date.now() - (await stat(path)).mtimeMs < 30000) throw new Error('Watcher is already starting');
            } else {
                try { process.kill(lock.pid, 0); throw new Error('Watcher is already running'); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
            }
            await unlink(path).catch(() => {});
        }
    }
    throw new Error('Unable to acquire worker lock');
}
async function main() {
    const mode = process.argv[2];
    if (mode === 'hooks') { console.log(JSON.stringify(hooksConfig(), null, 2)); return; }
    if (mode === 'profile') { console.log(profileConfig()); return; }
    if (mode === 'hook') {
        try {
            let input = '';
            for await (const chunk of process.stdin) {
                input += chunk;
                if (Buffer.byteLength(input) > LIMIT) return;
            }
            await enqueue(baseDir(), JSON.parse(input));
        } catch { /* Hooks never make permission decisions or disrupt Codex. */ }
        return;
    }
    if (!['run', 'once'].includes(mode)) {
        console.log('Usage: node --experimental-strip-types codex-watch.ts hook|run|once|hooks|profile');
        return;
    }
    const base = baseDir();
    const release = await acquire(base);
    let rpc: ReadOnlyRpc | null = null;
    let nextDiscovery = 0;
    let daemonHealth: Dict = { connected: false };
    try {
        do {
            await drain(base);
            if (mode === 'run' && process.env.CODEX_HERMES_DISCOVERY !== '0' && Date.now() >= nextDiscovery) {
                try {
                    if (!rpc || rpc.closed) rpc = await connectDaemon();
                    const snapshot = await daemonSnapshot(rpc);
                    await reconcileDaemon(base, snapshot);
                    daemonHealth = { connected: true, sessions: snapshot.length, checkedAt: stamp() };
                } catch {
                    rpc?.close(); rpc = null;
                    daemonHealth = { connected: false, checkedAt: stamp(), error: 'Local Codex daemon is unavailable; hooks continue to work.' };
                }
                nextDiscovery = Date.now() + 10000;
            }
            await tick(base, process.env.CODEX_HERMES_SEND === '1', sendNotification, Date.now(), daemonHealth);
            if (mode === 'once') break;
            await new Promise(r => setTimeout(r, 2000));
        } while (true);
    } finally { rpc?.close(); await release(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(() => { console.error('codex-watch: worker failed; check permissions, state, and worker.lock.'); process.exitCode = 1; });
}

// 1.2.0: daemon model and actual timestamps for compact /cx;
// the current model is never assigned to historical turns.
