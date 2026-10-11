# Installation and configuration

Codex Hermes uses a standalone Node worker and a separate Hermes command plugin.
Requires Node 22.13+, Python 3.9+, Hermes, and Codex CLI with a local app-server daemon.
Hooks are optional and require a Codex build supporting official hook definitions.
The daemon interface is version-dependent; `/cxstatus` reports connection failures.

## Install the worker and control plugin

From the repository root:

```sh
mkdir -p "$HOME/.local/share/codex-hermes" "$HOME/.hermes/plugins"
cp watcher/codex-watch.ts watcher/codex-daemon.ts watcher/package.json "$HOME/.local/share/codex-hermes/"
cp -R codex-control "$HOME/.hermes/plugins/"
hermes plugins enable codex-control
node --experimental-strip-types "$HOME/.local/share/codex-hermes/codex-watch.ts" run
```

Use `$HERMES_HOME/plugins/` for a custom Hermes home. Both `.ts` files must be beside one another.
No runtime npm/pip dependencies are required. `/cxhelp`, `/cxstatus`, and `/cx` inspect the setup.
A running gateway may need `hermes gateway restart` after its active work completes.

Delivery is off unless `CODEX_HERMES_SEND=1`:

```sh
CODEX_HERMES_SEND=1 node --experimental-strip-types "$HOME/.local/share/codex-hermes/codex-watch.ts" run
```

One worker owns each state root. Ctrl+C stops it; a stale lock from a dead PID is reclaimed
at the next start. `once` handles one event batch without daemon discovery.

## Ordinary sessions

Daemon discovery reads loaded threads and turn summaries every ten seconds. Ordinary
terminal Codex sessions need no special profile. The initial snapshot imports history
without sending old turn completions; subsequent new completions can notify.

The worker connects to `$CODEX_HOME/app-server-control/app-server-control.sock`
(with `~/.codex` as the default Codex home). `CODEX_HERMES_SOCKET` overrides the socket.
`CODEX_HERMES_DISCOVERY=0` disables this path. Reading never resumes, starts, interrupts,
subscribes to, or approves a thread. An unavailable daemon leaves the last observations
available while `/cxstatus` reports the failure.

## Optional hooks

Hooks add recognized test observations and support separately configured processes without
a daemon. Generate a profile from the permanent installed location:

```sh
node --experimental-strip-types "$HOME/.local/share/codex-hermes/codex-watch.ts" profile > /tmp/codex-hermes.config.toml
```

Inspect the output and place it at `$CODEX_HOME/codex-hermes.config.toml`. Do not overwrite
existing config.toml, hooks.json, or another profile. Start `codex -p codex-hermes`, then
inspect and trust the new definitions through `/hooks`. The generated profile references
absolute paths, so regenerate it if the installation or Node path changes.
`hooks` prints standalone definitions for manual integration with another profile.

Hooks write normalized observations with empty stdout. They do not use HTTP/LLM or decide
permissions; their errors do not interrupt Codex. The worker performs state processing and delivery.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CODEX_HERMES_BASE_DIR` | `~/.cache/codex-hermes` | Shared worker/control root |
| `CODEX_HERMES_SEND` | `0` | Only `1` enables delivery |
| `CODEX_HERMES_NOTIFY` | `done,permission,reminder,error` | Enabled notification levels |
| `CODEX_HERMES_DISCOVERY` | enabled | `0` disables daemon discovery |
| `CODEX_HERMES_SOCKET` | Codex home socket | Socket override |
| `CODEX_HERMES_TG_RICH` | `1` | Try rich messages; `0` forces fallback |
| `CODEX_HERMES_TG_TOKEN` | Hermes token | Telegram token override |
| `CODEX_HERMES_TG_CHAT_ID` | Hermes home chat | Recipient override |
| `CODEX_HERMES_TG_TIMEOUT_MS` | `15000` | Bot API request timeout |
| `CODEX_HERMES_CMD_TIMEOUT_MS` | `30000` | Hermes command timeout |
| `CODEX_HERMES_WAITING_REMINDER_MIN` | `10` | Permission reminders, at most three; `0` disables |
| `CODEX_HERMES_STATE_RETENTION_HOURS` | `168` | State retention |

The token falls back to `TELEGRAM_BOT_TOKEN` or `$HERMES_HOME/.env`. Never commit credentials.
Control settings: `CX_CONTROL_STALE_AFTER_MINUTES=45`, `CX_CONTROL_MAX_LIST_ROWS=15`.
Invalid numeric values fall back to defaults. Hooks, worker, and control must share the
same base directory; keep it separate from OpenCode.

## Supervision and updates

For launchd, point `ProgramArguments` to the absolute Node path, `--experimental-strip-types`,
the installed `codex-watch.ts`, and `run`; use the permanent installation as `WorkingDirectory`.
launchd does not expand `~`. Preserve existing environment, delivery settings, and mute state.
Linux supervisors use the same worker command and environment.

Back up installed sources and supervisor configuration before updating. Stop only this worker,
replace both source files together, and restart it. Refresh hook paths only if necessary;
new definitions require normal trust review. Do not restart the shared Codex daemon just
to update the watcher. Update the control plugin and restart the Hermes gateway separately.
