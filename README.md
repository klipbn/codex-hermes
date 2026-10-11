# Codex Hermes

[![Release](https://img.shields.io/github/v/release/klipbn/codex-hermes)](https://github.com/klipbn/codex-hermes/releases/latest)
[![CI](https://github.com/klipbn/codex-hermes/actions/workflows/ci.yml/badge.svg)](https://github.com/klipbn/codex-hermes/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-22.13%2B-339933)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/python-3.9%2B-3776AB)](https://www.python.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Watch Codex CLI sessions and get useful updates in Telegram through Hermes.**
Read-only daemon discovery, optional hooks, session history, and honest test availability.

## Preview

![Example Codex CLI notification](docs/notification-preview.png)

*Simulated dark-theme Telegram Desktop screenshot with fictional chats and actual notification renderer output. Client presentation may vary.*

## What it does

A standalone Node worker reads terminal-origin threads from the local Codex daemon. Optional hooks add test observations. The Hermes control plugin reads the resulting state. Hermes provides the Telegram gateway and the `hermes send` CLI.
The control plugin itself never calls an LLM.

```text
Codex CLI → watcher → local state ← Hermes control ← slash commands
                    └→ Telegram notifications
```

| Component | Version | Source |
|---|---|---|
| `codex-watch` | 1.3.1 | [watcher/](watcher/) |
| `codex-control` | 1.3.0 | [codex-control/](codex-control/) |

**Repository release: [v1.0.1](https://github.com/klipbn/codex-hermes/releases/tag/v1.0.1).** The watcher and control plugin have independent versions and release histories.

See [CHANGELOG.md](CHANGELOG.md) for repository releases and component changelogs for runtime changes.

## Releases

Download the tested watcher and control source ZIPs from
[GitHub Releases](https://github.com/klipbn/codex-hermes/releases/latest).
Every release includes `SHA256SUMS`; verify downloaded archives with `shasum -a 256 -c SHA256SUMS`
or `sha256sum -c SHA256SUMS`. Each component archive includes its source, version metadata,
changelog, README, and MIT LICENSE. GitHub also provides the tagged repository source archive.

## Quick start

Requires Codex CLI, [Hermes Agent](https://github.com/NousResearch/hermes-agent),
Node **22.13+**, and Python **3.9+**. The local worker/plugin setup supports macOS and Linux.

```sh
git clone https://github.com/klipbn/codex-hermes.git
cd codex-hermes
mkdir -p "$HOME/.local/share/codex-hermes" "$HOME/.hermes/plugins"
cp watcher/codex-watch.ts watcher/codex-daemon.ts watcher/package.json "$HOME/.local/share/codex-hermes/"
cp -R codex-control "$HOME/.hermes/plugins/"
hermes plugins enable codex-control
node --experimental-strip-types "$HOME/.local/share/codex-hermes/codex-watch.ts" run
```

The worker observes sessions with **Telegram delivery off by default**. To enable delivery,
run it with `CODEX_HERMES_SEND=1`. One worker owns each state root; Ctrl+C stops it.
In Hermes, use `/cxhelp`, `/cxstatus`, and `/cx`. Ordinary daemon sessions need no special profile.

Use `$HERMES_HOME/plugins/` instead of `~/.hermes/plugins/` when Hermes has a custom home.
If an existing gateway has not loaded the commands, restart that gateway after its active work completes.
Full instructions: [installation](docs/installation.md).

## Commands

| Need | Command |
|---|---|
| Current sessions | `/cx` |
| Last turn summary | `/cxsum [target]` |
| Recorded tests | `/cxtests [target]` |
| Activity statistics | `/cxstats [days]` |
| Pause notifications | `/cxmute [minutes\|off\|levels]` |
| Health and setup | `/cxstatus` |

`target` is a current list number or a session ID. Numbers can change when the list changes;
use a session ID for a durable reference. [Full command reference](codex-control/README.md).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_HERMES_BASE_DIR` | `~/.cache/codex-hermes` | Shared watcher/control state root |
| `CODEX_HERMES_NOTIFY` | `done,permission,reminder,error` | Notification levels |
| `CODEX_HERMES_SEND` | `0` | Only `1` enables Telegram delivery |
| `CODEX_HERMES_DISCOVERY` | `1` | `0` disables daemon discovery |

Keep the OpenCode and Codex state roots separate. Notification labels, help, diagnostics,
and the OpenCode AI-summary prompt are English. User-provided titles, agent replies,
and external errors are preserved in their original language.

See [installation](docs/installation.md) for all settings and
[the data contract](docs/data-contract.md) for ownership, retention, and compatibility.

## What is sent

The notification includes the session title and project, turn outcome, and the available
summary and observations. OpenCode can include SDK session diffs, recognized tests, tools,
and recorded token/cost values. Codex includes the original final response and available
test/model/timing observations; unavailable diff, cost, or token values remain unavailable.

Completed/error turns try rich HTML sections. If credentials are missing, the request
times out, or the configured Bot API does not support `sendRichMessage`, delivery falls
back to `hermes send` with expandable blockquotes. Permission and reminder notifications
are concise. Footers use English dates and Moscow time. [Examples](docs/notifications.md).

## Limits and privacy

- Daemon discovery is read-only: no start, resume, interrupt, subscriptions, or approval decisions.
- Thread source/originator filtering does not prove that a terminal window is currently open. `UNLOADED` and `STALE` are observations, not proof of closure.
- Hooks observe recognized shell test commands; daemon-only summaries can have no test journal. Missing data is not reported as zero.
- The first daemon snapshot imports history without notifying. Delivery retries are bounded; a crash after sending can still cause a duplicate.
- State and Telegram messages can contain task titles, answers, file paths, and test commands. Choose the recipient accordingly.
- Tokens and private configuration stay outside the repository and are not recorded in state or logs by these components.

## Development

```sh
npm ci --prefix watcher --ignore-scripts
npm --prefix watcher run typecheck
npm --prefix watcher test
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/package.py watcher
python3 scripts/package.py control
```

The watcher runs TypeScript directly; npm packages are development dependencies.
Python uses the standard library. Tests use temporary state and fake SDK/delivery boundaries.
Builds place MIT-licensed source ZIPs in ignored `dist/`; no installation or publication occurs.

[Contributing](CONTRIBUTING.md) · [Release process](docs/releasing.md)

## License

[MIT](LICENSE)
