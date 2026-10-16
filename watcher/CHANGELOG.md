# codex-watch changelog

## 1.3.2 — 2026-10-16

- Exit with an error after two minutes without state or daemon progress so an existing supervisor can restart a stalled worker.
- Refresh the deadline during state operations and daemon reads so productive batches are not limited by their total duration.
- Preserve hook behavior, state, and the single-worker lock; a replacement reclaims a dead worker's lock.
- Add isolated process regressions for stalled reads, replacement startup, and slow but progressing batches.

## 1.3.1 — 2026-10-11

- Recognize CLI code-mode sessions reported as `source=vscode` with `originator=codex_hermes_monitor`.
- Keep monitor-origin subagents excluded and preserve silent history imports and completion deduplication.

## 1.3.0 — 2026-10-11

- English notification labels, CLI help, operational errors, comments, and documentation.
- English dates in 24-hour Moscow time; original user titles, agent answers, and errors remain unchanged.
- Standalone project with stable source filenames and independent watcher releases.
- `codex-daemon.ts` ships with the watcher and shares its version.

## 1.2.0

- Read the model, session creation time, and last activity timestamp from the daemon.
- Assign the current model to active turns only, never to historical turns.
- Expose fields for compact `/cx` listings with actual timestamps.

## 1.1.0

- Discover ordinary terminal sessions automatically through the read-only daemon.
- Save initial history silently; reconcile hooks and daemon turns.
- Report daemon connection health in heartbeat; keep unavailable metrics explicit.

## 1.0.0

- Official hooks, event queue, turn history, and recognized test tracking.
- Separate worker and Telegram notification queue with rich and fallback delivery.
- Hooks do not make permission decisions or access the network.
