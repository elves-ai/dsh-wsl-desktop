"""All fixtures are temporary; no WSL or real management/service command is run."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
HELPER = Path(__file__).resolve().parents[1] / 'src-tauri/helpers/check_environment.py'
spec = importlib.util.spec_from_file_location('check_environment', HELPER)
environment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(environment)


class EnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / 'DSH with spaces'
        self.make_project(self.repo)
        self.launcher = self.root / 'launcher.py'
        self.marker = self.root / 'MUST_NOT_EXIST'
        self.launcher.write_text('from pathlib import Path\nPath(' + repr(str(self.marker)) + ').touch()\nraise RuntimeError("TOKEN-SECRET")\n')
        self.node = self.root / 'node'
        self.node.write_text('fake executable; never execute me')
        self.node.chmod(0o700)
        self.config = self.root / 'config.json'
        self.data = {'repository': str(self.repo), 'node': str(self.node),
                     'state_directory': str(self.root / 'not-created-state'), 'port': 3080,
                     'token': 'TOKEN-SECRET', 'other': {'preserve': True}}
        self.write_config()
        self.calls = []
        # Unit tests never connect to a real listening service.
        idle = patch.object(environment, 'port_is_idle', return_value=True)
        self.idle = idle.start()
        self.addCleanup(idle.stop)
        ss = patch.object(environment, 'ss_available', return_value=True)
        ss.start()
        self.addCleanup(ss.stop)

    def make_project(self, repo):
        (repo / 'apps/cli/src').mkdir(parents=True)
        (repo / 'apps/cli/src/bin.ts').write_text('throw new Error("ENTRY-MUST-NOT-RUN")')
        (repo / 'package.json').write_text(json.dumps({'name': environment.PROJECT_NAME,
            'engines': {'node': '^22.19.0 || >=24.0.0'},
            'scripts': {'postinstall': 'touch MUST_NOT_EXIST'}}))
        (repo / 'apps/web/dist/assets').mkdir(parents=True)
        (repo / 'apps/web/dist/index.html').write_text('<script type="module" src="/assets/app.js"></script>')
        (repo / 'apps/web/dist/assets/app.js').write_text('throw new Error("WEB-MUST-NOT-RUN")')

    def write_config(self):
        self.config.write_text(json.dumps(self.data))

    def runner(self, node, args, cwd):
        self.calls.append((node, args, cwd))
        return b'v24.22.0\n' if args == ['--version'] else b'dsh-dependency-ok'

    def inspect(self, runner=None):
        return environment.inspect(str(self.launcher), str(self.config), 3080, runner or self.runner)

    def statuses(self, report):
        return {item['id']: item['status'] for item in report['checks']}

    def test_success_is_read_only_and_does_not_execute_launcher(self):
        before = self.config.read_bytes()
        report = self.inspect()
        self.assertTrue(all(s == 'passed' for s in self.statuses(report).values()))
        self.assertEqual(report['repository'], str(self.repo))
        self.assertFalse(self.marker.exists())
        self.assertFalse((self.root / 'not-created-state').exists())
        self.assertEqual(before, self.config.read_bytes())
        self.assertNotIn('TOKEN-SECRET', json.dumps(report))
        self.assertEqual(self.calls[1][1][:2], ['--input-type=module', '--eval'])
        self.assertIn("import.meta.resolve('tsx/esm')", self.calls[1][1][2])
        self.assertNotIn('import(', self.calls[1][1][2])

    def test_missing_config_only_marks_upstream_error(self):
        self.config.unlink()
        states = self.statuses(self.inspect())
        self.assertEqual(states['launcher'], 'passed')
        self.assertEqual(states['linux_config'], 'error')
        self.assertTrue(all(states[key] == 'skipped' for key in ('repository', 'node', 'dependencies', 'web_assets')))
        self.assertEqual(self.calls, [])

    def test_missing_project_keeps_config_and_current_directory(self):
        self.data['repository'] = str(self.root / 'missing')
        self.write_config()
        report = self.inspect()
        states = self.statuses(report)
        self.assertEqual(report['repository'], self.data['repository'])
        self.assertEqual(states['linux_config'], 'passed')
        self.assertEqual(states['repository'], 'error')
        self.assertEqual(states['node'], 'skipped')
        self.assertEqual(states['web_assets'], 'skipped')

    def test_invalid_project_name_and_entry(self):
        (self.repo / 'package.json').write_text('{"name":"another-project"}')
        self.assertEqual(self.statuses(self.inspect())['repository'], 'error')

    def test_missing_node_skips_dependency_not_independent_web(self):
        self.node.unlink()
        states = self.statuses(self.inspect())
        self.assertEqual(states['node'], 'error')
        self.assertEqual(states['dependencies'], 'skipped')
        self.assertEqual(states['web_assets'], 'passed')
        self.assertEqual(self.calls, [])

    def test_incompatible_node(self):
        states = self.statuses(self.inspect(lambda *_: b'v23.1.0'))
        self.assertEqual(states['node'], 'error')
        self.assertEqual(states['dependencies'], 'skipped')

    def test_missing_dependencies(self):
        def missing(node, args, cwd):
            if args == ['--version']:
                return b'v24.22.0'
            raise RuntimeError('RAW STDERR token=TOKEN-SECRET')
        report = self.inspect(missing)
        self.assertEqual(self.statuses(report)['dependencies'], 'error')
        self.assertEqual(self.statuses(report)['web_assets'], 'passed')
        self.assertNotIn('TOKEN-SECRET', json.dumps(report))
        self.assertNotIn('RAW STDERR', json.dumps(report))

    def test_missing_assets_and_traversal(self):
        index = self.repo / 'apps/web/dist/index.html'
        index.write_text('<script src="/missing.js"></script>')
        self.assertEqual(self.statuses(self.inspect())['web_assets'], 'error')
        index.write_text('<script src="/%2e%2e/%2e%2e/secret.js"></script>')
        self.assertEqual(self.statuses(self.inspect())['web_assets'], 'error')

    def test_large_assets_are_not_read_in_full(self):
        (self.repo / 'apps/web/dist/assets/app.js').write_bytes(b'x' * (environment.MAX_FILE + 1))
        self.assertEqual(self.statuses(self.inspect())['web_assets'], 'passed')

    def test_broken_launcher_does_not_hide_independent_checks(self):
        self.launcher.write_text('def broken(: token=TOKEN-SECRET')
        report = self.inspect()
        states = self.statuses(report)
        self.assertEqual(states['launcher'], 'error')
        self.assertTrue(all(states[k] == 'passed' for k in states if k != 'launcher'))
        self.assertNotIn('TOKEN-SECRET', json.dumps(report))

    def test_port_and_required_config_validation(self):
        for value in (False, 0, 65536, 3081, '3080'):
            self.data['port'] = value
            self.write_config()
            self.assertEqual(self.statuses(self.inspect())['linux_config'], 'error')
        self.data['port'] = 3080
        for key in ('repository', 'node', 'state_directory'):
            old = self.data.pop(key)
            self.write_config()
            self.assertEqual(self.statuses(self.inspect())['linux_config'], 'error')
            self.data[key] = old

    def test_sensitive_and_control_repository_is_not_returned(self):
        for path in ('/tmp/?token=TOKEN-SECRET', '/tmp/secret:abc', '/tmp/a\nb', '/tmp/\u202eabc', 'relative', '/' + 'x' * 4096):
            self.data['repository'] = path
            self.write_config()
            report = self.inspect()
            self.assertIsNone(report['repository'])
            self.assertNotIn('TOKEN-SECRET', json.dumps(report))

    def test_versions_follow_project_range_without_running_packages(self):
        for version, expected in [('22.18.0', False), ('22.19.0', True), ('22.30.0', True),
                                  ('23.9.0', False), ('24.0.0', True), ('26.1.0', True)]:
            self.assertEqual(environment.satisfies(environment.version_tuple(version), '^22.19.0 || >=24.0.0'), expected)
        for requirement in ('^0.0.3', '~24.2', '>= 24.0.0 < 25', '24.x', '22.19.0 - 24.9.0'):
            self.assertIsInstance(environment.satisfies((24, 2, 1), requirement), bool)
        for requirement in ('evil()', None, {}, '>=24 || BAD', '24.0.0-beta'):
            self.assertFalse(environment.satisfies((24, 2, 1), requirement))

    def test_non_json_constants_are_rejected(self):
        self.config.write_text(json.dumps(self.data)[:-1] + ',"invalid":NaN}')
        before = self.config.read_bytes()
        self.assertEqual(self.statuses(self.inspect())['linux_config'], 'error')
        self.assertFalse(environment.save_repository(str(self.config), str(self.repo)))
        self.assertEqual(before, self.config.read_bytes())

    def test_fifo_and_large_files_fail_without_blocking(self):
        self.config.unlink()
        os.mkfifo(self.config)
        self.assertEqual(self.statuses(self.inspect())['linux_config'], 'error')
        self.config.unlink()
        self.config.write_bytes(b'x' * (environment.MAX_FILE + 1))
        self.assertEqual(self.statuses(self.inspect())['linux_config'], 'error')

    def test_node_probe_scrubs_preloads_and_bounds_output(self):
        fake = self.root / 'fake-node'
        # Use a tiny executable fixture, not a management/project script.
        fake.write_text('#!/usr/bin/python3\nimport os,sys\nsys.stdout.write(os.environ.get("NODE_OPTIONS", "unset"))\n')
        fake.chmod(0o700)
        with patch.dict(os.environ, {'NODE_OPTIONS': '--import token=TOKEN-SECRET'}):
            self.assertEqual(environment.run_node(str(fake), [], str(self.repo)), b'unset')
        fake.write_text('#!/usr/bin/python3\nimport sys\nsys.stdout.write("x" * 20000)\n')
        with self.assertRaises(ValueError):
            environment.run_node(str(fake), [], str(self.repo))

    def test_embedded_command_output_is_json_only(self):
        source = HELPER.read_text()
        # Missing project prevents any configured fake Node from running.
        self.data['repository'] = str(self.root / 'missing')
        self.write_config()
        result = subprocess.run(['/usr/bin/python3', '-I', '-c', source, 'inspect',
                                 str(self.launcher), str(self.config), '3080'],
                                capture_output=True, check=True, timeout=5)
        report = json.loads(result.stdout)
        self.assertEqual(self.statuses(report)['repository'], 'error')
        self.assertEqual(result.stderr, b'')
        self.assertNotIn(b'TOKEN-SECRET', result.stdout)
        self.assertFalse(self.marker.exists())

    def test_explicit_save_preserves_fields_and_mode_atomically(self):
        other = self.root / 'another DSH'
        self.make_project(other)
        self.config.chmod(0o640)
        before_inode = self.config.stat().st_ino
        self.assertTrue(environment.save_repository(str(self.config), str(other)))
        after = json.loads(self.config.read_text())
        self.assertEqual(after, {**self.data, 'repository': str(other)})
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o640)
        self.assertNotEqual(before_inode, self.config.stat().st_ino)
        self.assertEqual(list(self.root.glob('.dsh-config-*')), [])
        self.assertFalse(self.marker.exists())

    def test_save_repairs_missing_or_invalid_old_repository(self):
        for bad in (None, 'relative', '/missing'):
            self.data['repository'] = bad
            self.write_config()
            self.assertTrue(environment.save_repository(str(self.config), str(self.repo)))
        del self.data['repository']
        self.write_config()
        self.assertTrue(environment.save_repository(str(self.config), str(self.repo)))

    def test_invalid_save_changes_nothing(self):
        original = self.config.read_bytes()
        for value in ('relative', '/tmp/missing', '/bad\npath', '/?token=TOKEN-SECRET'):
            self.assertFalse(environment.save_repository(str(self.config), value))
            self.assertEqual(original, self.config.read_bytes())
        (self.repo / 'package.json').write_text('{"name":"not-dsh"}')
        self.assertFalse(environment.save_repository(str(self.config), str(self.repo)))
        self.assertEqual(original, self.config.read_bytes())
        self.assertEqual(list(self.root.glob('.dsh-config-*')), [])

    def test_missing_or_symlink_configuration_cannot_be_saved(self):
        original = self.config.read_bytes()
        link = self.root / 'link.json'
        link.symlink_to(self.config)
        self.assertFalse(environment.save_repository(str(link), str(self.repo)))
        self.assertEqual(original, self.config.read_bytes())
        self.assertFalse(environment.save_repository(str(self.root / 'absent.json'), str(self.repo)))

    def test_missing_ss_is_error_but_project_checks_still_run(self):
        with patch.object(environment, 'ss_available', return_value=False):
            states = self.statuses(self.inspect())
        self.assertEqual(states['launcher'], 'error')
        self.assertEqual(states['repository'], 'passed')

    def test_starting_manager_lock_blocks_save_without_writing(self):
        state = Path(self.data['state_directory'])
        state.mkdir()
        lock = state / 'server.lock'
        lock.write_text('never modify this lock')
        before = self.config.read_bytes()
        with lock.open('rb') as manager:
            environment.fcntl.flock(manager.fileno(), environment.fcntl.LOCK_EX | environment.fcntl.LOCK_NB)
            self.assertFalse(environment.save_repository(str(self.config), str(self.repo)))
        self.assertEqual(before, self.config.read_bytes())
        self.assertEqual(lock.read_text(), 'never modify this lock')
        self.assertEqual(list(self.root.glob('.dsh-config-*')), [])

    def test_existing_idle_lock_is_held_until_atomic_replace(self):
        state = Path(self.data['state_directory'])
        state.mkdir()
        lock = state / 'server.lock'
        lock.write_text('unchanged')
        lock.chmod(0o400)
        before = lock.stat()
        original_replace = environment.os.replace
        def replace_while_locked(source, destination):
            with lock.open('rb') as other:
                with self.assertRaises(BlockingIOError):
                    environment.fcntl.flock(other.fileno(), environment.fcntl.LOCK_EX | environment.fcntl.LOCK_NB)
            original_replace(source, destination)
        with patch.object(environment.os, 'replace', side_effect=replace_while_locked):
            self.assertTrue(environment.save_repository(str(self.config), str(self.repo)))
        with lock.open('rb') as other:
            environment.fcntl.flock(other.fileno(), environment.fcntl.LOCK_EX | environment.fcntl.LOCK_NB)
        self.assertEqual(lock.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertEqual(lock.stat().st_mode, before.st_mode)
        self.assertEqual(lock.read_text(), 'unchanged')

    def test_unknown_lock_permissions_or_invalid_state_fail_closed(self):
        original_open = environment.os.open
        def deny_lock(path, *args, **kwargs):
            if str(path).endswith('/server.lock'):
                raise PermissionError('RAW-SENSITIVE')
            return original_open(path, *args, **kwargs)
        before = self.config.read_bytes()
        with patch.object(environment.os, 'open', side_effect=deny_lock):
            self.assertFalse(environment.save_repository(str(self.config), str(self.repo)))
        self.assertEqual(before, self.config.read_bytes())
        self.data.pop('state_directory')
        self.write_config()
        self.assertFalse(environment.save_repository(str(self.config), str(self.repo)))

    def test_absent_server_lock_is_not_created_by_save(self):
        state = Path(self.data['state_directory'])
        self.assertTrue(environment.save_repository(str(self.config), str(self.repo)))
        self.assertFalse(state.exists())

    def test_listener_or_unknown_port_state_blocks_save_without_writing(self):
        before = self.config.read_bytes()
        self.idle.return_value = False
        self.assertFalse(environment.save_repository(str(self.config), str(self.repo)))
        self.assertEqual(before, self.config.read_bytes())
        self.assertEqual(list(self.root.glob('.dsh-config-*')), [])

    def test_listener_appearing_before_replace_blocks_save(self):
        before = self.config.read_bytes()
        self.idle.side_effect = [True, False]
        self.assertFalse(environment.save_repository(str(self.config), str(self.repo)))
        self.assertEqual(before, self.config.read_bytes())
        self.assertEqual(list(self.root.glob('.dsh-config-*')), [])

    def test_invalid_or_missing_port_blocks_save(self):
        for port in (None, False, 0, 65536, '3080'):
            self.data['port'] = port
            self.write_config()
            before = self.config.read_bytes()
            self.assertFalse(environment.save_repository(str(self.config), str(self.repo)))
            self.assertEqual(before, self.config.read_bytes())
        self.data.pop('port')
        self.write_config()
        self.assertFalse(environment.save_repository(str(self.config), str(self.repo)))

    def test_save_mode_does_not_emit_any_other_config_values(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            environment.main(['save', str(self.config), str(self.repo)])
        self.assertEqual(json.loads(output.getvalue()), {'saved': True})
        self.assertNotIn('TOKEN-SECRET', output.getvalue())


class PortGuardTests(unittest.TestCase):
    def test_only_connection_refused_allows_save(self):
        for error, expected in ((ConnectionRefusedError(), True), (TimeoutError(), False),
                                (PermissionError(), False), (OSError(), False)):
            with patch.object(environment.socket, 'create_connection', side_effect=error) as connect:
                self.assertEqual(environment.port_is_idle(3080), expected)
                connect.assert_called_once_with(('127.0.0.1', 3080), timeout=0.25)
        with patch.object(environment.socket, 'create_connection') as connect:
            self.assertFalse(environment.port_is_idle(3080))
            connect.return_value.__exit__.assert_called_once()


if __name__ == '__main__':
    unittest.main()
