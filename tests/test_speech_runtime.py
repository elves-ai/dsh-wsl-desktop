"""Stdlib-only security/protocol and Linux sleep-fixture lifecycle tests."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import selectors
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HELPER = Path(__file__).resolve().parents[1] / "src-tauri/helpers/speech_runtime.py"
CODE = HELPER.read_text(encoding="utf-8")
SPEC = importlib.util.spec_from_file_location("speech_runtime_under_test", HELPER)
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)

SLEEP_SERVER = r'''
import json, os, pathlib, signal, subprocess, sys, time
identity = json.loads(sys.stdin.buffer.readline(4097))
assert len(identity["control_token"]) == 64
model_dir = pathlib.Path(sys.argv[sys.argv.index("--model-dir") + 1])
model = subprocess.Popen([sys.executable, "-c", "import pathlib,signal,sys,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path(sys.argv[1]).write_text('ready'); time.sleep(120)", str(model_dir / "model-ready")])
deadline = time.monotonic() + 3
while not (model_dir / "model-ready").exists() and time.monotonic() < deadline:
    time.sleep(.01)
(model_dir / "report.json").write_text(json.dumps({"service_pid":os.getpid(), "model_pid":model.pid,"argv":sys.argv,"received_instance":identity["instance_id"],"token_received":True}))
while True:
    time.sleep(.1)
'''


def files_for(server=b"# fixture\n"):
    return {"server.py": server, "native_q8.py": b"# no GPU\n",
            "runtime_check.py": b"# no check\n", "voice/profile.json": b"{}",
            "voice/reference.wav": b"RIFFfixture", "managed_runtime.py": CODE.encode()}


def stage_request(files):
    return {"files": {name: base64.b64encode(data).decode("ascii") for name, data in files.items()}}


def running(pid):
    try:
        return Path("/proc/%d/stat" % pid).read_text().rsplit(")", 1)[1].split()[0] != "Z"
    except FileNotFoundError:
        return False


def until(predicate, seconds=5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(.025)
    return predicate()


@unittest.skipUnless(sys.platform == "linux", "WSL/Linux /proc ownership protocol")
class StageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="speech-runtime-test-")
        self.home = Path(self.temp.name)
        self.patch = mock.patch.object(runtime.Path, "home", return_value=self.home)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.addCleanup(self.temp.cleanup)
        self.files = files_for()
        self.request = stage_request(self.files)

    def test_fixed_digest_private_files_and_reuse_without_overwrite(self):
        result = runtime.stage(self.request)
        sha = hashlib.sha256()
        for name in sorted(self.files):
            sha.update(name.encode() + b"\0" + self.files[name])
        expected = self.home / ".dsh-wsl-desktop/speech/service" / sha.hexdigest()
        self.assertEqual(result, {"ok": True, "script_path": str(expected / "server.py"),
                                  "runtime_helper": str(expected / "managed_runtime.py")})
        before = (expected / "server.py").stat()
        self.assertEqual(runtime.stage(self.request), result)
        after = (expected / "server.py").stat()
        self.assertEqual((before.st_ino, before.st_mtime_ns), (after.st_ino, after.st_mtime_ns))
        self.assertEqual(expected.stat().st_mode & 0o777, 0o700)
        for name in self.files:
            self.assertEqual((expected / name).stat().st_mode & 0o777, 0o600)
        self.assertEqual(runtime.validate_bundle(result["script_path"]), result["runtime_helper"])

    def test_exact_whitelist_blocks_traversal_absolute_extra_and_missing(self):
        for name in ("../escape", "/tmp/escape", "voice/../../escape", "model.bin"):
            with self.subTest(name=name):
                request = stage_request(dict(self.files, **{name: b"evil"}))
                with self.assertRaises(runtime.Refused):
                    runtime.stage(request)
        for request in ({"files": {}}, dict(self.request, target="/tmp/escape")):
            with self.assertRaises(runtime.Refused):
                runtime.stage(request)
        self.assertFalse((self.home / ".dsh-wsl-desktop").exists())

    def test_base64_and_per_file_caps(self):
        for value in ("!", "YWJj\n", "非ASCII", 3):
            request = stage_request(self.files)
            request["files"]["server.py"] = value
            with self.assertRaises(runtime.Refused):
                runtime.stage(request)
        for name, cap in runtime.FILE_CAPS.items():
            with self.subTest(name=name):
                files = dict(self.files, **{name: b"x" * (cap + 1)})
                with self.assertRaises(runtime.Refused):
                    runtime.stage(stage_request(files))

    def test_total_cap(self):
        files = {name: b"x" * cap for name, cap in runtime.FILE_CAPS.items()}
        self.assertGreater(sum(map(len, files.values())), runtime.TOTAL_CAP)
        with self.assertRaises(runtime.Refused):
            runtime.stage(stage_request(files))

    def test_symlink_cache_ancestors_and_owned_are_not_followed(self):
        outside = self.home / "outside"
        outside.mkdir()
        parent = self.home
        for component in (".dsh-wsl-desktop", "speech", "service", "owned"):
            with self.subTest(component=component):
                path = parent / component
                path.symlink_to(outside, target_is_directory=True)
                try:
                    if component != "owned":
                        with self.assertRaises(OSError):
                            runtime.stage(self.request)
                    with self.assertRaises(OSError):
                        runtime.marker_dir(create=True)
                    self.assertEqual(list(outside.iterdir()), [])
                finally:
                    path.unlink()
                path.mkdir(mode=0o700)
                parent = path

    def test_cache_ancestors_and_owned_refuse_unsafe_permissions(self):
        os.close(runtime.marker_dir(create=True))
        paths = [self.home]
        for component in (".dsh-wsl-desktop", "speech", "service", "owned"):
            paths.append(paths[-1] / component)
        for path in paths:
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)
            modes = (0o702, 0o720, 0o740, 0o701) if path.name in ("service", "owned") else (0o702, 0o720)
            for mode in modes:
                with self.subTest(path=path, mode=oct(mode)):
                    path.chmod(mode)
                    try:
                        with self.assertRaises(runtime.Refused) as error:
                            runtime.marker_dir()
                        self.assertEqual(error.exception.code, "unsafe_cache")
                    finally:
                        path.chmod(0o700)

    def test_cache_ancestors_and_owned_refuse_foreign_owner(self):
        os.close(runtime.marker_dir(create=True))
        paths = [self.home]
        for component in (".dsh-wsl-desktop", "speech", "service", "owned"):
            paths.append(paths[-1] / component)
        real_fstat = os.fstat
        for path in paths:
            identity = (path.stat().st_dev, path.stat().st_ino)

            def foreign_owner(fd):
                info = real_fstat(fd)
                if (info.st_dev, info.st_ino) == identity:
                    fields = list(info)
                    fields[4] = os.getuid() + 1
                    return os.stat_result(fields)
                return info

            with self.subTest(path=path), mock.patch.object(runtime.os, "fstat", side_effect=foreign_owner):
                with self.assertRaises(runtime.Refused) as error:
                    runtime.marker_dir()
                self.assertEqual(error.exception.code, "unsafe_cache")

    def test_symlink_bundle_is_not_followed(self):
        fd, root = runtime.cache()
        os.close(fd)
        outside = self.home / "outside"
        outside.mkdir()
        (root / runtime.bundle_digest(self.files)).symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            runtime.stage(self.request)
        self.assertEqual(list(outside.iterdir()), [])

    def test_symlink_file_and_voice_dir_are_refused(self):
        fd, root = runtime.cache()
        os.close(fd)
        bundle = root / runtime.bundle_digest(self.files)
        bundle.mkdir(mode=0o700)
        outside = self.home / "outside"
        outside.write_bytes(b"sentinel")
        (bundle / "server.py").symlink_to(outside)
        with self.assertRaises(OSError):
            runtime.stage(self.request)
        self.assertEqual(outside.read_bytes(), b"sentinel")
        (bundle / "server.py").unlink()
        (bundle / "voice").rmdir()
        target = self.home / "external-voice"
        target.mkdir()
        (bundle / "voice").symlink_to(target, target_is_directory=True)
        with self.assertRaises(OSError):
            runtime.stage(self.request)
        self.assertEqual(list(target.iterdir()), [])

    def test_fifo_entry_is_refused_without_blocking(self):
        fd, root = runtime.cache()
        os.close(fd)
        bundle = root / runtime.bundle_digest(self.files)
        bundle.mkdir(mode=0o700)
        os.mkfifo(bundle / "server.py", 0o600)
        with self.assertRaises(runtime.Refused):
            runtime.stage(self.request)

    def test_untrusted_existing_file_is_never_overwritten(self):
        result = runtime.stage(self.request)
        script = Path(result["script_path"])
        script.write_bytes(b"changed")
        with self.assertRaises(runtime.Refused):
            runtime.stage(self.request)
        with self.assertRaises(runtime.Refused):
            runtime.validate_bundle(str(script))
        self.assertEqual(script.read_bytes(), b"changed")

    def test_helper_checksum_and_manifest_are_required(self):
        result = runtime.stage(self.request)
        helper = Path(result["runtime_helper"])
        helper.write_bytes(b"changed")
        with self.assertRaises(runtime.Refused):
            runtime.validate_bundle(result["script_path"])
        helper.write_bytes(self.files["managed_runtime.py"])
        manifest = helper.parent / ".manifest.json"
        manifest.write_bytes(b"{}")
        with self.assertRaises(runtime.Refused):
            runtime.validate_bundle(result["script_path"])

    def test_hardlinked_and_public_files_refused(self):
        result = runtime.stage(self.request)
        script = Path(result["script_path"])
        os.link(script, self.home / "hardlink")
        with self.assertRaises(runtime.Refused):
            runtime.validate_bundle(str(script))
        (self.home / "hardlink").unlink()
        script.chmod(0o644)
        with self.assertRaises(runtime.Refused):
            runtime.validate_bundle(str(script))

    def test_absolute_paths_refuse_ambiguous_controls_and_relative(self):
        for path in ("relative", "/tmp/../server.py", "//tmp/x", "/tmp//x", "/tmp/./x",
                     "/tmp/a\nsecret", "/tmp/a\0b", "/tmp/a\x7fb", ""):
            with self.subTest(path=path), self.assertRaises(runtime.Refused):
                runtime.absolute(path)
        self.assertEqual(runtime.absolute("/space path/file"), "/space path/file")

    def test_check_event_accepts_only_matching_cuda_rocm_results(self):
        base = {"kind": "result", "environment_ok": True, "models_ok": True,
                "gpu_name": "NVIDIA fixture", "error_code": None}
        for backend, device in [("cuda", "CUDA0"), ("cuda", "CUDA99"), ("rocm", "ROCm1")]:
            event = dict(base, backend=backend, device=device)
            self.assertEqual(runtime.check_event(json.dumps(event).encode()), event)
        for backend, device in [("cuda", "ROCm0"), ("rocm", "CUDA0"), ("cpu", "CPU"),
                                ("cuda", "auto"), ("cuda", "CUDA00"), ("cuda", "CUDA100"),
                                ("cuda", "CUDA-1"), (None, None), ([], "CUDA0")]:
            with self.subTest(backend=backend, device=device), self.assertRaises(runtime.Refused):
                runtime.check_event(json.dumps(dict(base, backend=backend, device=device)).encode())
        for fields in [{"backend": "cuda"}, {"device": "CUDA0"}, {"backend": "cuda", "device": "CUDA0", "raw": "/secret"}]:
            with self.assertRaises(runtime.Refused):
                runtime.check_event(json.dumps(dict(base, **fields)).encode())

    def test_check_event_preserves_safe_cuda_errors_and_model_roles(self):
        for code in ["cuda_libraries_unavailable", "gpu_backend_mismatch", "gpu_runtime_unavailable",
                     "missing_talker", "missing_codec", "hash_mismatch_talker", "hash_mismatch_codec"]:
            event = {"kind": "result", "environment_ok": False, "models_ok": False,
                     "gpu_name": None, "error_code": code, "backend": None, "device": None}
            self.assertEqual(runtime.check_event(json.dumps(event).encode()), event)

    def test_bounded_json_rejects_duplicate_trailing_and_oversize(self):
        for text in (b'{"files":{},"files":{}}', b'{}{}', b'[]', b'bad'):
            with self.assertRaises(runtime.Refused):
                runtime.read_json(io.BytesIO(text), 100)
        with self.assertRaises(runtime.Refused):
            runtime.read_json(io.BytesIO(b" " * 101), 100)

    def test_missing_marker_probe_is_readonly_and_stop_refuses(self):
        creds = {"instance_id": "1" * 64, "control_token": "2" * 64}
        script = self.home / ".dsh-wsl-desktop/speech/service" / ("a" * 64) / "server.py"
        parent = self.home
        for component in (".dsh-wsl-desktop", "speech", "service", "owned", None):
            with self.subTest(missing=component), mock.patch.object(runtime.os, "mkdir") as mkdir, \
                 mock.patch.object(runtime.os, "killpg") as kill:
                self.assertEqual(runtime.probe_owned(creds), {"ok": True, "alive": False})
                with self.assertRaises(runtime.Refused):
                    runtime.stop(creds)
                with self.assertRaises(FileNotFoundError):
                    runtime.validate_bundle(str(script))
                mkdir.assert_not_called()
                kill.assert_not_called()
                self.assertEqual(list(parent.iterdir()), [])
            if component is not None:
                parent = parent / component
                parent.mkdir(mode=0o700)
        self.assertFalse((self.home / ".local").exists())

    def test_legacy_service_directory_is_not_reused_or_migrated(self):
        legacy = self.home / ".local/share/dsh-pet/speech-service"
        legacy.mkdir(parents=True, mode=0o700)
        sentinel = legacy / "sentinel"
        sentinel.write_bytes(b"legacy service data")
        result = runtime.stage(self.request)
        self.assertEqual(Path(result["script_path"]).parent.parent,
                         self.home / ".dsh-wsl-desktop/speech/service")
        self.assertEqual(list(legacy.iterdir()), [sentinel])
        self.assertEqual(sentinel.read_bytes(), b"legacy service data")
        with self.assertRaises(runtime.Refused) as error:
            runtime.validate_bundle(str(legacy / runtime.bundle_digest(self.files) / "server.py"))
        self.assertEqual(error.exception.code, "not_staged")

    def test_marker_cleanup_requires_same_inode_and_private_context(self):
        fd = runtime.marker_dir(create=True)
        instance = "1" * 64
        runtime.put_file(fd, instance + ".json", b"{}", 100)
        os.close(fd)
        _, inode = runtime.marker_read(instance)
        path = self.home / ".dsh-wsl-desktop/speech/service/owned" / (instance + ".json")
        runtime.marker_remove(instance, (inode[0], inode[1] + 1))
        self.assertTrue(path.exists())
        path.chmod(0o644)
        with self.assertRaises(runtime.Refused):
            runtime.marker_remove(instance, inode)
        self.assertTrue(path.exists())
        path.chmod(0o600)
        runtime.marker_remove(instance, inode)
        self.assertFalse(path.exists())


@unittest.skipUnless(sys.platform == "linux", "WSL/Linux /proc ownership protocol")
class GuardTests(unittest.TestCase):
    def setUp(self):
        self.pid = 12345
        self.script = "/private/bundle/server.py"
        self.helper = "/private/bundle/managed_runtime.py"
        self.marker = {"uid": os.getuid(), "boot_id": "boot", "pid": self.pid,
                       "start_time": "100", "pgid": self.pid, "session": self.pid,
                       "script_path": self.script, "runtime_helper": self.helper,
                       "supervisor_python": sys.executable}
        self.info = {"uid": os.getuid(), "start_time": "100", "pgid": self.pid,
                     "session": self.pid, "command": [os.fsencode(sys.executable),
                      os.fsencode(self.helper), b"--supervise"]}
        self.stack = mock.patch.multiple(runtime, boot_id=mock.Mock(return_value="boot"),
                     validate_bundle=mock.Mock(return_value=self.helper),
                     process_info=mock.Mock(side_effect=lambda _pid: self.info))
        self.stack.start()
        self.addCleanup(self.stack.stop)

    def test_matching_guard(self):
        self.assertEqual(runtime.verify_process(self.marker), self.pid)

    def test_pid_reuse_uid_boot_session_group_command_and_source_mismatch(self):
        mutations = [("marker", "uid", os.getuid() + 1), ("marker", "boot_id", "other"),
                     ("marker", "runtime_helper", "/outside/helper.py"),
                     ("marker", "supervisor_python", "/outside/python"),
                     ("marker", "session", 99), ("marker", "pgid", 99),
                     ("info", "start_time", "101"), ("info", "uid", os.getuid() + 1),
                     ("info", "pgid", 99), ("info", "session", 99),
                     ("info", "command", [b"python", b"unrelated.py"]),
                     ("info", "command", self.info["command"] + [b"--extra"])]
        for source, key, value in mutations:
            with self.subTest(source=source, key=key):
                target = self.marker if source == "marker" else self.info
                old = target[key]
                target[key] = value
                try:
                    with self.assertRaises(runtime.Refused), mock.patch.object(runtime.os, "killpg") as kill:
                        runtime.verify_process(self.marker)
                    kill.assert_not_called()
                finally:
                    target[key] = old

    def test_stop_rechecks_identity_before_kill_fallback(self):
        creds = {"instance_id": "1" * 64, "control_token": "2" * 64}
        with mock.patch.object(runtime, "owned", return_value=(creds["instance_id"], self.marker, (1, 2))), \
             mock.patch.object(runtime, "verify_process", side_effect=[self.pid, runtime.Refused("not_owned")]), \
             mock.patch.object(runtime, "marker_remove") as remove, \
             mock.patch.object(runtime.os, "killpg") as kill:
            self.assertEqual(runtime.stop(creds), {"ok": True, "stopped": True})
        kill.assert_called_once_with(self.pid, signal.SIGTERM)
        remove.assert_called_once()

    def test_stop_timeout_only_kills_same_verified_group(self):
        creds = {"instance_id": "1" * 64, "control_token": "2" * 64}
        with mock.patch.object(runtime, "owned", return_value=(creds["instance_id"], self.marker, (1, 2))), \
             mock.patch.object(runtime, "verify_process", return_value=self.pid) as verify, \
             mock.patch.object(runtime, "STOP_TIMEOUT", 0), \
             mock.patch.object(runtime, "marker_remove"), \
             mock.patch.object(runtime.os, "killpg") as kill:
            runtime.stop(creds)
        self.assertEqual(verify.call_count, 2)
        self.assertEqual(kill.call_args_list, [mock.call(self.pid, signal.SIGTERM), mock.call(self.pid, signal.SIGKILL)])


@unittest.skipUnless(sys.platform == "linux", "WSL/Linux /proc ownership protocol")
class ProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="speech-runtime-process-")
        self.home = Path(self.temp.name)
        self.env = dict(os.environ, HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1")
        self.launched = []
        self.addCleanup(self.cleanup)

    def cli(self, action, request=None, raw=None):
        result = subprocess.run(["/usr/bin/python3", "-c", CODE, action],
            input=raw if raw is not None else json.dumps(request).encode(),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env, timeout=12)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(len(result.stdout.splitlines()), 1)
        self.assertLessEqual(len(result.stdout), runtime.SMALL_INPUT_CAP + 1)
        return json.loads(result.stdout)

    def cleanup(self):
        for launch in self.launched:
            creds = {key: launch[key] for key in ("instance_id", "control_token")}
            try:
                self.cli("--stop", creds)
            except Exception:
                pass
            # Fixture-only emergency cleanup, identity checked before a signal.
            try:
                info = runtime.process_info(launch["pid"])
                if info["start_time"] == launch["start_time"] and info["pgid"] == launch["pid"] and info["session"] == launch["pid"]:
                    os.killpg(launch["pid"], signal.SIGKILL)
            except (OSError, runtime.Refused):
                pass
        self.temp.cleanup()

    def start(self):
        staged = self.cli("--stage", stage_request(files_for(SLEEP_SERVER.encode())))
        self.assertTrue(staged["ok"], staged)
        model = self.home / ("model-" + str(len(self.launched)))
        model.mkdir()
        launch = self.cli("--launch", {"script_path": staged["script_path"], "python_path": "/usr/bin/python3",
                           "model_dir": str(model), "native_lib": str(self.home / "libfixture.so")})
        self.assertTrue(launch["ok"], launch)
        self.launched.append(launch)
        self.assertTrue(until(lambda: (model / "report.json").exists()))
        report = json.loads((model / "report.json").read_text())
        return launch, report

    def creds(self, launch):
        return {key: launch[key] for key in ("instance_id", "control_token")}

    def marker_path(self, launch):
        return self.home / ".dsh-wsl-desktop/speech/service/owned" / (launch["instance_id"] + ".json")

    def test_detached_launch_stop_and_secret_channel(self):
        launch, report = self.start()
        self.assertEqual(set(launch), {"ok", "instance_id", "control_token", "pid", "start_time", "script_path"})
        self.assertEqual(report["received_instance"], launch["instance_id"])
        self.assertTrue(report["token_received"])
        token = launch["control_token"].encode()
        for pid in (launch["pid"], report["service_pid"], report["model_pid"]):
            self.assertNotIn(token, Path("/proc/%d/cmdline" % pid).read_bytes())
            self.assertNotIn(token, Path("/proc/%d/environ" % pid).read_bytes())
            self.assertEqual(os.getpgid(pid), launch["pid"])
            self.assertEqual(os.getsid(pid), launch["pid"])
        marker_path = self.marker_path(launch)
        marker = marker_path.read_bytes()
        self.assertNotIn(token, marker)
        self.assertEqual(marker_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(marker)["token_sha256"], hashlib.sha256(token).hexdigest())
        public = self.cli("--probe-owned", self.creds(launch))
        self.assertEqual(public, {"ok": True, "alive": True})
        stopped = self.cli("--stop", self.creds(launch))
        self.assertEqual(stopped, {"ok": True, "stopped": True})
        self.assertTrue(until(lambda: not running(report["model_pid"])))
        self.assertFalse(marker_path.exists())
        self.assertEqual(self.cli("--probe-owned", self.creds(launch)), {"ok": True, "alive": False})

    def test_wrong_token_cannot_stop_and_unrelated_child_survives(self):
        external = subprocess.Popen(["/usr/bin/python3", "-c", "import time; time.sleep(120)"],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            launch, report = self.start()
            wrong = dict(self.creds(launch), control_token="0" * 64)
            self.assertEqual(self.cli("--probe-owned", wrong), {"ok": True, "alive": False})
            self.assertEqual(self.cli("--stop", wrong), {"ok": False, "error": "not_owned"})
            self.assertTrue(running(report["service_pid"]))
            self.cli("--stop", self.creds(launch))
            self.assertIsNone(external.poll())
        finally:
            external.terminate()
            external.wait(timeout=3)

    def test_real_marker_tampering_never_signals_wrong_identity(self):
        launch, report = self.start()
        path = self.marker_path(launch)
        original = json.loads(path.read_text())
        for field, value in (("start_time", "0"), ("uid", os.getuid() + 1),
                             ("boot_id", "wrong"), ("runtime_helper", "/external/helper.py"),
                             ("pid", os.getpid()), ("session", os.getpid()),
                             ("script_path", "/external/server.py")):
            with self.subTest(field=field):
                changed = dict(original, **{field: value})
                path.write_text(json.dumps(changed))
                self.assertFalse(self.cli("--stop", self.creds(launch))["ok"])
                self.assertTrue(running(report["service_pid"]))
        path.write_text(json.dumps(original))
        self.assertTrue(self.cli("--stop", self.creds(launch))["ok"])

    def test_server_death_cleans_orphan_term_ignoring_model_group(self):
        launch, report = self.start()
        self.assertTrue(running(report["model_pid"]))
        os.kill(report["service_pid"], signal.SIGKILL)
        self.assertTrue(until(lambda: not running(report["model_pid"])))
        self.assertTrue(until(lambda: not running(launch["pid"])))
        self.assertFalse(self.marker_path(launch).exists())

    def held_start(self, read_reply=True):
        staged = self.cli("--stage", stage_request(files_for(SLEEP_SERVER.encode())))
        model = self.home / "held-model"
        model.mkdir()
        request = {"script_path": staged["script_path"], "python_path": "/usr/bin/python3",
                   "model_dir": str(model), "native_lib": "/fixture/native.so"}
        child = subprocess.Popen(["/usr/bin/python3", "-c", CODE, "--launch-held"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env)
        def cleanup():
            child.stdin.close()
            if child.poll() is None:
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=3)
            child.stdout.close()
            child.stderr.close()
        self.addCleanup(cleanup)
        child.stdin.write(json.dumps(request).encode() + b"\n")
        child.stdin.flush()
        lease = None
        if read_reply:
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(5))
            lease = json.loads(child.stdout.readline())
            self.assertTrue(lease["ok"], lease)
        return child, model, lease

    def test_held_launch_eof_stops_owned_group(self):
        child, model, lease = self.held_start()
        self.assertTrue(until(lambda: (model / "report.json").exists()))
        pids = json.loads((model / "report.json").read_text())
        self.assertIsNone(child.poll())
        self.assertTrue(self.cli("--probe-owned", self.creds(lease))["alive"])
        child.stdin.close()
        self.assertEqual(child.wait(timeout=4), 0)
        self.assertTrue(until(lambda: not running(pids["model_pid"])))
        self.assertFalse(running(pids["service_pid"]))
        self.assertFalse(self.marker_path(lease).exists())
        self.assertEqual(child.stdout.read(), b"")
        self.assertEqual(child.stderr.read(), b"")

    def test_held_unreceived_lease_eof_cleans_resident_service(self):
        child, model, _ = self.held_start(read_reply=False)
        self.assertTrue(until(lambda: (model / "report.json").exists()))
        pids = json.loads((model / "report.json").read_text())
        child.stdin.close()  # native cancellation before reading any private lease
        self.assertEqual(child.wait(timeout=4), 0)
        self.assertTrue(until(lambda: not running(pids["model_pid"])))
        self.assertFalse(running(pids["service_pid"]))
        owned = self.home / ".dsh-wsl-desktop/speech/service/owned"
        self.assertEqual(list(owned.iterdir()), [])
        self.assertEqual(child.stderr.read(), b"")

    def test_held_startup_eof_cannot_orphan_service(self):
        child, model, _ = self.held_start(read_reply=False)
        child.stdin.close()
        self.assertEqual(child.wait(timeout=4), 0)
        owned = self.home / ".dsh-wsl-desktop/speech/service/owned"
        self.assertFalse(owned.exists() and list(owned.iterdir()))
        if (model / "report.json").exists():
            pids = json.loads((model / "report.json").read_text())
            self.assertTrue(until(lambda: not running(pids["model_pid"])))
            self.assertFalse(running(pids["service_pid"]))
        self.assertEqual(child.stderr.read(), b"")

    def test_held_owner_sigkill_triggers_supervisor_parent_death_cleanup(self):
        child, model, lease = self.held_start()
        self.assertTrue(until(lambda: (model / "report.json").exists()))
        pids = json.loads((model / "report.json").read_text())
        child.kill()  # Linux owner helper dies without Python finally handlers
        self.assertEqual(child.wait(timeout=2), -signal.SIGKILL)
        self.assertTrue(until(lambda: not running(pids["model_pid"])))
        self.assertTrue(until(lambda: not running(pids["service_pid"])))
        self.assertTrue(until(lambda: not running(lease["pid"])))
        self.assertFalse(self.marker_path(lease).exists())
        self.assertEqual(child.stderr.read(), b"")

    def test_held_helper_exits_on_service_death_even_with_stdin_open(self):
        child, model, lease = self.held_start()
        self.assertTrue(until(lambda: (model / "report.json").exists()))
        pids = json.loads((model / "report.json").read_text())
        os.kill(pids["service_pid"], signal.SIGKILL)
        self.assertEqual(child.wait(timeout=4), 0)
        self.assertTrue(until(lambda: not running(pids["model_pid"])))
        self.assertFalse(self.marker_path(lease).exists())
        self.assertEqual(child.stdout.read(), b"")
        self.assertEqual(child.stderr.read(), b"")

    def test_launch_broken_private_reply_pipe_cleans_group(self):
        staged = self.cli("--stage", stage_request(files_for(SLEEP_SERVER.encode())))
        model = self.home / "broken-reply-model"
        model.mkdir()
        request = {"script_path": staged["script_path"], "python_path": "/usr/bin/python3",
                   "model_dir": str(model), "native_lib": "/fixture/native.so"}
        child = subprocess.Popen(["/usr/bin/python3", "-c", CODE, "--launch"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env)
        child.stdout.close()  # app dies before receiving its private launch result
        child.stdin.write(json.dumps(request).encode())
        child.stdin.close()
        try:
            self.assertEqual(child.wait(timeout=8), 0)
            self.assertEqual(child.stderr.read(), b"")
            owned = self.home / ".dsh-wsl-desktop/speech/service/owned"
            self.assertEqual(list(owned.iterdir()), [])
            if (model / "report.json").exists():
                pids = json.loads((model / "report.json").read_text())
                self.assertTrue(until(lambda: not running(pids["service_pid"])))
                self.assertTrue(until(lambda: not running(pids["model_pid"])))
        finally:
            child.stderr.close()
            if child.poll() is None:
                child.kill()
                child.wait(timeout=3)

    def test_failed_supervisor_before_marker_cleans_descendant_group(self):
        crashing_helper = r"""
import json,os,pathlib,subprocess,sys,time
config=json.load(sys.stdin)
root=pathlib.Path(config['model_dir'])
model=subprocess.Popen([sys.executable,'-c',"import pathlib,signal,sys,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path(sys.argv[1]).write_text('ready'); time.sleep(120)",str(root/'ready')])
deadline=time.monotonic()+2
while not (root/'ready').exists() and time.monotonic()<deadline:
    time.sleep(.01)
(root/'pids.json').write_text(json.dumps({'supervisor':os.getpid(),'nested':model.pid}))
os._exit(1)
"""
        files = files_for()
        files["managed_runtime.py"] = crashing_helper.encode()
        staged = self.cli("--stage", stage_request(files))
        model = self.home / "failed-supervisor"
        model.mkdir()
        result = self.cli("--launch", {"script_path": staged["script_path"],
            "python_path": "/usr/bin/python3", "model_dir": str(model), "native_lib": "/fixture/native.so"})
        self.assertEqual(result, {"ok": False, "error": "launch_failed"})
        pids = json.loads((model / "pids.json").read_text())
        self.assertFalse(running(pids["supervisor"]))
        self.assertTrue(until(lambda: not running(pids["nested"])))

    def test_native_stdin_bootstrap_preserves_python_c_protocol(self):
        bootstrap = "import base64,json,sys; source=json.loads(sys.stdin.buffer.readline(131073))['source']; exec(compile(base64.b64decode(source),'<speech-runtime>','exec'),{'__name__':'__main__'})"
        data = json.dumps({"source": base64.b64encode(CODE.encode()).decode()}).encode() + b"\n"
        data += json.dumps({"instance_id": "1"*64, "control_token": "2"*64}).encode()
        result = subprocess.run(["/usr/bin/python3", "-c", bootstrap, "--probe-owned"],
            input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(json.loads(result.stdout), {"ok": True, "alive": False})

    def test_external_script_bad_paths_and_private_errors(self):
        staged = self.cli("--stage", stage_request(files_for()))
        request = {"script_path": staged["script_path"], "python_path": "/usr/bin/python3",
                   "model_dir": str(self.home / "model"), "native_lib": str(self.home / "private-secret-path")}
        for key, value in (("script_path", "/external/server.py"), ("python_path", "relative"),
                           ("model_dir", "/path\nsecret"), ("native_lib", "/path/../other")):
            result = self.cli("--launch", dict(request, **{key: value}))
            self.assertFalse(result["ok"])
            self.assertEqual(set(result), {"ok", "error"})
            self.assertNotIn(str(self.home), json.dumps(result))
        result = self.cli("--launch", dict(request, python_path="/nonexistent-private-python"))
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "launch_failed")

    def inspect_start(self, checker, timeout=None):
        files = files_for()
        files["runtime_check.py"] = checker.encode()
        stage = self.cli("--stage", stage_request(files))
        self.assertTrue(stage["ok"], stage)
        model = self.home / "inspect-model"
        model.mkdir(exist_ok=True)
        code = CODE if timeout is None else CODE.replace("INSPECT_TIMEOUT = 180.0", "INSPECT_TIMEOUT = " + str(timeout))
        child = subprocess.Popen(["/usr/bin/python3", "-c", code, "--inspect"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env)
        request = {"script_path": stage["script_path"], "python_path": "/usr/bin/python3",
                   "model_dir": str(model), "native_lib": "/fixture/native.so"}
        child.stdin.write(json.dumps(request).encode() + b"\n")
        child.stdin.flush()
        return child, model

    def inspect_finish(self, child):
        try:
            self.assertEqual(child.wait(timeout=5), 0)
            data = child.stdout.read(runtime.INSPECT_OUTPUT_CAP + 1)
            self.assertLessEqual(len(data), runtime.INSPECT_OUTPUT_CAP)
            self.assertEqual(child.stderr.read(), b"")
            return [json.loads(line) for line in data.splitlines()]
        finally:
            child.stdin.close()
            child.stdout.close()
            child.stderr.close()
            if child.poll() is None:
                child.kill()
                child.wait(timeout=3)

    def test_inspect_streams_progress_result_with_stdin_kept_open(self):
        checker = "import json; print(json.dumps({'kind':'progress','progress':25}),flush=True); print(json.dumps({'kind':'result','environment_ok':True,'models_ok':True,'gpu_name':'AMD fixture','error_code':None}),flush=True)"
        child, _ = self.inspect_start(checker)
        events = self.inspect_finish(child)
        self.assertEqual(events, [{"kind": "progress", "progress": 25},
            {"kind": "result", "environment_ok": True, "models_ok": True,
             "gpu_name": "AMD fixture", "error_code": None}])

    def test_inspect_cuda_result_and_auto_device_reach_the_staged_checker(self):
        checker = "import json,sys; assert sys.argv[sys.argv.index('--device')+1]=='auto'; print(json.dumps({'kind':'result','environment_ok':True,'models_ok':True,'gpu_name':'NVIDIA fixture','error_code':None,'backend':'cuda','device':'CUDA0'}),flush=True)"
        child, _ = self.inspect_start(checker)
        events = self.inspect_finish(child)
        self.assertTrue(events[-1]["environment_ok"])
        self.assertEqual((events[-1]["backend"], events[-1]["device"]), ("cuda", "CUDA0"))

    def inspect_sleep_checker(self):
        return r"""
import json,os,pathlib,signal,subprocess,sys,time
root = pathlib.Path(sys.argv[sys.argv.index('--models')+1])
child = subprocess.Popen([sys.executable,'-c',"import pathlib,signal,sys,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path(sys.argv[1]).write_text('ready'); time.sleep(120)",str(root/'nested-ready')])
deadline=time.monotonic()+2
while not (root/'nested-ready').exists() and time.monotonic()<deadline:
    time.sleep(.01)
(root/'check-pids.json').write_text(json.dumps({'checker':os.getpid(),'nested':child.pid}))
print(json.dumps({'kind':'progress','progress':1}),flush=True)
time.sleep(120)
"""

    def test_inspect_stdin_eof_cancels_checker_and_nested_probe_group(self):
        child, model = self.inspect_start(self.inspect_sleep_checker())
        try:
            self.assertTrue(until(lambda: (model / "check-pids.json").exists()))
            pids = json.loads((model / "check-pids.json").read_text())
            self.assertEqual(os.getsid(pids["checker"]), pids["checker"])
            self.assertEqual(os.getpgid(pids["nested"]), pids["checker"])
            child.stdin.close()
            events = self.inspect_finish(child)
            self.assertEqual(events[-1]["error_code"], "check_cancelled")
            self.assertTrue(until(lambda: not running(pids["nested"])))
            self.assertFalse(running(pids["checker"]))
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=3)

    def test_inspect_hard_deadline_cleans_nested_probe_group(self):
        child, model = self.inspect_start(self.inspect_sleep_checker(), timeout=.25)
        events = self.inspect_finish(child)
        pids = json.loads((model / "check-pids.json").read_text())
        self.assertEqual(events[-1]["error_code"], "check_timeout")
        self.assertTrue(until(lambda: not running(pids["nested"])))
        self.assertFalse(running(pids["checker"]))

    def test_inspect_rejects_raw_output_oversize_and_untrusted_fields(self):
        for checker, expected in (
            ("print('RAW private /path/user',flush=True)", "invalid_check_output"),
            ("print('X'*9000,flush=True)", "check_output_too_large"),
            ("print('{\"kind\":\"progress\",\"progress\":NaN}',flush=True)", "invalid_check_output"),
            ("import json; print(json.dumps({'kind':'result','environment_ok':False,'models_ok':False,'gpu_name':None,'error_code':'/raw/path'}),flush=True)", "invalid_check_output")):
            with self.subTest(expected=expected):
                child, _ = self.inspect_start(checker)
                events = self.inspect_finish(child)
                self.assertEqual(events[-1]["error_code"], expected)
                self.assertNotIn("/path", json.dumps(events))
                self.assertNotIn("/raw", json.dumps(events))

    def test_inspect_eof_cancels_even_when_native_stops_reading_stdout(self):
        checker = self.inspect_sleep_checker().rsplit("time.sleep(120)", 1)[0]
        checker += "while True:\n    print(json.dumps({'kind':'progress','progress':1}),flush=True)\n"
        child, model = self.inspect_start(checker)
        try:
            self.assertTrue(until(lambda: (model / "check-pids.json").exists()))
            pids = json.loads((model / "check-pids.json").read_text())
            # Deliberately do not drain the output pipe; force backpressure.
            time.sleep(.1)
            child.stdin.close()
            self.assertEqual(child.wait(timeout=2), 0)
            self.assertTrue(until(lambda: not running(pids["nested"])))
            self.assertFalse(running(pids["checker"]))
            self.assertEqual(child.stderr.read(), b"")
        finally:
            child.stdout.close()
            child.stderr.close()
            if child.poll() is None:
                child.kill()
                child.wait(timeout=3)

    def test_inspect_total_output_cap(self):
        checker = "import json; line=json.dumps({'kind':'progress','progress':1}); print((line+'\\n')*3000,flush=True)"
        child, _ = self.inspect_start(checker)
        # Drain while the checker runs, just as the native adapter does.
        output = bytearray()
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                available = selector.select(.1)
                if available:
                    chunk = os.read(child.stdout.fileno(), 8192)
                    if not chunk:
                        break
                    output.extend(chunk)
        self.inspect_finish(child)
        self.assertLessEqual(len(output), runtime.INSPECT_OUTPUT_CAP)
        self.assertGreater(len(output.splitlines()), 100)
        self.assertEqual(json.loads(output.splitlines()[-1])["error_code"], "check_output_too_large")

    def test_cli_is_not_a_shell_or_generic_command_parser(self):
        for action in ("echo", "--exec", "--install", "--download", "--probe"):
            self.assertEqual(self.cli(action, {"command": "touch /tmp/never"}),
                             {"ok": False, "error": "invalid_request"})
        self.assertEqual(self.cli("--stop", raw=b"x" * (runtime.SMALL_INPUT_CAP + 1)),
                         {"ok": False, "error": "input_too_large"})
        self.assertEqual(self.cli("--stop", raw=b'{"instance_id":"private-path"}'),
                         {"ok": False, "error": "invalid_request"})


if __name__ == "__main__":
    unittest.main()
