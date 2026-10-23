# Codex Control 1.4.0

A standalone Hermes command plugin for Codex CLI observations from codex-watch.
It reads local state and never calls an LLM, resumes a thread, or decides permissions.

## Install

Copy this `codex-control` folder into `$HERMES_HOME/plugins/` (default `~/.hermes/plugins/`),
then run `hermes plugins enable codex-control`. Restart a running gateway after its active
work completes if updated commands have not loaded. Python stdlib only; no pip install needed.

## Commands

| Command | Purpose |
|---|---|
| `/cx` | Current observed Codex sessions |
| `/cx <number\|session_id>` | Session details |
| `/cx all` | Retained history |
| `/cxsum [target]` | Last completed turn's original answer and observations |
| `/cxtests [target]` | Recognized test commands and exit results |
| `/cxdiff [target]` | Full-diff availability |
| `/cxstats [days]` | Retained turn statistics |
| `/cxproj [project]` | Seven-day project activity |
| `/cxfind <text>` | Search session titles, projects, and summaries |
| `/cxwait` | Sessions requiring attention |
| `/cxclosed` | Closed or unloaded observations |
| `/cxlast` | Most recent completed turn |
| `/cxmute [minutes\|off\|levels]` | Pause or filter delivery |
| `/cxstatus` | Worker heartbeat, daemon/local CLI discovery, and delivery health |
| `/cxhelp` | Registry-generated help |

Targets accept a current list number, session ID, or unique ID prefix. With no target,
the most recently updated session is selected. Numbers can change when sessions enter/leave
the list; session IDs are durable. Sessions are never merged by daemon PID.

## Data and limits

`CODEX_HERMES_BASE_DIR` defaults to `~/.cache/codex-hermes`, separate from OpenCode.
Control writes only `control.json`; state and heartbeat belong to the worker.
`CX_CONTROL_STALE_AFTER_MINUTES=45`, `CX_CONTROL_MAX_LIST_ROWS=15`; invalid values fall back.

The final answer is shown verbatim. Generated help and labels are English. Daemon-only
turn summaries may lack a test journal; hooks add recognized shell-test observations.
Missing exit codes stay unknown, and unavailable cost, tokens, and full diff stay unavailable.
The retained journal contains at most 30 turns per session and is not all-time accounting.
STALE, UNLOADED, and a fresh worker heartbeat do not prove whether a terminal window is open.
Local CLI discovery is reported separately from the daemon. Older watchers produce an explicit
missing-capability warning; an unavailable scan is never displayed as zero additional sessions.

Full setup: https://github.com/klipbn/codex-hermes/blob/main/docs/installation.md

## History and license

[CHANGELOG.md](CHANGELOG.md). MIT; the source release includes its LICENSE.
