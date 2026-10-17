# codex-control changelog

## 1.3.1 — 2026-10-17

- Show local CLI discovery separately from daemon connectivity in `/cxstatus`.
- Distinguish missing watcher capabilities, unavailable scans, stale observations, and confirmed session counts.

## 1.3.0 — 2026-10-11

- English command descriptions, help, status labels, and diagnostic messages.
- Preserve original user titles and agent summaries in all command output.
- Standalone source project with repeatable release packaging.

## 1.2.0

- Compact `/cx` listings similar to `/oc`, with session details and commands by row number.
- Daemon models and timestamps; history and closed sessions retain their IDs.

## 1.1.0

- Discover ordinary and already-open terminal sessions through the daemon.
- Separate UNLOADED from active sessions; diagnose connections through `/cxstatus`.
- Do not substitute zero for unavailable tests in summaries.

## 1.0.0

- Independent `/cx…` commands reading Codex state v1.
- Turn history, tests, mute controls, diagnostics, and explicit unavailable metrics.
