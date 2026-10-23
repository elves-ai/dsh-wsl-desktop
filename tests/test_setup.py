"""Offline first-run deployment tests. No real WSL, manager or service is run."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'src-tauri/helpers' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

setup = load('setup_environment', 'setup_environment.py')
environment = load('setup_checks', 'check_environment.py')


class SetupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='dsh-setup-test-')
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        previous = os.umask(0o077)
        self.addCleanup(os.umask, previous)
        self.repository = self.home / 'Harness source; not a shell'
        (self.repository / 'apps/cli/src').mkdir(parents=True)
        (self.repository / 'apps/cli/src/bin.ts').write_text('// fixture')
        (self.repository / 'package.json').write_text(json.dumps({
            'name':'@deepseek-ai/dsh-root', 'engines':{'node':'>=24.0.0'}}))
        dist = self.repository / 'apps/web/dist'
        dist.mkdir(parents=True)
        (dist / 'index.html').write_text('<script src="/main.js"></script>')
        (dist / 'main.js').write_text('// fixture')
        self.node = self.home / 'node'
        self.node.write_text('not executed')
        self.node.chmod(0o700)
        self.payload = {'action':'install', 'request':{'linux_user':'tester',
            'repository':str(self.repository), 'node':str(self.node), 'port':31999},
            'manager':'VERSION = "1.0.0"\n', 'checks':'not used by patched checker'}
        self.checks = dict(environment.__dict__)
        self.checks['run_node'] = self.runner
        self.checks['ss_available'] = lambda: True
        self.checks['port_is_idle'] = lambda _: True
        self.checks['inspect_values'] = lambda config, port: environment.inspect_values(config, port, self.runner)
        patch = mock.patch.object(setup, 'account', return_value=('tester', self.home))
        patch.start()
        self.addCleanup(patch.stop)
        patch = mock.patch.object(setup, 'checker', return_value=self.checks)
        patch.start()
        self.addCleanup(patch.stop)

    def runner(self, node, args, cwd):
        self.assertEqual(node, str(self.node))
        self.assertEqual(cwd, str(self.repository))
        if args == ['--input-type=module', '--eval', setup.NODE_IDENTITY]:
            return json.dumps({'platform':'linux', 'execPath':str(self.node)}).encode()
        return b'v24.0.0' if args == ['--version'] else b'dsh-dependency-ok'

    def files(self):
        return {str(path.relative_to(self.home)):path.read_bytes()
                for path in self.home.rglob('*') if path.is_file()}

    def test_discovery_is_read_only_and_detects_nvm_numerically(self):
        for version in ('v9.0.0', 'v24.2.0', 'v24.12.0'):
            node = self.home / '.nvm/versions/node' / version / 'bin/node'
            node.parent.mkdir(parents=True)
            node.write_text('never executed')
            node.chmod(0o700)
        before = self.files()
        result = setup.identity()
        self.assertEqual(result['linux_user'], 'tester')
        self.assertTrue(result['node'].endswith('/v24.12.0/bin/node'))
        self.assertEqual(self.files(), before)

    def test_success_and_repeat_are_identical_and_private(self):
        result = setup.install(self.payload)
        self.assertEqual(result['manager_version'], '1.0.0')
        self.assertEqual(Path(result['linux_launcher']).read_text(), self.payload['manager'])
        config = json.loads(Path(result['linux_config']).read_text())
        self.assertEqual(config['repository'], str(self.repository))
        self.assertEqual(config['node'], str(self.node))
        self.assertEqual(config['port'], 31999)
        self.assertNotEqual(config['state_directory'], str(self.repository))
        for key in ('linux_launcher', 'linux_config'):
            self.assertEqual(Path(result[key]).stat().st_mode & 0o777, 0o600)
        before = self.files()
        self.assertEqual(setup.install(self.payload), result)
        self.assertEqual(self.files(), before)

    def test_unsupported_pidfd_kernel_fails_before_deployment(self):
        with mock.patch.object(setup, 'pidfd_available', return_value=False):
            with self.assertRaisesRegex(setup.SetupError, '^pidfd$'):
                setup.install(self.payload)
        self.assertFalse((self.home / '.local').exists())

    def test_no_manager_import_or_service_start_during_install(self):
        self.payload['manager'] = 'raise RuntimeError("must never execute")\n'
        with mock.patch.object(subprocess, 'Popen', side_effect=AssertionError('must not execute')):
            result = setup.install(self.payload)
        self.assertTrue(Path(result['linux_launcher']).exists())

    def test_invalid_project_creates_no_deployment_files(self):
        (self.repository / 'package.json').write_text('{}')
        before = self.files()
        with self.assertRaisesRegex(setup.SetupError, '^repository$'):
            setup.install(self.payload)
        self.assertEqual(self.files(), before)
        self.assertFalse((self.home / '.local').exists())

    def test_missing_dependency_or_assets_is_read_only(self):
        for check in ('dependencies', 'web_assets', 'node'):
            with self.subTest(check=check):
                report = environment.inspect_values({
                    **self.payload['request'], 'state_directory':str(self.home / 'state')}, 31999, self.runner)
                for item in report['checks']:
                    if item['id'] == check:
                        item['status'] = 'error'
                self.checks['inspect_values'] = lambda *_: report
                before = self.files()
                with self.assertRaisesRegex(setup.SetupError, '^' + check + '$'):
                    setup.install(self.payload)
                self.assertEqual(self.files(), before)
                self.assertFalse((self.home / '.local').exists())

    def test_wrapper_resolves_to_real_linux_node_before_persisting(self):
        import shlex
        import shutil
        real = shutil.which('node')
        if not real:
            self.skipTest('Node is unavailable for the wrapper identity integration check')
        real = str(Path(real).resolve())
        self.node.write_text('#!/bin/sh\nexec ' + shlex.quote(real) + ' "$@"\n')
        self.checks['run_node'] = environment.run_node
        self.checks['inspect_values'] = lambda config, port: environment.inspect_values(config, port,
            lambda node, args, cwd: b'v24.0.0' if args == ['--version'] else b'dsh-dependency-ok')
        result = setup.install(self.payload)
        config = json.loads(Path(result['linux_config']).read_text())
        self.assertEqual(config['node'], real)
        self.assertNotEqual(config['node'], str(self.node))

    def test_windows_node_or_invalid_runtime_is_rejected_before_writing(self):
        for result in ({'platform':'win32','execPath':'C:/node.exe'},
                       {'platform':'linux','execPath':'relative'}, {'platform':'linux'}):
            with self.subTest(result=result):
                self.checks['run_node'] = lambda *_: json.dumps(result).encode()
                with self.assertRaisesRegex(setup.SetupError, '^node$'):
                    setup.install(self.payload)
                self.assertFalse((self.home / '.local').exists())

    def test_missing_ss_and_busy_port_create_no_deployment(self):
        self.checks['ss_available'] = lambda: False
        with self.assertRaisesRegex(setup.SetupError, '^launcher$'):
            setup.install(self.payload)
        self.assertFalse((self.home / '.local').exists())
        self.checks['ss_available'] = lambda: True
        self.checks['port_is_idle'] = lambda _: False
        with self.assertRaisesRegex(setup.SetupError, '^port_busy$'):
            setup.install(self.payload)
        self.assertFalse((self.home / '.local').exists())

    def test_invalid_user_paths_or_port_create_no_deployment(self):
        for key, value in [('linux_user','other'), ('node','node'), ('repository','C:/Harness'),
                           ('port',0), ('port',True), ('repository','/tmp/token=private-value')]:
            with self.subTest(key=key,value=value):
                payload = dict(self.payload, request=dict(self.payload['request'], **{key:value}))
                with self.assertRaises(setup.SetupError):
                    setup.install(payload)
                self.assertFalse((self.home / '.local').exists())

    def test_existing_manager_never_overwritten(self):
        result = setup.install(self.payload)
        path = Path(result['linux_launcher'])
        path.write_text('existing user code')
        before = self.files()
        with self.assertRaisesRegex(setup.SetupError, '^conflict$'):
            setup.install(self.payload)
        self.assertEqual(self.files(), before)

    def test_existing_config_never_overwritten(self):
        result = setup.install(self.payload)
        path = Path(result['linux_config'])
        path.write_text('existing invalid config')
        before = self.files()
        with self.assertRaisesRegex(setup.SetupError, '^conflict$'):
            setup.install(self.payload)
        self.assertEqual(self.files(), before)

    def test_symlink_parent_or_file_rejected(self):
        target = self.home / 'outside'
        target.mkdir()
        (self.home / '.local').symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(setup.SetupError, '^storage$'):
            setup.install(self.payload)
        self.assertEqual(list(target.iterdir()), [])

    def test_file_symlink_rejected_without_touching_target(self):
        result = setup.install(self.payload)
        path = Path(result['linux_launcher'])
        target = self.home / 'other.py'
        target.write_text('preserve me')
        path.unlink()
        path.symlink_to(target)
        with self.assertRaises(OSError):
            setup.install(self.payload)
        self.assertEqual(target.read_text(), 'preserve me')

    def test_interruption_after_manager_publication_can_retry(self):
        publish = setup.publish_new
        def interrupt(path, content):
            if path.name == 'config.json':
                raise OSError('simulated Windows-side retry')
            return publish(path, content)
        with mock.patch.object(setup, 'publish_new', side_effect=interrupt):
            with self.assertRaises(OSError):
                setup.install(self.payload)
        result = setup.install(self.payload)
        self.assertTrue(Path(result['linux_config']).exists())
        self.assertFalse(list(self.home.rglob('.setup-*')))

    def test_crash_after_hardlink_publication_is_recoverable(self):
        result = setup.install(self.payload)
        for key in ('linux_launcher', 'linux_config'):
            path = Path(result[key])
            interrupted = path.parent / '.setup-interrupted'
            os.link(path, interrupted)
            self.assertEqual(path.stat().st_nlink, 2)
            self.assertEqual(setup.install(self.payload), result)
            self.assertFalse(interrupted.exists())
            self.assertEqual(path.stat().st_nlink, 1)

    def test_retry_with_new_port_uses_distinct_profile_without_overwriting(self):
        first = setup.install(self.payload)
        original = Path(first['linux_config']).read_bytes()
        self.payload['request']['port'] += 1
        second = setup.install(self.payload)
        self.assertNotEqual(first['linux_config'], second['linux_config'])
        self.assertEqual(Path(first['linux_config']).read_bytes(), original)

    def test_initialization_refuses_held_starting_profile(self):
        result = setup.install(self.payload)
        config = json.loads(Path(result['linux_config']).read_text())
        import fcntl
        lock = os.open(Path(config['state_directory']) / 'server.lock', os.O_CREAT | os.O_RDWR, 0o600)
        self.addCleanup(os.close, lock)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = self.files()
        with self.assertRaises(BlockingIOError):
            setup.install(self.payload)
        self.assertEqual(self.files(), before)

    def test_real_checker_load_is_not_main_execution(self):
        source = (ROOT / 'src-tauri/helpers/check_environment.py').read_text()
        # Use the unpatched function from a fresh module.
        module = load('setup_unpatched', 'setup_environment.py')
        namespace = module.checker(source)
        self.assertTrue(callable(namespace['inspect_values']))

    def test_embedded_main_is_bounded_and_credential_safe(self):
        source = (ROOT / 'src-tauri/helpers/setup_environment.py').read_text()
        for data in (b'{invalid token=private-value', b'x' * (setup.MAX_INPUT + 1)):
            result = subprocess.run([sys.executable,'-I','-c',source],input=data,
                                    stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=4)
            self.assertEqual(result.returncode,0)
            self.assertIn('error',json.loads(result.stdout))
            self.assertNotIn(b'private-value',result.stdout + result.stderr)
            self.assertEqual(result.stderr,b'')


if __name__ == '__main__':
    unittest.main()
