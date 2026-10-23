"""Hermes Codex CLI monitoring. Only codex-watch writes state; this plugin writes control.json."""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
from datetime import datetime, timezone, timedelta

PLUGIN_VERSION = '1.4.0'
BASE_DIR = Path(os.environ.get('CODEX_HERMES_BASE_DIR', Path.home() / '.cache/codex-hermes'))
LEVELS = ('done', 'permission', 'reminder', 'error')
LIMIT = 2 * 1024 * 1024
ICONS = {'BUSY': '🟡', 'WAITING': '🔐', 'IDLE': '🟢', 'ERROR': '🔴', 'INTERRUPTED': '🟠'}


def number_env(name, default):
    try:
        value = int(os.environ.get(name, default))
        return value if value > 0 else default
    except (TypeError, ValueError):
        return default


def parse_date(value):
    try:
        date = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return date.replace(tzinfo=date.tzinfo or timezone.utc)
    except (ValueError, TypeError):
        return datetime.min.replace(tzinfo=timezone.utc)


def read_json(path):
    try:
        if path.stat().st_size > LIMIT:
            return None
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def states():
    result, invalid = [], 0
    for path in (BASE_DIR / 'sessions').glob('*.json'):
        value = read_json(path)
        if not value or value.get('schemaVersion') != 1 or value.get('source') != 'codex' or not isinstance(value.get('sessionID'), str) or not isinstance(value.get('turns'), list):
            invalid += 1
            continue
        result.append(value)
    result.sort(key=lambda s: (parse_date(s.get('updatedAt')), s['sessionID']), reverse=True)
    return result, f'\n⚠ Skipped corrupt or incompatible state files: {invalid}.' if invalid else ''


def status(s):
    value = s.get('status', 'unknown')
    if value in ('closed', 'unloaded'):
        return value.upper()
    age = (datetime.now(timezone.utc) - parse_date(s.get('updatedAt'))).total_seconds()
    if age > number_env('CX_CONTROL_STALE_AFTER_MINUTES', 45) * 60:
        return 'STALE (no recent events)'
    return {'busy': 'BUSY', 'waiting': 'WAITING', 'idle': 'IDLE',
            'interrupted': 'INTERRUPTED', 'error': 'ERROR'}.get(value, 'UNKNOWN')


def heading(s):
    return f"{s.get('title') or s.get('project') or 'Codex'}\n{status(s)} · {s.get('project') or 'unknown project'}\n{s['sessionID']}"


def visible_rows(rows):
    # Heartbeat updates do not change row numbers; opening or closing sessions refreshes the list.
    return sorted((s for s in rows if s.get('status') not in ('closed', 'unloaded')),
                  key=lambda s: s['sessionID'])


def short(value, limit):
    value = ' '.join(str(value).split())
    return value if len(value) <= limit else value[:limit - 1] + '…'


def human_duration(seconds):
    seconds = max(0, int(seconds))
    return f'{seconds}s' if seconds < 60 else f'{seconds // 60}m' if seconds < 3600 else f'{seconds // 3600}h {seconds % 3600 // 60}m'


def session_age(s):
    state = s.get('status')
    if state == 'waiting':
        at = s.get('waitingSince')
    elif state == 'busy':
        at = (s.get('active') or {}).get('startedAt')
    else:
        at = (s['turns'][-1] if s['turns'] else {}).get('finishedAt') or s.get('lastActivityAt')
    date = parse_date(at)
    if date == datetime.min.replace(tzinfo=timezone.utc):
        return '?'
    age = human_duration((datetime.now(timezone.utc) - date).total_seconds())
    return age if state in ('busy', 'waiting') else age + ' ago'


def compact_row(s, number):
    label = status(s).split()[0]
    icon = ICONS.get(label, '⚪')
    project = short(s.get('project') or 'unknown project', 36)
    model = short(s.get('model') or (s.get('active') or {}).get('model') or '—', 28)
    title = short(s.get('title') or s.get('project') or 'Codex', 82)
    return f'{icon} {number} · {label} · {project} · {session_age(s)} · 🤖 {model}\n   {title}'


def target(raw):
    rows, warning = states()
    value = raw.strip()
    if not rows:
        return None, 'No Codex sessions yet.' + warning
    if not value:
        return rows[0], warning
    if value.isdecimal():
        visible = visible_rows(rows)[:number_env('CX_CONTROL_MAX_LIST_ROWS', 15)]
        index = int(value) - 1
        if 0 <= index < len(visible):
            return visible[index], warning
        return None, f'Session #{value} is not in the current /cx list. Refresh the list.' + warning
    exact = [s for s in rows if s['sessionID'] == value]
    matches = exact or [s for s in rows if s['sessionID'].startswith(value)]
    if len(matches) == 1:
        return matches[0], warning
    return None, ('Ambiguous prefix: provide more session_id characters.' if matches else 'Session not found.') + warning


def latest(s):
    return s.get('active') or (s['turns'][-1] if s['turns'] else {})


def test_counts(turn):
    if turn.get('testsAvailable') is False:
        return 'unavailable: Codex summaries do not include a complete test log'
    counts = turn.get('testCounts') or {}
    suffix = ' · incomplete tracking' if turn.get('testsTruncated') else ''
    return f"✅ {counts.get('passed', 0)} · ❌ {counts.get('failed', 0)} · ❔ {counts.get('unknown', 0)}{suffix}"


def home_path(path):
    home = str(Path.home())
    return '~' + path[len(home):] if path == home or path.startswith(home + os.sep) else path


def session_detail(s):
    label = status(s)
    turn = s['turns'][-1] if s['turns'] else {}
    model = s.get('model') or (s.get('active') or {}).get('model') or turn.get('model') or 'unavailable'
    lines = [f"{ICONS.get(label.split()[0], '⚪')} Codex · {label}", '',
             f"📝 {s.get('title') or s.get('project') or 'Untitled session'}",
             f"📁 {s.get('project') or 'unknown project'}"]
    if s.get('directory'):
        lines.append(f"📂 {home_path(s['directory'])}")
    lines += [f'⏱️ {session_age(s)}', f"🆔 {s['sessionID']}", f'🤖 Model {model}']
    if turn:
        duration = turn.get('durationMs')
        duration = human_duration(duration / 1000) if isinstance(duration, (int, float)) else 'duration unavailable'
        lines.append(f"🏁 Last turn: {turn.get('outcome', 'unavailable')} · {duration}")
    summary = turn.get('summary') or 'No completed turns yet.'
    # Leave room for the header within the Telegram reply limit.
    summary = summary if len(summary) <= 3000 else summary[:2999] + '…'
    return '\n'.join(lines) + '\n\n🧠 Last summary\n' + summary


def handle_cx(raw=''):
    if raw.strip() and raw.strip() != 'all':
        s, warning = target(raw)
        if not s:
            return warning
        return session_detail(s) + warning
    rows, warning = states()
    history = raw.strip() == 'all'
    if not history:
        rows = visible_rows(rows)
    limit = number_env('CX_CONTROL_MAX_LIST_ROWS', 15)
    shown = rows[:limit]
    output = f"Codex · {'history' if history else 'now'} · sessions: {len(rows)}\n\n"
    output += ('\n\n'.join(heading(s) if history else compact_row(s, n)
                           for n, s in enumerate(shown, 1))
               or 'No monitored sessions. Check the daemon connection: /cxstatus.')
    if len(rows) > limit:
        output += f'\n… more: {len(rows) - limit}. Use /cxfind <text>.'
    footer = 'Details: /cx <session_id>' if history else 'Details: /cx <number>'
    return output + '\n\n' + footer + '\nHistory: /cx all · closed: /cxclosed' + warning


def handle_sum(raw=''):
    s, warning = target(raw)
    if not s:
        return warning
    # Always show the last completed turn, even while a new turn is running.
    turn = s['turns'][-1] if s['turns'] else {}
    duration = turn.get('durationMs')
    duration = f'{round(duration / 1000)} s' if isinstance(duration, (int, float)) else 'unavailable'
    return (f"📝 {s.get('title') or s.get('project') or 'Codex'}\n"
            f"{turn.get('summary') or 'No completed turns yet.'}\n"
            f"Outcome: {turn.get('outcome', 'unavailable')} · ⏱ {duration}\n"
            f"Tests: {test_counts(turn)}\nModel: {turn.get('model') or 'unavailable'}\n"
            'Cost / tokens / full diff: unavailable in hooks.' + warning)


def handle_tests(raw=''):
    s, warning = target(raw)
    if not s:
        return warning
    turn = latest(s)
    if turn.get('testsAvailable') is False:
        return '🧪 Tests: ' + test_counts(turn) + '. Use codex-hermes profile hooks for detailed tracking.' + warning
    tests = list(turn.get('tests') or []) + list((turn.get('pendingTests') or {}).values())
    result = f"🧪 {s.get('title') or s.get('project') or 'Codex'}\n{test_counts(turn)}\n"
    for t in tests[-10:]:
        code = t.get('exitCode')
        result += f"\n{t.get('status', 'unknown')} · exit={code if code is not None else '?'}\n{t.get('command', '')}\n"
    if not tests:
        result += '\nNo recognized test runs.'
    return result + '\nShowing the latest 10; counts cover observed runs in this turn. Without an exit code, the result is unknown.' + warning


def handle_diff(raw=''):
    s, warning = target(raw)
    if not s:
        return warning
    return '📦 Full diff: unavailable. Official Codex hooks do not provide session diffs; repository git status is not substituted.' + warning


def stats_text(rows, days):
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    turns = [t for s in rows for t in s['turns'] if isinstance(t, dict) and parse_date(t.get('finishedAt')) >= cutoff]
    counts = {k: sum(int((t.get('testCounts') or {}).get(k, 0)) for t in turns) for k in ('passed', 'failed', 'unknown')}
    seconds = sum(max(0, t.get('durationMs') or 0) for t in turns) / 1000
    interrupted = sum(t.get('outcome') != 'done' for t in turns)
    missing_tests = sum(t.get('testsAvailable') is False for t in turns)
    return (f'Turns: {len(turns)} · interrupted: {interrupted}\nTurn duration: {round(seconds)} s\n'
            f"Tests: ✅ {counts['passed']} · ❌ {counts['failed']} · ❔ {counts['unknown']}\n"
            f'Incomplete test tracking: {missing_tests} turns have no test log.\n'
            'Cost / tokens / diff: unavailable.\n'
            'Saved history only: up to 30 turns per session, retained for 7 days by default. '
            'Test tracking covers recognized Bash commands; this is not a complete CI report.')


def handle_stats(raw=''):
    if raw.strip() and (not raw.strip().isdigit() or not 1 <= int(raw.strip()) <= 365):
        return 'Usage: /cxstats [days: 1–365]'
    days = int(raw.strip() or 7)
    rows, warning = states()
    return f'📊 Codex · {days} days\n' + stats_text(rows, days) + warning


def handle_find(raw=''):
    query = raw.strip().casefold()
    if not query:
        return 'Usage: /cxfind <title, project, or summary text>'
    rows, warning = states()
    matches = [s for s in rows if query in ' '.join(str(s.get(k, '')) for k in ('title', 'project', 'lastSummary', 'sessionID')).casefold()]
    return ('\n\n'.join(heading(s) for s in matches[:15]) or 'Nothing found.') + warning


def handle_wait(raw=''):
    rows, warning = states()
    return ('\n\n'.join(heading(s) for s in rows if status(s).split()[0] in ('WAITING', 'ERROR', 'INTERRUPTED', 'STALE', 'UNKNOWN')) or 'No sessions need attention.') + warning


def handle_closed(raw=''):
    rows, warning = states()
    return ('\n\n'.join(heading(s) for s in rows if s.get('status') in ('closed', 'unloaded')) or 'No closed sessions.') + warning


def handle_last(raw=''):
    rows, warning = states()
    rows = [s for s in rows if s['turns']]
    if not rows:
        return 'No completed turns yet.' + warning
    row = max(rows, key=lambda s: parse_date(s['turns'][-1].get('finishedAt')))
    return handle_sum(row['sessionID'])


def handle_project(raw=''):
    rows, warning = states()
    query = raw.strip().casefold()
    projects = sorted({s.get('project') or 'unknown' for s in rows})
    return '\n\n'.join(f'📁 {name}\n' + stats_text([s for s in rows if (s.get('project') or 'unknown') == name], 7)
                       for name in projects if not query or query in name.casefold()) + warning or 'No projects yet.'


def handle_mute(raw=''):
    value = raw.strip().lower()
    current = read_json(BASE_DIR / 'control.json') or {}
    if not value:
        return f"Muted until: {current.get('muteUntil') or 'off'}\nDisabled: {', '.join(current.get('disabledLevels') or []) or 'none'}\n/cxmute [minutes|off|done permission reminder error]"
    if value == 'off':
        updated = {'muteUntil': None, 'disabledLevels': []}
    elif value.isdigit() and 1 <= int(value) <= 10080:
        updated = dict(current, muteUntil=(datetime.now(timezone.utc) + timedelta(minutes=int(value))).isoformat())
    else:
        levels = value.replace(',', ' ').split()
        if not levels or any(level not in LEVELS for level in levels):
            return 'Specify 1–10080 minutes, off, or levels: ' + ', '.join(LEVELS)
        updated = dict(current, disabledLevels=sorted(set(levels)))
    BASE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    BASE_DIR.chmod(0o700)
    fd, path = tempfile.mkstemp(prefix='.control-', dir=BASE_DIR)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(updated, stream)
        os.replace(path, BASE_DIR / 'control.json')
    finally:
        if os.path.exists(path):
            os.unlink(path)
    return 'Codex notification settings saved. The watcher applies them on its next cycle; /cxstatus shows acknowledgement.'


def handle_status(raw=''):
    health = read_json(BASE_DIR / 'watcher.json')
    if not health:
        return 'Codex watcher has not started yet, or its heartbeat is corrupt.'
    age = (datetime.now(timezone.utc) - parse_date(health.get('heartbeatAt'))).total_seconds()
    fresh = age < 90
    control = read_json(BASE_DIR / 'control.json') or {}
    acknowledged = health.get('muteUntil') == control.get('muteUntil') and health.get('disabledLevels', []) == control.get('disabledLevels', [])
    daemon = health.get('daemon') or {}
    daemon_line = f"Daemon: connected, terminal sessions: {daemon.get('sessions', 0)}" if daemon.get('connected') and fresh else 'Daemon: no recent confirmed connection'
    local = health.get('local')
    if not isinstance(local, dict) or 'available' not in local:
        local_line = 'Local CLI: capability unavailable; update the watcher to monitor embedded sessions.'
    elif not fresh:
        local_line = 'Local CLI: no recent confirmed scan'
    elif local.get('available'):
        local_line = f"Local CLI: available, additional sessions: {local.get('sessions', '?')}"
    else:
        local_line = 'Local CLI: unavailable. ' + str(local.get('error') or 'Check ps, lsof, and Codex session files.')
    return (f"Codex watcher {health.get('version', '?')} · {'running' if fresh else 'STALE'}\n"
            f"Telegram: {'enabled' if health.get('sendEnabled') else 'disabled'}\n"
            f"{daemon_line}\n{local_line}\n"
            f"Mute: {'applied' if acknowledged and fresh else 'awaiting watcher acknowledgement'}\n"
            f"Delivery failures this cycle: {health.get('deliveryFailures', '?')}\n"
            'A fresh watcher heartbeat does not prove session terminals are open.')


def handle_help(raw=''):
    return '\n'.join(f"/{c['name']} {c.get('args_hint', '')} — {c['description']}" for c in COMMANDS)


def safe_handler(handler):
    def wrapped(raw_args=''):
        try:
            result = handler(raw_args)
            return result if len(result) <= 3800 else result[:3700] + '\n… output truncated; refine the session_id or filter.'
        except Exception:
            return 'Unable to read Codex data. Check state, permissions, and /cxstatus.'
    return wrapped


COMMANDS = [
    {'name': 'cx', 'handler': handle_cx, 'description': 'Codex sessions', 'args_hint': '[number|session_id|all]'},
    {'name': 'cxsum', 'handler': handle_sum, 'description': 'Last turn summary', 'args_hint': '[number|session_id]'},
    {'name': 'cxtests', 'handler': handle_tests, 'description': 'Tests from the current or last turn', 'args_hint': '[number|session_id]'},
    {'name': 'cxdiff', 'handler': handle_diff, 'description': 'Full diff availability', 'args_hint': '[number|session_id]'},
    {'name': 'cxstats', 'handler': handle_stats, 'description': 'Saved turn statistics', 'args_hint': '[days]'},
    {'name': 'cxfind', 'handler': handle_find, 'description': 'Find sessions', 'args_hint': '<text>'},
    {'name': 'cxproj', 'handler': handle_project, 'description': '7-day project summary', 'args_hint': '[project]'},
    {'name': 'cxwait', 'handler': handle_wait, 'description': 'Sessions needing attention'},
    {'name': 'cxclosed', 'handler': handle_closed, 'description': 'Closed sessions'},
    {'name': 'cxlast', 'handler': handle_last, 'description': 'Last completed turn'},
    {'name': 'cxmute', 'handler': handle_mute, 'description': 'Notification settings', 'args_hint': '[minutes|off|levels]'},
    {'name': 'cxstatus', 'handler': handle_status, 'description': 'Watcher health and delivery'},
    {'name': 'cxhelp', 'handler': handle_help, 'description': 'All Codex commands'},
]


def register(ctx):
    for command in COMMANDS:
        kwargs = dict(handler=safe_handler(command['handler']), description=command['description'])
        if command.get('args_hint'):
            kwargs['args_hint'] = command['args_hint']
        ctx.register_command(command['name'], **kwargs)
