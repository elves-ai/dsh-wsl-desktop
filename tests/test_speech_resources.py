"""Offline fixtures only: never fetch weights, install packages or initialize GPUs."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "src-tauri/helpers/speech_resources.py"
spec = importlib.util.spec_from_file_location("speech_resources", HELPER)
resources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resources)


class Response(io.BytesIO):
    def __init__(self, data, length=None):
        super().__init__(data)
        self.headers = {"Content-Length": str(len(data) if length is None else length)}


class ResourcesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.home_patch = patch.dict(os.environ, {"HOME": str(self.root)})
        self.home_patch.start()
        self.model = self.root / "models"
        self.data = {"talker.gguf": b"GGUF-fixture-one", "codec.gguf": b"GGUF-fixture-two"}
        self.hashes = {n: hashlib.sha256(b).hexdigest() for n, b in self.data.items()}
        self.events = []
        self.urls = []

    def tearDown(self):
        self.home_patch.stop()
        self.temp.cleanup()

    def open(self, url):
        self.urls.append(url)
        self.assertTrue(url.startswith(resources.BASE_URL))
        return Response(self.data[url.rsplit("/", 1)[1]])

    def download(self, cancelled=lambda: False, opener=None):
        with patch.object(resources, "MODELS", self.hashes):
            return resources.download({"model_dir": str(self.model)}, self.events.append,
                                      cancelled, opener or self.open)

    def no_parts(self):
        self.assertFalse(list(self.model.glob("*.part")))

    def test_manifest_matches_native_runtime_exactly(self):
        native_spec = importlib.util.spec_from_file_location("native", ROOT / "services/qwen_tts/native_q8.py")
        native = importlib.util.module_from_spec(native_spec)
        native_spec.loader.exec_module(native)
        self.assertEqual(resources.MODELS, native.MODEL_SHA256)
        self.assertEqual(resources.REVISION, "b7ee2e8c7459c3bea99da23e3d178125a7d1713c")
        self.assertEqual(len(resources.MODELS), 2)
        self.assertTrue(all(name.endswith("Q8_0.gguf") for name in resources.MODELS))

    def test_absolute_and_pseudo_paths_rejected(self):
        for value in ("relative", "//home", "/home/../tmp", "/home/./a", "/home/", "/a\nb", "/a:b", "/a\\b"):
            with self.subTest(value=value), self.assertRaises(resources.Refused):
                resources.absolute(value)
        for value in ("/proc", "/proc/self", "/sys/kernel", "/dev", "/run/user"):
            with self.assertRaises(resources.Refused):
                resources.allowed(value)
        self.assertEqual(resources.absolute("/home/test/a ; $(touch bad)"), "/home/test/a ; $(touch bad)")

    def test_browser_filters_special_files_and_directory_links(self):
        (self.root / "directory").mkdir()
        (self.root / "python3").symlink_to(sys.executable)
        (self.root / "dir-link").symlink_to(self.root / "directory", target_is_directory=True)
        (self.root / "secret.txt").write_text("never returned")
        (self.root / "libqwen.so").write_bytes(b"not loaded")
        os.mkfifo(self.root / "fifo")
        model = resources.browse({"path": str(self.root), "kind": "model_dir"})
        self.assertEqual([x["name"] for x in model["entries"]], ["directory"])
        with self.assertRaisesRegex(resources.Refused, "^invalid_request$"):
            resources.browse({"path": str(self.root), "kind": "python_path"})
        native = resources.browse({"path": str(self.root), "kind": "native_lib"})
        self.assertEqual([x["name"] for x in native["entries"]], ["directory", "libqwen.so"])
        self.assertEqual(native["parent"], str(self.root.parent))
        self.assertNotIn("never returned", json.dumps(native))

    def test_browser_null_home_root_and_closed_schema(self):
        with patch.object(resources.Path, "home", return_value=self.root):
            self.assertEqual(resources.browse({"path": None, "kind": "model_dir"})["path"], str(self.root))
        self.assertIsNone(resources.browse({"path": "/", "kind": "model_dir"})["parent"])
        for request in ({"path": str(self.root), "kind": "shell"},
                        {"path": str(self.root), "kind": "model_dir", "command": "ls"}):
            with self.assertRaises(resources.Refused):
                resources.browse(request)

    def test_browser_refuses_symlink_ancestors(self):
        (self.root / "alias").symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            resources.browse({"path": str(self.root / "alias"), "kind": "model_dir"})

    def test_browser_is_bounded(self):
        for i in range(210):
            (self.root / str(i)).mkdir()
        result = resources.browse({"path": str(self.root), "kind": "model_dir"})
        self.assertEqual(len(result["entries"]), 200)
        self.assertTrue(result["truncated"])

    def test_success_progress_hash_atomic_and_retry_reuses_valid(self):
        self.assertEqual(self.download(), {"ok": True})
        self.assertEqual(len(self.urls), 2)
        for name, data in self.data.items():
            self.assertEqual((self.model / name).read_bytes(), data)
        values = [x["downloaded_bytes"] for x in self.events]
        self.assertEqual(values, sorted(values))
        self.assertEqual(self.events[-1]["total_bytes"], sum(map(len, self.data.values())))
        self.no_parts()
        before = {n: (self.model / n).stat().st_ino for n in self.data}
        self.download()
        self.assertEqual(len(self.urls), 2)
        self.assertEqual(before, {n: (self.model / n).stat().st_ino for n in self.data})

    def test_hash_failure_never_publishes_and_can_retry(self):
        with self.assertRaisesRegex(resources.Refused, "model_hash_mismatch"):
            self.download(opener=lambda url: Response(b"wrong model"))
        self.assertFalse((self.model / "talker.gguf").exists())
        self.no_parts()
        self.download()

    def test_content_length_failure_does_not_publish(self):
        with self.assertRaisesRegex(resources.Refused, "incomplete_download"):
            self.download(opener=lambda url: Response(b"partial", 100))
        self.assertFalse((self.model / "talker.gguf").exists())
        self.no_parts()

    def test_cancel_removes_partial_and_does_not_publish(self):
        cancelled = False
        class CancelResponse(Response):
            def read(inner, size):
                nonlocal cancelled
                result = super(CancelResponse, inner).read(size)
                cancelled = True
                return result
        with self.assertRaisesRegex(resources.Refused, "cancelled"):
            self.download(lambda: cancelled, lambda url: CancelResponse(self.data["talker.gguf"]))
        self.assertFalse((self.model / "talker.gguf").exists())
        self.no_parts()
        self.download()

    def test_network_error_keeps_prior_complete_file_for_retry(self):
        def fail_second(url):
            if url.endswith("codec.gguf"):
                raise OSError("private network detail")
            return self.open(url)
        with self.assertRaises(OSError):
            self.download(opener=fail_second)
        self.assertEqual((self.model / "talker.gguf").read_bytes(), self.data["talker.gguf"])
        self.assertFalse((self.model / "codec.gguf").exists())
        self.no_parts()
        self.download()

    def test_existing_invalid_file_is_not_overwritten(self):
        self.model.mkdir()
        target = self.model / "talker.gguf"
        target.write_bytes(b"user data")
        with self.assertRaisesRegex(resources.Refused, "existing_model_mismatch"):
            self.download()
        self.assertEqual(target.read_bytes(), b"user data")
        self.assertFalse(self.urls)

    def test_symlink_destination_and_file_are_not_followed(self):
        self.model.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            self.download()
        self.model.unlink()
        self.model.mkdir()
        external = self.root / "outside"
        external.write_bytes(b"do not touch")
        (self.model / "talker.gguf").symlink_to(external)
        with self.assertRaises(OSError):
            self.download()
        self.assertEqual(external.read_bytes(), b"do not touch")

    def test_group_writable_directory_is_refused(self):
        self.model.mkdir(mode=0o777)
        self.model.chmod(0o777)
        with self.assertRaisesRegex(resources.Refused, "unsafe_download_directory"):
            self.download()
        self.assertFalse(self.urls)

    def test_commit_never_overwrites_file_created_during_download(self):
        def race(url):
            (self.model / "talker.gguf").write_bytes(b"race winner")
            return Response(self.data["talker.gguf"])
        with self.assertRaisesRegex(resources.Refused, "existing_model_mismatch"):
            self.download(opener=race)
        self.assertEqual((self.model / "talker.gguf").read_bytes(), b"race winner")
        self.no_parts()

    def test_existing_fifo_is_refused_without_blocking(self):
        self.model.mkdir()
        os.mkfifo(self.model / "talker.gguf")
        with self.assertRaisesRegex(resources.Refused, "unsafe_model_file"):
            self.download()

    def test_directory_lock_blocks_another_download(self):
        self.model.mkdir()
        fd = os.open(self.model / ".dsh-q8-download.lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            resources.fcntl.flock(fd, resources.fcntl.LOCK_EX | resources.fcntl.LOCK_NB)
            with self.assertRaisesRegex(resources.Refused, "download_busy"):
                self.download()
        finally:
            os.close(fd)
        self.assertFalse(self.urls)

    def test_trusted_redirect_allowlist(self):
        for url in (resources.BASE_URL + "file", "https://cas-bridge.xethub.hf.co/path?signature=x"):
            self.assertEqual(resources.trusted_url(url), url)
        for url in ("http://huggingface.co/x", "https://huggingface.co.evil.test/x", "https://evil.test/x",
                    "file:///etc/passwd", "https://user:pass@huggingface.co/x", "https://huggingface.co:444/x"):
            with self.subTest(url=url), self.assertRaises(resources.Refused):
                resources.trusted_url(url)

    def test_candidates_only_check_default_and_fixed_system_bases(self):
        paths = [self.root / ".venv/bin/python", self.root / "miniconda3/envs/tts/bin/python",
                 self.root / "project/.venv/bin/python", self.root / "custom/bin/python3"]
        for path in paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(sys.executable)
        expected = [str(self.root / resources.SPEECH_ROOT / "runtime/venv/bin/python"),
                    "/usr/bin/python3", "/usr/local/bin/python3"]
        environ = {"PATH": str(paths[-1].parent), "VIRTUAL_ENV": str(paths[0].parent.parent),
                   "CONDA_PREFIX": str(paths[1].parent.parent)}
        with patch.dict(os.environ, environ), \
             patch.object(resources.os.path, "isfile", return_value=True) as isfile, \
             patch.object(resources.os, "access", return_value=True), \
             patch.object(resources.Path, "iterdir", side_effect=AssertionError("no scan")), \
             patch("shutil.which", side_effect=AssertionError("no PATH lookup")):
            result = resources.candidates(self.root)
        self.assertEqual(result, expected)
        self.assertEqual([call.args[0] for call in isfile.call_args_list], expected)
        self.assertTrue(all(path.is_symlink() for path in paths))

    def test_probe_requires_only_modern_python_and_stdlib_venv(self):
        for version, expected in (("3.9.9", "python_too_old"), ("3.10.0", "ready"), ("3.14.4", "ready")):
            with self.subTest(version=version):
                self.assertEqual(resources.python_status(version), expected)
                self.assertEqual(resources.python_usable({"status": expected}), expected == "ready")
        self.assertFalse(resources.python_usable({"status": "probe_failed"}))
        result = resources.probe(sys.executable)
        self.assertEqual(result["status"], "ready")
        self.assertTrue(result["ready"])
        self.assertRegex(result["version"], r"^\d+\.\d+\.\d+$")

    def test_probe_and_initialize_skip_gpu_metadata_libraries_imports_and_site_hooks(self):
        selected = self.managed_environment(sdk=True)
        packages = Path(selected).parent.parent / "lib" / ("python%d.%d" % sys.version_info[:2]) / "site-packages"
        for name in ("nvidia", "torch"):
            (packages / (name + ".py")).write_text("raise AssertionError('must not import GPU')")
        for name in ("nvidia-cuda-runtime-cu12", "nvidia-cublas-cu12"):
            metadata = packages / (name + "-1.0.dist-info")
            metadata.mkdir()
            (metadata / "METADATA").write_text("Name: " + name + "\nVersion: 1.0\n")
        guard = """
import sys

def guard(event, args):
    if event.startswith('socket.') or event == 'ctypes.dlopen':
        raise AssertionError('no network or native libraries')
    if event == 'import' and (args[0].split('.')[0] in {'torch', 'nvidia', 'rocm_sdk'} or args[0] == 'importlib.metadata'):
        raise AssertionError('no GPU imports or metadata')
    if event in {'open', 'os.listdir', 'os.scandir', 'glob.glob'} and args:
        path = str(args[0])
        if any(part in path for part in ('site-packages', '.dist-info', '/sys/bus/pci', '/usr/local/cuda', 'libcudart', 'libcublas', '/opt/rocm')):
            raise AssertionError('no package or GPU scan')
sys.addaudithook(guard)
"""
        environment = {key: str(packages) for key in ("PYTHONPATH", "CUDA_HOME", "CUDA_PATH", "CUDAToolkit_ROOT", "LD_LIBRARY_PATH")}
        with patch.dict(os.environ, environment), \
             patch.object(resources, "PROBE", guard + resources.PROBE), \
             patch.object(resources.subprocess, "Popen", wraps=subprocess.Popen) as popen, \
             patch.object(resources, "run_initialize", side_effect=AssertionError("read-only reuse")), \
             patch.object(resources, "opener", side_effect=AssertionError("offline only")):
            checked = resources.probe(selected)
            self.assertEqual(checked["status"], "ready")
            result = self.initialize()
        self.assertTrue(result["reused_python"])
        self.assertEqual(result["config"]["python_path"], selected)
        for call in popen.call_args_list:
            self.assertEqual(call.args[0][1:5], ["-I", "-S", "-B", "-c"])
            self.assertEqual(call.kwargs["env"], {"PATH": "/usr/bin:/bin", "HOME": str(self.root)})
        self.assertFalse((self.root / "poison").exists())

    def test_probe_old_broken_malformed_and_missing_venv_fail_closed(self):
        binary = self.root / "python-fixture"
        cases = [("print('{\"version\":\"3.9.9\"}')", "python_too_old"),
                 ("print('private output'); raise SystemExit(1)", "probe_failed"),
                 ("print('{\"version\":\"broken\"}')", "probe_failed"),
                 ("print('x' * 12000)", "probe_failed"),
                 ("import time; time.sleep(10)", "probe_failed")]
        for body, status in cases:
            with self.subTest(body=body):
                binary.write_text("#!" + sys.executable + "\n" + body + "\n")
                binary.chmod(0o700)
                result = resources.probe(str(binary))
                self.assertEqual(result["status"], status)
                self.assertFalse(result["ready"])
                self.assertNotIn("private", json.dumps(result))
        no_venv = """
import sys
class NoVenv:
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'venv':
            raise ModuleNotFoundError('fixture: venv unavailable')
sys.meta_path.insert(0, NoVenv())
"""
        with patch.object(resources, "PROBE", no_venv + resources.PROBE):
            self.assertEqual(resources.probe(sys.executable)["status"], "probe_failed")

    def test_removed_discovery_command_cannot_read_config_scan_or_run(self):
        external = self.environment(sdk=True, venv=True)
        config = self.legacy_config(external)
        original = config.read_bytes()
        body = ("defused=lambda *a,**kw: (_ for _ in ()).throw(AssertionError('no discovery')); "
                "m.candidates=defused; m.probe=defused; m.read_initialize_json=defused; "
                "m.browse=defused; m.initialize=defused; m.download=defused")
        for request in (b'{}', json.dumps({"python_path": external, "model_dir": "", "native_lib": ""}).encode()):
            with self.subTest(request=request):
                result = subprocess.run([sys.executable, "-B", "-c", self._held_runner(body), "--resources-discover"],
                                        input=request, capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(json.loads(result.stdout), {"ok": False, "error": "invalid_request"})
                self.assertEqual(result.stderr, b"")
        for name in ("discover", "detect_gpu", "gpu_command", "gpu_vendor", "initialized_config"):
            self.assertFalse(hasattr(resources, name))
        self.assertEqual(config.read_bytes(), original)
        self.assertFalse((config.parent / "runtime").exists())
        self.assertFalse((self.root / "poison").exists())

    def test_initialize_creates_default_instead_of_reusing_external_project_venv(self):
        external = self.environment(sdk=True, venv=True, name="work/project/.tools/qwen-rocm-wsl/venv")
        with patch.object(resources, "candidates", return_value=[sys.executable]), \
             patch.object(resources, "probe", return_value={"status": "ready"}), \
             patch.object(resources, "run_initialize", side_effect=self.fake_initialize_run):
            result = self.initialize(python_path=external)
        self.assertTrue(result["created_venv"])
        self.assertEqual(result["config"]["python_path"],
                         str(self.root / resources.SPEECH_ROOT / "runtime/venv/bin/python"))
        self.assertTrue(Path(external).is_symlink())
        self.assertFalse((self.root / "poison").exists())

    def test_initialize_reuses_default_without_sdk_even_if_external_is_ready(self):
        fd = resources.initialize_root(self.root, create=True)
        os.close(fd)
        managed = self.environment(venv=True, name=resources.SPEECH_ROOT + "/runtime/venv")
        external = self.environment(sdk=True, venv=True)
        with patch.object(resources, "candidates", return_value=[managed, external]), \
             patch.object(resources, "run_initialize", side_effect=AssertionError("reuse default")):
            result = self.initialize()
        self.assertTrue(result["reused_python"])
        self.assertEqual(result["config"]["python_path"], managed)

    def test_candidates_ignore_legacy_environments_without_moving_them(self):
        paths = [self.root / ".dsh-wsl-desktop/speech/runtime/venv/bin/python",
                 self.root / ".local/share/dsh-pet/qwen-runtime/venv/bin/python",
                 self.root / ".local/share/dsh-speech/venv/bin/python",
                 self.root / ".local/share/dsh-speech/qwen-runtime/venv/bin/python"]
        for path in paths:
            path.parent.mkdir(parents=True)
            path.symlink_to(sys.executable)
        result = resources.candidates(self.root)
        self.assertEqual(result[0], str(paths[0]))
        self.assertTrue(all(str(path) not in result for path in paths[1:]))
        self.assertTrue(set(result) <= {str(paths[0]), "/usr/bin/python3", "/usr/local/bin/python3"})
        self.assertTrue(all(path.is_symlink() for path in paths))

    def test_probe_missing_executable_fails_closed(self):
        result = resources.probe("/not/a/python")
        self.assertEqual(result["status"], "probe_failed")
        self.assertFalse(result["ready"])

    def environment(self, sdk=False, venv=False, name="external"):
        binary = self.root / name / "bin/python"
        binary.parent.mkdir(parents=True)
        binary.symlink_to(sys.executable)
        if venv:
            (binary.parent.parent / "pyvenv.cfg").write_text("home = /fixture/base\ninclude-system-site-packages = false\n")
        if sdk:
            packages = binary.parent.parent / "lib" / ("python%d.%d" % sys.version_info[:2]) / "site-packages"
            metadata = packages / "rocm_sdk_core-10.0.dist-info"
            metadata.mkdir(parents=True)
            (metadata / "METADATA").write_text("Name: rocm-sdk-core\nVersion: 10.0\n")
            (packages / "rocm_sdk.py").write_text("raise AssertionError('no imports')")
            (packages / "poison.pth").write_text("import pathlib; pathlib.Path(%r).touch()" % str(self.root / "poison"))
        return str(binary)

    def managed_environment(self, sdk=False):
        fd = resources.initialize_root(self.root, create=True)
        os.close(fd)
        return self.environment(sdk=sdk, venv=True, name=resources.SPEECH_ROOT + "/runtime/venv")

    def initialize(self, **kwargs):
        return resources.initialize({"python_path": "", "model_dir": "", "native_lib": "", **kwargs})

    def fake_initialize_run(self, command, cancelled, error, **kwargs):
        resources.require(not cancelled(), "cancelled")
        if "venv" in command:
            path = Path(command[-1])
            (path / "bin").mkdir(exist_ok=True)
            (path / "bin/python").write_bytes(b"fixture, never executed")
            (path / "bin/python").chmod(0o700)
            (path / "pyvenv.cfg").write_text("home = /fixture/base\n")
        return False if kwargs.get("optional") and "importlib.util" in command[-1] else True

    def test_initialize_reuses_default_without_install_or_site_hooks(self):
        selected = self.managed_environment(sdk=True)
        with patch.object(resources, "candidates", return_value=[selected]), \
             patch.object(resources, "run_initialize", side_effect=AssertionError("must not run venv")), \
             patch.object(resources, "opener", side_effect=AssertionError("offline only")):
            result = self.initialize(python_path=selected)
        speech = self.root / resources.SPEECH_ROOT
        expected = {"python_path": selected, "model_dir": str(speech / "models/qwen3-tts-q8"), "native_lib": ""}
        self.assertEqual(result, {"config": expected, "config_path": str(speech / "config.json"),
                                  "reused_python": True, "created_venv": False})
        self.assertEqual(json.loads((speech / "config.json").read_text()), {"schema_version": 1, "config": expected})
        self.assertEqual((speech / "config.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.root / ".dsh-wsl-desktop").stat().st_mode & 0o777, 0o700)
        self.assertTrue((speech / "models/qwen3-tts-q8").is_dir())
        self.assertTrue(Path(selected).is_symlink())
        self.assertTrue((speech / "runtime/venv/pyvenv.cfg").is_file())
        self.assertFalse((speech / "runtime" / resources.INIT_INTENT).exists())
        self.assertFalse((self.root / "poison").exists())

    def test_initialize_reuses_default_existing_venv_even_without_sdk(self):
        selected = self.managed_environment()
        with patch.object(resources, "candidates", return_value=[selected]), \
             patch.object(resources, "run_initialize", side_effect=AssertionError):
            result = self.initialize(python_path=selected)
        self.assertEqual(result["config"]["python_path"], selected)
        self.assertTrue(result["reused_python"])
        self.assertFalse(result["created_venv"])
        self.assertEqual(resources.probe(selected)["status"], "ready")

    def test_initialize_reuses_default_and_keeps_custom_model_native(self):
        selected = self.managed_environment(sdk=True)
        model = str(self.root / "external-models")
        native = str(self.root / "libqwen.so")
        with patch.object(resources, "candidates", return_value=[selected]), \
             patch.dict(resources.os.environ, {"DSH_QWEN_NATIVE_LIB": "/ignored/environment.so"}), \
             patch.object(resources, "run_initialize", side_effect=AssertionError):
            result = self.initialize(python_path=selected, model_dir=model, native_lib=native)
        self.assertEqual(result["config"], {"python_path": selected, "model_dir": model, "native_lib": native})
        self.assertFalse(Path(model).exists())
        self.assertFalse(Path(native).exists())
        self.assertFalse((self.root / resources.SPEECH_ROOT / "models").exists())

    def test_initialize_readonly_reuses_documented_manually_created_venv(self):
        fd = resources.initialize_root(self.root, create=True)
        os.close(fd)
        selected = self.environment(sdk=True, venv=True, name=resources.SPEECH_ROOT + "/runtime/venv")
        runtime = Path(selected).parent.parent
        before = {str(path.relative_to(runtime)): (path.lstat().st_ino, path.lstat().st_mtime_ns)
                  for path in runtime.rglob("*")}
        with patch.object(resources, "candidates", return_value=[selected]), \
             patch.object(resources, "run_initialize", side_effect=AssertionError("read-only reuse only")):
            result = self.initialize()
        self.assertTrue(result["reused_python"])
        self.assertFalse(result["created_venv"])
        self.assertEqual(result["config"]["python_path"], selected)
        self.assertEqual({str(path.relative_to(runtime)): (path.lstat().st_ino, path.lstat().st_mtime_ns)
                          for path in runtime.rglob("*")}, before)
        self.assertFalse((runtime.parent / resources.INIT_INTENT).exists())
        self.assertFalse((runtime.parent / resources.INIT_COMPLETE).exists())

    def test_initialize_partial_runtime_ready_probe_cannot_bypass_recovery(self):
        def fail(command, cancelled, error, **kwargs):
            if "venv" in command:
                raise resources.Refused("initialize_venv_failed")
            return True
        with patch.object(resources, "candidates", return_value=[sys.executable]), \
             patch.object(resources, "probe", return_value={"status": "ready"}), \
             patch.object(resources, "run_initialize", side_effect=fail):
            with self.assertRaisesRegex(resources.Refused, "^initialize_venv_failed$"):
                self.initialize()
        selected = str(self.root / resources.SPEECH_ROOT / "runtime/venv/bin/python")
        with patch.object(resources, "candidates", return_value=[selected]), \
             patch.object(resources, "probe", return_value={"status": "ready"}), \
             patch.object(resources, "run_initialize", side_effect=fail):
            with self.assertRaisesRegex(resources.Refused, "^initialize_venv_failed$"):
                self.initialize(python_path=selected)
        self.assertFalse((self.root / resources.SPEECH_ROOT / "config.json").exists())

    def test_initialize_real_standard_venv_offline_in_fixed_final_location(self):
        # This is the only real venv creation: all files and bundled pip live in
        # TemporaryDirectory HOME. No package index or real-user setup is used.
        previous_umask = os.umask(0o002)
        try:
            with patch.object(resources, "candidates", return_value=[sys.executable]), \
                 patch.object(resources, "opener", side_effect=AssertionError("offline")):
                result = self.initialize(python_path=sys.executable)
        finally:
            parent_umask = os.umask(previous_umask)
        self.assertEqual(parent_umask, 0o002, "only the initialization child may set a private umask")
        target = self.root / resources.SPEECH_ROOT / "runtime/venv"
        self.assertEqual(result["config"]["python_path"], str(target / "bin/python"))
        self.assertTrue(result["created_venv"])
        self.assertFalse(result["reused_python"])
        self.assertTrue((target / "pyvenv.cfg").is_file())
        self.assertEqual((target / "bin").stat().st_mode & 0o777, 0o700)
        self.assertEqual((target / "pyvenv.cfg").stat().st_mode & 0o777, 0o600)
        self.assertFalse((target / "bin/python").is_symlink())
        checked = subprocess.run([str(target / "bin/python"), "-I", "-B", "-c", "import sys; print(sys.prefix)"],
                                 capture_output=True, timeout=5)
        self.assertEqual(checked.returncode, 0)
        self.assertEqual(checked.stdout.decode().strip(), str(target))
        if (target / "bin/pip").exists():
            self.assertIn(str(target / "bin/python"), (target / "bin/pip").read_text().splitlines()[0])
        before = (target / "pyvenv.cfg").stat().st_mtime_ns
        with patch.object(resources, "run_initialize", side_effect=AssertionError("do not rebuild complete venv")):
            again = self.initialize()
        self.assertEqual(again["config"], result["config"])
        self.assertTrue(again["reused_python"])
        self.assertFalse(again["created_venv"])
        self.assertEqual((target / "pyvenv.cfg").stat().st_mtime_ns, before)

    def test_initialize_normalizes_new_copied_activation_modes_only(self):
        source = self.root / "activation-template"
        source.write_text("fixture activation")
        source.chmod(0o664)
        def create(command, cancelled, error, **kwargs):
            result = self.fake_initialize_run(command, cancelled, error, **kwargs)
            if "venv" in command:
                target = Path(command[-1]) / "bin/activate"
                import shutil
                shutil.copy(source, target)  # CPython venv preserves template mode.
            return result
        with patch.object(resources, "candidates", return_value=[sys.executable]), \
             patch.object(resources, "probe", return_value={"status": "ready"}), \
             patch.object(resources, "run_initialize", side_effect=create):
            result = self.initialize()
        copied = Path(result["config"]["python_path"]).parent / "activate"
        self.assertTrue(result["created_venv"])
        self.assertEqual(copied.read_text(), "fixture activation")
        self.assertEqual(copied.stat().st_mode & 0o777, 0o644)
        self.assertEqual(source.stat().st_mode & 0o777, 0o664)

    def test_initialize_permission_normalization_refuses_links_without_touching_source(self):
        for link in ("hard", "symbolic"):
            with self.subTest(link=link), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                venv = root / "managed"
                venv.mkdir(mode=0o700)
                source = root / "external"
                source.write_text("do not change")
                source.chmod(0o664)
                if link == "hard":
                    os.link(source, venv / "activate")
                else:
                    (venv / "activate").symlink_to(source)
                with self.assertRaises(resources.Refused):
                    resources.check_managed_venv(venv, normalize_permissions=True)
                self.assertEqual(source.stat().st_mode & 0o777, 0o664)
                self.assertEqual(source.read_text(), "do not change")

    def test_existing_writable_managed_files_are_not_silently_repaired(self):
        tree = self.root / "existing-tree"
        tree.mkdir(mode=0o700)
        file = tree / "activate"
        file.write_text("keep mode")
        file.chmod(0o664)
        with self.assertRaises(resources.Refused):
            resources.check_managed_venv(tree)
        self.assertEqual(file.stat().st_mode & 0o777, 0o664)

    def test_initialize_ignores_explicit_sdkless_external_venv_and_uses_system_base(self):
        external = self.environment(venv=True)
        with patch.object(resources, "candidates", return_value=[sys.executable]), \
             patch.object(resources, "probe", return_value={"status": "ready"}), \
             patch.object(resources, "run_initialize", side_effect=self.fake_initialize_run) as run:
            result = self.initialize(python_path=external)
        self.assertTrue(result["created_venv"])
        self.assertTrue(result["config"]["python_path"].endswith("/speech/runtime/venv/bin/python"))
        venv_command = next(call.args[0] for call in run.call_args_list if "venv" in call.args[0])
        self.assertEqual(venv_command[0], sys.executable)
        self.assertIn("--copies", venv_command)
        self.assertIn("--without-pip", venv_command)
        self.assertTrue(Path(external).is_symlink())

    def test_initialize_uses_only_usable_modern_base(self):
        def probe(path):
            return {"status": {"/old/python": "python_too_old", "/broken/python": "probe_failed"}.get(path, "ready")}
        with patch.object(resources, "candidates", return_value=["/old/python", "/broken/python", sys.executable]), \
             patch.object(resources, "probe", side_effect=probe), \
             patch.object(resources, "run_initialize", side_effect=self.fake_initialize_run) as run:
            self.initialize()
        venv_command = next(call.args[0] for call in run.call_args_list if "venv" in call.args[0])
        self.assertEqual(venv_command[0], sys.executable)

    def test_initialize_unavailable_python_has_fixed_error_and_no_config(self):
        with patch.object(resources, "candidates", return_value=[]), \
             self.assertRaisesRegex(resources.Refused, "^initialize_python_unavailable$"):
            self.initialize()
        self.assertFalse((self.root / resources.SPEECH_ROOT / "config.json").exists())

    def test_initialize_rejects_symlink_runtime_and_model_containers(self):
        selected = self.environment(sdk=True)
        fd = resources.initialize_root(self.root, create=True)
        os.close(fd)
        speech = self.root / resources.SPEECH_ROOT
        outside = self.root / "outside"
        outside.mkdir()
        (speech / "models").symlink_to(outside, target_is_directory=True)
        with patch.object(resources, "candidates", return_value=[selected]), \
             patch.object(resources, "initialize_venv", return_value=(str(speech / "runtime/venv/bin/python"), True)), \
             patch.object(resources, "run_initialize", side_effect=AssertionError("no real venv")), \
             self.assertRaisesRegex(resources.Refused, "^unsafe_initialize_directory$"):
            self.initialize(python_path=selected)
        self.assertFalse(list(outside.iterdir()))
        self.assertFalse((speech / "config.json").exists())
        (speech / "models").unlink()
        (speech / "runtime").symlink_to(outside, target_is_directory=True)
        with patch.object(resources, "candidates", return_value=[sys.executable]), \
             patch.object(resources, "probe", return_value={"status": "ready"}), \
             patch.object(resources, "run_initialize", side_effect=AssertionError), \
             self.assertRaisesRegex(resources.Refused, "^unsafe_initialize_directory$"):
            self.initialize()
        self.assertFalse(list(outside.iterdir()))
        self.assertFalse((speech / "config.json").exists())

    def test_initialize_default_native_is_empty_not_environment_override(self):
        selected = self.managed_environment(sdk=True)
        with patch.object(resources, "candidates", return_value=[selected]), \
             patch.dict(resources.os.environ, {"DSH_QWEN_NATIVE_LIB": "/ignored/legacy.so"}):
            result = self.initialize(python_path=selected)
        self.assertEqual(result["config"]["native_lib"], "")

    def test_initialize_venv_base_falls_back_if_venv_module_unavailable(self):
        def run(command, cancelled, error, **kwargs):
            if command[0] == "/fixture/no-venv-python":
                return False
            return self.fake_initialize_run(command, cancelled, error, **kwargs)
        with patch.object(resources, "candidates", return_value=["/fixture/no-venv-python", sys.executable]), \
             patch.object(resources, "probe", return_value={"status": "ready"}), \
             patch.object(resources, "run_initialize", side_effect=run) as calls:
            result = self.initialize()
        self.assertTrue(result["created_venv"])
        command = next(call.args[0] for call in calls.call_args_list if "venv" in call.args[0])
        self.assertEqual(command[0], sys.executable)

    def test_initialize_request_is_closed_and_paths_must_be_absolute_strings(self):
        valid = {"python_path": "", "model_dir": "", "native_lib": ""}
        cases = [{}, {**valid, "auto_read": True}, {**valid, "python_path": None},
                 {**valid, "model_dir": False}, {**valid, "native_lib": "relative"},
                 {**valid, "python_path": "/a/../b"}]
        for request in cases:
            with self.subTest(request=request), self.assertRaises(resources.Refused):
                resources.initialize(request)
        self.assertFalse((self.root / ".dsh-wsl-desktop").exists())

    def test_initialize_refuses_cancelled_before_any_write(self):
        with self.assertRaisesRegex(resources.Refused, "^cancelled$"):
            resources.initialize({"python_path": "", "model_dir": "", "native_lib": ""}, lambda: True)
        self.assertFalse((self.root / ".dsh-wsl-desktop").exists())

    def test_initialize_does_not_overwrite_different_or_damaged_config(self):
        selected = self.managed_environment(sdk=True)
        with patch.object(resources, "candidates", return_value=[selected]):
            result = self.initialize(python_path=selected)
        config = Path(result["config_path"])
        original = config.read_bytes()
        with self.assertRaisesRegex(resources.Refused, "^initialize_config_conflict$"):
            self.initialize(model_dir=str(self.root / "different"))
        self.assertEqual(config.read_bytes(), original)
        for data in (b"broken {", b"null", b"[]", b'{"schema_version":true,"config":{}}', b'{"schema_version":2,"config":{}}'):
            with self.subTest(data=data):
                config.write_bytes(data)
                with patch.object(resources, "run_initialize", side_effect=AssertionError), \
                     self.assertRaisesRegex(resources.Refused, "^initialize_config_conflict$"):
                    self.initialize()
                self.assertEqual(config.read_bytes(), data)

    def test_initialize_refuses_symlink_managed_roots_and_preserves_target(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "keep").write_text("user file")
        app = self.root / ".dsh-wsl-desktop"
        app.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(resources.Refused, "^unsafe_initialize_directory$"):
            self.initialize()
        self.assertEqual(list(outside.iterdir()), [outside / "keep"])
        app.unlink()
        app.mkdir(mode=0o700)
        (app / "speech").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(resources.Refused, "^unsafe_initialize_directory$"):
            self.initialize()
        self.assertEqual((outside / "keep").read_text(), "user file")

    def test_initialize_rejects_nonprivate_root_foreign_owner_and_writable_subdir(self):
        app = self.root / ".dsh-wsl-desktop"
        app.mkdir(mode=0o755)
        app.chmod(0o755)
        with self.assertRaisesRegex(resources.Refused, "^unsafe_initialize_directory$"):
            self.initialize()
        app.chmod(0o700)
        speech = app / "speech"
        speech.mkdir(mode=0o700)
        speech.chmod(0o770)
        with self.assertRaisesRegex(resources.Refused, "^unsafe_initialize_directory$"):
            self.initialize()
        speech.chmod(0o700)
        uid = os.getuid()
        with patch.object(resources.os, "getuid", return_value=uid + 1), \
             self.assertRaisesRegex(resources.Refused, "^unsafe_initialize_directory$"):
            self.initialize()
        self.assertFalse((speech / "config.json").exists())

    def test_initialize_refuses_unsafe_config_files_without_reading_or_overwriting(self):
        speech = self.root / resources.SPEECH_ROOT
        speech.mkdir(parents=True, mode=0o700)
        speech.parent.chmod(0o700)
        config = speech / "config.json"
        external = self.root / "user-secret"
        external.write_text("private")
        for kind in ("symlink", "fifo", "hardlink", "public"):
            with self.subTest(kind=kind):
                if kind == "symlink":
                    config.symlink_to(external)
                elif kind == "fifo":
                    os.mkfifo(config, 0o600)
                elif kind == "hardlink":
                    os.link(external, config)
                else:
                    config.write_text("private")
                    config.chmod(0o644)
                with self.assertRaisesRegex(resources.Refused, "^unsafe_initialize_file$"):
                    self.initialize()
                self.assertEqual(external.read_text(), "private")
                config.unlink()

    def test_initialize_busy_lock_does_not_write_config(self):
        fd = resources.initialize_root(self.root, create=True)
        lock = os.open(".initialize.lock", os.O_CREAT | os.O_RDWR, 0o600, dir_fd=fd)
        try:
            resources.fcntl.flock(lock, resources.fcntl.LOCK_EX | resources.fcntl.LOCK_NB)
            with self.assertRaisesRegex(resources.Refused, "^initialize_busy$"):
                self.initialize()
        finally:
            os.close(lock)
            os.close(fd)
        self.assertFalse((self.root / resources.SPEECH_ROOT / "config.json").exists())

    def test_initialize_refuses_nonmanaged_existing_runtime_without_overwrite(self):
        runtime = self.root / resources.SPEECH_ROOT / "runtime/venv"
        runtime.mkdir(parents=True)
        (self.root / ".dsh-wsl-desktop").chmod(0o700)
        (self.root / resources.SPEECH_ROOT).chmod(0o700)
        sentinel = runtime / "user-file"
        sentinel.write_text("keep")
        with patch.object(resources, "candidates", return_value=[sys.executable]), \
             patch.object(resources, "run_initialize", side_effect=AssertionError), \
             self.assertRaisesRegex(resources.Refused, "^initialize_runtime_conflict$"):
            self.initialize()
        self.assertEqual(sentinel.read_text(), "keep")
        self.assertFalse((runtime.parent / resources.INIT_INTENT).exists())

    def test_initialize_partial_failure_retries_in_place_without_deleting_files(self):
        calls = []
        target = self.root / resources.SPEECH_ROOT / "runtime/venv"
        def fail_once(command, cancelled, error, **kwargs):
            if "venv" in command and not calls:
                calls.append(command)
                (target / "keep-user-file").write_text("untouched")
                raise resources.Refused("initialize_venv_failed")
            return self.fake_initialize_run(command, cancelled, error, **kwargs)
        with patch.object(resources, "candidates", return_value=[sys.executable]), \
             patch.object(resources, "probe", return_value={"status": "ready"}), \
             patch.object(resources, "run_initialize", side_effect=fail_once):
            with self.assertRaisesRegex(resources.Refused, "^initialize_venv_failed$"):
                self.initialize()
            self.assertFalse((target.parent.parent / "config.json").exists())
            inode = target.stat().st_ino
            result = self.initialize()
        self.assertTrue(result["created_venv"])
        self.assertEqual(target.stat().st_ino, inode)
        self.assertEqual((target / "keep-user-file").read_text(), "untouched")
        self.assertEqual(result["config"]["python_path"], str(target / "bin/python"))

    def test_initialize_completed_runtime_after_config_failure_is_reused(self):
        original = resources.publish_initialize_json
        def fail_config(fd, name, value, cancelled):
            if name == "config.json":
                raise resources.Refused("cancelled")
            return original(fd, name, value, cancelled)
        with patch.object(resources, "candidates", return_value=[sys.executable]), \
             patch.object(resources, "probe", return_value={"status": "ready"}), \
             patch.object(resources, "run_initialize", side_effect=self.fake_initialize_run), \
             patch.object(resources, "publish_initialize_json", side_effect=fail_config):
            with self.assertRaisesRegex(resources.Refused, "^cancelled$"):
                self.initialize()
        with patch.object(resources, "candidates", return_value=[]), \
             patch.object(resources, "probe", return_value={"status": "ready"}), \
             patch.object(resources, "run_initialize", side_effect=AssertionError("do not rebuild complete venv")):
            result = self.initialize()
        self.assertTrue(result["reused_python"])
        self.assertFalse(result["created_venv"])

    def test_initialize_retry_rejects_symlink_in_partial_runtime(self):
        def fail(command, cancelled, error, **kwargs):
            if "venv" in command:
                raise resources.Refused("initialize_venv_failed")
            return True
        with patch.object(resources, "candidates", return_value=[sys.executable]), \
             patch.object(resources, "run_initialize", side_effect=fail):
            with self.assertRaises(resources.Refused):
                self.initialize()
        runtime = self.root / resources.SPEECH_ROOT / "runtime/venv"
        external = self.root / "outside"
        external.mkdir()
        (runtime / "bin").symlink_to(external, target_is_directory=True)
        with patch.object(resources, "candidates", return_value=[sys.executable]), \
             patch.object(resources, "run_initialize", side_effect=AssertionError), \
             self.assertRaisesRegex(resources.Refused, "^initialize_runtime_conflict$"):
            self.initialize()
        self.assertFalse(list(external.iterdir()))

    def test_initialize_ensurepip_is_only_bundled_offline_step(self):
        def run(command, cancelled, error, **kwargs):
            self.fake_initialize_run(command, cancelled, error, **kwargs)
            return True
        with patch.object(resources, "candidates", return_value=[sys.executable]), \
             patch.object(resources, "probe", return_value={"status": "ready"}), \
             patch.object(resources, "run_initialize", side_effect=run) as calls:
            self.initialize()
        commands = [call.args[0] for call in calls.call_args_list]
        self.assertTrue(any("ensurepip" in command for command in commands))
        self.assertTrue(all("install" not in command and "pip" not in command for command in commands))
        self.assertTrue(all("sudo" not in command and "apt" not in command for command in commands))

    def test_initialize_ensurepip_failure_never_publishes_config(self):
        def run(command, cancelled, error, **kwargs):
            self.fake_initialize_run(command, cancelled, error, **kwargs)
            if "ensurepip" in command:
                raise resources.Refused(error)
            return True
        with patch.object(resources, "candidates", return_value=[sys.executable]), \
             patch.object(resources, "probe", return_value={"status": "ready"}), \
             patch.object(resources, "run_initialize", side_effect=run), \
             self.assertRaisesRegex(resources.Refused, "^initialize_pip_failed$"):
            self.initialize()
        speech = self.root / resources.SPEECH_ROOT
        self.assertFalse((speech / "config.json").exists())
        self.assertFalse((speech / "runtime" / resources.INIT_COMPLETE).exists())

    def test_initialize_publication_is_noreplace_and_cancel_cleans_own_config(self):
        fd = resources.initialize_root(self.root, create=True)
        config = self.root / resources.SPEECH_ROOT / "config.json"
        original_link = os.link
        def cancel_after_link(*args, **kwargs):
            original_link(*args, **kwargs)
            cancelled[0] = True
        cancelled = [False]
        try:
            with patch.object(resources.os, "link", side_effect=cancel_after_link), \
                 self.assertRaisesRegex(resources.Refused, "^cancelled$"):
                resources.publish_initialize_json(fd, "config.json", {"schema_version": 1}, lambda: cancelled[0])
            self.assertFalse(config.exists())
            config.write_text("race winner")
            with self.assertRaisesRegex(resources.Refused, "^initialize_config_conflict$"):
                resources.publish_initialize_json(fd, "config.json", {"schema_version": 1}, lambda: False)
            self.assertEqual(config.read_text(), "race winner")
            self.assertFalse(list(config.parent.glob("*.tmp")))
        finally:
            os.close(fd)

    def legacy_config(self, python_path, model_dir=None, native_lib=""):
        fd = resources.initialize_root(self.root, create=True)
        os.close(fd)
        config = self.root / resources.SPEECH_ROOT / "config.json"
        config.write_text(json.dumps({"schema_version": 1, "config": {
            "python_path": python_path, "model_dir": model_dir or str(self.root / "legacy-models"),
            "native_lib": native_lib}}))
        config.chmod(0o600)
        return config

    def test_initialize_legacy_config_creates_default_ignoring_external_draft_without_rewrite(self):
        external = self.environment(sdk=True, venv=True)
        draft = self.environment(venv=True, name="draft")
        native = str(self.root / "legacy.so")
        config = self.legacy_config(external, native_lib=native)
        original = config.read_bytes()
        metadata = (config.stat().st_ino, config.stat().st_mtime_ns)
        managed = str(config.parent / "runtime/venv/bin/python")
        def probe(path):
            self.assertNotIn(path, (external, draft))
            return {"status": "ready"}
        with patch.object(resources, "candidates", return_value=[sys.executable]), \
             patch.object(resources, "probe", side_effect=probe), \
             patch.object(resources, "run_initialize", side_effect=self.fake_initialize_run) as run, \
             patch.object(resources, "opener", side_effect=AssertionError("offline")):
            result = self.initialize(python_path=draft)
        self.assertTrue(result["created_venv"])
        self.assertFalse(result["reused_python"])
        self.assertEqual(result["config"], {"python_path": managed, "model_dir": str(self.root / "legacy-models"),
                                            "native_lib": native})
        self.assertEqual(result["config_path"], str(config))
        self.assertTrue(any("venv" in call.args[0] for call in run.call_args_list))
        self.assertTrue(all(call.args[0][0] not in (external, draft) for call in run.call_args_list))
        self.assertEqual(config.read_bytes(), original)
        self.assertEqual((config.stat().st_ino, config.stat().st_mtime_ns), metadata)
        self.assertTrue(Path(external).is_symlink())
        self.assertTrue(Path(draft).is_symlink())
        self.assertFalse(Path(result["config"]["model_dir"]).exists())
        self.assertFalse(Path(native).exists())
        self.assertFalse((self.root / "poison").exists())

    def test_initialize_saved_external_python_reuses_only_default_without_rewriting_config(self):
        managed = self.managed_environment()
        external = self.environment(sdk=True, venv=True)
        config = self.legacy_config(external)
        original = config.read_bytes()
        with patch.object(resources, "probe", side_effect=AssertionError("no old external probe")), \
             patch.object(resources, "candidates", side_effect=AssertionError("no scan")), \
             patch.object(resources, "run_initialize", side_effect=AssertionError("read-only reuse")):
            result = self.initialize(python_path=external)
        self.assertEqual(result["config"]["python_path"], managed)
        self.assertTrue(result["reused_python"])
        self.assertFalse(result["created_venv"])
        self.assertEqual(config.read_bytes(), original)
        self.assertFalse((self.root / "poison").exists())

    def test_initialize_missing_completed_interpreter_rebuild_failure_stays_partial_then_retries(self):
        with patch.object(resources, "candidates", return_value=[sys.executable]), \
             patch.object(resources, "probe", return_value={"status": "ready"}), \
             patch.object(resources, "run_initialize", side_effect=self.fake_initialize_run):
            initialized = self.initialize()
        target = Path(initialized["config"]["python_path"])
        runtime = target.parent.parent.parent
        config = Path(initialized["config_path"])
        original = config.read_bytes()
        complete = runtime / resources.INIT_COMPLETE
        intent = (runtime / resources.INIT_INTENT).read_bytes()
        self.assertTrue(complete.is_file())
        sentinel = target.parent.parent / "keep-user-file"
        sentinel.write_text("untouched")
        target.unlink()
        def fail(command, cancelled, error, **kwargs):
            self.fake_initialize_run(command, cancelled, error, **kwargs)
            if "ensurepip" in command:
                raise resources.Refused("initialize_pip_failed")
            return True
        with patch.object(resources, "candidates", return_value=[sys.executable]), \
             patch.object(resources, "probe", return_value={"status": "ready"}), \
             patch.object(resources, "run_initialize", side_effect=fail) as run:
            with self.assertRaisesRegex(resources.Refused, "^initialize_pip_failed$"):
                self.initialize()
        self.assertTrue(any("venv" in call.args[0] for call in run.call_args_list))
        self.assertFalse(complete.exists())
        self.assertTrue(target.exists())
        self.assertEqual(config.read_bytes(), original)
        self.assertEqual((runtime / resources.INIT_INTENT).read_bytes(), intent)
        with patch.object(resources, "candidates", return_value=[sys.executable]), \
             patch.object(resources, "probe", return_value={"status": "ready"}), \
             patch.object(resources, "run_initialize", side_effect=self.fake_initialize_run) as run:
            restored = self.initialize()
        self.assertTrue(restored["created_venv"])
        self.assertFalse(restored["reused_python"])
        self.assertEqual(restored["config"], initialized["config"])
        self.assertTrue(any("venv" in call.args[0] for call in run.call_args_list))
        self.assertTrue(target.is_file())
        self.assertTrue(os.access(target, os.X_OK))
        self.assertEqual(json.loads(complete.read_text()), json.loads(intent))
        self.assertEqual(config.read_bytes(), original)
        self.assertEqual(sentinel.read_text(), "untouched")

    def test_initialize_subprocess_timeout_and_private_output_have_fixed_errors(self):
        with self.assertRaisesRegex(resources.Refused, "^initialize_timeout$"):
            resources.run_initialize([sys.executable, "-c", "import time; time.sleep(10)"], lambda: False,
                                     "initialize_venv_failed", timeout=0.05)
        with self.assertRaisesRegex(resources.Refused, "^initialize_venv_failed$"):
            resources.run_initialize([sys.executable, "-c", "print('private'); raise SystemExit(1)"], lambda: False,
                                     "initialize_venv_failed")

    def _held_runner(self, body):
        return ("import importlib.util; s=importlib.util.spec_from_file_location('r', %r); "
                "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); " % str(HELPER)) + body + "; m.main()"

    def test_successful_helper_exits_with_owner_stdin_still_held(self):
        code = self._held_runner("m.download=lambda request,emit,cancelled: {'ok':True}")
        process = subprocess.Popen([sys.executable, "-c", code, "--resources-download"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            process.stdin.write(json.dumps({"model_dir": str(self.model)}).encode() + b"\n")
            process.stdin.flush()
            self.assertEqual(json.loads(process.stdout.readline()), {"ok": True})
            self.assertEqual(process.wait(timeout=3), 0)
            self.assertEqual(process.stderr.read(), b"")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()

    def test_owner_eof_is_observed_as_cancellation(self):
        code = self._held_runner("m.download=lambda request,emit,cancelled: {'ok':False,'error':'cancelled' if cancelled.__self__.wait(2) else 'owner_lost'}")
        result = subprocess.run([sys.executable, "-c", code, "--resources-download"],
            input=json.dumps({"model_dir": str(self.model)}).encode() + b"\n", capture_output=True, timeout=4)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {"ok": False, "error": "cancelled"})
        self.assertEqual(result.stderr, b"")

    def test_initialize_cli_success_exits_with_owner_stdin_held(self):
        selected = self.managed_environment(sdk=True)
        process = subprocess.Popen([sys.executable, "-B", str(HELPER), "--resources-initialize"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            process.stdin.write(json.dumps({"python_path": selected, "model_dir": "", "native_lib": ""}).encode() + b"\n")
            process.stdin.flush()
            wire = json.loads(process.stdout.readline())
            self.assertEqual(set(wire), {"ok", "result"})
            self.assertTrue(wire["ok"])
            self.assertEqual(set(wire["result"]), {"config", "config_path", "reused_python", "created_venv"})
            self.assertEqual(wire["result"]["config"]["python_path"], selected)
            self.assertEqual(wire["result"]["config_path"], str(self.root / resources.SPEECH_ROOT / "config.json"))
            self.assertTrue(wire["result"]["reused_python"])
            self.assertFalse(wire["result"]["created_venv"])
            self.assertEqual(process.wait(timeout=4), 0)
            self.assertEqual(process.stderr.read(), b"")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()

    def test_initialize_owner_eof_cancels_real_child_process_group(self):
        pid_file = self.root / "venv-processes.json"
        grandchild = "import time; time.sleep(30)"
        child = ("import subprocess,sys,os,json,time; "
                 "p=subprocess.Popen([sys.executable,'-c',%r]); "
                 "open(%r,'w').write(json.dumps([os.getpid(),p.pid])); time.sleep(30)" % (grandchild, str(pid_file)))
        # Replace only venv execution with a long-running process tree; keep the
        # real owner channel and cancellable process-group runner under test.
        body = ("m.candidates=lambda home: [%r]; "
                "m.probe=lambda *args: {'status':'ready'}; "
                "original=m.run_initialize; "
                "m.run_initialize=lambda command,cancelled,error,**kw: "
                "original([%r,'-c',%r] if 'venv' in command else command,cancelled,error,**kw)"
                % (sys.executable, sys.executable, child))
        process = subprocess.Popen([sys.executable, "-B", "-c", self._held_runner(body), "--resources-initialize"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        pids = []
        try:
            process.stdin.write(json.dumps({"python_path": "", "model_dir": "", "native_lib": ""}).encode() + b"\n")
            process.stdin.flush()
            deadline = time.monotonic() + 5
            while not pid_file.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(pid_file.exists(), "venv subprocess never started")
            pids = json.loads(pid_file.read_text())
            process.stdin.close()
            self.assertEqual(json.loads(process.stdout.readline()), {"ok": False, "error": "cancelled"})
            self.assertEqual(process.wait(timeout=4), 0)
            self.assertEqual(process.stderr.read(), b"")
            for pid in pids:
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    proc = Path("/proc") / str(pid) / "stat"
                    if not proc.exists() or proc.read_text().split(") ", 1)[1].startswith("Z "):
                        break
                    time.sleep(0.01)
                else:
                    self.fail("cancelled venv process-group descendant is still running")
            self.assertFalse((self.root / resources.SPEECH_ROOT / "config.json").exists())
            self.assertFalse((self.root / resources.SPEECH_ROOT / "runtime" / resources.INIT_COMPLETE).exists())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            for pid in pids:
                try:
                    os.kill(pid, 9)
                except ProcessLookupError:
                    pass
            if not process.stdin.closed:
                process.stdin.close()
            process.stdout.close()
            process.stderr.close()

    def test_initialize_cli_failure_has_fixed_error_without_subprocess_output(self):
        secret = "never disclose private subprocess output"
        body = ("m.candidates=lambda home: [%r]; "
                "m.probe=lambda *args: {'status':'ready'}; "
                "original=m.run_initialize; "
                "m.run_initialize=lambda command,cancelled,error,**kw: "
                "original([%r,'-c',%r] if 'venv' in command else command,cancelled,error,**kw)"
                % (sys.executable, sys.executable, "print(%r); raise SystemExit(1)" % secret))
        process = subprocess.Popen([sys.executable, "-B", "-c", self._held_runner(body), "--resources-initialize"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            process.stdin.write(b'{"python_path":"","model_dir":"","native_lib":""}\n')
            process.stdin.flush()
            self.assertEqual(json.loads(process.stdout.readline()), {"ok": False, "error": "initialize_venv_failed"})
            self.assertEqual(process.wait(timeout=4), 0)
            self.assertEqual(process.stderr.read(), b"")
            self.assertFalse((self.root / resources.SPEECH_ROOT / "config.json").exists())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()

    def test_cli_unknown_operation_has_fixed_error(self):
        result = subprocess.run([sys.executable, str(HELPER), "--shell"], input=b'{}', capture_output=True, timeout=5)
        self.assertEqual(json.loads(result.stdout), {"ok": False, "error": "invalid_request"})
        self.assertEqual(result.stderr, b"")


if __name__ == "__main__":
    unittest.main()
