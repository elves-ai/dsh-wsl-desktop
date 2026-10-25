"""Offline read-only prerequisite checks: no packages, SDKs, services or model downloads."""
import contextlib
import importlib.util
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
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "src-tauri/helpers/speech_install.py"
spec = importlib.util.spec_from_file_location("speech_prerequisites", HELPER)
I = importlib.util.module_from_spec(spec)
spec.loader.exec_module(I)


class PrerequisiteTests(unittest.TestCase):
    def fixtures(self, cuda='{"version":12080,"arch":89}', python="ready", missing=(),
                 machine="x86_64", bridge=True, release="microsoft-standard-WSL2", distro="ubuntu", amd=None):
        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(I.platform, "machine", return_value=machine))
        stack.enter_context(patch.object(I, "wsl_gpu_bridge", return_value=bridge))
        stack.enter_context(patch.object(I, "amd_gpu_arch", return_value=amd))
        stack.enter_context(patch.object(I, "read_system", side_effect=lambda p, *a:
            "ID=" + distro + "\n" if p == "/etc/os-release" else release))
        stack.enter_context(patch.object(I.shutil, "which", side_effect=lambda tool, **kw:
            None if tool in missing else "/usr/bin/" + tool))
        stack.enter_context(patch.object(I, "readonly_probe", side_effect=lambda code, *a, **kw:
            python if code == I.PYTHON_PROBE else cuda))
        # Any installation side effect or network use is a regression.
        for name in ("install", "run", "install_cuda", "fetch", "checkout", "bootstrap_pip"):
            stack.enter_context(patch.object(I, name, side_effect=AssertionError("must be read-only")))
        stack.enter_context(patch.object(I.urllib.request, "build_opener", side_effect=AssertionError("no network")))
        stack.enter_context(patch.object(I.tempfile, "TemporaryFile", side_effect=AssertionError("no files")))
        stack.enter_context(patch.object(Path, "mkdir", side_effect=AssertionError("no directories")))
        return stack

    def result(self, **kwargs):
        with self.fixtures(**kwargs):
            value = I.preflight(lambda: False)
        self.assertEqual(set(value), {"ready", "checks", "install_command"})
        self.assertEqual([c["id"] for c in value["checks"]], ["platform", "python", "tools", "gpu"])
        self.assertTrue(all(set(c) == {"id", "status", "detail"} for c in value["checks"]))
        self.assertEqual(value["ready"], all(c["status"] == "ready" for c in value["checks"]))
        self.assertTrue(all(len(c["detail"]) < 180 for c in value["checks"]))
        return value

    def test_nvidia_ready_requires_driver_and_exact_installer_arches(self):
        for arch in I.CUDA_ARCHES:
            value = self.result(cuda=json.dumps({"version": 12080, "arch": arch}))
            self.assertTrue(value["ready"])
            self.assertIsNone(value["install_command"])
        for version, arch, status in [(12070, 89, "action"), (12080, 999, "unsupported")]:
            value = self.result(cuda=json.dumps({"version": version, "arch": arch}))
            self.assertFalse(value["ready"])
            self.assertEqual(value["checks"][3]["status"], status)
        for invalid in ("invalid", "[]", '{"version":true,"arch":89}',
                        '{"version":12080,"arch":89,"unexpected":1}'):
            self.assertEqual(self.result(cuda=invalid)["checks"][3]["status"], "action")

    def test_platform_bridge_and_arch_are_required(self):
        for kwargs in ({"machine": "aarch64"}, {"bridge": False}, {"release": "Linux"}):
            value = self.result(**kwargs)
            self.assertFalse(value["ready"])
            self.assertEqual(value["checks"][0]["status"], "unsupported")
            self.assertEqual(value["checks"][3]["status"], "unsupported")

    def test_missing_tools_and_python_offer_only_fixed_debian_ubuntu_guidance(self):
        for distro in ("ubuntu", '"ubuntu"', "debian"):
            value = self.result(python="old", missing=("git", "cc", "c++"), distro=distro)
            self.assertEqual(value["install_command"], I.INSTALL_COMMAND)
            self.assertEqual(value["checks"][1]["status"], "action")
            self.assertIn("git、cc、c++", value["checks"][2]["detail"])
        for distro in ("fedora", "ubuntu;touch /tmp/evil", "pop\nID_LIKE=ubuntu", "ubuntu\nID=debian"):
            value = self.result(python=None, distro=distro)
            self.assertIsNone(value["install_command"])
        for tool in ("git", "bash", "make", "cc", "c++", "realpath"):
            self.assertEqual(self.result(missing=(tool,))["checks"][2]["status"], "action")

    def test_amd_evidence_does_not_require_sdk_before_installing_sdk(self):
        value = self.result(cuda=None, amd=120001)
        self.assertTrue(value["ready"])
        self.assertIn("安装组件时将验证 ROCm", value["checks"][3]["detail"])
        pending = self.result(cuda=None, amd=None)
        self.assertTrue(pending["ready"])
        self.assertIn("兼容性待安装组件时验证", pending["checks"][3]["detail"])
        self.assertEqual(self.result(cuda=None, amd=110000)["checks"][3]["status"], "unsupported")

    def test_amd_sysfs_requires_real_gpu_vendor_and_reports_exact_arch(self):
        with tempfile.TemporaryDirectory() as folder:
            node = Path(folder) / "0"
            node.mkdir()
            valid = {"gfx_target_version": "120001", "vendor_id": "4098", "simd_count": "96"}
            for changed in ({}, {"gfx_target_version": "120000"}, {"vendor_id": "4318"}, {"simd_count": "0"}):
                fields = dict(valid, **changed)
                (node / "properties").write_text("".join(k + " " + v + "\n" for k, v in fields.items()))
                (node / "gpu_id").write_text("1\n")
                original = I.os.scandir
                with patch.object(I.os, "scandir", side_effect=lambda _: original(folder)):
                    self.assertEqual(I.amd_gpu_arch(), int(fields["gfx_target_version"])
                                     if fields["vendor_id"] == "4098" and fields["simd_count"] != "0" else None)
            (node / "properties").write_text("".join(k + " " + v + "\n" for k, v in valid.items()))
            (node / "gpu_id").write_text("0")
            with patch.object(I.os, "scandir", side_effect=lambda _: original(folder)):
                self.assertIsNone(I.amd_gpu_arch())

    def test_bridge_requires_character_device_and_never_requires_dev_kfd(self):
        for mode, expected in ((0o020600, True), (0o100600, False)):
            with patch.object(I.os, "stat", return_value=os.stat_result((mode,) + (0,) * 9)) as inspect:
                self.assertEqual(I.wsl_gpu_bridge(), expected)
                inspect.assert_called_once_with("/dev/dxg")
        with patch.object(I.os, "stat", side_effect=FileNotFoundError):
            self.assertFalse(I.wsl_gpu_bridge())

    def test_probe_isolated_bounded_timeout_and_cancel_without_tempfiles(self):
        with patch.object(I.tempfile, "TemporaryFile", side_effect=AssertionError("no temp files")), \
             patch.dict(os.environ, {"PYTHONPATH": "/evil", "LD_PRELOAD": "/evil", "PYTHONINSPECT": "1"}):
            self.assertEqual(I.readonly_probe("print('ready')", lambda: False), "ready")
            self.assertIsNone(I.readonly_probe("print('x'*8192)", lambda: False))
            self.assertIsNone(I.readonly_probe("raise SystemExit(2)", lambda: False))
            start = time.monotonic()
            self.assertIsNone(I.readonly_probe("import time;time.sleep(60)", lambda: False, timeout=.1))
            self.assertLess(time.monotonic() - start, 2)
            with self.assertRaisesRegex(I.InstallError, "cancelled"):
                I.readonly_probe("print('never')", lambda: True)
        with patch.object(I.subprocess, "Popen", side_effect=FileNotFoundError):
            self.assertIsNone(I.readonly_probe(I.PYTHON_PROBE, lambda: False))

    def start_held(self, body):
        source = HELPER.read_text()
        code = "import sys;" + "exec(compile(" + repr(source) + ",'<bundled>','exec'),globals());" + body
        # __name__ must not auto-run before our fixtures have been applied.
        code = "__name__='fixture';" + code
        child = subprocess.Popen([sys.executable, "-I", "-B", "-c", code, "--resources-preflight"],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.cleanup_child, child)
        return child

    @staticmethod
    def cleanup_child(child):
        if child.poll() is None:
            child.kill()
        child.wait()
        for stream in (child.stdin, child.stdout, child.stderr):
            if not stream.closed:
                stream.close()

    def test_held_success_returns_while_owner_stays_attached_and_rejects_extra_input(self):
        for request, ok in [({}, True), ({"path": "/evil"}, False), ({"command": "sudo apt"}, False)]:
            child = self.start_held("preflight=lambda cancelled:{'fixture':True};main()")
            child.stdin.write((json.dumps(request) + "\n").encode()); child.stdin.flush()
            self.assertTrue(select.select([child.stdout], [], [], 3)[0])
            value = json.loads(child.stdout.readline())
            self.assertEqual(value["ok"], ok)
            child.wait(timeout=3)
            self.assertEqual(child.stderr.read(), b"")

    def test_owner_eof_and_sigterm_cancel_probe_group_quickly(self):
        for stop in ("eof", "sigterm"):
            with self.subTest(stop=stop), tempfile.TemporaryDirectory() as folder:
                pidfile = str(Path(folder) / "pid")
                probe = "import os,time;open(" + repr(pidfile) + ",'w').write(str(os.getpid()));time.sleep(60)"
                child = self.start_held("preflight=lambda cancelled:readonly_probe(" + repr(probe) + ",cancelled,timeout=60);main()")
                child.stdin.write(b"{}\n"); child.stdin.flush()
                deadline = time.monotonic() + 3
                while not Path(pidfile).exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(Path(pidfile).exists())
                pid = int(Path(pidfile).read_text())
                if stop == "eof": child.stdin.close()
                else: child.send_signal(signal.SIGTERM)
                child.wait(timeout=3)
                self.assertEqual(json.loads(child.stdout.readline()), {"ok": False, "error": "cancelled"})
                self.assertFalse(Path("/proc", str(pid)).exists())


if __name__ == "__main__":
    unittest.main()
