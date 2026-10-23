"""Contract: the plugin reads real watcher fixtures without network access or Hermes."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((ROOT / 'codex-control/__init__.py').exists(), 'The codex-control plugin is required')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        spec = importlib.util.spec_from_file_location('codex_control', ROOT / 'codex-control/__init__.py')
        self.plugin = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.plugin)
        self.plugin.BASE_DIR = self.base

    def events(self, *events):
        env = dict(os.environ, CODEX_HERMES_BASE_DIR=str(self.base), CODEX_HERMES_SEND='0')
        for event in events:
            event = dict(session_id='session-one', cwd='/work/demo', model='test-model', **event)
            subprocess.run(['node', '--experimental-strip-types', str(ROOT / 'watcher/codex-watch.ts'), 'hook'],
                           input=json.dumps(event), text=True, env=env, check=True, capture_output=True)
        subprocess.run(['node', '--experimental-strip-types', str(ROOT / 'watcher/codex-watch.ts'), 'once'],
                       env=env, check=True, capture_output=True)

    def command(self, name, args=''):
        return next(c['handler'] for c in self.plugin.COMMANDS if c['name'] == name)(args)

    def test_english_help_and_state_errors(self):
        help_text = self.command('cxhelp')
        self.assertIn('/cx [number|session_id|all] — Codex sessions', help_text)
        self.assertIn('No Codex sessions yet.', self.command('cxsum'))
        self.assertIn('Usage: /cxstats [days: 1–365]', self.command('cxstats', '0'))
        self.assertIn('Usage: /cxfind <title, project, or summary text>', self.command('cxfind'))
        self.assertIn('Codex watcher has not started yet, or its heartbeat is corrupt.', self.command('cxstatus'))
        self.assertIn('Unable to read Codex data.', self.plugin.safe_handler(lambda _: 1 / 0)(''))
        folder = self.base / 'sessions'
        folder.mkdir()
        (folder / 'bad.json').write_text('{bad')
        self.assertIn('Skipped corrupt or incompatible state files: 1.', self.command('cx'))

    def test_watcher_contract_summary_metrics_and_tests(self):
        self.events({'hook_event_name': 'UserPromptSubmit', 'turn_id': 'one', 'prompt': '\u0418\u0441\u043f\u0440\u0430\u0432\u044c \u0431\u0430\u0433'},
                    {'hook_event_name': 'PreToolUse', 'turn_id': 'one', 'tool_name': 'Bash',
                     'tool_use_id': 'test1', 'tool_input': {'command': 'npm test'}},
                    {'hook_event_name': 'PostToolUse', 'turn_id': 'one', 'tool_name': 'Bash',
                     'tool_use_id': 'test1', 'tool_input': {'command': 'npm test'}, 'tool_response': {'exit_code': 1}},
                    {'hook_event_name': 'Stop', 'turn_id': 'one', 'last_assistant_message': '\u041f\u0440\u043e\u0432\u0435\u0440\u0438\u043b \u0431\u0430\u0433'})
        self.assertIn('\u0418\u0441\u043f\u0440\u0430\u0432\u044c \u0431\u0430\u0433', self.command('cx'))
        self.assertIn('\u041f\u0440\u043e\u0432\u0435\u0440\u0438\u043b \u0431\u0430\u0433', self.command('cxsum', 'session-one'))
        self.assertIn('npm test', self.command('cxtests'))
        self.assertIn('exit=1', self.command('cxtests'))
        self.assertIn('unavailable', self.command('cxdiff').lower())
        stats = self.command('cxstats')
        self.assertIn('Turns: 1', stats)
        self.assertIn('unavailable', stats)
        self.assertNotIn('$0', stats)

    def test_mute_is_the_only_control_write_and_invalid_args_do_not_modify(self):
        self.command('cxmute', '60')
        control = json.loads((self.base / 'control.json').read_text())
        self.assertIn('muteUntil', control)
        before = (self.base / 'control.json').read_bytes()
        self.command('cxmute', 'abracadabra')
        self.assertEqual(before, (self.base / 'control.json').read_bytes())
        self.command('cxmute', 'off')
        self.assertIsNone(json.loads((self.base / 'control.json').read_text())['muteUntil'])
        self.assertEqual(0o600, (self.base / 'control.json').stat().st_mode & 0o777)

    def test_registry_has_no_opencode_command_collisions(self):
        registered = {}
        class Context:
            def register_command(self, name, **kwargs):
                registered[name] = kwargs
        self.plugin.register(Context())
        self.assertTrue({'cx', 'cxsum', 'cxtests', 'cxdiff', 'cxstats', 'cxmute', 'cxhelp', 'cxstatus'} <= registered.keys())
        self.assertTrue(all(x.startswith('cx') for x in registered))
        for c in registered.values():
            self.assertIsInstance(c['handler'](''), str)

    def test_local_discovery_health_distinguishes_empty_unavailable_and_old_watchers(self):
        from datetime import datetime, timezone
        health = {'version': '1.4.0', 'heartbeatAt': datetime.now(timezone.utc).isoformat(),
                  'daemon': {'connected': True, 'sessions': 0}}
        path = self.base / 'watcher.json'
        path.write_text(json.dumps(health))
        self.assertIn('Local CLI: capability unavailable', self.command('cxstatus'))
        health['local'] = {'available': True, 'sessions': 1}
        path.write_text(json.dumps(health))
        self.assertIn('Local CLI: available, additional sessions: 1', self.command('cxstatus'))
        health['local'] = {'available': False, 'error': 'Session index unavailable.'}
        path.write_text(json.dumps(health))
        self.assertIn('Local CLI: unavailable', self.command('cxstatus'))
        self.assertNotIn('additional sessions: 0', self.command('cxstatus'))
        health['local'] = {'available': True, 'sessions': 1}
        health['heartbeatAt'] = '2020-01-01T00:00:00Z'
        path.write_text(json.dumps(health))
        self.assertIn('Local CLI: no recent confirmed scan', self.command('cxstatus'))

    def test_corrupt_and_unknown_schema_states_are_skipped_with_warning(self):
        folder = self.base / 'sessions'
        folder.mkdir()
        (folder / 'bad.json').write_text('{bad')
        (folder / 'future.json').write_text(json.dumps({'schemaVersion': 999}))
        self.assertIn('corrupt', self.command('cx').lower())

    def test_same_pid_sessions_are_distinct_and_stale_is_not_live(self):
        folder = self.base / 'sessions'
        folder.mkdir()
        for i in (1, 2):
            (folder / f'{i}.json').write_text(json.dumps({'schemaVersion': 1, 'source': 'codex',
                'sessionID': f'session-{i}', 'title': f'\u0417\u0430\u0434\u0430\u0447\u0430 {i}', 'status': 'busy',
                'pid': 1, 'updatedAt': '2020-01-01T00:00:00Z', 'turns': []}))
        result = self.command('cx', 'all')
        self.assertIn('\u0417\u0430\u0434\u0430\u0447\u0430 1', result)
        self.assertIn('\u0417\u0430\u0434\u0430\u0447\u0430 2', result)
        self.assertIn('STALE', result)

    def test_daemon_summary_does_not_claim_zero_tests_and_unloaded_is_not_active(self):
        folder = self.base / 'sessions'
        folder.mkdir()
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()
        (folder / 's.json').write_text(json.dumps({'schemaVersion': 1, 'source': 'codex',
            'sessionID': 's', 'title': '\u0417\u0430\u0434\u0430\u0447\u0430 \u0438\u0437 daemon', 'status': 'idle', 'updatedAt': now,
            'turns': [{'id': 't', 'finishedAt': now, 'testsAvailable': False, 'testCounts': None,
                       'tests': [], 'outcome': 'done', 'summary': '\u0413\u043e\u0442\u043e\u0432\u043e'}]}))
        self.assertIn('unavailable', self.command('cxtests'))
        self.assertIn('Incomplete', self.command('cxstats'))
        state = json.loads((folder / 's.json').read_text()); state['status'] = 'unloaded'
        (folder / 's.json').write_text(json.dumps(state))
        self.assertNotIn('\u0417\u0430\u0434\u0430\u0447\u0430 \u0438\u0437 daemon', self.command('cx'))
        self.assertIn('UNLOADED', self.command('cx', 'all'))

    def test_compact_list_numbers_resolve_to_same_session_after_heartbeat(self):
        from datetime import datetime, timezone, timedelta
        folder = self.base / 'sessions'; folder.mkdir()
        now = datetime.now(timezone.utc)
        for sid, closed in [('session-a', False), ('session-b', False), ('session-c', True)]:
            (folder / f'{sid}.json').write_text(json.dumps({'schemaVersion': 1, 'source': 'codex',
                'sessionID': sid, 'title': '\u0417\u0430\u0434\u0430\u0447\u0430 ' + sid, 'project': '\u0434\u043b\u0438\u043d\u043d\u044b\u0439-\u043f\u0440\u043e\u0435\u043a\u0442-' * 10,
                'status': 'closed' if closed else 'busy', 'model': 'gpt-6-astra',
                'updatedAt': now.isoformat(), 'active': {'startedAt': (now-timedelta(minutes=20)).isoformat()},
                'turns': [{'summary': '\u0418\u0442\u043e\u0433 '+sid}]}))
        result = self.command('cx')
        self.assertIn('Codex · now · sessions: 2', result)
        self.assertIn('🟡 1 · BUSY', result)
        self.assertIn('20m · 🤖 gpt-6-astra', result)
        self.assertIn('Details: /cx <number>', result)
        self.assertLess(max(map(len, result.splitlines())), 150)
        self.assertEqual(self.plugin.target('1')[0]['sessionID'], 'session-a')
        self.assertIn('\u0418\u0442\u043e\u0433 session-a', self.command('cxsum', '1'))
        p=folder/'session-a.json'; state=json.loads(p.read_text())
        state['updatedAt']=(now+timedelta(minutes=1)).isoformat();p.write_text(json.dumps(state))
        self.assertEqual(self.plugin.target('2')[0]['sessionID'], 'session-b')
        self.assertIn('#3', self.command('cx', '3'))
        self.assertIn('session-c', self.command('cx', 'all'))

    def test_idle_age_uses_turn_completion_not_fresh_poll_and_unknown_model_is_explicit(self):
        from datetime import datetime, timezone, timedelta
        folder = self.base / 'sessions';folder.mkdir()
        now=datetime.now(timezone.utc)
        (folder/'s.json').write_text(json.dumps({'schemaVersion': 1, 'source': 'codex',
            'sessionID': 's', 'status': 'idle', 'project': 'hermes', 'updatedAt': now.isoformat(),
            'turns': [{'finishedAt': (now-timedelta(minutes=7)).isoformat()}]}))
        result=self.command('cx')
        self.assertIn('🟢 1 · IDLE',result)
        self.assertIn('7m ago',result)
        self.assertNotIn('0s',result)
        self.assertIn('🤖 —',result)


    def test_session_details_match_the_opencode_layout(self):
        from datetime import datetime, timezone, timedelta
        folder = self.base / 'sessions'; folder.mkdir()
        now = datetime.now(timezone.utc)
        (folder / 's.json').write_text(json.dumps({'schemaVersion': 1, 'source': 'codex',
            'sessionID': 'session-x', 'title': '[TRG-1] - \u0417\u0430\u0434\u0430\u0447\u0430', 'project': 'demo-project',
            'directory': str(Path.home() / 'work/demo-project'), 'status': 'idle', 'model': 'gpt-6-luna',
            'updatedAt': now.isoformat(),
            'turns': [{'finishedAt': (now - timedelta(minutes=5)).isoformat(), 'outcome': 'done',
                       'durationMs': 1968000, 'summary': 'Line one\n\nLine two', 'testsAvailable': False}]}))
        result = self.command('cx', '1')
        lines = result.splitlines()
        self.assertEqual(lines[0], '🟢 Codex · IDLE')
        self.assertIn('📝 [TRG-1] - \u0417\u0430\u0434\u0430\u0447\u0430', lines)
        self.assertIn('📁 demo-project', lines)
        self.assertIn('📂 ~/work/demo-project', lines)
        self.assertIn('⏱️ 5m ago', lines)
        self.assertIn('🆔 session-x', lines)
        self.assertIn('🤖 Model gpt-6-luna', lines)
        self.assertTrue(result.endswith('🧠 Last summary\nLine one\n\nLine two\n\n📦 Session diff\nUnavailable'
                                        '\n\n🧪 Tests\nUnavailable'), result)
        for removed in ('Cost', 'Updated:', 'Outcome:'):
            self.assertNotIn(removed, result)
        state = json.loads((folder / 's.json').read_text())
        state['turns'][0].update(testsAvailable=True, tests=[{'status': 'failed', 'command': 'npm test'}])
        (folder / 's.json').write_text(json.dumps(state))
        self.assertTrue(self.command('cx', '1').endswith('🧪 Tests\n❌ npm test'))
        state['turns'][0]['tests'] = []
        (folder / 's.json').write_text(json.dumps(state))
        self.assertTrue(self.command('cx', '1').endswith('🧪 Tests\nTests not run'))


if __name__ == '__main__':
    unittest.main()
