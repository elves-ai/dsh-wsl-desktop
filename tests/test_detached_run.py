"""Offline bootstrap tests; the integration child is an inert test-owned script."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "src-tauri/helpers/detached_run.py"
SPEC = importlib.util.spec_from_file_location("detached_run", SCRIPT_PATH)
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)


class BootstrapTests(unittest.TestCase):
    def test_launch_uses_argv_and_independent_session_and_ignored_hangup(self):
        child = object()
        with mock.patch.object(adapter.signal, "signal") as disposition, mock.patch.object(adapter.subprocess, "Popen", return_value=child) as spawn:
            self.assertIs(adapter.launch("/tmp/a project/manager.py", "/tmp/a config.json"), child)
        disposition.assert_called_once_with(signal.SIGHUP, signal.SIG_IGN)
        spawn.assert_called_once_with(
            [sys.executable, "/tmp/a project/manager.py", "run", "--config", "/tmp/a config.json"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True,
            shell=False,
        )

    def test_hangup_is_ignored_before_spawning(self):
        order = []
        with mock.patch.object(adapter.signal, "signal", side_effect=lambda *_: order.append("ignore")), mock.patch.object(adapter.subprocess, "Popen", side_effect=lambda *_, **__: order.append("spawn")):
            adapter.launch("/tmp/manager.py", "/tmp/config.json")
        self.assertEqual(order, ["ignore", "spawn"])

    def test_main_returns_without_waiting_or_touching_existing_service(self):
        child = mock.Mock()
        with mock.patch.object(adapter, "launch", return_value=child) as launch, mock.patch.object(adapter.os, "umask") as umask:
            self.assertEqual(adapter.main(["/tmp/manager.py", "/tmp/config.json"]), 0)
        launch.assert_called_once_with("/tmp/manager.py", "/tmp/config.json")
        umask.assert_called_once_with(0o077)
        child.wait.assert_not_called()
        child.poll.assert_not_called()
        child.terminate.assert_not_called()
        child.kill.assert_not_called()

    def test_paths_are_validated_before_signal_or_spawn(self):
        for path in ["relative.py", "-c", "", "/tmp/new\nline", "/tmp/null\0byte", "/tmp/del\x7f"]:
            for args in [(path, "/tmp/config.json"), ("/tmp/manager.py", path)]:
                with self.subTest(args=args), mock.patch.object(adapter.signal, "signal") as disposition, mock.patch.object(adapter.subprocess, "Popen") as spawn:
                    with self.assertRaises(ValueError):
                        adapter.launch(*args)
                    disposition.assert_not_called()
                    spawn.assert_not_called()

    def test_argument_and_spawn_failures_are_silent(self):
        for args in [[], ["one"], ["one", "two", "three"], ["/tmp/manager.py", "/tmp/config.json"]]:
            stdout, stderr = io.StringIO(), io.StringIO()
            with self.subTest(args=args), mock.patch.object(adapter, "launch", side_effect=OSError("token=secret")), mock.patch.object(adapter.os, "umask"), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertEqual(adapter.main(args), 1)
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(stderr.getvalue(), "")

    @unittest.skipUnless(hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"), "requires Linux pidfd for test-owned cleanup")
    def test_test_owned_manager_survives_wrapper_exit_and_direct_sighup(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manager = directory / "inert manager.py"
            # No sockets, DSH modules, subprocesses or real configuration files.
            manager.write_text('''import json, os, pathlib, signal, sys, time
root = pathlib.Path(sys.argv[3])
ready = root / "ready.tmp"
ready.write_text(json.dumps({"pid": os.getpid(), "sid": os.getsid(0), "hup_ignored": signal.getsignal(signal.SIGHUP) == signal.SIG_IGN, "argv": sys.argv[1:]}))
ready.replace(root / "ready.json")
deadline = time.monotonic() + 10
while root.exists() and time.monotonic() < deadline and not (root / "finish").exists():
    if (root / "ping").exists():
        (root / "pong").write_text("alive")
    time.sleep(0.01)
''', encoding="utf-8")
            wrapper = subprocess.run([sys.executable, "-c", SCRIPT_PATH.read_text(encoding="utf-8"), str(manager), str(directory)], stdin=subprocess.DEVNULL, capture_output=True, timeout=5)
            self.assertEqual(wrapper.returncode, 0, wrapper.stderr)
            self.assertEqual(wrapper.stdout, b"")
            ready = directory / "ready.json"
            deadline = time.monotonic() + 5
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(ready.exists(), "inert manager did not report readiness")
            data = json.loads(ready.read_text(encoding="utf-8"))
            pidfd = os.pidfd_open(data["pid"])
            try:
                self.assertEqual(data["sid"], data["pid"])
                self.assertTrue(data["hup_ignored"])
                self.assertEqual(data["argv"], ["run", "--config", str(directory)])
                signal.pidfd_send_signal(pidfd, signal.SIGHUP)
                (directory / "ping").touch()
                deadline = time.monotonic() + 3
                while not (directory / "pong").exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue((directory / "pong").exists(), "inert manager did not survive SIGHUP")
            finally:
                (directory / "finish").touch()
                if not select.select([pidfd], [], [], 3)[0]:
                    signal.pidfd_send_signal(pidfd, signal.SIGTERM)
                    select.select([pidfd], [], [], 3)
                os.close(pidfd)


if __name__ == "__main__":
    unittest.main()
