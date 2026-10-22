"""Offline adapter tests: fake helpers only; never import or stop a real service."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "src-tauri" / "helpers" / "guarded_stop.py"
SPEC = importlib.util.spec_from_file_location("guarded_stop", SCRIPT)
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name)
        self.pid = 12345  # Inert number: never passed to any real process API.
        self.metadata = {"pid": self.pid, "start_ticks": "1000"}
        self.write_metadata()
        self.module = SimpleNamespace(
            listener=mock.Mock(return_value=("harness", self.pid)),
            lock_is_held=mock.Mock(return_value=True),
            process_start_ticks=mock.Mock(return_value="1000"),
        )
        self.guard = adapter.make_guard(self.module, self.state, self.pid)

    def write_metadata(self):
        (self.state / "run.json").write_text(json.dumps(self.metadata), encoding="utf-8")

    def test_legal_owned_pid_passes(self):
        self.assertEqual(self.guard({}), ("harness", self.pid))
        self.module.process_start_ticks.assert_called_once_with(self.pid)

    def test_listener_pid_changed(self):
        self.module.listener.return_value = "harness", self.pid + 1
        self.assertEqual(self.guard({}), ("foreign", None))
        self.module.process_start_ticks.assert_not_called()

    def test_metadata_pid_changed(self):
        self.metadata["pid"] += 1
        self.write_metadata()
        self.assertEqual(self.guard({}), ("foreign", None))

    def test_metadata_is_reloaded_on_every_identity_check(self):
        self.assertEqual(self.guard({}), ("harness", self.pid))
        self.metadata["pid"] += 1
        self.write_metadata()
        self.assertEqual(self.guard({}), ("foreign", None))

    def test_no_supervisor_lock(self):
        self.module.lock_is_held.return_value = False
        self.assertEqual(self.guard({}), ("foreign", None))

    def test_changed_process_start_tick(self):
        self.module.process_start_ticks.return_value = "1001"
        self.assertEqual(self.guard({}), ("foreign", None))

    def test_missing_or_malformed_metadata_and_ticks_fail_closed(self):
        for metadata in [None, [], {}, {"pid": self.pid},
                         {"pid": str(self.pid), "start_ticks": "1000"},
                         {"pid": self.pid, "start_ticks": 1000}]:
            with self.subTest(metadata=metadata):
                self.metadata = metadata
                self.write_metadata()
                self.assertEqual(self.guard({}), ("foreign", None))
        (self.state / "run.json").write_text("not JSON token=secret", encoding="utf-8")
        self.assertEqual(self.guard({}), ("foreign", None))
        (self.state / "run.json").unlink()
        self.assertEqual(self.guard({}), ("foreign", None))

    def test_vanished_process_fails_closed(self):
        self.module.process_start_ticks.side_effect = FileNotFoundError("token=secret")
        self.assertEqual(self.guard({}), ("foreign", None))

    def test_absent_unlocked_is_already_stopped(self):
        self.module.listener.return_value = "absent", None
        self.module.lock_is_held.return_value = False
        (self.state / "run.json").unlink()
        self.assertEqual(self.guard({}), ("absent", None))
        self.module.process_start_ticks.assert_not_called()

    def test_absent_but_starting_requires_the_same_owner(self):
        self.module.listener.return_value = "absent", None
        self.assertEqual(self.guard({}), ("absent", None))
        self.metadata["pid"] += 1
        self.write_metadata()
        self.assertEqual(self.guard({}), ("foreign", None))

    def test_absent_but_starting_requires_matching_ticks(self):
        self.module.listener.return_value = "absent", None
        self.module.process_start_ticks.return_value = "1001"
        self.assertEqual(self.guard({}), ("foreign", None))

    def test_foreign_and_unknown_listeners_stay_foreign(self):
        for result in [("foreign", None), ("foreign", 9999), ("unexpected", self.pid)]:
            self.module.listener.return_value = result
            self.assertEqual(self.guard({}), ("foreign", None))
        self.module.lock_is_held.assert_not_called()

    def test_original_listener_is_saved_before_replacement(self):
        self.module.listener = self.guard
        self.assertEqual(self.module.listener({}), ("harness", self.pid))

    def test_invalid_expected_pids_rejected(self):
        for pid in [None, True, False, 0, -1, "12345", 0x100000000]:
            with self.subTest(pid=pid):
                with self.assertRaises(ValueError):
                    adapter.make_guard(self.module, self.state, pid)

    def test_main_installs_guard_inside_original_stop_lock_scope(self):
        config = {"state_directory": str(self.state)}
        config_file = self.state / "config.json"
        config_file.write_text(json.dumps(config), encoding="utf-8")
        in_operation_lock = False

        def lock_is_held(state):
            self.assertTrue(in_operation_lock, "ownership read must be under operation.lock")
            self.assertEqual(state, self.state)
            return True

        def fake_stop(received_config, state):
            nonlocal in_operation_lock
            self.assertEqual(received_config, config)
            self.assertEqual(state, self.state)
            in_operation_lock = True
            try:
                self.assertEqual(self.module.listener(received_config), ("harness", self.pid))
                self.metadata["pid"] += 1
                self.write_metadata()
                self.assertEqual(self.module.listener(received_config), ("foreign", None))
                return 74
            finally:
                in_operation_lock = False

        self.module.lock_is_held.side_effect = lock_is_held
        self.module.stop = mock.Mock(side_effect=fake_stop)
        with mock.patch.object(adapter, "_load_helper", return_value=self.module):
            self.assertEqual(adapter.main(["unused-helper.py", str(config_file), str(self.pid)]), 74)
        self.module.stop.assert_called_once()

    def test_main_failures_emit_only_static_safe_json(self):
        config_file = self.state / "config.json"
        config_file.write_text(json.dumps({"state_directory": str(self.state)}), encoding="utf-8")
        cases = [[], ["token=secret", "missing", "not-a-pid"],
                 ["token=secret", "missing", "0"],
                 ["token=secret", "missing", "4294967296"],
                 ["token=secret", "missing", "１２３"],
                 ["token=secret", "missing", str(self.pid)],
                 ["token=secret", str(config_file), str(self.pid)]]
        for args in cases:
            with self.subTest(args=args):
                output = io.StringIO()
                with contextlib.redirect_stdout(output), mock.patch.object(
                    adapter, "_load_helper", side_effect=RuntimeError("Bearer hidden token=secret")
                ):
                    self.assertEqual(adapter.main(args), 1)
                self.assertEqual(json.loads(output.getvalue()),
                                 {"state": "error", "code": "launcher_failure"})
                self.assertNotIn("secret", output.getvalue())
                self.assertNotIn("hidden", output.getvalue())

    def test_import_helper_does_not_execute_its_main(self):
        fake_path = self.state / "fake_helper.py"
        fake_path.write_text('if __name__ == "__main__":\n    raise RuntimeError("must not run")\nVALUE = 42\n',
                             encoding="utf-8")
        self.assertEqual(adapter._load_helper(str(fake_path)).VALUE, 42)


if __name__ == "__main__":
    unittest.main()
