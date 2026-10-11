# codex-watch 1.3.1

Codex CLI session observations and Telegram notifications through Hermes.
Requires Node 22.13+. This source package includes an MIT LICENSE and has no runtime npm dependencies.
The Hermes command plugin `codex-control` is installed separately.

## Run

Keep `codex-watch.ts` and `codex-daemon.ts` beside each other:

```sh
node --experimental-strip-types codex-watch.ts run
```

Telegram delivery is off by default. `CODEX_HERMES_SEND=1` enables it.
Use one worker per `CODEX_HERMES_BASE_DIR` (default `~/.cache/codex-hermes`). Ctrl+C stops it.
The daemon is only read: there are no start/resume/interrupt/approval calls or subscriptions.
Initial history is not sent. Generated text is English; original session content stays unchanged.
Ordinary CLI and CLI code-mode sessions are discovered without hooks.

## Optional hooks

```sh
node --experimental-strip-types codex-watch.ts profile
node --experimental-strip-types codex-watch.ts hooks
```

Generate definitions after installing the files at their permanent location: paths are absolute.
Trust new hooks through the Codex `/hooks` interface. Do not replace existing configurations
automatically. Hooks capture observations, do not use the network, and do not decide permissions.

`hook` stores one input event; `once` drains events without daemon discovery;
`run` observes daemon threads, drains events, and handles delivery.

## Development

The full repository includes tests, a TypeScript configuration, and a locked development dependency set.
From `watcher/`: `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`.
Install-only ZIPs omit that test harness. [Changelog](CHANGELOG.md).
