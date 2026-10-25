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
        result = resources.probe(str(binary), "amd")
        self.assertTrue(result["ready"])
        self.assertEqual(result["status"], "ready")
        for vendor, status in [("nvidia", "missing_cuda_runtime"), ("unknown", "gpu_unknown"), ("intel", "unsupported_gpu")]:
            checked = resources.probe(str(binary), vendor)
            self.assertEqual(checked["status"], status)
            self.assertFalse(checked["ready"])
        self.assertRegex(result["version"], r"^\d+\.\d+\.\d+$")
        self.assertFalse((self.root / "poison").exists())

    def test_readiness_recognizes_rocm_10_core_metadata_without_import(self):
        binary = self.root / "venv/bin/python"
        binary.parent.mkdir(parents=True)
        binary.symlink_to(sys.executable)
        packages = self.root / "venv/lib" / ("python%d.%d" % sys.version_info[:2]) / "site-packages"
        metadata = packages / "rocm_sdk_core-10.1.0.dist-info"
        metadata.mkdir(parents=True)
        (metadata / "METADATA").write_text("Name: rocm-sdk-core\nVersion: 10.1.0\n")
        (packages / "rocm_sdk.py").write_text("raise Exception('must not import')")
        (packages / "poison.pth").write_text("import pathlib; pathlib.Path(%r).touch()" % str(self.root / "poison"))
        result = resources.probe(str(binary), "amd")
        self.assertTrue(result["ready"])
        self.assertEqual(result["status"], "ready")
        self.assertFalse((self.root / "poison").exists())

    def test_probe_requires_sdk_core_not_just_other_rocm_components(self):
        from contextlib import redirect_stdout
        import importlib.metadata
        from types import SimpleNamespace

        for names, expected in (([], False), (["rocm"], False),
                                (["rocm-sdk-libraries", "rocm-sdk-devel"], False),
                                (["rocm-sdk-core"], True), (["rocm_sdk_core"], True),
                                (["rocm-sdk"], True)):
            with self.subTest(names=names):
                distributions = [SimpleNamespace(metadata={"Name": name}) for name in names]
                output = io.StringIO()
                with patch.object(importlib.metadata, "distributions", return_value=distributions), redirect_stdout(output):
                    exec(resources.PROBE, {})
                self.assertEqual(json.loads(output.getvalue())["rocm_sdk"], expected)

    def metadata_probe(self, names=(), files=(), environ=None):
        from contextlib import redirect_stdout
        import importlib.metadata
        from types import SimpleNamespace
        output = io.StringIO()
        distributions = [SimpleNamespace(metadata={"Name": name}) for name in names]
        with patch.object(importlib.metadata, "distributions", return_value=distributions), \
             patch.object(os.path, "isfile", side_effect=lambda p: p in files), \
             patch.dict(os.environ, environ or {}, clear=True), redirect_stdout(output):
            exec(resources.PROBE, {})
        return json.loads(output.getvalue())

    def test_cuda_metadata_requires_complete_same_major_runtime_not_torch(self):
        cases = [([], False), (["torch", "cuda-python"], False),
                 (["nvidia-cuda-runtime-cu12"], False), (["nvidia-cublas-cu12"], False),
                 (["nvidia-cuda-runtime-cu12", "nvidia-cublas-cu13"], False),
                 (["nvidia-cuda-runtime-cu12", "nvidia-cublas-cu12"], True),
                 (["nvidia_cuda_runtime_cu13", "nvidia_cublas_cu13"], True)]
        for names, expected in cases:
            with self.subTest(names=names):
                value = self.metadata_probe(names)
                self.assertEqual(value["cuda_runtime"], expected)
                self.assertEqual(resources.python_status("3.12.1", False, "nvidia", expected),
                                 "ready" if expected else "missing_cuda_runtime")

    def test_cuda_system_library_discovery_only_checks_filenames(self):
        root = str(self.root / "cuda ; $(touch never)")
        files = [root + "/lib64/libcudart.so.12", root + "/lib64/libcublas.so.12",
                 root + "/lib64/libcublasLt.so.12"]
        for key in ("CUDA_HOME", "CUDA_PATH", "CUDAToolkit_ROOT"):
            with self.subTest(key=key):
                self.assertTrue(self.metadata_probe(files=files, environ={key: root})["cuda_runtime"])
        self.assertTrue(self.metadata_probe(files=files, environ={"LD_LIBRARY_PATH": root + "/lib64"})["cuda_runtime"])
        for bad in (files[:1], files[:2], [files[0], files[2], root + "/lib64/libcublas.so.13"],
                    [root + "/stubs/libcudart.so.12", root + "/stubs/libcublas.so.12"]):
            self.assertFalse(self.metadata_probe(files=bad, environ={"CUDA_HOME": root,
                             "LD_LIBRARY_PATH": root + "/stubs"})["cuda_runtime"])

    def test_cuda_probe_forwards_explicit_toolkit_path_without_loading_fake_libraries(self):
        selected = self.environment(venv=True)
        root = self.root / "CUDA toolkit ; not a shell"
        libs = root / "lib64"
        libs.mkdir(parents=True)
        for name in ("cudart", "cublas", "cublasLt"):
            (libs / ("lib" + name + ".so.12")).write_bytes(b"not a real shared library")
        with patch.dict(os.environ, {"CUDA_HOME": str(root)}):
            result = resources.probe(selected, "nvidia")
        self.assertEqual(result["status"], "ready")
        self.assertTrue(result["ready"])

    def test_cuda_probe_skips_gpu_imports_and_site_hooks(self):
        selected = self.environment(venv=True)
        packages = Path(selected).parent.parent / "lib" / ("python%d.%d" % sys.version_info[:2]) / "site-packages"
        for name in ("nvidia-cuda-runtime-cu12", "nvidia-cublas-cu12"):
            metadata = packages / (name + "-1.0.dist-info")
            metadata.mkdir(parents=True)
            (metadata / "METADATA").write_text("Name: " + name + "\nVersion: 1.0\n")
        (packages / "nvidia.py").write_text("raise AssertionError('must not import GPU')")
        (packages / "torch.py").write_text("raise AssertionError('must not import torch')")
        (packages / "poison.pth").write_text("import pathlib; pathlib.Path(%r).touch()" % str(self.root / "poison"))
        for vendor, ready in (("nvidia", True), ("mixed", True), ("amd", False),
                              ("unknown", False), ("intel", False)):
            result = resources.probe(selected, vendor)
            self.assertEqual(result["ready"], ready)
        self.assertFalse((self.root / "poison").exists())
        with patch.object(resources, "candidates", return_value=[selected]), \
             patch.object(resources, "detect_gpu", side_effect=AssertionError("no GPU query")), \
             patch.object(resources, "run_initialize", side_effect=AssertionError("read-only reuse")):
            result = self.initialize()
        self.assertTrue(result["reused_python"])
        self.assertEqual(result["config"]["python_path"], selected)

    def test_mixed_status_accepts_either_backend_but_not_unknown_or_intel(self):
        for rocm in (False, True):
            for cuda in (False, True):
                with self.subTest(rocm=rocm, cuda=cuda):
                    self.assertEqual(resources.python_status("3.12.1", rocm, "mixed", cuda),
                                     "ready" if rocm or cuda else "missing_gpu_runtime")
                    for vendor, status in (("unknown", "gpu_unknown"), ("intel", "unsupported_gpu")):
                        self.assertEqual(resources.python_status("3.12.1", rocm, vendor, cuda), status)
        self.assertEqual(resources.python_status("3.9.9", True, "nvidia", True), "python_too_old")

    def test_initialize_python_usability_is_not_gpu_dependency_readiness(self):
        for status in ("missing_cuda_runtime", "missing_gpu_runtime", "gpu_unknown"):
            self.assertTrue(resources.python_usable({"status": status}))
        for status in ("python_too_old", "probe_failed"):
            self.assertFalse(resources.python_usable({"status": status}))

    def test_discover_preserves_config_and_no_network(self):
        config = {"python_path": "", "model_dir": str(self.root / "selected"), "native_lib": str(self.root / "libqwen.so")}
        with patch.object(resources, "candidates", return_value=[]), patch.object(resources, "opener", side_effect=AssertionError), \
             patch.object(resources, "detect_gpu", return_value={"vendor": "unknown", "names": []}):
            result = resources.discover(config)
        self.assertEqual(result["model_dir"], config["model_dir"])
        self.assertEqual(result["native_lib"], config["native_lib"])

    def test_documented_runtime_and_selected_python_are_candidates(self):
        documented = self.root / ".dsh-wsl-desktop/speech/runtime/venv/bin/python"
        documented.parent.mkdir(parents=True)
        documented.symlink_to(sys.executable)
        self.assertIn(str(documented), resources.candidates(self.root, {}))
        selected = str(self.root / "outside-custom-env/bin/python")
        request = {"python_path": selected, "model_dir": "", "native_lib": ""}
        with patch.object(resources, "candidates", return_value=[str(documented), selected]), \
             patch.object(resources, "probe", side_effect=lambda p, vendor: {"path": p, "version": "unknown", "ready": False, "status": "probe_failed"}), \
             patch.object(resources, "detect_gpu", return_value={"vendor": "unknown", "names": []}):
            found = resources.discover(request)
        self.assertEqual([p["path"] for p in found["python_environments"]], [selected, str(documented)])

    def test_new_default_model_directory_is_read_only(self):
        request = {"python_path": "", "model_dir": "", "native_lib": ""}
        with patch.object(resources.Path, "home", return_value=self.root), \
             patch.object(resources, "candidates", return_value=[]), \
             patch.object(resources, "detect_gpu", return_value={"vendor": "unknown", "names": []}), \
             patch.dict(resources.os.environ, {}, clear=True):
            found = resources.discover(request)
        self.assertEqual(found["model_dir"], str(self.root / ".dsh-wsl-desktop/speech/models/qwen3-tts-q8"))
        self.assertEqual(request, {"python_path": "", "model_dir": "", "native_lib": ""})
        self.assertFalse((self.root / ".dsh-wsl-desktop").exists())
        self.assertFalse((self.root / ".local").exists())

    def test_new_runtime_precedes_legacy_environments_without_moving_them(self):
        paths = [self.root / ".dsh-wsl-desktop/speech/runtime/venv/bin/python",
                 self.root / ".local/share/dsh-pet/qwen-runtime/venv/bin/python",
                 self.root / ".local/share/dsh-speech/venv/bin/python",
                 self.root / ".local/share/dsh-speech/qwen-runtime/venv/bin/python"]
        for path in paths:
            path.parent.mkdir(parents=True)
            path.symlink_to(sys.executable)
        self.assertEqual(resources.candidates(self.root, {})[:len(paths)], list(map(str, paths)))
        self.assertTrue(all(path.is_symlink() for path in paths))

    def test_status_distinguishes_vendor_version_and_dependency(self):
        cases = [
            ("3.9.9", True, "amd", "python_too_old"),
            ("3.14.4", False, "amd", "missing_rocm_sdk"),
            ("3.10.0", True, "amd", "ready"),
            ("3.14.4", True, "mixed", "ready"),
            ("3.14.4", False, "mixed", "missing_gpu_runtime"),
            ("3.14.4", False, "nvidia", "missing_cuda_runtime"),
            ("3.14.4", True, "nvidia", "missing_cuda_runtime"),
            ("3.14.4", True, "intel", "unsupported_gpu"),
            ("3.14.4", False, "unknown", "gpu_unknown"),
        ]
        for version, sdk, vendor, expected in cases:
            with self.subTest(vendor=vendor, sdk=sdk, version=version):
                self.assertEqual(resources.python_status(version, sdk, vendor), expected)

    def gpu_fixture(self, adapters=None, *, pci=None, smi="", wsl=True, raw=None):
        read_text = Path.read_text
        def read(path, *args, **kwargs):
            if str(path) == "/proc/sys/kernel/osrelease":
                return "microsoft-standard-WSL2" if wsl else "linux"
            return read_text(path, *args, **kwargs)
        def command(args, **kwargs):
            return (raw if raw is not None else json.dumps(adapters)) if "-Command" in args else smi
        with patch.object(Path, "iterdir", return_value=pci or []), \
             patch.object(Path, "read_text", autospec=True, side_effect=read), \
             patch.object(resources.shutil, "which", return_value="/windows/powershell.exe"), \
             patch.object(resources.os.path, "isfile", return_value=True), \
             patch.object(resources.os, "access", return_value=True), \
             patch.object(resources, "gpu_command", side_effect=command) as run:
            return resources.detect_gpu(), run.call_args_list

    def test_wsl_windows_adapters_detect_amd_nvidia_and_hybrid(self):
        amd = {"Name": "AMD Radeon RX 9070 XT", "PNPDeviceID": "PCI/VEN_1002"}
        nvidia = {"Name": "NVIDIA GeForce RTX 5090", "PNPDeviceID": "PCI/VEN_10DE"}
        intel = {"Name": "Intel Graphics", "PNPDeviceID": "PCI/VEN_8086"}
        for adapters, vendor in [(amd, "amd"), (nvidia, "nvidia"), ([intel, nvidia], "nvidia"),
                                  ([amd, nvidia], "mixed"), (intel, "intel")]:
            with self.subTest(vendor=vendor):
                result, calls = self.gpu_fixture(adapters)
                self.assertEqual(result["vendor"], vendor)
                self.assertTrue(result["names"])
                self.assertIn("Get-CimInstance Win32_VideoController", calls[0].args[0][-1])
                self.assertEqual(calls[0].kwargs["timeout"], 5)
        self.assertEqual(resources.gpu_vendor("AMD Graphics"), "amd")
        self.assertEqual(resources.gpu_vendor("Unknown adapter PCI/VEN_10DE"), "nvidia")

    def test_pci_detection_ignores_non_display_devices(self):
        devices = []
        for name, device_class, vendor in [("display", "0x030000", "0x1002"),
                                           ("network", "0x020000", "0x10de")]:
            device = self.root / name
            device.mkdir()
            (device / "class").write_text(device_class)
            (device / "vendor").write_text(vendor)
            devices.append(device)
        result, calls = self.gpu_fixture(pci=devices, wsl=False)
        self.assertEqual(result, {"vendor": "amd", "names": ["AMD GPU (PCI)"]})
        self.assertTrue(all("-Command" not in call.args[0] for call in calls))

    def test_unknown_timeout_malformed_and_nvidia_fallback(self):
        for raw in ("", "not json", "null", "[42]", '{"Name":42}'):
            with self.subTest(raw=raw):
                result, _ = self.gpu_fixture(raw=raw)
                self.assertEqual(result, {"vendor": "unknown", "names": []})
        result, _ = self.gpu_fixture(raw="", smi="A100-SXM4-80GB\n")
        self.assertEqual(result, {"vendor": "nvidia", "names": ["A100-SXM4-80GB"]})

    def test_adapter_names_are_bounded_and_normalized(self):
        adapters = [{"Name": "NVIDIA " + "x" * 500 + str(i)} for i in range(30)]
        result, _ = self.gpu_fixture(adapters)
        self.assertLessEqual(len(result["names"]), 16)
        self.assertTrue(all(len(name) <= 200 for name in result["names"]))
        result, _ = self.gpu_fixture({"Name": "NVIDIA\n  Test"})
        self.assertEqual(result["names"], ["NVIDIA Test"])

    def test_gpu_commands_fail_closed_and_kill_on_timeout(self):
        self.assertEqual(resources.gpu_command(["/not/a/binary"]), "")
        self.assertEqual(resources.gpu_command([sys.executable, "-c", "print('private error'); raise SystemExit(1)"]), "")
        self.assertEqual(resources.gpu_command([sys.executable, "-c", "print('x'*12000)"]), "")
        self.assertEqual(resources.gpu_command([sys.executable, "-c", "import time; time.sleep(10)"], timeout=0.05), "")

    def test_discovery_passes_vendor_to_each_python_probe(self):
        config = {"python_path": "", "model_dir": "", "native_lib": ""}
        for vendor, status in [("amd", "missing_rocm_sdk"), ("nvidia", "missing_cuda_runtime"), ("unknown", "gpu_unknown")]:
            with self.subTest(vendor=vendor), \
                 patch.object(resources, "detect_gpu", return_value={"vendor": vendor, "names": []}), \
                 patch.object(resources, "candidates", return_value=[sys.executable]), \
                 patch.object(resources, "probe", side_effect=lambda p, v: {"path": p, "version": "3.14.4", "ready": False,
                     "status": resources.python_status("3.14.4", False, v)}) as probe:
                found = resources.discover(config)
                probe.assert_called_once_with(sys.executable, vendor)
                self.assertEqual(found["gpu"]["vendor"], vendor)
                self.assertEqual(found["python_environments"][0]["status"], status)
                self.assertFalse(found["python_environments"][0]["ready"])

    def test_probe_failure_is_not_a_missing_dependency(self):
        result = resources.probe("/not/a/python", "amd")
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

    def initialize(self, **kwargs):
        return resources.initialize({"python_path": "", "model_dir": "", "native_lib": "", **kwargs})

    def fake_initialize_run(self, command, cancelled, error, **kwargs):
        resources.require(not cancelled(), "cancelled")
        if "venv" in command:
            path = Path(command[-1])
            (path / "bin").mkdir(exist_ok=True)
            (path / "bin/python").write_bytes(b"fixture, never executed")
            (path / "pyvenv.cfg").write_text("home = /fixture/base\n")
        return False if kwargs.get("optional") and "importlib.util" in command[-1] else True

    def test_initialize_reuses_selected_rocm_without_install_or_gpu_query(self):
        selected = self.environment(sdk=True)
        with patch.object(resources, "candidates", return_value=[]), \
             patch.object(resources, "run_initialize", side_effect=AssertionError("must not run venv")), \
             patch.object(resources, "detect_gpu", side_effect=AssertionError("must not query GPU")), \
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
        self.assertFalse((speech / "runtime").exists())
        self.assertFalse((self.root / "poison").exists())

    def test_initialize_reuses_explicit_existing_venv_even_without_sdk(self):
        selected = self.environment(venv=True)
        with patch.object(resources, "candidates", return_value=[]), \
             patch.object(resources, "run_initialize", side_effect=AssertionError):
            result = self.initialize(python_path=selected)
        self.assertEqual(result["config"]["python_path"], selected)
        self.assertTrue(result["reused_python"])
        self.assertFalse(result["created_venv"])
        self.assertEqual(resources.probe(selected, "amd")["status"], "missing_rocm_sdk")

    def test_initialize_discovers_core_metadata_and_keeps_external_paths(self):
        selected = self.environment(sdk=True)
        model = str(self.root / "external-models")
        native = str(self.root / "libqwen.so")
        with patch.object(resources, "candidates", return_value=[selected]), \
             patch.dict(resources.os.environ, {"DSH_QWEN_NATIVE_LIB": "/ignored/environment.so"}), \
             patch.object(resources, "run_initialize", side_effect=AssertionError):
            result = self.initialize(model_dir=model, native_lib=native)
        self.assertEqual(result["config"], {"python_path": selected, "model_dir": model, "native_lib": native})
        self.assertFalse(Path(model).exists())
        self.assertFalse(Path(native).exists())
        self.assertFalse((self.root / resources.SPEECH_ROOT / "models").exists())

    def test_initialize_readonly_reuses_documented_manually_created_rocm_venv(self):
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
             patch.object(resources, "probe", return_value={"status": "missing_rocm_sdk"}), \
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
        with patch.object(resources, "candidates", return_value=[sys.executable]), \
             patch.object(resources, "opener", side_effect=AssertionError("offline")), \
             patch.object(resources, "detect_gpu", side_effect=AssertionError):
            result = self.initialize(python_path=sys.executable)
        target = self.root / resources.SPEECH_ROOT / "runtime/venv"
        self.assertEqual(result["config"]["python_path"], str(target / "bin/python"))
        self.assertTrue(result["created_venv"])
        self.assertFalse(result["reused_python"])
        self.assertTrue((target / "pyvenv.cfg").is_file())
        self.assertFalse((target / "bin/python").is_symlink())
        checked = subprocess.run([str(target / "bin/python"), "-I", "-B", "-c", "import sys; print(sys.prefix)"],
                                 capture_output=True, timeout=5)
        self.assertEqual(checked.returncode, 0)
        self.assertEqual(checked.stdout.decode().strip(), str(target))
        if (target / "bin/pip").exists():
            self.assertIn(str(target / "bin/python"), (target / "bin/pip").read_text().splitlines()[0])
        before = (target / "pyvenv.cfg").stat().st_mtime_ns
        with patch.object(resources, "probe", side_effect=AssertionError("idempotent config needs no re-probe")), \
             patch.object(resources, "run_initialize", side_effect=AssertionError):
            again = self.initialize()
        self.assertEqual(again["config"], result["config"])
        self.assertTrue(again["reused_python"])
        self.assertFalse(again["created_venv"])
        self.assertEqual((target / "pyvenv.cfg").stat().st_mtime_ns, before)

    def test_initialize_plain_python_builds_venv_and_does_not_auto_reuse_sdkless_venv(self):
        external = self.environment(venv=True)
        with patch.object(resources, "candidates", return_value=[external, sys.executable]), \
             patch.object(resources, "probe", return_value={"status": "missing_rocm_sdk"}), \
             patch.object(resources, "run_initialize", side_effect=self.fake_initialize_run) as run:
            result = self.initialize(python_path=sys.executable)
        self.assertTrue(result["created_venv"])
        self.assertTrue(result["config"]["python_path"].endswith("/speech/runtime/venv/bin/python"))
        venv_command = next(call.args[0] for call in run.call_args_list if "venv" in call.args[0])
        self.assertEqual(venv_command[0], sys.executable)
        self.assertIn("--copies", venv_command)
        self.assertIn("--without-pip", venv_command)
        self.assertTrue(Path(external).is_symlink())

    def test_initialize_uses_only_usable_modern_base(self):
        def probe(path, vendor):
            return {"status": {"/old/python": "python_too_old", "/broken/python": "probe_failed"}.get(path, "missing_rocm_sdk")}
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
             self.assertRaisesRegex(resources.Refused, "^unsafe_initialize_directory$"):
            self.initialize()
        self.assertFalse(list(outside.iterdir()))
        self.assertFalse((speech / "config.json").exists())
        (speech / "models").unlink()
        (speech / "runtime").symlink_to(outside, target_is_directory=True)
        with patch.object(resources, "candidates", return_value=[sys.executable]), \
             patch.object(resources, "probe", return_value={"status": "missing_rocm_sdk"}), \
             patch.object(resources, "run_initialize", side_effect=AssertionError), \
             self.assertRaisesRegex(resources.Refused, "^unsafe_initialize_directory$"):
            self.initialize()
        self.assertFalse(list(outside.iterdir()))
        self.assertFalse((speech / "config.json").exists())

    def test_initialize_default_native_is_empty_not_environment_override(self):
        selected = self.environment(sdk=True)
        with patch.object(resources, "candidates", return_value=[selected]), \
             patch.dict(resources.os.environ, {"DSH_QWEN_NATIVE_LIB": "/ignored/legacy.so"}):
            result = self.initialize()
        self.assertEqual(result["config"]["native_lib"], "")

    def test_initialize_venv_base_falls_back_if_venv_module_unavailable(self):
        def run(command, cancelled, error, **kwargs):
            if command[0] == "/fixture/no-venv-python":
                return False
            return self.fake_initialize_run(command, cancelled, error, **kwargs)
        with patch.object(resources, "candidates", return_value=["/fixture/no-venv-python", sys.executable]), \
             patch.object(resources, "probe", return_value={"status": "missing_rocm_sdk"}), \
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
        selected = self.environment(sdk=True)
        with patch.object(resources, "candidates", return_value=[selected]):
            result = self.initialize()
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
             patch.object(resources, "probe", return_value={"status": "missing_rocm_sdk"}), \
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
             patch.object(resources, "probe", return_value={"status": "missing_rocm_sdk"}), \
             patch.object(resources, "run_initialize", side_effect=self.fake_initialize_run), \
             patch.object(resources, "publish_initialize_json", side_effect=fail_config):
            with self.assertRaisesRegex(resources.Refused, "^cancelled$"):
                self.initialize()
        with patch.object(resources, "candidates", return_value=[]), \
             patch.object(resources, "probe", return_value={"status": "missing_rocm_sdk"}), \
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
             patch.object(resources, "probe", return_value={"status": "missing_rocm_sdk"}), \
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
             patch.object(resources, "probe", return_value={"status": "missing_rocm_sdk"}), \
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

    def test_discover_reads_initialized_config_fills_only_empty_fields_without_writes(self):
        selected = self.environment(sdk=True)
        with patch.object(resources, "candidates", return_value=[selected]):
            initialized = self.initialize(model_dir=str(self.root / "selected-model"), native_lib=str(self.root / "selected.so"))
        original = Path(initialized["config_path"]).read_bytes()
        request = {"python_path": "", "model_dir": "", "native_lib": ""}
        with patch.object(resources, "candidates", return_value=[]), \
             patch.object(resources, "detect_gpu", return_value={"vendor": "unknown", "names": []}), \
             patch.object(resources.os, "mkdir", side_effect=AssertionError("read only")), \
             patch.object(resources, "publish_initialize_json", side_effect=AssertionError("read only")):
            found = resources.discover(request)
            explicit = resources.discover({"python_path": sys.executable, "model_dir": str(self.root / "override"), "native_lib": str(self.root / "override.so")})
        self.assertEqual(found["python_environments"][0]["path"], selected)
        self.assertEqual(found["model_dir"], initialized["config"]["model_dir"])
        self.assertEqual(found["native_lib"], initialized["config"]["native_lib"])
        self.assertEqual(explicit["python_environments"][0]["path"], sys.executable)
        self.assertEqual(explicit["model_dir"], str(self.root / "override"))
        self.assertEqual(explicit["native_lib"], str(self.root / "override.so"))
        self.assertEqual(Path(initialized["config_path"]).read_bytes(), original)
        self.assertEqual(request, {"python_path": "", "model_dir": "", "native_lib": ""})

    def test_discover_ignores_corrupt_or_unsafe_initialized_config_read_only(self):
        fd = resources.initialize_root(self.root, create=True)
        os.close(fd)
        config = self.root / resources.SPEECH_ROOT / "config.json"
        config.write_text("broken")
        config.chmod(0o600)
        with patch.object(resources, "candidates", return_value=[]), \
             patch.object(resources, "detect_gpu", return_value={"vendor": "unknown", "names": []}), \
             patch.object(resources.os, "mkdir", side_effect=AssertionError):
            result = resources.discover({"python_path": "", "model_dir": "", "native_lib": ""})
        self.assertEqual(result["model_dir"], str(config.parent / "models/qwen3-tts-q8"))
        self.assertEqual(config.read_text(), "broken")

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
        selected = self.environment(sdk=True)
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
        body = ("m.candidates=lambda home,env: [%r]; "
                "m.probe=lambda *args: {'status':'missing_rocm_sdk'}; "
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
        body = ("m.candidates=lambda home,env: [%r]; "
                "m.probe=lambda *args: {'status':'missing_rocm_sdk'}; "
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
