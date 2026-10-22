"""Stop only the PID confirmed by the launcher, using the existing helper lock.

Run as python3 -c SCRIPT HELPER_PATH CONFIG_PATH EXPECTED_PID. This adapter
never calls the helper main(), starts a service, or sends a signal itself.
"""

import importlib.util
import json
from pathlib import Path
import sys

# Importing the legacy helper must not write __pycache__ beside the old script.
sys.dont_write_bytecode = True


def make_guard(module, state, expected_pid):
    """Wrap listener; checks execute inside the original stop's operation.lock.

    Fail closed for a running or starting service without matching supervisor
    ownership. An absent, unlocked service is already stopped and is harmless.
    """
    if type(expected_pid) is not int or not 0 < expected_pid <= 0xFFFFFFFF:
        raise ValueError("invalid expected PID")
    original_listener = module.listener
    state = Path(state)

    def guarded(config):
        try:
            kind, pid = original_listener(config)
            if kind == "foreign":
                return "foreign", None
            if kind not in ("harness", "absent"):
                return "foreign", None
            if kind == "harness" and (type(pid) is not int or pid != expected_pid):
                return "foreign", None
            locked = module.lock_is_held(state)
            if kind == "absent" and not locked:
                return "absent", None
            if not locked:
                return "foreign", None
            metadata = json.loads((state / "run.json").read_text(encoding="utf-8"))
            if (not isinstance(metadata, dict)
                    or type(metadata.get("pid")) is not int
                    or metadata["pid"] != expected_pid
                    or not isinstance(metadata.get("start_ticks"), str)
                    or metadata["start_ticks"] != module.process_start_ticks(expected_pid)):
                return "foreign", None
            return kind, pid if kind == "harness" else None
        except Exception:
            # No exception text, path, helper output, or credentials reach stdout.
            return "foreign", None

    return guarded


def _load_helper(path):
    spec = importlib.util.spec_from_file_location("_dsh_guarded_helper", path)
    if spec is None or spec.loader is None:
        raise ValueError("helper unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    try:
        if len(args) != 3:
            raise ValueError("invalid arguments")
        helper_path, config_path, pid_text = args
        if not pid_text.isascii() or not pid_text.isdecimal():
            raise ValueError("invalid expected PID")
        expected_pid = int(pid_text)
        if not 0 < expected_pid <= 0xFFFFFFFF:
            raise ValueError("invalid expected PID")
        config = json.loads(Path(config_path).read_text(encoding="utf-8"))
        state = Path(config["state_directory"])
        module = _load_helper(helper_path)
        module.listener = make_guard(module, state, expected_pid)
        # The existing helper takes operation.lock before calling our guard;
        # retain its pidfd-based identity recheck, SIGTERM and wait behavior.
        return module.stop(config, state)
    except Exception:
        print(json.dumps({"state": "error", "code": "launcher_failure"}), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
