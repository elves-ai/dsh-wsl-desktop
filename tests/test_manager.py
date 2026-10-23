# SPDX-License-Identifier: MIT
"""Linux-only manager tests. Never contact 3080, the real checkout, or real services.

The integration fixture is an HTTP server inside a fake tsx preload in a temporary
repository. Node itself is real so /proc executable/argv/cwd checks are exercised,
not mocked. It never imports Harness. Every signalled process was created here.
"""
import contextlib
import ctypes
import errno
import fcntl
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "src-tauri/helpers/manager.py"
GUARD = ROOT / "src-tauri/helpers/guarded_stop.py"
DETACHED = ROOT / "src-tauri/helpers/detached_run.py"


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


manager = load(HELPER, "manager_under_test")
guarded_stop = load(GUARD, "guard_under_test")


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    assert port != 3080, "tests may never use the real service port"
    return port


def eventually(check, timeout=8):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = check()
        if last:
            return last
        time.sleep(0.03)
    raise AssertionError("test fixture did not reach expected state: " + repr(last))


FAKE_SERVICE = r'''
import http from 'node:http';
import fs from 'node:fs';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
if (!port || port === 3080) throw new Error('unsafe test port');
const settings = JSON.parse(fs.readFileSync('fixture.json', 'utf8'));
fs.writeFileSync('environment.json', JSON.stringify(process.env));
if (settings.delay) await new Promise(resolve => setTimeout(resolve, settings.delay));
const token = 'A'.repeat(43);
const server = http.createServer((req, res) => {
  if (req.url === '/?token=' + token) {
    res.writeHead(303, {Location: settings.redirect || '/', 'Set-Cookie': 'dsh_session=fake; HttpOnly; SameSite=Strict'});
  } else {
    res.writeHead(settings.status || 401);
  }
  res.end();
});
server.listen(port, '127.0.0.1', () => {
  if (!settings.noToken) console.log('Open http://127.0.0.1:' + port + '/?token=' + token);
  console.log('private log content api_key=never-return-this');
});
if (settings.ignoreTerm) process.on('SIGTERM', () => {});
await new Promise(() => {});
'''


@unittest.skipUnless(sys.platform == "linux", "Linux /proc and pidfd contract")
class ManagerUnitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dsh-manager-unit-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.config = {"repository": str(self.root), "node": sys.executable,
                       "state_directory": str(self.state), "port": free_port()}

    def private(self, name, data):
        self.state.mkdir(mode=0o700, exist_ok=True)
        path = self.state / name
        path.write_text(data)
        path.chmod(0o600)
        return path

    def test_version_default_state_and_source_argv(self):
        self.assertEqual(manager.VERSION, "1.0.0")
        self.assertEqual(manager.DEFAULT_STATE, Path.home() / ".local/state/dsh-wsl-desktop")
        self.assertEqual(manager._argv(self.config), [sys.executable, "--import", "tsx/esm",
                         "apps/cli/src/bin.ts", "web", "--host", "127.0.0.1", "--port",
                         str(self.config["port"]), "--no-open"])

    def test_probe_and_logs_create_nothing(self):
        self.assertEqual(manager.listener(self.config), ("absent", None))
        self.assertEqual(manager.probe(self.config), {"state": "stopped", "managed": False})
        self.assertEqual(manager.logs(self.config), {"state": "logs"})
        self.assertFalse(self.state.exists())

    def test_confirmation_precedes_config_read_and_never_echoes_arguments(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = manager.main(["stop", "--config", "/token=TOP_SECRET"])
        self.assertEqual(result, 1)
        self.assertEqual(json.loads(output.getvalue())["code"], "confirmation_required")
        self.assertNotIn("TOP_SECRET", output.getvalue())
        self.assertFalse(self.state.exists())

    def test_invalid_config_and_arguments_are_static_json_only(self):
        for args in (["probe", "--config", "/secret=VERY_PRIVATE"], ["probe", "SECRET"],
                     ["run", "--config", "/not-present", "--confirmed"]):
            with self.subTest(args=args), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(manager.main(args), 1)
                self.assertEqual(json.loads(output.getvalue())["code"], "launcher_failure")
                self.assertNotIn("VERY_PRIVATE", output.getvalue())
        for port in (True, 0, -1, 65536, "1234"):
            with self.assertRaises(ValueError):
                manager.validate_config(dict(self.config, port=port))

    def test_logs_return_path_only_not_log_content(self):
        self.private("web.log", "token=NEVER_RETURN api_key=SECRET")
        reply = manager.logs(self.config)
        self.assertEqual(reply, {"state": "logs", "service_log": str(self.state / "web.log")})
        self.assertNotIn("NEVER_RETURN", json.dumps(reply))

    def test_symlink_and_hardlink_and_fifo_state_files_rejected(self):
        self.state.mkdir(mode=0o700)
        target = self.root / "target"
        target.write_text("untouched")
        target.chmod(0o600)
        for name in ("operation.lock", "server.lock", "run.json", "web.log"):
            with self.subTest(name=name):
                link = self.state / name
                link.symlink_to(target)
                with self.assertRaises(OSError):
                    manager._file(self.state, name, os.O_RDWR, create=True)
                link.unlink()
                os.link(target, link)
                with self.assertRaises(ValueError):
                    manager._file(self.state, name, os.O_RDWR, create=True)
                link.unlink()
                os.mkfifo(link, 0o600)
                with self.assertRaises(ValueError):
                    manager._file(self.state, name, os.O_RDWR, create=True)
                link.unlink()
        self.assertEqual(target.read_text(), "untouched")

    def test_state_directory_symlink_and_world_access_fail_closed(self):
        target = self.root / "real"
        target.mkdir(mode=0o700)
        self.state.symlink_to(target, target_is_directory=True)
        with self.assertRaises(OSError):
            manager.lock_is_held(self.state)
        self.state.unlink()
        self.state.mkdir(mode=0o755)
        self.state.chmod(0o755)
        with self.assertRaises(ValueError):
            manager.lock_is_held(self.state)
        self.assertEqual(list(self.state.iterdir()), [])

    def test_record_private_bounded_and_typed(self):
        for content in ("x" * (manager.MAX_RECORD + 1), "{}", '{"pid":true}', "[]"):
            self.private("run.json", content)
            with self.assertRaises((ValueError, TypeError)):
                manager._read_record(self.state)
        path = self.private("run.json", "{}")
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            manager._read_record(self.state)

    def test_process_start_ticks_validates_pid_and_process_identity(self):
        self.assertTrue(manager.process_start_ticks(os.getpid()).isdecimal())
        self.assertFalse(manager.process_matches(self.config, os.getpid()))
        for pid in (True, 0, -1, 2**32, "1"):
            with self.assertRaises(ValueError):
                manager.process_start_ticks(pid)

    def test_auth_log_scans_bounded_windows_latest_candidate_only(self):
        root = f"http://127.0.0.1:{self.config['port']}/"
        candidate = root + "?token=" + "A" * 43
        self.private("web.log", candidate + "\n" + "x" * (manager.LOG_WINDOW * 5))
        with mock.patch.object(manager, "http_status", return_value=(303, True)) as request:
            self.assertEqual(manager._auth_url(self.state, root), candidate)
            request.assert_called_once_with(candidate)
        invalid = candidate + "EXTRA"
        self.private("web.log", invalid)
        with mock.patch.object(manager, "http_status") as request:
            self.assertIsNone(manager._auth_url(self.state, root))
            request.assert_not_called()
        self.private("web.log", candidate + "\n" + root + "?token=" + "B" * 43)
        with mock.patch.object(manager, "http_status", return_value=(401, False)) as request:
            self.assertIsNone(manager._auth_url(self.state, root))
            request.assert_called_once_with(root + "?token=" + "B" * 43)

    def test_auth_cannot_join_disjoint_log_windows(self):
        root = f"http://127.0.0.1:{self.config['port']}/"
        candidate = root + "?token=" + "A" * 43
        self.private("web.log", "x" * (manager.LOG_WINDOW - len(candidate)) + candidate
                     + "INVALID" + "x" * (manager.LOG_WINDOW * 3))
        with mock.patch.object(manager, "http_status") as request:
            self.assertIsNone(manager._auth_url(self.state, root))
            request.assert_not_called()

    def test_kernel_pidfd_unavailable_refuses_launch_before_spawn(self):
        with mock.patch.object(os, "pidfd_open", side_effect=OSError(errno.ENOSYS, "private")), \
                mock.patch.object(subprocess, "Popen") as spawn, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(manager.run(self.config), 1)
            self.assertEqual(json.loads(output.getvalue())["code"], "launcher_failure")
            spawn.assert_not_called()
        self.assertFalse((self.state / "web.log").exists())

    def test_unsafe_log_refuses_launch_without_touching_target(self):
        self.state.mkdir(mode=0o700)
        target = self.root / "target"
        target.write_text("private content")
        target.chmod(0o600)
        (self.state / "web.log").symlink_to(target)
        with mock.patch.object(subprocess, "Popen") as spawn:
            with self.assertRaises(OSError):
                manager.run(self.config)
            spawn.assert_not_called()
        self.assertEqual(target.read_text(), "private content")

    def test_http_rejects_all_nonliteral_loopback_urls(self):
        for value in ("https://127.0.0.1:9/", "http://localhost:9/", "http://127.1:9/",
                      "http://127.0.0.1:9@evil/", "http://[::1]:9/", "http://127.0.0.1:9/path",
                      "http://127.0.0.1:9/?token=" + "A" * 43 + "&other=1",
                      "http://127.0.0.1:9/#fragment", "http://127.0.0.1:65536/"):
            with self.subTest(value=value), mock.patch.object(http.client, "HTTPConnection") as connect:
                with self.assertRaises(ValueError):
                    manager.http_status(value)
                connect.assert_not_called()

    def test_http_never_follows_redirects_or_uses_proxy_environment(self):
        hits = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                self.send_response(303)
                self.send_header("Location", "http://192.0.2.1/forbidden")
                self.send_header("Set-Cookie", "dsh_session=fake")
                self.end_headers()
            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.addCleanup(server.server_close)
        self.assertNotEqual(server.server_port, 3080)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with mock.patch.dict(os.environ, {"http_proxy": "http://192.0.2.1:9", "no_proxy": ""}):
                self.assertEqual(manager.http_status(f"http://127.0.0.1:{server.server_port}/"), (303, True))
            self.assertEqual(hits, ["/"])
        finally:
            server.shutdown()
            thread.join()

    def test_wildcard_listener_is_foreign_even_if_current_user(self):
        with socket.socket() as server:
            server.bind(("0.0.0.0", 0))
            server.listen()
            port = server.getsockname()[1]
            self.assertNotEqual(port, 3080)
            self.assertEqual(manager.listener(dict(self.config, port=port)), ("foreign", None))


@unittest.skipUnless(sys.platform == "linux" and shutil.which("node") and hasattr(os, "pidfd_open")
                     and hasattr(signal, "pidfd_send_signal"), "Linux pidfd and Node needed for fake service")
class ManagerIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Reap our deliberate orphans without depending on the machine's init process.
        cls.libc = ctypes.CDLL(None, use_errno=True)
        cls.old_subreaper = ctypes.c_int()
        if cls.libc.prctl(37, ctypes.byref(cls.old_subreaper), 0, 0, 0) != 0:
            raise unittest.SkipTest("subreaper unavailable")
        if cls.libc.prctl(36, 1, 0, 0, 0) != 0:
            raise unittest.SkipTest("subreaper unavailable")

    @classmethod
    def tearDownClass(cls):
        cls.libc.prctl(36, cls.old_subreaper.value, 0, 0, 0)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dsh-manager-integration-")
        self.root = Path(self.temp.name)
        self.repo = self.root / "fake repository"
        self.repo.mkdir()
        module = self.repo / "node_modules/tsx"
        module.mkdir(parents=True)
        (module / "package.json").write_text(json.dumps({"type": "module", "exports": {"./esm": "./fake.mjs"}}))
        (module / "fake.mjs").write_text(FAKE_SERVICE)
        self.settings = self.repo / "fixture.json"
        self.settings.write_text("{}")
        self.state = self.root / "private state"
        self.config = {"repository": str(self.repo), "node": str(Path(shutil.which("node")).resolve()),
                       "state_directory": str(self.state), "port": free_port(),
                       "home": str(self.root / "isolated home")}
        self.config_path = self.root / "config.json"
        self.config_path.write_text(json.dumps(self.config))
        self.supervisors = []
        self.children = {}  # pid -> pidfd acquired only for our fixture-created process.

    def tearDown(self):
        for fd in self.children.values():
            try:
                signal.pidfd_send_signal(fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for proc in self.supervisors:
            if proc.poll() is None:
                proc.terminate()
            try:
                proc.wait(timeout=4)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=4)
            if proc.stdout:
                proc.stdout.close()
            if proc.stderr:
                proc.stderr.close()
        for pid, fd in self.children.items():
            poll = select.poll()
            poll.register(fd, select.POLLIN)
            poll.poll(3000)
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass
            os.close(fd)
        self.temp.cleanup()

    def command(self, action, *extra):
        return [sys.executable, "-B", str(HELPER), action, "--config", str(self.config_path), *extra]

    def cli(self, action, *extra):
        result = subprocess.run(self.command(action, *extra), capture_output=True, text=True, timeout=12)
        self.assertEqual(result.stderr, "")
        reply = json.loads(result.stdout)
        self.assertEqual(result.returncode, 1 if reply["state"] == "error" else 0)
        return reply

    def remember_child(self, record):
        pid = record["pid"]
        if pid not in self.children:
            self.children[pid] = os.pidfd_open(pid)
        return pid

    def start(self, settings=None):
        if settings is not None:
            self.settings.write_text(json.dumps(settings))
        proc = subprocess.Popen(self.command("run"), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.supervisors.append(proc)
        ready, _, _ = select.select([proc.stdout], [], [], 6)
        self.assertTrue(ready, "supervisor did not publish initial JSON")
        reply = json.loads(proc.stdout.readline())
        self.assertEqual(reply["state"], "starting", reply)
        pid = self.remember_child(manager._read_record(self.state))
        self.assertEqual(reply["pid"], pid)
        return proc, pid

    def ready(self):
        return eventually(lambda: (reply if reply.get("state") == "ready" else None)
                          if (reply := manager.probe(self.config)) else None)

    def call_stop(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            status = manager.stop(self.config, self.state)
        reply = json.loads(output.getvalue())
        self.assertEqual(status, 1 if reply["state"] == "error" else 0)
        return reply

    def test_lifecycle_credentials_dedup_permissions_logs_and_guarded_stop(self):
        proc, pid = self.start()
        reply = self.ready()
        self.assertTrue(reply["managed"])
        self.assertTrue(reply["authenticated"])
        self.assertEqual(reply["pid"], pid)
        self.assertEqual(reply["url"], f"http://127.0.0.1:{self.config['port']}/?token=" + "A" * 43)
        self.assertEqual(manager.listener(self.config), ("harness", pid))
        self.assertTrue(manager.process_matches(self.config, pid))
        self.assertTrue(manager.lock_is_held(self.state))
        record = manager._read_record(self.state)
        self.assertEqual(record["supervisor"], proc.pid)
        self.assertEqual(record["start_ticks"], manager.process_start_ticks(pid))
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o700)
        for name in ("operation.lock", "server.lock", "run.json", "web.log"):
            self.assertEqual(stat.S_IMODE((self.state / name).stat().st_mode), 0o600)
        inode = (self.state / "web.log").stat().st_ino
        self.assertEqual(self.cli("run")["pid"], pid)
        self.assertEqual((self.state / "web.log").stat().st_ino, inode)
        self.assertNotIn("never-return", json.dumps(self.cli("logs")))
        result = subprocess.run([sys.executable, "-B", str(GUARD), str(HELPER), str(self.config_path), str(pid)],
                                capture_output=True, text=True, timeout=12)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(json.loads(result.stdout)["state"], "stopped")
        self.assertEqual(result.stderr, "")
        proc.wait(timeout=4)
        self.assertFalse((self.state / "run.json").exists())
        self.assertFalse(manager.lock_is_held(self.state))
        self.assertEqual(self.cli("probe")["state"], "stopped")

    def test_auth_failure_does_not_remove_ownership_or_prevent_stop(self):
        proc, pid = self.start({"noToken": True})
        reply = self.ready()
        self.assertTrue(reply["managed"])
        self.assertFalse(reply["authenticated"])
        self.assertEqual(reply["code"], "managed_auth_unavailable")
        self.assertEqual(self.cli("stop", "--confirmed")["state"], "stopped")
        proc.wait(timeout=4)

    def test_starting_child_can_be_stopped_under_adapter_lock(self):
        proc, pid = self.start({"delay": 3000})
        self.assertEqual(manager.listener(self.config), ("absent", None))
        reply = manager.probe(self.config)
        self.assertEqual(reply, {"state": "starting", "managed": True, "pid": pid})
        original = manager.listener
        guard = guarded_stop.make_guard(manager, self.state, pid)
        calls = []
        def checked(config):
            with open(self.state / "operation.lock", "rb") as lock:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            calls.append(True)
            return guard(config)
        with mock.patch.object(manager, "listener", checked):
            self.assertEqual(self.call_stop()["state"], "stopped")
        self.assertGreaterEqual(len(calls), 2)
        self.assertIs(manager.listener, original)
        proc.wait(timeout=4)

    def test_hup_and_sigkill_supervisor_do_not_destroy_child_or_log(self):
        proc, pid = self.start()
        self.ready()
        proc.send_signal(signal.SIGHUP)
        self.assertEqual(manager.listener(self.config), ("harness", pid))
        self.assertIsNone(proc.poll())
        proc.kill()
        proc.wait(timeout=4)
        self.assertFalse(manager.lock_is_held(self.state))
        self.assertTrue(manager._log_matches(self.state, pid))
        self.assertTrue(self.ready()["managed"])
        self.assertEqual(self.call_stop()["state"], "stopped")

    def test_signal_during_publication_still_publishes_recoverable_child(self):
        marker, release = self.root / "publishing.json", self.root / "release"
        wrapper = ("import importlib.util, json, time; from pathlib import Path\n"
                   + "s=importlib.util.spec_from_file_location('delayed', " + repr(str(HELPER)) + ")\n"
                   + "m=importlib.util.module_from_spec(s); s.loader.exec_module(m)\n"
                   + "original=m._write_record\n"
                   + "def publish(state, record):\n"
                   + "    Path(" + repr(str(marker)) + ").write_text(json.dumps(record))\n"
                   + "    while not Path(" + repr(str(release)) + ").exists(): time.sleep(0.01)\n"
                   + "    original(state, record)\n"
                   + "m._write_record=publish\n"
                   + "raise SystemExit(m.main(['run', '--config', " + repr(str(self.config_path)) + "]))\n")
        proc = subprocess.Popen([sys.executable, "-B", "-c", wrapper],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.supervisors.append(proc)
        eventually(marker.exists)
        pid = self.remember_child(json.loads(marker.read_text()))
        proc.terminate()
        release.touch()
        stdout, stderr = proc.communicate(timeout=4)
        self.assertEqual(stderr, "")
        self.assertEqual(json.loads(stdout)["pid"], pid)
        self.assertEqual(manager._read_record(self.state)["pid"], pid)
        self.assertFalse(manager.lock_is_held(self.state))
        self.assertTrue(self.ready()["managed"])
        self.assertEqual(self.call_stop()["state"], "stopped")

    def test_record_publication_failure_rolls_back_only_new_child_by_pidfd(self):
        original_spawn = subprocess.Popen
        created = []
        def spawn(*args, **kwargs):
            child = original_spawn(*args, **kwargs)
            created.append(child)
            self.supervisors.append(child)
            self.children[child.pid] = os.pidfd_open(child.pid)
            return child
        with mock.patch.object(subprocess, "Popen", spawn), \
                mock.patch.object(manager, "_write_record", side_effect=OSError(errno.ENOSPC, "private")), \
                mock.patch.object(signal, "pidfd_send_signal", wraps=signal.pidfd_send_signal) as send:
            with self.assertRaises(OSError):
                manager.run(self.config)
        self.assertEqual(len(created), 1)
        self.assertIsNotNone(created[0].poll())
        signals = [call.args[1] for call in send.call_args_list]
        self.assertEqual(signals, [0, signal.SIGTERM])
        self.assertFalse((self.state / "run.json").exists())
        self.assertFalse(manager.lock_is_held(self.state))
        self.assertEqual(manager.listener(self.config), ("absent", None))

    def test_guarded_probe_real_manager_reports_auth_and_no_file_creation(self):
        result = subprocess.run([sys.executable, "-B", str(GUARD), "--probe", str(HELPER), str(self.config_path)],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["state"], "stopped")
        self.assertFalse(self.state.exists())
        proc, pid = self.start()
        self.ready()
        result = subprocess.run([sys.executable, "-B", str(GUARD), "--probe", str(HELPER), str(self.config_path)],
                                capture_output=True, text=True, timeout=5)
        reply = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        self.assertTrue(reply["managed"])
        self.assertTrue(reply["authenticated"])
        self.assertEqual(reply["pid"], pid)
        # Stop also accepts the conventional flag-first ordering.
        result = subprocess.run([sys.executable, "-B", str(HELPER), "stop", "--confirmed", "--config", str(self.config_path)],
                                capture_output=True, text=True, timeout=12)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(json.loads(result.stdout)["state"], "stopped")

    def test_process_identity_rejects_directory_executable_and_start_changes(self):
        proc, pid = self.start()
        self.ready()
        self.assertFalse(manager.process_matches(dict(self.config, repository=str(self.root)), pid))
        self.assertFalse(manager.process_matches(dict(self.config, node=sys.executable), pid))
        original = manager.process_start_ticks
        tick = original(pid)
        with mock.patch.object(manager, "process_start_ticks", side_effect=[tick, str(int(tick) + 1)]):
            self.assertFalse(manager.process_matches(self.config, pid))
        self.assertEqual(self.call_stop()["state"], "stopped")

    def test_orphan_recovery_preserves_exact_child_log_descriptors(self):
        proc, pid = self.start()
        self.ready()
        original_record = manager._read_record(self.state)
        original_log = (self.state / "web.log").stat().st_ino
        proc.terminate()  # Only the test-created supervisor, never the child/service.
        proc.wait(timeout=4)
        self.assertFalse(manager.lock_is_held(self.state))
        self.assertEqual(manager._read_record(self.state), original_record)
        self.assertTrue(manager._log_matches(self.state, pid))
        reply = self.ready()
        self.assertTrue(reply["managed"])
        self.assertEqual(self.cli("run")["pid"], pid)
        self.assertEqual((self.state / "web.log").stat().st_ino, original_log)
        result = subprocess.run([sys.executable, "-B", str(GUARD), str(HELPER), str(self.config_path), str(pid)],
                                capture_output=True, text=True, timeout=12)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(json.loads(result.stdout)["state"], "stopped")

    def test_orphan_initializing_is_not_duplicated_or_blindly_stopped(self):
        proc, pid = self.start({"delay": 1200})
        proc.terminate()
        proc.wait(timeout=4)
        inode = (self.state / "web.log").stat().st_ino
        self.assertEqual(self.cli("run")["pid"], pid)
        self.assertEqual((self.state / "web.log").stat().st_ino, inode)
        self.assertEqual(self.cli("stop", "--confirmed")["code"], "stop_incomplete")
        self.ready()
        self.assertEqual(self.cli("stop", "--confirmed")["state"], "stopped")

    def test_external_identical_cli_is_connectable_but_never_adopted_or_signalled(self):
        log = self.root / "external.log"
        with log.open("wb") as output:
            child = subprocess.Popen(manager._argv(self.config), cwd=self.repo,
                                     env=manager._environment(self.config), stdout=output, stderr=output)
        self.supervisors.append(child)
        self.children[child.pid] = os.pidfd_open(child.pid)
        eventually(lambda: manager.listener(self.config) == ("harness", child.pid))
        reply = self.ready()
        self.assertFalse(reply["managed"])
        self.assertFalse(reply["authenticated"])
        self.assertEqual(self.cli("run")["pid"], child.pid)
        self.assertFalse((self.state / "web.log").exists())
        self.assertEqual(self.cli("stop", "--confirmed")["code"], "process_changed")
        self.assertIsNone(child.poll())

    def test_unrelated_http_listener_rejected_without_signal_or_log_truncation(self):
        with socket.socket() as server:
            server.bind(("127.0.0.1", self.config["port"]))
            server.listen()
            self.state.mkdir(mode=0o700)
            log = self.state / "web.log"
            log.write_text("untouched secret")
            log.chmod(0o600)
            self.assertEqual(self.cli("probe")["code"], "port_in_use")
            self.assertEqual(self.cli("run")["code"], "port_in_use")
            self.assertEqual(self.cli("stop", "--confirmed")["code"], "port_in_use")
            self.assertEqual(log.read_text(), "untouched secret")

    def test_metadata_start_time_mismatch_and_guarded_expected_pid_reject_stop(self):
        proc, pid = self.start()
        self.ready()
        record = manager._read_record(self.state)
        manager._write_record(self.state, dict(record, start_ticks="0"))
        with mock.patch.object(signal, "pidfd_send_signal") as send:
            self.assertEqual(self.call_stop()["code"], "process_changed")
            send.assert_not_called()
        manager._write_record(self.state, dict(record, boot_id="wrong-boot"))
        with mock.patch.object(signal, "pidfd_send_signal") as send:
            self.assertEqual(self.call_stop()["code"], "process_changed")
            send.assert_not_called()
        manager._write_record(self.state, record)
        with mock.patch.object(manager, "listener", guarded_stop.make_guard(manager, self.state, pid + 1)):
            self.assertEqual(self.call_stop()["code"], "port_in_use")
        self.assertIsNone(proc.poll())
        self.assertEqual(self.call_stop()["state"], "stopped")

    def test_log_inode_change_rejects_ownership_even_with_live_supervisor(self):
        proc, pid = self.start()
        self.ready()
        (self.state / "web.log").rename(self.state / "old.log")
        (self.state / "web.log").write_text("forged token=" + "A" * 43)
        (self.state / "web.log").chmod(0o600)
        self.assertFalse(manager.probe(self.config)["managed"])
        with mock.patch.object(signal, "pidfd_send_signal") as send:
            self.assertEqual(self.call_stop()["code"], "process_changed")
            send.assert_not_called()
        self.assertIsNone(proc.poll())

    def test_pidfd_unavailable_or_identity_changes_after_open_never_signals(self):
        proc, pid = self.start()
        self.ready()
        with mock.patch.object(os, "pidfd_open", side_effect=OSError(errno.ENOSYS, "secret")), \
                mock.patch.object(signal, "pidfd_send_signal") as send:
            self.assertEqual(self.call_stop()["code"], "process_changed")
            send.assert_not_called()
        original = manager._owned
        calls = []
        def changed(*args):
            calls.append(True)
            return original(*args) if len(calls) == 1 else None
        with mock.patch.object(manager, "_owned", changed), mock.patch.object(signal, "pidfd_send_signal") as send:
            self.assertEqual(self.call_stop()["code"], "process_changed")
            send.assert_not_called()
        self.assertEqual(self.call_stop()["state"], "stopped")

    def test_stop_timeout_never_escalates_and_leaves_service(self):
        proc, pid = self.start({"ignoreTerm": True})
        self.ready()
        with mock.patch.object(manager, "STOP_TIMEOUT", 0.05):
            self.assertEqual(self.call_stop()["code"], "stop_timeout")
        self.assertEqual(manager.listener(self.config), ("harness", pid))
        self.assertIsNone(proc.poll())

    def test_child_environment_is_whitelisted_and_dsh_home_is_explicit(self):
        with mock.patch.dict(os.environ, {"NODE_OPTIONS": "--nonexistent", "NODE_PATH": "/malicious",
                                          "DSH_HOME": "/wrong", "SECRET_TOKEN": "never-forward"}):
            proc, pid = self.start()
        self.ready()
        env = json.loads((self.repo / "environment.json").read_text())
        for name in ("NODE_OPTIONS", "NODE_PATH", "SECRET_TOKEN"):
            self.assertNotIn(name, env)
        self.assertEqual(env["DSH_HOME"], self.config["home"])
        self.assertEqual(os.getsid(pid), pid)
        self.assertEqual(self.call_stop()["state"], "stopped")

    def test_parallel_runs_deduplicate_one_supervisor_and_child(self):
        for _ in range(5):
            proc = subprocess.Popen(self.command("run"), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.supervisors.append(proc)
        record = eventually(lambda: manager._read_record(self.state) if (self.state / "run.json").exists() else None)
        pid = self.remember_child(record)
        self.ready()
        for proc in self.supervisors:
            ready, _, _ = select.select([proc.stdout], [], [], 6)
            self.assertTrue(ready)
            reply = json.loads(proc.stdout.readline())
            self.assertEqual(reply["pid"], pid)
        eventually(lambda: len([proc for proc in self.supervisors if proc.poll() is None]) == 1)
        self.assertEqual(self.call_stop()["state"], "stopped")

    def test_detached_adapter_does_not_tie_service_to_request_lifetime(self):
        result = subprocess.run([sys.executable, "-B", str(DETACHED), str(HELPER), str(self.config_path)],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        record = eventually(lambda: manager._read_record(self.state) if (self.state / "run.json").exists() else None)
        pid = self.remember_child(record)
        self.ready()
        self.assertTrue(manager.lock_is_held(self.state))
        self.assertEqual(self.call_stop()["state"], "stopped")
        # The detached supervisor is our adopted child; reap that exact known PID.
        os.waitpid(record["supervisor"], 0)


if __name__ == "__main__":
    unittest.main()
