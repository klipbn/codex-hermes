# Codex state contract

The shared root is `CODEX_HERMES_BASE_DIR`, default `~/.cache/codex-hermes`.
Never share it with OpenCode. The session key is `session_id`, not a background daemon PID.

| Object | Path | Owner |
|---|---|---|
| Normalized hook events | `events/*.json` | Hook |
| Session state | `sessions/<sha256(session_id)>.json` | Worker |
| Delivery queue | `outbox/*.json` | Worker |
| Heartbeat/health | `watcher.json` | Worker |
| Mute settings | `control.json` | Control plugin |
| Worker lock | `worker.lock` | Worker |

`schemaVersion=1` state includes identity, title/project, status, model, an active turn,
and up to 30 completed turns. The recent test list is limited to 10; turn counters are separate.
At most 100 simultaneous test observations are tracked, with overflow marked incomplete.
Unrecognized/missing exit codes are `unknown`. Unavailable cost, tokens, and full diff are `null`.
Unknown schemas and damaged state receive explicit warnings rather than fabricated metrics.

## Discovery and lifecycle

Read-only RPC allows `initialize`, `thread/loaded/list`, `thread/read`, and `thread/turns/list`.
There are no subscriptions or thread-control calls. Source/originator filters select terminal-
origin observations, not proof of current terminal window ownership. Initial history is silent;
new completions can notify. Hooks and daemon observations coordinate turn IDs without duplicate
journal entries. `UNLOADED` and `STALE` are not asserted as terminal closure.

Hooks only enqueue data. `run` / `once` process state under a single worker lock. Writes are
atomic, directories are 0700, files are 0600, and invalid numeric environment values fall back.
The control plugin writes only `control.json`; it never makes permission decisions or LLM calls.

## Delivery

Delivery requires `CODEX_HERMES_SEND=1`. The outbox survives worker restarts and allows at
most three attempts within one hour. A crash between successful sending and queue deletion
can cause a duplicate. Mute and SEND=0 discard pending notices rather than later replaying them.
Rich output has an honest fallback and dynamic content is escaped at rendering.

The English update keeps the schema, commands, and raw user content unchanged. Generated
labels are English; existing history retains its original content. Check actual writer/reader
fixtures whenever the schema changes, preserving compatibility with one previous major version.
