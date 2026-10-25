#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Evan Yang
"""Repository-owned Linux supervisor; no private/third-party manager code.

CLI: probe|run|logs --config FILE; stop --config FILE --confirmed.
run intentionally stays alive: detached_run.py owns detaching the supervisor.
Only the exact recorded child can be stopped, exclusively through a Linux pidfd.
A dying supervisor leaves the child's session, log descriptors and record intact.
"""

from contextlib import contextmanager
import fcntl
import http.client
import json
import os
from pathlib import Path
import pwd
import re
import select
import signal
import stat
import subprocess
import sys
import time
import unicodedata

VERSION = "1.0.0"
DEFAULT_STATE = Path.home() / ".dsh-wsl-desktop/state"
MAX_RECORD = 65536
LOG_WINDOW = 128 * 1024
STOP_TIMEOUT = 8.0
LOCK_TIMEOUT = 5.0


def _path(value):
    if (not isinstance(value, str) or not value.startswith("/")
            or value.startswith("//") or len(value.encode("utf-8")) > 4096
            or any(unicodedata.category(c).startswith("C") for c in value)
            or any(part in (".", "..") for part in value.split("/"))
            or re.search(r"(?:token|secret|password|api[_-]?key|authorization)\s*[=:]", value, re.I)):
        raise ValueError("invalid path")
    return Path(value)


def validate_config(config):
    if not isinstance(config, dict):
        raise ValueError("invalid config")
    for key in ("repository", "node"):
        _path(config.get(key))
    _path(config.get("state_directory", str(DEFAULT_STATE)))
    if "home" in config:
        _path(config["home"])
    if type(config.get("port")) is not int or not 0 < config["port"] <= 65535:
        raise ValueError("invalid port")
    return config


def _state(config):
    return _path(config.get("state_directory", str(DEFAULT_STATE)))


@contextmanager
def _directory(state, create=False):
    """Walk with openat/NOFOLLOW; never chmod or follow an existing state path."""
    state = _path(str(state))
    if state == Path("/"):
        raise ValueError("invalid state")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in state.parts[1:]:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                              dir_fd=fd)
            os.close(fd)
            fd = next_fd
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("insecure state")
        yield fd
    finally:
        os.close(fd)


def _regular(fd, private=True):
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_nlink != 1 or (private and info.st_mode & 0o077)):
        raise ValueError("insecure file")
    return info


def _file(state, name, flags=os.O_RDONLY, create=False):
    with _directory(state, create=create) as directory:
        fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
                     | (os.O_CREAT if create else 0), 0o600, dir_fd=directory)
    try:
        _regular(fd)
        return fd
    except BaseException:
        os.close(fd)
        raise


def _read_record(state):
    with os.fdopen(_file(state, "run.json"), "rb") as source:
        content = source.read(MAX_RECORD + 1)
    if len(content) > MAX_RECORD:
        raise ValueError("large record")
    record = json.loads(content)
    if (not isinstance(record, dict) or type(record.get("pid")) is not int
            or not 0 < record["pid"] <= 0xFFFFFFFF
            or not isinstance(record.get("start_ticks"), str)
            or not re.fullmatch(r"[0-9]+", record["start_ticks"])
            or type(record.get("supervisor")) is not int
            or not 0 < record["supervisor"] <= 0xFFFFFFFF
            or record["supervisor"] == record["pid"]):
        raise ValueError("invalid record")
    return record


def _write_record(state, record):
    # Validate an old target before replacing it. Never truncate a link/FIFO.
    try:
        os.close(_file(state, "run.json"))
    except FileNotFoundError:
        pass
    with _directory(state) as directory:
        name = ".run-" + os.urandom(12).hex()
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(record, output)
                output.flush()
                os.fsync(output.fileno())
            os.replace(name, "run.json", src_dir_fd=directory, dst_dir_fd=directory)
            os.fsync(directory)
        finally:
            try:
                os.unlink(name, dir_fd=directory)
            except FileNotFoundError:
                pass


@contextmanager
def _operation(state):
    fd = _file(state, "operation.lock", os.O_RDWR, create=True)
    try:
        deadline = time.monotonic() + LOCK_TIMEOUT
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("busy")
                time.sleep(0.025)
        yield
    finally:
        os.close(fd)


def lock_is_held(state):
    """Read-only observation: probes must not create any files."""
    try:
        fd = _file(state, "server.lock")
    except FileNotFoundError:
        return False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False
    finally:
        os.close(fd)


def process_start_ticks(pid):
    if type(pid) is not int or not 0 < pid <= 0xFFFFFFFF:
        raise ValueError("invalid pid")
    # comm can contain spaces and ')' characters; fields after the LAST ')' are fixed.
    content = Path(f"/proc/{pid}/stat").read_text()
    fields = content[content.rfind(")") + 2:].split()
    if len(fields) < 20 or not fields[19].isdecimal():
        raise ValueError("invalid process")
    return fields[19]


def _boot_id():
    value = Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
    if re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", value) is None:
        raise ValueError("invalid boot identity")
    return value


def _argv(config):
    return [config["node"], "--import", "tsx/esm", "apps/cli/src/bin.ts", "web",
            "--host", "127.0.0.1", "--port", str(config["port"]), "--no-open"]


def process_matches(config, pid):
    """Command, all Linux UIDs, executable inode and cwd must match the launch."""
    try:
        validate_config(config)
        before = process_start_ticks(pid)
        proc = Path(f"/proc/{pid}")
        if proc.stat().st_uid != os.getuid():
            return False
        status = (proc / "status").read_text()
        uid = re.search(r"^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$", status, re.M)
        if uid is None or any(int(value) != os.getuid() for value in uid.groups()):
            return False
        command = (proc / "cmdline").read_bytes()
        expected = b"\0".join(os.fsencode(arg) for arg in _argv(config)) + b"\0"
        if command != expected:
            return False
        if not os.path.samefile(proc / "cwd", config["repository"]):
            return False
        if not os.path.samefile(proc / "exe", config["node"]):
            return False
        return process_start_ticks(pid) == before
    except (OSError, ValueError, TypeError):
        return False


def _listeners(port):
    """Return listening socket inodes; a non-exact IPv4 bind is always foreign."""
    result = set()
    foreign = False
    for filename in ("tcp", "tcp6"):
        try:
            with open("/proc/net/" + filename, encoding="ascii") as source:
                rows = source.readlines()
        except FileNotFoundError:
            if filename == "tcp6":
                continue
            raise
        for row in rows[1:]:
            fields = row.split()
            address, number = fields[1].split(":")
            if fields[3] == "0A" and int(number, 16) == port:
                result.add(fields[9])
                if filename != "tcp" or address != "0100007F":
                    foreign = True
    return result, foreign


def listener(config):
    """Classify the port, not ownership. A matching external CLI is never adopted."""
    try:
        validate_config(config)
        inodes, foreign = _listeners(config["port"])
        if not inodes:
            return "absent", None
        if foreign or len(inodes) != 1:
            return "foreign", None
        target = "socket:[" + next(iter(inodes)) + "]"
        owners = set()
        for proc in Path("/proc").iterdir():
            if not proc.name.isdecimal():
                continue
            try:
                if proc.stat().st_uid != os.getuid():
                    continue
                for descriptor in (proc / "fd").iterdir():
                    try:
                        if os.readlink(descriptor) == target:
                            owners.add(int(proc.name))
                            break
                    except OSError:
                        continue
            except OSError:
                continue
        # Ambiguous/inaccessible socket owners fail closed; do not infer from HTTP.
        if len(owners) != 1:
            return "foreign", None
        pid = owners.pop()
        if not process_matches(config, pid) or _listeners(config["port"]) != (inodes, False):
            return "foreign", None
        return "harness", pid
    except (OSError, ValueError, IndexError, TypeError):
        return "foreign", None


def _log_matches(state, pid):
    try:
        fd = _file(state, "web.log")
        try:
            info = os.fstat(fd)
            for number in (1, 2):
                output = os.stat(f"/proc/{pid}/fd/{number}")
                if (output.st_dev, output.st_ino) != (info.st_dev, info.st_ino):
                    return False
            return True
        finally:
            os.close(fd)
    except (OSError, ValueError):
        return False


def _owned(config, state, pid=None):
    try:
        record = _read_record(state)
        child = record["pid"]
        if record.get("boot_id") != _boot_id():
            return None  # PID/start ticks alone can repeat after a reboot.
        if pid is not None and pid != child:
            return None
        if (process_start_ticks(child) != record["start_ticks"]
                or not process_matches(config, child) or not _log_matches(state, child)):
            return None
        if lock_is_held(state):
            supervisor = record["supervisor"]
            if process_start_ticks(supervisor) != record.get("supervisor_start_ticks"):
                return None
            status = Path(f"/proc/{child}/status").read_text()
            if re.search(r"^PPid:\s+" + str(supervisor) + r"$", status, re.M) is None:
                return None
        return record
    except (OSError, ValueError, KeyError, TypeError):
        return None


def http_status(url):
    """Only a literal loopback root/token URL; no DNS, proxies or redirects."""
    match = re.fullmatch(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})/(?:\?token=[A-Za-z0-9_-]{43})?", url)
    if match is None or int(match[1]) > 65535:
        raise ValueError("invalid loopback URL")
    connection = http.client.HTTPConnection("127.0.0.1", int(match[1]), timeout=1.0)
    try:
        connection.request("GET", url[url.index("/", len("http://")):],
                           headers={"Connection": "close"})
        response = connection.getresponse()
        return response.status, bool(response.getheader("Set-Cookie"))
    except (OSError, http.client.HTTPException):
        return 0, False
    finally:
        connection.close()


def _auth_url(state, root):
    try:
        with os.fdopen(_file(state, "web.log"), "rb") as source:
            head = source.read(LOG_WINDOW)
            size = source.seek(0, 2)
            source.seek(max(0, size - LOG_WINDOW))
            tail = source.read(LOG_WINDOW) if size > LOG_WINDOW else b""
        pattern = re.compile(re.escape(root) + r"\?token=[A-Za-z0-9_-]{43}(?![A-Za-z0-9_%&?#=/-])")
        candidate = None
        # Never join windows: that could manufacture a credential across the gap.
        for chunk, at_eof in ((head, size <= LOG_WINDOW), (tail, True)):
            text = chunk.decode("utf-8", errors="replace")
            for match in pattern.finditer(text):
                if match.end() != len(text) or at_eof:
                    candidate = match.group()
        if candidate is not None and http_status(candidate) == (303, True):
            return candidate
    except (OSError, ValueError):
        pass
    return None


def probe(config):
    validate_config(config)
    state = _state(config)
    kind, pid = listener(config)
    if kind == "foreign":
        return {"state": "error", "code": "port_in_use", "managed": False}
    locked = lock_is_held(state)
    record = _owned(config, state, pid)
    if kind == "absent":
        if record is not None:
            return {"state": "starting", "managed": True, "pid": record["pid"]}
        return {"state": "starting" if locked else "stopped", "managed": False}
    root = f"http://127.0.0.1:{config['port']}/"
    status, _ = http_status(root)
    reply = {"state": "ready" if status in (200, 401) else "starting",
             "managed": record is not None, "authenticated": False, "pid": pid}
    if reply["state"] == "ready":
        reply["url"] = root
        if record is not None:
            candidate = _auth_url(state, root)
            # Never return a credential after a listener or ownership transition.
            if listener(config) != ("harness", pid) or _owned(config, state, pid) != record:
                return {"state": "error", "code": "process_changed", "managed": False}
            if candidate is not None:
                reply.update(url=candidate, authenticated=True)
            elif status == 401:
                reply["code"] = "managed_auth_unavailable"
    return reply


def _emit(reply):
    print(json.dumps(reply, ensure_ascii=True), flush=True)
    return 1 if reply["state"] == "error" else 0


def _error(code):
    return _emit({"state": "error", "code": code, "managed": False})


def stop(config, state):
    """Adapter entry: listener (including its guard) runs INSIDE operation.lock."""
    validate_config(config)
    state = _path(str(state))
    if state != _state(config):
        return _error("process_changed")
    with _operation(state):
        kind, pid = listener(config)
        if kind == "foreign":
            return _error("port_in_use")
        locked = lock_is_held(state)
        record = _owned(config, state, pid)
        if kind == "absent" and not locked:
            # The adapter cannot validate its expected PID in this case. No signal.
            if record is not None:
                return _error("stop_incomplete")
            return _emit({"state": "stopped", "managed": False})
        if record is None:
            return _error("process_changed")
        pid = record["pid"]
        if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
            return _error("process_changed")
        try:
            pidfd = os.pidfd_open(pid, 0)
        except OSError:
            return _error("process_changed")
        try:
            # Acquire pidfd first, THEN recheck start time, argv, log and guarded listener.
            latest_kind, latest_pid = listener(config)
            if (latest_kind not in ("absent", "harness")
                    or (latest_kind == "harness" and latest_pid != pid)
                    or _owned(config, state, pid) != record):
                return _error("process_changed")
            try:
                signal.pidfd_send_signal(pidfd, signal.SIGTERM, None, 0)
            except OSError:
                return _error("process_changed")
            poller = select.poll()
            poller.register(pidfd, select.POLLIN)
            if not poller.poll(int(STOP_TIMEOUT * 1000)):
                return _error("stop_timeout")
            # No SIGKILL escalation and no process-group/PID signalling, ever.
            # The guarded adapter deliberately rejects the now-dead PID. Do not
            # invoke its identity guard after exit; observe only socket absence.
            if _listeners(config["port"])[0]:
                return _error("stop_incomplete")
            return _emit({"state": "stopped", "managed": False})
        finally:
            os.close(pidfd)


def _pidfd_supported():
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        return False
    try:
        fd = os.pidfd_open(os.getpid(), 0)
        try:
            signal.pidfd_send_signal(fd, 0, None, 0)
        finally:
            os.close(fd)
        return True
    except OSError:
        return False


def _environment(config):
    user = pwd.getpwuid(os.getuid())
    env = {"HOME": user.pw_dir, "USER": user.pw_name, "LOGNAME": user.pw_name,
           "PATH": str(Path(config["node"]).parent) + ":/usr/bin:/bin", "LANG": "C.UTF-8"}
    if "home" in config:
        env["DSH_HOME"] = config["home"]
    return env


def _cleanup(state, record):
    # Caller has operation.lock. Never remove a newer run's record or the log inode.
    try:
        if _read_record(state) == record:
            with _directory(state) as directory:
                os.unlink("run.json", dir_fd=directory)
    except (OSError, ValueError):
        pass


def _rollback_launch(config, state, child, record, pidfd):
    """Best-effort rollback of THIS unpublished child only; never kill a bare PID."""
    if pidfd is None or record is None or child.poll() is not None:
        return
    try:
        if (process_start_ticks(child.pid) != record["start_ticks"]
                or not process_matches(config, child.pid)
                or not _log_matches(state, child.pid)):
            return
        signal.pidfd_send_signal(pidfd, signal.SIGTERM, None, 0)
        poller = select.poll()
        poller.register(pidfd, select.POLLIN)
        if poller.poll(int(STOP_TIMEOUT * 1000)):
            child.wait()
    except (OSError, ValueError):
        pass


def run(config):
    validate_config(config)
    state = _state(config)
    server = None
    child = None
    record = None
    previous = {}
    departing = False
    announced = False
    published = False
    rollback_fd = None

    def leave(_signum, _frame):
        # Do not raise asynchronously between spawn() and publishing run.json.
        # The child must not inherit a blocked signal mask either.
        nonlocal departing
        departing = True

    try:
        # Ignore HUP even when not launched through detached_run. TERM/INT stop only
        # this supervisor, never its child. The preserved record enables recovery.
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            previous[signum] = signal.signal(signum, signal.SIG_IGN if signum == signal.SIGHUP
                                             else leave)
        with _operation(state):
            if lock_is_held(state):
                return _emit(probe(config))
            kind, _ = listener(config)
            if kind != "absent":
                return _emit(probe(config))
            # An orphan may still be initializing before listen(). Never overwrite its log.
            if _owned(config, state) is not None:
                return _emit(probe(config))
            # Missing pidfd support must fail before launch: never create an un-stoppable run.
            if not _pidfd_supported():
                return _error("launcher_failure")
            server = _file(state, "server.lock", os.O_RDWR, create=True)
            try:
                fcntl.flock(server, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return _emit(probe(config))
            # Check state target before launching so a hostile record cannot orphan a new child.
            try:
                os.close(_file(state, "run.json"))
            except FileNotFoundError:
                pass
            boot = _boot_id()
            supervisor_ticks = process_start_ticks(os.getpid())
            log = _file(state, "web.log", os.O_WRONLY, create=True)
            try:
                os.ftruncate(log, 0)
                child = subprocess.Popen(_argv(config), cwd=config["repository"],
                                         env=_environment(config), stdin=subprocess.DEVNULL,
                                         stdout=log, stderr=log, close_fds=True,
                                         start_new_session=True, shell=False)
                try:
                    rollback_fd = os.pidfd_open(child.pid, 0)
                except OSError:
                    pass  # Publication can still preserve a recoverable child identity.
            finally:
                os.close(log)
            record = {"pid": child.pid, "start_ticks": process_start_ticks(child.pid),
                      "boot_id": boot, "supervisor": os.getpid(),
                      "supervisor_start_ticks": supervisor_ticks}
            _write_record(state, record)
            published = True
            _emit({"state": "starting", "managed": True, "pid": child.pid})
            announced = True
        while child.poll() is None:
            if departing:
                return 0
            time.sleep(0.1)
        return 0
    except Exception:
        if announced:
            return 1  # Exactly one protocol JSON, even if the supervisor later fails.
        raise
    finally:
        # Roll back only a newly spawned, unpublished child, with a pinned pidfd
        # and full identity recheck. A published service survives supervisor errors.
        if child is not None and not published:
            _rollback_launch(config, state, child, record, rollback_fd)
        if rollback_fd is not None:
            os.close(rollback_fd)
        if child is not None and child.poll() is not None and record is not None:
            try:
                with _operation(state):
                    _cleanup(state, record)
            except (OSError, ValueError, TimeoutError):
                pass  # Cleanup failure cannot change or signal another run.
        if server is not None:
            os.close(server)
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def logs(config):
    validate_config(config)
    state = _state(config)
    try:
        os.close(_file(state, "web.log"))
    except FileNotFoundError:
        return {"state": "logs"}
    # A path only. Raw service output may contain API keys, prompts or session cookies.
    return {"state": "logs", "service_log": str(state / "web.log")}


def _load_config(path):
    fd = os.open(_path(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as source:
        _regular(source.fileno(), private=False)
        content = source.read(MAX_RECORD + 1)
    if len(content) > MAX_RECORD:
        raise ValueError("large config")
    return validate_config(json.loads(content))


def main(argv=None):
    # Disable argparse's echo of untrusted argv/config values and its non-JSON stderr.
    args = sys.argv[1:] if argv is None else argv
    try:
        if args == ["--version"]:
            print(VERSION)
            return 0
        if not args or args[0] not in ("probe", "run", "stop", "logs"):
            return _error("launcher_failure")
        action, options = args[0], list(args[1:])
        confirmed = "--confirmed" in options
        if confirmed:
            if action != "stop" or options.count("--confirmed") != 1:
                return _error("launcher_failure")
            options.remove("--confirmed")
        if len(options) != 2 or options[0] != "--config":
            return _error("launcher_failure")
        if action == "stop" and not confirmed:
            return _error("confirmation_required")
        config = _load_config(options[1])
        if args[0] == "run":
            return run(config)
        if args[0] == "stop":
            return stop(config, _state(config))
        return _emit(probe(config) if args[0] == "probe" else logs(config))
    except Exception:
        # No exception, argv, config, log text or environment value escapes to diagnostics.
        return _error("launcher_failure")


if __name__ == "__main__":
    sys.exit(main())
