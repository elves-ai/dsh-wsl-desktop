import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("assistant_directory", Path(__file__).parents[1] / "src-tauri/helpers/assistant_directory.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class AssistantDirectoryTests(unittest.TestCase):
    def run_helper(self, home, *arguments):
        return subprocess.run(
            [sys.executable, "-B", str(Path(helper.__file__).resolve()), *arguments],
            env={**os.environ, "HOME": str(home)},
            capture_output=True, text=True, check=False,
        )

    def test_default_is_independent_user_directory_and_reusable(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
            result = helper.prepare()
            self.assertEqual(result["path"], str(Path(directory) / ".dsh-wsl-desktop" / "assistant"))
            self.assertTrue(Path(result["path"]).is_dir())
            self.assertEqual(helper.prepare(), result)
            self.assertEqual(helper.inspect(), result)
            self.assertFalse((Path(directory) / "DSH-Assistant").exists())

    def test_default_does_not_migrate_or_overwrite_existing_directories(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
            root = Path(directory)
            paths = (root / "DSH-Assistant", root / "my-assistant", root / ".dsh-wsl-desktop" / "assistant")
            for path in paths:
                path.mkdir(parents=True)
                (path / "keep.txt").write_text(str(path))
            self.assertEqual(helper.prepare()["path"], str(paths[-1]))
            for path in paths:
                self.assertEqual((path / "keep.txt").read_text(), str(path))
                self.assertEqual(list(path.iterdir()), [path / "keep.txt"])

    def test_python_api_rejects_any_path_argument_without_writes(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
            for operation in (helper.prepare, helper.inspect):
                for raw in ("", "~/.dsh-wsl-desktop/assistant", "~/DSH-Assistant", directory, None):
                    with self.subTest(operation=operation.__name__, path=raw), self.assertRaises(TypeError):
                        operation(raw)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_assistant_first_creates_private_root_compatible_with_speech(self):
        speech_spec = importlib.util.spec_from_file_location("speech_resources_for_assistant", Path(__file__).parents[1] / "src-tauri/helpers/speech_resources.py")
        speech = importlib.util.module_from_spec(speech_spec)
        speech_spec.loader.exec_module(speech)
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
            old_umask = os.umask(0o022)
            try:
                helper.prepare()
                data = Path(directory) / ".dsh-wsl-desktop"
                self.assertEqual(data.stat().st_mode & 0o777, 0o700)
                self.assertEqual((data / "assistant").stat().st_mode & 0o777, 0o700)
                fd = speech.initialize_root(Path(directory), create=True)
                os.close(fd)
                self.assertEqual((data / "speech").stat().st_mode & 0o777, 0o700)
            finally:
                os.umask(old_umask)

    def test_managed_root_and_workspace_links_are_refused_without_writes(self):
        for component in ("root", "workspace"):
            for dangling in (False, True):
                for operation in (helper.prepare, helper.inspect):
                    with self.subTest(component=component, dangling=dangling, operation=operation.__name__), tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
                        root = Path(directory) / ".dsh-wsl-desktop"
                        outside = Path(directory) / "outside"
                        if not dangling:
                            outside.mkdir()
                        if component == "workspace":
                            root.mkdir()
                        link = root if component == "root" else root / "assistant"
                        link.symlink_to(outside, target_is_directory=True)
                        with self.assertRaises(ValueError):
                            operation()
                        self.assertTrue(link.is_symlink())
                        if dangling:
                            self.assertFalse(outside.exists())
                        else:
                            self.assertEqual(list(outside.iterdir()), [])

    def test_existing_directory_modes_are_not_changed(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
            data = Path(directory) / ".dsh-wsl-desktop"
            workspace = data / "assistant"
            data.mkdir(mode=0o755)
            workspace.mkdir(mode=0o750)
            before = (data.stat().st_mode, workspace.stat().st_mode)
            helper.prepare()
            self.assertEqual((data.stat().st_mode, workspace.stat().st_mode), before)

    def test_rejects_existing_files_without_overwriting(self):
        for component in ("root", "workspace"):
            for operation in (helper.prepare, helper.inspect):
                with self.subTest(component=component, operation=operation.__name__), tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
                    data = Path(directory) / ".dsh-wsl-desktop"
                    if component == "workspace":
                        data.mkdir()
                    existing = data if component == "root" else data / "assistant"
                    existing.write_text("keep")
                    with self.assertRaises((OSError, ValueError)):
                        operation()
                    self.assertEqual(existing.read_text(), "keep")

    def test_inspect_missing_workspace_has_no_side_effects(self):
        for root_exists in (False, True):
            with self.subTest(root_exists=root_exists), tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
                data = Path(directory) / ".dsh-wsl-desktop"
                if root_exists:
                    data.mkdir(mode=0o750)
                before = Path(directory).stat()
                with patch.object(Path, "mkdir", side_effect=AssertionError("inspect must not create")), patch.object(os, "mkdir", side_effect=AssertionError("inspect must not create")), patch.object(os, "chmod", side_effect=AssertionError("inspect must not chmod")):
                    result = helper.inspect()
                self.assertEqual(result, {"path": str(data / "assistant")})
                self.assertEqual(Path(directory).stat(), before)
                self.assertEqual(list(Path(directory).iterdir()), [data] if root_exists else [])
                self.assertFalse((data / "assistant").exists())

    def test_inspect_existing_workspace_preserves_contents_and_metadata(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
            expected = helper.prepare()
            workspace = Path(expected["path"])
            marker = workspace / "keep.txt"
            marker.write_text("keep")
            paths = (Path(directory), workspace.parent, workspace, marker)
            before = [path.stat() for path in paths]
            self.assertEqual(helper.inspect(), expected)
            self.assertEqual([path.stat() for path in paths], before)
            self.assertEqual(marker.read_text(), "keep")

    def test_inspect_returns_same_canonical_path_with_linked_home(self):
        with tempfile.TemporaryDirectory() as directory:
            actual_home = Path(directory) / "actual"
            actual_home.mkdir()
            linked_home = Path(directory) / "home-link"
            linked_home.symlink_to(actual_home, target_is_directory=True)
            with patch.object(Path, "home", return_value=linked_home):
                inspected = helper.inspect()
                self.assertEqual(inspected["path"], str(actual_home / ".dsh-wsl-desktop" / "assistant"))
                self.assertEqual(list(actual_home.iterdir()), [])
                self.assertEqual(helper.prepare(), inspected)

    def test_workspace_link_inserted_during_creation_is_refused(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
            root = Path(directory) / ".dsh-wsl-desktop"
            root.mkdir()
            outside = Path(directory) / "outside"
            outside.mkdir()
            original_mkdir = os.mkdir

            def raced_mkdir(path, mode=0o777, *, dir_fd=None):
                if path == "assistant" and dir_fd is not None:
                    (root / "assistant").symlink_to(outside, target_is_directory=True)
                return original_mkdir(path, mode, dir_fd=dir_fd)

            with patch.object(os, "mkdir", side_effect=raced_mkdir), self.assertRaises(OSError):
                helper.prepare()
            self.assertEqual(list(outside.iterdir()), [])

    def test_cli_inspects_without_creation_then_prepares_default(self):
        with tempfile.TemporaryDirectory(prefix="assistant ; ") as directory:
            expected = {"path": str(Path(directory) / ".dsh-wsl-desktop" / "assistant")}
            inspected = self.run_helper(directory, "--inspect")
            self.assertEqual(inspected.returncode, 0, inspected.stderr)
            self.assertEqual(json.loads(inspected.stdout), expected)
            self.assertEqual(list(Path(directory).iterdir()), [])
            prepared = self.run_helper(directory)
            self.assertEqual(prepared.returncode, 0, prepared.stderr)
            self.assertEqual(json.loads(prepared.stdout), expected)
            self.assertTrue(Path(expected["path"]).is_dir())
            self.assertEqual(json.loads(self.run_helper(directory, "--inspect").stdout), expected)

    def test_cli_rejects_all_other_arguments_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            for arguments in (("",), (directory,), ("~/.dsh-wsl-desktop/assistant",), ("--help",), ("--unknown",), ("--inspect", directory), ("--inspect", "--inspect"), ("--",)):
                with self.subTest(arguments=arguments):
                    result = self.run_helper(directory, *arguments)
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(json.loads(result.stdout), {"error": "workspace unavailable"})
                    self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
