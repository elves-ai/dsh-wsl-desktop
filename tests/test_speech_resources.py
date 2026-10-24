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
        self.model = self.root / "models"
        self.data = {"talker.gguf": b"GGUF-fixture-one", "codec.gguf": b"GGUF-fixture-two"}
        self.hashes = {n: hashlib.sha256(b).hexdigest() for n, b in self.data.items()}
        self.events = []
        self.urls = []

    def tearDown(self):
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
        python = resources.browse({"path": str(self.root), "kind": "python_path"})
        self.assertEqual([x["name"] for x in python["entries"]], ["directory", "python3"])
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

    def test_candidate_venv_conda_path_and_no_recursive_scan(self):
        paths = [self.root / ".venv/bin/python", self.root / "miniconda3/envs/tts/bin/python",
                 self.root / "project/.venv/bin/python", self.root / "custom/bin/python3"]
        for path in paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(sys.executable)
        result = resources.candidates(self.root, {"PATH": str(paths[-1].parent)})
        for path in paths:
            self.assertIn(str(path), result)
        self.assertLessEqual(len(result), 48)

    def test_readiness_reads_metadata_without_import_or_site_hooks(self):
        binary = self.root / "venv/bin/python"
        binary.parent.mkdir(parents=True)
        binary.symlink_to(sys.executable)
        packages = self.root / "venv/lib" / ("python%d.%d" % sys.version_info[:2]) / "site-packages"
        metadata = packages / "rocm_sdk-1.0.dist-info"
        metadata.mkdir(parents=True)
        (metadata / "METADATA").write_text("Name: rocm-sdk\nVersion: 1.0\n")
        (packages / "rocm_sdk.py").write_text("raise Exception('must not import')")
        (packages / "poison.pth").write_text("import pathlib; pathlib.Path(%r).touch()" % str(self.root / "poison"))
        result = resources.probe(str(binary))
        self.assertTrue(result["ready"])
        self.assertRegex(result["version"], r"^\d+\.\d+\.\d+$")
        self.assertFalse((self.root / "poison").exists())

    def test_discover_preserves_config_and_no_network(self):
        config = {"python_path": "", "model_dir": str(self.root / "selected"), "native_lib": str(self.root / "libqwen.so")}
        with patch.object(resources, "candidates", return_value=[]), patch.object(resources, "opener", side_effect=AssertionError):
            result = resources.discover(config)
        self.assertEqual(result["model_dir"], config["model_dir"])
        self.assertEqual(result["native_lib"], config["native_lib"])

    def test_documented_runtime_and_selected_python_are_candidates(self):
        documented = self.root / ".local/share/dsh-pet/qwen-runtime/venv/bin/python"
        documented.parent.mkdir(parents=True)
        documented.symlink_to(sys.executable)
        self.assertIn(str(documented), resources.candidates(self.root, {}))
        selected = str(self.root / "outside-custom-env/bin/python")
        request = {"python_path": selected, "model_dir": "", "native_lib": ""}
        with patch.object(resources, "candidates", return_value=[str(documented), selected]), \
             patch.object(resources, "probe", side_effect=lambda p: {"path": p, "version": "unknown", "ready": False}):
            found = resources.discover(request)
        self.assertEqual([p["path"] for p in found["python_environments"]], [selected, str(documented)])

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

    def test_cli_unknown_operation_has_fixed_error(self):
        result = subprocess.run([sys.executable, str(HELPER), "--shell"], input=b'{}', capture_output=True, timeout=5)
        self.assertEqual(json.loads(result.stdout), {"ok": False, "error": "invalid_request"})
        self.assertEqual(result.stderr, b"")


if __name__ == "__main__":
    unittest.main()
