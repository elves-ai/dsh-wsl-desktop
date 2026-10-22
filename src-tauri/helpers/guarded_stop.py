"""Probe ownership independently of authentication, or safely stop an owned PID.

Run as python3 -c SCRIPT --probe HELPER_PATH CONFIG_PATH, or retain the stop
form SCRIPT HELPER_PATH CONFIG_PATH EXPECTED_PID. This adapter never calls the
helper main(), starts a service, or sends a signal itself. Probe creates no files.
"""

import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

# Importing the legacy helper must not write __pycache__ beside the old script.
sys.dont_write_bytecode = True


def _read_metadata(state):
    # A missing supervisor must not make stale/unbounded/symlinked state authoritative.
    fd = os.open(Path(state) / "run.json", os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise ValueError("invalid ownership record")
        content = source.read(65537)
    if len(content) > 65536:
        raise ValueError("ownership record too large")
    return json.loads(content.decode("utf-8"))


def _orphan_log_matches(state, pid, proc_root="/proc"):
    """Recover only a recorded child still writing THIS run's regular log file.

    PID/start_ticks are checked separately. A Node listener, old run.json, or a
    credential-shaped line alone is never sufficient evidence of ownership.
    """
    try:
        info = (Path(state) / "web.log").lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            return False
        proc = Path(proc_root) / str(pid)
        if proc.stat().st_uid != os.getuid():
            return False
        for descriptor in ("1", "2"):
            output = (proc / "fd" / descriptor).stat()
            if (output.st_dev, output.st_ino) != (info.st_dev, info.st_ino):
                return False
        return True
    except OSError:
        return False


def make_guard(module, state, expected_pid, lock_check=None):
    """Wrap listener; checks execute inside the original stop's operation.lock.

    Accept a live supervisor or a recorded child whose exact PID/start time and
    output-log inodes still prove its original launch. Otherwise fail closed.
    An absent, unlocked service is already stopped and is harmless.
    """
    if type(expected_pid) is not int or not 0 < expected_pid <= 0xFFFFFFFF:
        raise ValueError("invalid expected PID")
    original_listener = module.listener
    state = Path(state)
    lock_check = module.lock_is_held if lock_check is None else lock_check

    def guarded(config):
        try:
            kind, pid = original_listener(config)
            if kind == "foreign":
                return "foreign", None
            if kind not in ("harness", "absent"):
                return "foreign", None
            if kind == "harness" and (type(pid) is not int or pid != expected_pid):
                return "foreign", None
            locked = lock_check(state)
            if kind == "absent" and not locked:
                return "absent", None
            if not locked and (kind != "harness"
                               or not _orphan_log_matches(state, expected_pid)
                               or not module.process_matches(config, expected_pid)):
                return "foreign", None
            metadata = _read_metadata(state)
            if (not isinstance(metadata, dict)
                    or type(metadata.get("pid")) is not int
                    or metadata["pid"] != expected_pid
                    or not isinstance(metadata.get("start_ticks"), str)
                    or metadata["start_ticks"] != module.process_start_ticks(expected_pid)):
                return "foreign", None
            if not locked and (type(metadata.get("supervisor")) is not int
                               or metadata["supervisor"] <= 0
                               or metadata["supervisor"] == expected_pid):
                return "foreign", None
            return kind, pid if kind == "harness" else None
        except Exception:
            # No exception text, path, helper output, or credentials reach stdout.
            return "foreign", None

    return guarded


# Bound log recovery even when a long-running service has produced a huge log.
LOG_WINDOW_BYTES = 128 * 1024


def _lock_is_held_read_only(state):
    """Observe an existing lock without creating state directories or lock files."""
    try:
        fd = os.open(Path(state) / "server.lock", os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        lock = os.fdopen(fd, "rb")
    except FileNotFoundError:
        return False
    with lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError("invalid supervisor lock")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False


def _auth_url(module, state, root):
    """Recover only exact loopback credentials from the current owned run's log."""
    try:
        fd = os.open(state / "web.log", os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as log:
            info = os.fstat(log.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
                return None
            head = log.read(LOG_WINDOW_BYTES)
            size = log.seek(0, 2)
            if size > LOG_WINDOW_BYTES:
                log.seek(size - LOG_WINDOW_BYTES)
                tail = log.read(LOG_WINDOW_BYTES)
            else:
                tail = b""
    except OSError:
        return None
    pattern = re.compile(re.escape(root) + r"\?token=[A-Za-z0-9_-]{43}(?![A-Za-z0-9_%&?#=/-])")
    # The gap is deliberately not joined: partial bytes must not manufacture a URL.
    candidates = []
    for chunk, at_eof in ((head, size <= LOG_WINDOW_BYTES), (tail, True)):
        text = chunk.decode("utf-8", errors="replace")
        for match in pattern.finditer(text):
            if match.end() != len(text) or at_eof:
                candidates.append(match.group())
    # Match legacy behavior: validate only the latest candidate. This also bounds
    # HTTP work when a noisy log contains thousands of credential-shaped strings.
    if candidates:
        candidate = candidates[-1]
        try:
            status, has_cookie = module.http_status(candidate)
            if status == 303 and has_cookie:
                return candidate
        except Exception:
            pass  # Authentication failure never removes proven service ownership.
    return None


def probe(module, config, state):
    """Return service identity and readiness without adopting external processes."""
    state = Path(state)
    port = config["port"]
    if type(port) is not int or not 0 < port <= 65535:
        raise ValueError("invalid port")
    root = f"http://127.0.0.1:{port}/"
    kind, pid = module.listener(config)
    if kind not in ("harness", "absent"):
        return {"state": "error", "code": "port_in_use", "managed": False}
    locked = _lock_is_held_read_only(state)
    if kind == "absent" and not locked:
        return {"state": "stopped", "managed": False}
    if locked:
        try:
            metadata = _read_metadata(state)
            owner_pid = metadata["pid"]
            if type(owner_pid) is not int or not 0 < owner_pid <= 0xFFFFFFFF:
                raise ValueError("invalid owner")
        except (OSError, ValueError, KeyError, TypeError):
            if kind == "absent":
                # The supervisor takes its lock before publishing the child record.
                return {"state": "starting", "managed": False}
            return {"state": "error", "code": "unverified_startup", "managed": False}
    else:
        owner_pid = pid
    guard = make_guard(module, state, owner_pid, _lock_is_held_read_only)
    expected = (kind, pid if kind == "harness" else None)
    managed = guard(config) == expected
    if locked and (not managed or (kind == "absent" and not module.process_matches(config, owner_pid))):
        if kind == "absent":
            return {"state": "starting", "managed": False}
        return {"state": "error", "code": "process_changed", "managed": False}
    if kind == "absent":
        return {"state": "starting", "managed": True, "pid": owner_pid}
    status, _ = module.http_status(root)
    reply = {"state": "ready" if status in (200, 401) else "starting",
             "managed": managed, "authenticated": False, "pid": pid}
    if reply["state"] == "ready":
        reply["url"] = root
        if managed:
            candidate = _auth_url(module, state, root)
            # Credentials are never returned after the listener or owner changes.
            if guard(config) != ("harness", pid):
                return {"state": "error", "code": "process_changed", "managed": False}
            if candidate is not None:
                reply["url"] = candidate
                reply["authenticated"] = True
            elif status == 401:
                reply["code"] = "managed_auth_unavailable"
    return reply


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
        if args[0] == "--probe":
            _, helper_path, config_path = args
            config = json.loads(Path(config_path).read_text(encoding="utf-8"))
            module = _load_helper(helper_path)
            reply = probe(module, config, Path(config["state_directory"]))
            print(json.dumps(reply), flush=True)
            return 1 if reply["state"] == "error" else 0
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
