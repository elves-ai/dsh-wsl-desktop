import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("assistant_directory", Path(__file__).parents[1] / "src-tauri/helpers/assistant_directory.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class AssistantDirectoryTests(unittest.TestCase):
    def test_default_is_independent_user_directory_and_reusable(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
            result = helper.prepare("")
            self.assertEqual(result["path"], str(Path(directory) / ".dsh-wsl-desktop" / "assistant"))
            self.assertTrue(Path(result["path"]).is_dir())
            self.assertEqual(helper.prepare("~/.dsh-wsl-desktop/assistant"), result)
            self.assertEqual(helper.prepare("  "), result)
            self.assertFalse((Path(directory) / "DSH-Assistant").exists())

    def test_default_does_not_migrate_or_overwrite_existing_directories(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
            root = Path(directory)
            legacy = root / "DSH-Assistant"
            custom = root / "my-assistant"
            default = root / ".dsh-wsl-desktop" / "assistant"
            for path in (legacy, custom, default):
                path.mkdir(parents=True)
                (path / "keep.txt").write_text(str(path))
            self.assertEqual(helper.prepare("")["path"], str(default))
            for raw, path in (("~/DSH-Assistant", legacy), (str(custom), custom), (str(default), default)):
                with self.subTest(path=raw):
                    self.assertEqual(helper.prepare(raw)["path"], str(path))
                    self.assertEqual((path / "keep.txt").read_text(), str(path))
                    self.assertEqual(list(path.iterdir()), [path / "keep.txt"])

    def test_explicit_legacy_or_custom_directory_does_not_create_default(self):
        for raw in ("~/DSH-Assistant", "~/my-assistant"):
            with self.subTest(path=raw), tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
                selected = Path(directory) / raw[2:]
                self.assertEqual(helper.prepare(raw)["path"], str(selected))
                self.assertFalse((Path(directory) / ".dsh-wsl-desktop").exists())

    def test_assistant_first_creates_private_root_compatible_with_speech(self):
        speech_spec = importlib.util.spec_from_file_location("speech_resources_for_assistant", Path(__file__).parents[1] / "src-tauri/helpers/speech_resources.py")
        speech = importlib.util.module_from_spec(speech_spec)
        speech_spec.loader.exec_module(speech)
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
            old_umask = os.umask(0o022)
            try:
                helper.prepare("")
                data = Path(directory) / ".dsh-wsl-desktop"
                self.assertEqual(data.stat().st_mode & 0o777, 0o700)
                self.assertEqual((data / "assistant").stat().st_mode & 0o777, 0o700)
                fd = speech.initialize_root(Path(directory), create=True)
                os.close(fd)
                self.assertEqual((data / "speech").stat().st_mode & 0o777, 0o700)
            finally:
                os.umask(old_umask)

    def test_managed_root_link_is_refused_without_writing_outside(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
            outside = Path(directory) / "outside"
            outside.mkdir()
            (Path(directory) / ".dsh-wsl-desktop").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                helper.prepare("")
            self.assertEqual(list(outside.iterdir()), [])

    def test_existing_managed_root_and_custom_directory_modes_are_not_changed(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
            data = Path(directory) / ".dsh-wsl-desktop"
            data.mkdir(mode=0o755)
            before = data.stat().st_mode
            helper.prepare("")
            self.assertEqual(data.stat().st_mode, before)
            custom = Path(directory) / "custom"
            custom.mkdir(mode=0o750)
            before = custom.stat().st_mode
            helper.prepare(str(custom))
            self.assertEqual(custom.stat().st_mode, before)

    def test_explicit_path_is_data_not_shell(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "assistant ; touch NOT-EXECUTED"
            self.assertEqual(helper.prepare(str(path))["path"], str(path))
            self.assertTrue(path.is_dir())
            self.assertFalse((Path(directory) / "NOT-EXECUTED").exists())

    def test_rejects_invalid_paths_without_writes(self):
        for path in ["relative", "C:\\project", "/", "//server/path", "/tmp/../other", "/tmp/bad\npath"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                helper.prepare(path)

    def test_rejects_symlink_and_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "real").mkdir()
            (root / "link").symlink_to(root / "real", target_is_directory=True)
            with self.assertRaises(ValueError):
                helper.prepare(str(root / "link"))
            (root / "file").write_text("keep")
            with self.assertRaises(OSError):
                helper.prepare(str(root / "file"))


if __name__ == "__main__":
    unittest.main()
