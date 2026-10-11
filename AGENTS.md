# codex-hermes: development instructions

Sources: `watcher/` and `codex-control/`. See the installation, state contract, and release
guides in `docs/`. Historical files under `archive/` or `docs/history/` do not replace these instructions.

## Authorization

Local edits and tests are allowed. Commits, pushes, repository creation, messages, deployment,
and restarts require explicit current-chat authorization. Tool availability is not permission.
Only delegate when the user or an applicable skill explicitly requests delegation.
Do not commit credentials, real state, session content, caches, or private configuration.

## Compatibility and invariants

- Daemon discovery is read-only and restricted to the documented RPC allowlist.
- Do not start, resume, interrupt, subscribe to, approve, or restart the shared daemon.
- Hooks have empty stdout, no network/LLM/permission decisions, and never interrupt Codex.
- One worker per root; no session keys based on daemon PID.
- Initial history is silent, hooks/daemon coordinate turns, and unavailable test journals stay unavailable.
- SEND defaults off; queue retries are bounded and do not guarantee exactly-once after a crash.
- Use same-directory atomic writes, restrictive data permissions, and defensive numeric environment parsing.
- Control reads watcher state and owns mute settings. Preserve existing command names and input aliases.
- Missing exit codes are unknown. Unavailable metrics stay unavailable, not zero or repository-wide substitutes.
- HTML escape all dynamic display content; do not escape or translate stored raw data.
- Preserve English generated text, original Unicode user content, and documented rich/fallback behavior.
- Do not claim a successful delivery proves the recipient read it.
- Preserve backward compatibility with at least one previous major version; warn on missing capabilities.

## Style, versions, checks

All maintained comments, documentation, metadata, test names, and generated UI are English.
Keep filenames stable; watcher and control have independent SemVer versions and changelogs.
Watcher version appears in package.json, package-lock.json, and WATCHER_VERSION.
Control version appears in plugin.yaml and PLUGIN_VERSION. Test actual reader/writer behavior.

Watcher runtime uses Node built-ins (and OpenCode plugin types for OpenCode); Python uses stdlib.
Run typecheck, Node/Python tests, syntax checks, and source packaging from README/CONTRIBUTING.
Never use live Telegram delivery or production state in tests. Review the actual staged diff
before publishing, and distinguish local checks, GitHub CI, and deployed-version verification.
