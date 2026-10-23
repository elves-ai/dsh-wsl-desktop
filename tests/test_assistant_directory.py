import importlib.util
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
            self.assertEqual(result["path"], str(Path(directory) / "DSH-Assistant"))
            self.assertEqual(helper.prepare("~/DSH-Assistant"), result)

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
