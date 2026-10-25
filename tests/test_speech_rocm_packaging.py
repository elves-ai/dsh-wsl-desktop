"""Real, offline pip regression for AMD's source-only ROCm metapackage."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("speech_install", ROOT / "src-tauri/helpers/speech_install.py")
I = importlib.util.module_from_spec(spec)
spec.loader.exec_module(I)


@unittest.skipUnless(importlib.util.find_spec("pip"), "requires a test Python with pip; never bootstraps online")
class RocmPackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        with patch.object(I, "run") as run:
            I.install_rocm_dependencies(sys.executable, lambda: False, I.environment())
        self.command = run.call_args_list[-1].args[0].copy()
        index = self.command.index("--index-url")
        self.command[index:index + 2] = ["--no-index", "--find-links", str(self.root)]
        self.command += ["--dry-run", "--ignore-installed", "--no-cache-dir"]

    def source(self, name, requires=()):
        normalized = name.replace("-", "_")
        info = normalized + "-10.1.0.dist-info"
        metadata = "Metadata-Version: 2.1\nName: " + name + "\nVersion: 10.1.0\n"
        if name == "rocm":
            metadata += "Provides-Extra: libraries\nProvides-Extra: devel\nProvides-Extra: device-gfx1201\n"
        metadata += "".join("Requires-Dist: " + requirement + "\n" for requirement in requires)
        # No setuptools, build dependencies, network, or platform GPU detection.
        backend = ("from pathlib import Path\n"
                   "def prepare_metadata_for_build_wheel(metadata_directory, config_settings=None):\n"
                   "    path = Path(metadata_directory) / " + repr(info) + "\n"
                   "    path.mkdir()\n"
                   "    (path / 'METADATA').write_text(" + repr(metadata) + ")\n"
                   "    return path.name\n")
        files = {"pyproject.toml": '[build-system]\nrequires = []\nbuild-backend = "fixture_backend"\nbackend-path = ["."]\n',
                 "fixture_backend.py": backend}
        with tarfile.open(self.root / (name + "-10.1.0.tar.gz"), "w:gz") as archive:
            for filename, content in files.items():
                data = content.encode()
                member = tarfile.TarInfo(name + "-10.1.0/" + filename)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))

    def core_wheel(self):
        info = "rocm_sdk_core-10.1.0.dist-info/"
        with zipfile.ZipFile(self.root / "rocm_sdk_core-10.1.0-py3-none-any.whl", "w") as wheel:
            wheel.writestr(info + "METADATA", "Metadata-Version: 2.1\nName: rocm-sdk-core\nVersion: 10.1.0\n")
            wheel.writestr(info + "WHEEL", "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
            wheel.writestr(info + "RECORD", "")

    def resolve(self, command):
        return subprocess.run(command, env=I.environment(), capture_output=True, text=True, timeout=30)

    def test_old_wheel_only_policy_reproduces_missing_rocm_distribution(self):
        self.source("rocm", ["rocm-sdk-core==10.1.0"])
        self.core_wheel()
        command = [arg for arg in self.command if arg != "--no-binary=rocm"]
        result = self.resolve(command)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No matching distribution found for rocm==10.1.0", result.stderr)

    def test_actual_installer_policy_resolves_source_meta_and_binary_sdk(self):
        self.source("rocm", ["rocm-sdk-core==10.1.0"])
        self.core_wheel()
        report = self.root / "report.json"
        result = self.resolve(self.command + ["--report", str(report)])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        packages = {item["metadata"]["name"]: item for item in json.loads(report.read_text())["install"]}
        self.assertEqual(set(packages), {"rocm", "rocm-sdk-core"})
        self.assertTrue(packages["rocm"]["download_info"]["url"].endswith(".tar.gz"))
        self.assertTrue(packages["rocm-sdk-core"]["download_info"]["url"].endswith(".whl"))

    def test_sdk_payload_cannot_fall_back_to_a_source_build(self):
        self.source("rocm", ["rocm-sdk-core==10.1.0"])
        self.source("rocm-sdk-core")
        result = self.resolve(self.command)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No matching distribution found for rocm-sdk-core==10.1.0", result.stderr)


if __name__ == "__main__":
    unittest.main()
