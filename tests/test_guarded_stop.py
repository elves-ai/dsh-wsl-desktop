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

    def test_recorded_orphan_is_stoppable_only_with_all_provenance_checks(self):
        self.module.lock_is_held.return_value = False
        self.module.process_matches = mock.Mock(return_value=True)
        self.metadata["supervisor"] = self.pid - 1
        self.write_metadata()
        with mock.patch.object(adapter, "_orphan_log_matches", return_value=True):
            self.assertEqual(self.guard({}), ("harness", self.pid))
            self.module.process_matches.return_value = False
            self.assertEqual(self.guard({}), ("foreign", None))
            self.module.process_matches.return_value = True
            self.module.process_start_ticks.return_value = "1001"
            self.assertEqual(self.guard({}), ("foreign", None))
        self.module.process_start_ticks.return_value = "1000"
        with mock.patch.object(adapter, "_orphan_log_matches", return_value=False):
            self.assertEqual(self.guard({}), ("foreign", None))

    def test_orphan_requires_an_original_supervisor_record(self):
        self.module.lock_is_held.return_value = False
        self.module.process_matches = mock.Mock(return_value=True)
        with mock.patch.object(adapter, "_orphan_log_matches", return_value=True):
            for supervisor in (None, True, "12344", 0, self.pid):
                self.metadata["supervisor"] = supervisor
                self.write_metadata()
                self.assertEqual(self.guard({}), ("foreign", None))

    def test_metadata_symlink_and_fifo_are_rejected_without_blocking(self):
        record = self.state / "run.json"
        record.unlink()
        record.symlink_to(self.state / "nonexistent.json")
        self.assertEqual(self.guard({}), ("foreign", None))
        record.unlink()
        import os
        os.mkfifo(record)
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


class ProbeTests(unittest.TestCase):
    """All processes, sockets, HTTP and supervisor locks are inert fake fixtures."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name)
        self.pid = 12345
        self.metadata = {"pid": self.pid, "start_ticks": "1000"}
        self.write_metadata()
        self.config = {"state_directory": str(self.state), "port": 3080}
        self.root = "http://127.0.0.1:3080/"
        self.token_url = self.root + "?token=" + "A" * 43
        self.module = SimpleNamespace(
            listener=mock.Mock(return_value=("harness", self.pid)),
            process_start_ticks=mock.Mock(return_value="1000"),
            process_matches=mock.Mock(return_value=True),
            http_status=mock.Mock(side_effect=lambda url: (401, False) if url == self.root else (303, True)),
            lock_is_held=mock.Mock(side_effect=AssertionError("legacy lock can create files")),
            stop=mock.Mock(side_effect=AssertionError("must never stop")),
            run=mock.Mock(side_effect=AssertionError("must never start")),
            main=mock.Mock(side_effect=AssertionError("must never run helper main")),
        )
        self.lock = mock.Mock(return_value=True)
        patcher = mock.patch.object(adapter, "_lock_is_held_read_only", self.lock)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.assert_no_lifecycle)

    def assert_no_lifecycle(self):
        for method in (self.module.stop, self.module.run, self.module.main, self.module.lock_is_held):
            method.assert_not_called()

    def write_metadata(self):
        (self.state / "run.json").write_text(json.dumps(self.metadata), encoding="utf-8")

    def probe(self):
        return adapter.probe(self.module, self.config, self.state)

    def test_owned_ready_missing_auth_remains_managed_and_stoppable(self):
        self.assertEqual(self.probe(), {
            "state": "ready", "managed": True, "authenticated": False,
            "pid": self.pid, "url": self.root, "code": "managed_auth_unavailable",
        })

    def test_owned_public_ready_needs_no_token(self):
        self.module.http_status.return_value = (200, False)
        self.module.http_status.side_effect = None
        reply = self.probe()
        self.assertTrue(reply["managed"])
        self.assertEqual(reply["state"], "ready")
        self.assertNotIn("code", reply)
        self.assertFalse(reply["authenticated"])

    def test_owned_token_recovered_and_only_url_contains_credential(self):
        (self.state / "web.log").write_text(self.token_url + "\n", encoding="utf-8")
        reply = self.probe()
        self.assertTrue(reply["managed"])
        self.assertTrue(reply["authenticated"])
        self.assertEqual(reply.pop("url"), self.token_url)
        self.assertNotIn("A" * 43, json.dumps(reply))
        self.module.http_status.assert_has_calls([mock.call(self.root), mock.call(self.token_url)])

    def test_recorded_orphan_recovers_auth_without_supervisor_lock(self):
        self.lock.return_value = False
        self.metadata["supervisor"] = self.pid - 1
        self.write_metadata()
        (self.state / "web.log").write_text(self.token_url + "\n", encoding="utf-8")
        with mock.patch.object(adapter, "_orphan_log_matches", return_value=True):
            reply = self.probe()
        self.assertTrue(reply["managed"])
        self.assertTrue(reply["authenticated"])
        self.assertEqual(reply["url"], self.token_url)
        self.assertEqual(reply["pid"], self.pid)

    def test_recorded_orphan_stays_stoppable_when_auth_is_missing(self):
        self.lock.return_value = False
        self.metadata["supervisor"] = self.pid - 1
        self.write_metadata()
        with mock.patch.object(adapter, "_orphan_log_matches", return_value=True):
            reply = self.probe()
            guard = adapter.make_guard(self.module, self.state, self.pid, self.lock)
            self.assertEqual(guard(self.config), ("harness", self.pid))
        self.assertTrue(reply["managed"])
        self.assertFalse(reply["authenticated"])
        self.assertEqual(reply["code"], "managed_auth_unavailable")

    def test_orphan_provenance_changed_during_auth_never_returns_credentials(self):
        self.lock.return_value = False
        self.metadata["supervisor"] = self.pid - 1
        self.write_metadata()
        (self.state / "web.log").write_text(self.token_url, encoding="utf-8")
        with mock.patch.object(adapter, "_orphan_log_matches", side_effect=[True, False]):
            reply = self.probe()
        self.assertEqual(reply, {"state": "error", "code": "process_changed", "managed": False})

    def test_external_ready_never_reads_stale_credentials_or_claims_ownership(self):
        self.lock.return_value = False
        (self.state / "web.log").write_text(self.token_url + "\n", encoding="utf-8")
        reply = self.probe()
        self.assertFalse(reply["managed"])
        self.assertFalse(reply["authenticated"])
        self.assertEqual(reply["url"], self.root)
        self.module.http_status.assert_called_once_with(self.root)
        self.module.process_start_ticks.assert_not_called()

    def test_absent_unlocked_is_stopped(self):
        self.module.listener.return_value = ("absent", None)
        self.lock.return_value = False
        self.assertEqual(self.probe(), {"state": "stopped", "managed": False})
        self.module.http_status.assert_not_called()

    def test_owned_starting_has_pid_without_authentication(self):
        self.module.listener.return_value = ("absent", None)
        self.assertEqual(self.probe(), {"state": "starting", "managed": True, "pid": self.pid})
        self.module.process_matches.assert_called_once_with(self.config, self.pid)
        self.module.http_status.assert_not_called()

    def test_starting_process_identity_mismatch_fails_closed(self):
        self.module.listener.return_value = ("absent", None)
        self.module.process_matches.return_value = False
        self.assertEqual(self.probe(), {"state": "starting", "managed": False})

    def test_starting_metadata_publication_is_waited_without_stop_authority(self):
        self.module.listener.return_value = ("absent", None)
        record = self.state / "run.json"
        for text in ('', '{"pid":', '{}', '{"pid": true}'):
            with self.subTest(text=text):
                record.write_text(text, encoding="utf-8")
                self.assertEqual(self.probe(), {"state": "starting", "managed": False})
        record.unlink()
        self.assertEqual(self.probe(), {"state": "starting", "managed": False})
        self.module.http_status.assert_not_called()

    def test_missing_or_malformed_metadata_is_explicit_not_external(self):
        for text in ("not JSON token=secret", "null", "[]", "{}", '{"pid": true}', '{"pid": "12345"}'):
            with self.subTest(text=text):
                (self.state / "run.json").write_text(text, encoding="utf-8")
                self.assertEqual(self.probe(), {
                    "state": "error", "code": "unverified_startup", "managed": False,
                })
        (self.state / "run.json").unlink()
        self.assertEqual(self.probe()["code"], "unverified_startup")

    def test_metadata_pid_and_reused_pid_ticks_must_match(self):
        self.metadata["pid"] += 1
        self.write_metadata()
        self.assertEqual(self.probe()["code"], "process_changed")
        self.metadata["pid"] = self.pid
        self.write_metadata()
        self.module.process_start_ticks.return_value = "1001"
        self.assertEqual(self.probe()["code"], "process_changed")

    def test_foreign_listener_has_static_error(self):
        self.module.listener.return_value = ("foreign", None)
        self.assertEqual(self.probe(), {"state": "error", "code": "port_in_use", "managed": False})
        self.module.http_status.assert_not_called()
        self.lock.assert_not_called()

    def test_auth_log_fifo_and_symlink_cannot_block_or_supply_credentials(self):
        import os
        log = self.state / "web.log"
        os.mkfifo(log)
        self.assertEqual(self.probe()["code"], "managed_auth_unavailable")
        log.unlink()
        target = self.state / "untrusted.log"
        target.write_text(self.token_url, encoding="utf-8")
        log.symlink_to(target)
        self.assertEqual(self.probe()["code"], "managed_auth_unavailable")
        self.module.http_status.assert_has_calls([mock.call(self.root), mock.call(self.root)])
        self.assertEqual(self.module.http_status.call_count, 2)

    def test_head_and_tail_recover_large_current_log(self):
        for position in ("head", "tail"):
            with self.subTest(position=position):
                filler = "x" * (adapter.LOG_WINDOW_BYTES * 3)
                text = self.token_url + "\n" + filler if position == "head" else filler + "\n" + self.token_url
                (self.state / "web.log").write_text(text, encoding="utf-8")
                self.assertEqual(self.probe()["url"], self.token_url)

    def test_middle_of_large_log_is_not_scanned(self):
        filler = "x" * (adapter.LOG_WINDOW_BYTES + 1)
        (self.state / "web.log").write_text(filler + "\n" + self.token_url + "\n" + filler, encoding="utf-8")
        self.assertEqual(self.probe()["code"], "managed_auth_unavailable")
        self.module.http_status.assert_called_once_with(self.root)

    def test_noncanonical_or_overlong_credentials_are_not_exchanged(self):
        candidates = [
            self.token_url + "A", self.token_url + "&other=1", self.token_url + "#fragment",
            self.token_url + "%20", self.token_url.replace("3080", "3081"),
            self.token_url.replace("127.0.0.1", "localhost"),
            self.token_url.replace("http:", "https:"), self.token_url[:-1],
        ]
        for candidate in candidates:
            with self.subTest(candidate=candidate):
                self.module.http_status.reset_mock()
                (self.state / "web.log").write_text(candidate + "\n", encoding="utf-8")
                self.assertEqual(self.probe()["code"], "managed_auth_unavailable")
                self.module.http_status.assert_called_once_with(self.root)

    def test_truncated_head_cannot_validate_prefix_of_longer_token(self):
        prefix = "x" * (adapter.LOG_WINDOW_BYTES - len(self.token_url))
        (self.state / "web.log").write_text(prefix + self.token_url + "A" + "x" * (adapter.LOG_WINDOW_BYTES * 3), encoding="utf-8")
        self.assertEqual(self.probe()["code"], "managed_auth_unavailable")
        self.module.http_status.assert_called_once_with(self.root)

    def test_failed_or_exceptional_exchange_preserves_managed(self):
        (self.state / "web.log").write_text(self.token_url, encoding="utf-8")
        for result in ((303, False), (401, False), RuntimeError("token=secret")):
            with self.subTest(result=result):
                def status(url):
                    if url == self.root:
                        return 401, False
                    if isinstance(result, Exception):
                        raise result
                    return result
                self.module.http_status.side_effect = status
                reply = self.probe()
                self.assertTrue(reply["managed"])
                self.assertEqual(reply["code"], "managed_auth_unavailable")
                self.assertEqual(reply["url"], self.root)

    def test_owner_change_during_auth_exchange_discards_url(self):
        (self.state / "web.log").write_text(self.token_url, encoding="utf-8")
        self.module.listener.side_effect = [("harness", self.pid), ("harness", self.pid), ("harness", self.pid + 1)]
        self.assertEqual(self.probe(), {"state": "error", "code": "process_changed", "managed": False})

    def test_probe_cli_never_calls_original_probe_or_lifecycle(self):
        config_file = self.state / "config.json"
        config_file.write_text(json.dumps(self.config), encoding="utf-8")
        self.module.probe = mock.Mock(side_effect=AssertionError("legacy probe conflates auth and identity"))
        output = io.StringIO()
        with contextlib.redirect_stdout(output), mock.patch.object(adapter, "_load_helper", return_value=self.module):
            self.assertEqual(adapter.main(["--probe", "fake-helper.py", str(config_file)]), 0)
        reply = json.loads(output.getvalue())
        self.assertTrue(reply["managed"])
        self.assertEqual(reply["code"], "managed_auth_unavailable")
        self.module.probe.assert_not_called()


class ReadOnlyLockTests(unittest.TestCase):
    def test_missing_lock_does_not_create_any_files(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "missing-state"
            self.assertFalse(adapter._lock_is_held_read_only(state))
            self.assertFalse(state.exists())

    def test_existing_lock_is_observed_without_content_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            path = state / "server.lock"
            path.write_bytes(b"existing lock")
            before = path.stat()
            with path.open("rb") as held:
                adapter.fcntl.flock(held, adapter.fcntl.LOCK_EX | adapter.fcntl.LOCK_NB)
                self.assertTrue(adapter._lock_is_held_read_only(state))
            self.assertFalse(adapter._lock_is_held_read_only(state))
            self.assertEqual(path.read_bytes(), b"existing lock")
            self.assertEqual(path.stat().st_mtime_ns, before.st_mtime_ns)


class OrphanLogIdentityTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.log = self.root / "web.log"
        self.log.write_bytes(b"fixture log")
        self.proc_root = self.root / "proc"
        self.pid = 12345
        self.fd = self.proc_root / str(self.pid) / "fd"
        self.fd.mkdir(parents=True)
        for name in ("1", "2"):
            (self.fd / name).symlink_to(self.log)

    def matches(self):
        return adapter._orphan_log_matches(self.root, self.pid, self.proc_root)

    def test_both_log_descriptors_must_match_exact_regular_log_inode(self):
        self.assertTrue(self.matches())
        other = self.root / "other.log"
        other.write_bytes(b"fixture log")
        (self.fd / "2").unlink()
        (self.fd / "2").symlink_to(other)
        self.assertFalse(self.matches())

    def test_same_filename_with_new_inode_does_not_prove_ownership(self):
        previous = self.root / "previous.log"
        self.log.rename(previous)
        self.log.write_bytes(b"new run")
        for name in ("1", "2"):
            (self.fd / name).unlink()
            (self.fd / name).symlink_to(previous)
        self.assertFalse(self.matches())

    def test_missing_descriptor_symlinked_log_and_wrong_uid_fail_closed(self):
        (self.fd / "1").unlink()
        self.assertFalse(self.matches())
        (self.fd / "1").symlink_to(self.log)
        previous = self.root / "previous.log"
        self.log.rename(previous)
        self.log.symlink_to(previous)
        self.assertFalse(self.matches())
        self.log.unlink()
        previous.rename(self.log)
        with mock.patch.object(adapter.os, "getuid", return_value=self.log.stat().st_uid + 1):
            self.assertFalse(self.matches())


if __name__ == "__main__":
    unittest.main()
