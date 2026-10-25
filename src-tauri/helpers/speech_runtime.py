"""Fixed stdlib WSL speech bundle staging and private process ownership protocol.

The native adapter embeds this file in /usr/bin/python3 -c. No shell, install,
model import, download, arbitrary destination, or port-based process discovery.
"""
import base64
import ctypes
import hashlib
import hmac
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import selectors
import signal
import threading
import stat
import subprocess
import sys
import time

FILE_CAPS = {
    "server.py": 512 * 1024,
    "native_q8.py": 512 * 1024,
    "runtime_check.py": 256 * 1024,
    "voice/profile.json": 64 * 1024,
    "voice/reference.wav": 1024 * 1024,
    "managed_runtime.py": 256 * 1024,
}
TOTAL_CAP = 2 * 1024 * 1024
STAGE_INPUT_CAP = 4 * ((TOTAL_CAP + 2) // 3) + 16384
SMALL_INPUT_CAP = 16384
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
NOFOLLOW = os.O_NOFOLLOW | os.O_CLOEXEC
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW
LAUNCH_TIMEOUT = 5.0
STOP_TIMEOUT = 3.0
INSPECT_TIMEOUT = 180.0
INSPECT_OUTPUT_CAP = 65536
INSPECT_LINE_CAP = 8192


class Refused(Exception):
    def __init__(self, code):
        self.code = code


def require(condition, code="invalid_request"):
    if not condition:
        raise Refused(code)


def exact(value, keys):
    require(isinstance(value, dict) and set(value) == set(keys))


def absolute(value):
    require(isinstance(value, str) and 0 < len(value) <= 4096)
    require(value.startswith("/") and not value.startswith("//"))
    require(all(ord(c) >= 32 and not 127 <= ord(c) <= 159 for c in value))
    require(str(PurePosixPath(value)) == value and ".." not in PurePosixPath(value).parts)
    return value


def read_json(stream, cap):
    data = stream.read(cap + 1)
    require(len(data) <= cap, "input_too_large")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result)
            result[key] = value
        return result
    try:
        result = json.loads(data, object_pairs_hook=unique)
    except (ValueError, UnicodeError, RecursionError):
        raise Refused("invalid_request") from None
    require(isinstance(result, dict))
    return result


def _dir(parent, name, private=False, create=True):
    if create:
        try:
            os.mkdir(name, mode=0o700, dir_fd=parent)
        except FileExistsError:
            pass
    fd = os.open(name, DIR_FLAGS, dir_fd=parent)
    try:
        info = os.fstat(fd)
        require(info.st_uid == os.getuid(), "unsafe_cache")
        require(not info.st_mode & 0o022, "unsafe_cache")
        if private:
            require(not info.st_mode & 0o077, "unsafe_cache")
        return fd
    except BaseException:
        os.close(fd)
        raise


def cache(create=True):
    home = Path.home()
    fd = os.open(str(home), DIR_FLAGS)
    try:
        info = os.fstat(fd)
        require(info.st_uid == os.getuid() and not info.st_mode & 0o022, "unsafe_cache")
        for component in (".dsh-wsl-desktop", "speech", "service"):
            child = _dir(fd, component, component == "service", create)
            os.close(fd)
            fd = child
        return fd, home / ".dsh-wsl-desktop/speech/service"
    except BaseException:
        os.close(fd)
        raise


def _regular(fd, cap):
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
            and info.st_nlink == 1 and not info.st_mode & 0o077,
            "unsafe_cache")
    require(info.st_size <= cap, "unsafe_cache")
    data = bytearray()
    while len(data) <= cap:
        chunk = os.read(fd, min(65536, cap + 1 - len(data)))
        if not chunk:
            break
        data.extend(chunk)
    require(len(data) <= cap, "unsafe_cache")
    return bytes(data), info


def read_file(parent, name, cap):
    fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | NOFOLLOW, dir_fd=parent)
    try:
        return _regular(fd, cap)
    finally:
        os.close(fd)


def put_file(parent, name, data, cap):
    try:
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW,
                     0o600, dir_fd=parent)
    except FileExistsError:
        existing, _ = read_file(parent, name, cap)
        require(hmac.compare_digest(existing, data), "bundle_mismatch")
        return
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        # Partial entries remain refused, never overwrite an untrusted entry.
        raise


def encoded(value):
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")


def bundle_digest(files):
    digest = hashlib.sha256()
    for name in sorted(files):
        digest.update(name.encode("ascii") + b"\0" + files[name])
    return digest.hexdigest()


def manifest_for(files):
    return {"version": 1, "bundle_id": bundle_digest(files), "files": {
        name: {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
        for name, data in files.items()}}


def stage(request):
    exact(request, ("files",))
    exact(request["files"], FILE_CAPS)
    files = {}
    total = 0
    for name, cap in FILE_CAPS.items():
        value = request["files"][name]
        require(isinstance(value, str) and len(value) <= 4 * ((cap + 2) // 3),
                "bundle_too_large")
        try:
            data = base64.b64decode(value, validate=True)
        except (ValueError, UnicodeError):
            raise Refused("invalid_bundle") from None
        require(len(data) <= cap, "bundle_too_large")
        total += len(data)
        require(total <= TOTAL_CAP, "bundle_too_large")
        files[name] = data
    manifest = manifest_for(files)
    root, path = cache()
    bundle = voice = None
    try:
        bundle = _dir(root, manifest["bundle_id"], True)
        voice = _dir(bundle, "voice", True)
        require(set(os.listdir(bundle)) <= {"voice", ".manifest.json", *[n for n in FILE_CAPS if "/" not in n]}, "unsafe_cache")
        require(set(os.listdir(voice)) <= {"profile.json", "reference.wav"}, "unsafe_cache")
        for name, data in files.items():
            parent, leaf = (voice, name.split("/")[1]) if "/" in name else (bundle, name)
            put_file(parent, leaf, data, FILE_CAPS[name])
        put_file(bundle, ".manifest.json", encoded(manifest), 8192)
    finally:
        for fd in (voice, bundle, root):
            if fd is not None:
                os.close(fd)
    dest = path / manifest["bundle_id"]
    return {"ok": True, "script_path": str(dest / "server.py"),
            "runtime_helper": str(dest / "managed_runtime.py")}


def validate_bundle(script):
    absolute(script)
    root, path = cache(create=False)
    bundle = voice = None
    try:
        parts = PurePosixPath(script).parts
        require(len(parts) >= 2 and HEX64.fullmatch(parts[-2]) is not None
                and script == str(path / parts[-2] / "server.py"), "not_staged")
        bundle = os.open(parts[-2], DIR_FLAGS, dir_fd=root)
        info = os.fstat(bundle)
        require(info.st_uid == os.getuid() and not info.st_mode & 0o077, "unsafe_cache")
        voice = os.open("voice", DIR_FLAGS, dir_fd=bundle)
        info = os.fstat(voice)
        require(info.st_uid == os.getuid() and not info.st_mode & 0o077, "unsafe_cache")
        require(set(os.listdir(bundle)) == {"voice", ".manifest.json", *[n for n in FILE_CAPS if "/" not in n]}, "unsafe_cache")
        require(set(os.listdir(voice)) == {"profile.json", "reference.wav"}, "unsafe_cache")
        files = {}
        for name, cap in FILE_CAPS.items():
            parent, leaf = (voice, name.split("/")[1]) if "/" in name else (bundle, name)
            files[name], _ = read_file(parent, leaf, cap)
        require(sum(map(len, files.values())) <= TOTAL_CAP, "unsafe_cache")
        raw, _ = read_file(bundle, ".manifest.json", 8192)
        expected = manifest_for(files)
        require(hmac.compare_digest(raw, encoded(expected)) and expected["bundle_id"] == parts[-2], "bundle_mismatch")
        return str(path / parts[-2] / "managed_runtime.py")
    finally:
        for fd in (voice, bundle, root):
            if fd is not None:
                os.close(fd)


def boot_id():
    with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as stream:
        return stream.read(128).strip()


def process_info(pid):
    require(type(pid) is int and pid > 1, "not_owned")
    with open("/proc/%d/stat" % pid, encoding="ascii") as stream:
        fields = stream.read(8192).rsplit(")", 1)[1].split()
    with open("/proc/%d/cmdline" % pid, "rb") as stream:
        command = stream.read(16385)
    require(len(command) <= 16384, "not_owned")
    return {"start_time": fields[19], "pgid": int(fields[2]),
            "session": int(fields[3]), "uid": os.stat("/proc/%d" % pid).st_uid,
            "command": command.split(b"\0")[:-1]}


def nonce(value):
    require(isinstance(value, str) and HEX64.fullmatch(value) is not None)
    return value


def credentials(request):
    exact(request, ("instance_id", "control_token"))
    return nonce(request["instance_id"]), nonce(request["control_token"])


def marker_dir(create=False):
    root, _ = cache(create=create)
    try:
        return _dir(root, "owned", True, create)
    finally:
        os.close(root)


def marker_read(instance):
    fd = marker_dir()
    try:
        raw, info = read_file(fd, instance + ".json", SMALL_INPUT_CAP)
        value = json.loads(raw)
        require(isinstance(value, dict), "not_owned")
        return value, (info.st_dev, info.st_ino)
    finally:
        os.close(fd)


def marker_remove(instance, identity):
    fd = marker_dir()
    try:
        try:
            _, info = read_file(fd, instance + ".json", SMALL_INPUT_CAP)
        except FileNotFoundError:
            return
        if (info.st_dev, info.st_ino) == identity:
            os.unlink(instance + ".json", dir_fd=fd)
    finally:
        os.close(fd)


def verify_process(marker):
    require(marker.get("uid") == os.getuid() and marker.get("boot_id") == boot_id(), "not_owned")
    pid = marker.get("pid")
    info = process_info(pid)
    helper = validate_bundle(marker.get("script_path"))
    require(marker.get("runtime_helper") == helper and marker.get("session") == pid
            and marker.get("pgid") == pid, "not_owned")
    expected = [os.fsencode(marker.get("supervisor_python", "")), os.fsencode(helper), b"--supervise"]
    require(info["uid"] == os.getuid() and info["start_time"] == marker.get("start_time")
            and info["pgid"] == pid and info["session"] == pid
            and info["command"] == expected, "not_owned")
    require(marker.get("supervisor_python") == sys.executable, "not_owned")
    return pid


def owned(request):
    instance, token = credentials(request)
    marker, identity = marker_read(instance)
    require(marker.get("instance_id") == instance, "not_owned")
    stored = marker.get("token_sha256")
    require(isinstance(stored, str) and hmac.compare_digest(
        stored, hashlib.sha256(token.encode("ascii")).hexdigest()), "not_owned")
    verify_process(marker)
    return instance, marker, identity


def probe_owned(request):
    credentials(request)
    try:
        owned(request)
        return {"ok": True, "alive": True}
    except (Refused, OSError, ValueError, TypeError, KeyError, IndexError):
        return {"ok": True, "alive": False}


def stop(request):
    try:
        instance, marker, identity = owned(request)
    except (OSError, ValueError, TypeError, KeyError, IndexError):
        raise Refused("not_owned") from None
    pid = marker["pid"]
    # Revalidate immediately before every group signal, never a port/PID search.
    verify_process(marker)
    os.killpg(pid, signal.SIGTERM)
    deadline = time.monotonic() + STOP_TIMEOUT
    while time.monotonic() < deadline:
        try:
            verify_process(marker)
        except (Refused, OSError, ValueError, TypeError, KeyError, IndexError):
            marker_remove(instance, identity)
            return {"ok": True, "stopped": True}
        time.sleep(0.05)
    verify_process(marker)
    os.killpg(pid, signal.SIGKILL)
    marker_remove(instance, identity)
    return {"ok": True, "stopped": True}


def launch(request, owner_pid=None, cancel=None):
    exact(request, ("script_path", "python_path", "model_dir", "native_lib"))
    for value in request.values():
        absolute(value)
    helper = validate_bundle(request["script_path"])
    instance, token = secrets.token_hex(32), secrets.token_hex(32)
    config = dict(request, instance_id=instance, control_token=token)
    if owner_pid is not None:
        config["lifetime_parent"] = owner_pid
    require(cancel is None or not cancel.is_set(), "launch_cancelled")
    child = subprocess.Popen([sys.executable, helper, "--supervise"],
                             stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True,
                             close_fds=True)
    # Keep the direct supervisor PID pinned until handoff or failure cleanup.
    start_time = None
    # Only the pipe receives secrets. In particular neither environment nor argv.
    try:
        start_time = process_info(child.pid)["start_time"]
        child.stdin.write(encoded(config) + b"\n")
        child.stdin.close()
        deadline = time.monotonic() + LAUNCH_TIMEOUT
        while time.monotonic() < deadline:
            require(cancel is None or not cancel.is_set(), "launch_cancelled")
            if os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                raise Refused("launch_failed")
            try:
                marker, _ = marker_read(instance)
                require(marker.get("pid") == child.pid, "launch_failed")
                owned({"instance_id": instance, "control_token": token})
                return {"ok": True, "instance_id": instance, "control_token": token,
                        "pid": child.pid, "start_time": marker["start_time"],
                        "script_path": request["script_path"]}
            except FileNotFoundError:
                pass
            time.sleep(0.025)
        raise Refused("launch_timeout")
    except BaseException:
        if child.stdin and not child.stdin.closed:
            child.stdin.close()
        # This is our unreaped direct Popen child, never a caller-supplied PID.
        # Even an already-crashed supervisor keeps its ID pinned until cleanup.
        try:
            if start_time is None:
                start_time = process_info(child.pid)["start_time"]
            _check_group_signal(child, start_time, signal.SIGTERM)
            threading.Event().wait(.8)
            _check_group_signal(child, start_time, signal.SIGKILL)
        except (OSError, Refused, ValueError, IndexError):
            pass
        finally:
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
        try:
            marker, identity = marker_read(instance)
            if marker.get("uid") == os.getuid() and marker.get("boot_id") == boot_id() and marker.get("pid") == child.pid and marker.get("start_time") == start_time and hmac.compare_digest(marker.get("token_sha256", ""), hashlib.sha256(token.encode("ascii")).hexdigest()):
                marker_remove(instance, identity)
        except (OSError, Refused, ValueError, TypeError):
            pass
        raise


def supervise(request):
    keys = ("script_path", "python_path", "model_dir", "native_lib", "instance_id", "control_token")
    exact(request, keys + (("lifetime_parent",) if "lifetime_parent" in request else ()))
    instance, token = nonce(request["instance_id"]), nonce(request["control_token"])
    for key in ("script_path", "python_path", "model_dir", "native_lib"):
        absolute(request[key])
    helper = validate_bundle(request["script_path"])
    require(sys.argv == [helper, "--supervise"], "not_owned")
    pid = os.getpid()
    require(os.getsid(0) == pid and os.getpgrp() == pid, "not_owned")
    stopping = [False]
    def shutdown(_signum, _frame):
        stopping[0] = True
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    lifetime_parent = request.get("lifetime_parent")
    if lifetime_parent is not None:
        require(type(lifetime_parent) is int and lifetime_parent > 1
                and os.getppid() == lifetime_parent, "not_owned")
        prctl = ctypes.CDLL(None, use_errno=True).prctl
        prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
        prctl.restype = ctypes.c_int
        require(prctl(1, signal.SIGTERM, 0, 0, 0) == 0
                and os.getppid() == lifetime_parent, "not_owned")
    child = None
    identity = None
    try:
        env = os.environ.copy()
        # Keep the immutable staged bundle free of import bytecode artifacts.
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        if os.path.isdir("/usr/lib/wsl/lib"):
            old = env.get("LD_LIBRARY_PATH", "")
            if "/usr/lib/wsl/lib" not in old.split(":"):
                env["LD_LIBRARY_PATH"] = "/usr/lib/wsl/lib" + (":" + old if old else "")
        child = subprocess.Popen([
            request["python_path"], request["script_path"],
            "--model-dir", request["model_dir"], "--native-lib", request["native_lib"],
            "--device", "auto", "--port", "18765", "--managed-stdin"],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env=env, close_fds=True)
        child.stdin.write(encoded({"instance_id": instance, "control_token": token}) + b"\n")
        child.stdin.close()
        info = process_info(pid)
        marker = {"version": 1, "instance_id": instance,
                  "token_sha256": hashlib.sha256(token.encode("ascii")).hexdigest(),
                  "uid": os.getuid(), "boot_id": boot_id(), "pid": pid,
                  "start_time": info["start_time"], "session": pid, "pgid": pid,
                  "supervisor_python": sys.executable, "runtime_helper": helper,
                  "script_path": request["script_path"], "service_pid": child.pid}
        fd = marker_dir(create=True)
        try:
            # Publish only a complete marker; launch must never read partial JSON.
            pending = instance + ".pending"
            put_file(fd, pending, encoded(marker), SMALL_INPUT_CAP)
            os.link(pending, instance + ".json", src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
            os.unlink(pending, dir_fd=fd)
            _, marker_info = read_file(fd, instance + ".json", SMALL_INPUT_CAP)
            identity = marker_info.st_dev, marker_info.st_ino
        finally:
            os.close(fd)
        while not stopping[0] and child.poll() is None:
            time.sleep(0.05)
    finally:
        try:
            if child is not None:
                # Leader stays alive through TERM grace; models inherit this group.
                os.killpg(pid, signal.SIGTERM)
                deadline = time.monotonic() + 0.75
                while time.monotonic() < deadline:
                    child.poll()
                    time.sleep(0.025)
            if identity is not None:
                marker_remove(instance, identity)
        finally:
            # Even a tampered marker must not prevent orphan-model cleanup.
            os.killpg(pid, signal.SIGKILL)


def watch_lifeline(cancel):
    try:
        fd = sys.stdin.fileno()
        os.set_blocking(fd, False)
        # Include bytes prefetched by the native stdin source bootstrap/readline.
        if sys.stdin.buffer.read1(1):
            return
        with selectors.DefaultSelector() as selector:
            selector.register(fd, selectors.EVENT_READ)
            selector.select()  # readable extra byte OR EOF invalidates the lease
    except (OSError, ValueError):
        pass
    finally:
        cancel.set()


def write_held_reply(result, cancel):
    output = sys.stdout.fileno()
    os.set_blocking(output, False)
    data = memoryview(encoded(result) + b"\n")
    deadline = time.monotonic() + 5
    with selectors.DefaultSelector() as selector:
        selector.register(output, selectors.EVENT_WRITE)
        while data:
            require(not cancel.is_set(), "launch_cancelled")
            require(time.monotonic() < deadline, "launch_timeout")
            if selector.select(.05):
                try:
                    data = data[os.write(output, data):]
                except BlockingIOError:
                    pass


def launch_held():
    lease = None
    attempted_reply = False
    cancel = threading.Event()
    try:
        line = sys.stdin.buffer.readline(SMALL_INPUT_CAP + 1)
        require(line.endswith(b"\n") and len(line) <= SMALL_INPUT_CAP)
        request = read_json(io.BytesIO(line), SMALL_INPUT_CAP)
        threading.Thread(target=watch_lifeline, args=(cancel,), daemon=True).start()
        lease = launch(request, owner_pid=os.getpid(), cancel=cancel)
        attempted_reply = True
        write_held_reply(lease, cancel)
        credentials_request = {key: lease[key] for key in ("instance_id", "control_token")}
        while not cancel.wait(.25):
            if not probe_owned(credentials_request)["alive"]:
                break
    except BaseException as error:
        if not attempted_reply and not cancel.is_set():
            code = error.code if isinstance(error, Refused) else "runtime_error"
            try:
                write_held_reply({"ok": False, "error": code}, cancel)
            except BaseException:
                pass
    finally:
        if lease is not None:
            try:
                stop({key: lease[key] for key in ("instance_id", "control_token")})
            except BaseException:
                pass


def check_event(line):
    try:
        value = read_json(io.BytesIO(line), INSPECT_LINE_CAP)
        if value.get("kind") == "progress":
            exact(value, ("kind", "progress"))
            progress = value["progress"]
            require(type(progress) in (int, float) and 0 <= progress <= 100)
        else:
            fields = ("kind", "environment_ok", "models_ok", "gpu_name", "error_code")
            # Older check fixtures omit this pair; new staged checkers always send
            # the actual GPU backend/device, never a generic auto/CPU readiness.
            exact(value, fields + (("backend", "device") if "backend" in value or "device" in value else ()))
            if "backend" in value:
                backend, device = value["backend"], value["device"]
                require((backend is None and device is None and not value["environment_ok"])
                    or (backend in {"cuda", "rocm"} and isinstance(device, str)
                        and re.fullmatch(("CUDA" if backend == "cuda" else "ROCm") + r"(?:0|[1-9][0-9]?)", device) is not None))
            require(value["kind"] == "result")
            require(type(value["environment_ok"]) is bool and type(value["models_ok"]) is bool)
            name, error = value["gpu_name"], value["error_code"]
            require(name is None or (isinstance(name, str) and len(name) <= 256
                    and re.fullmatch(r"[A-Za-z0-9 _().+:-]*", name) is not None))
            require(error is None or error in {
                "wsl2_gpu_bridge_required", "rocm_sdk_not_installed", "gpu_probe_timeout",
                "gpu_probe_failed", "gpu_compute_failed", "gpu_device_unavailable",
                "environment_unavailable", "native_unavailable", "models_changed",
                "cuda_libraries_unavailable", "gpu_backend_mismatch", "gpu_runtime_unavailable",
                "models_hash_mismatch", "models_unavailable", "invalid_config", "check_failed",
                "missing_talker", "missing_codec", "hash_mismatch_talker", "hash_mismatch_codec"})
        return value
    except (Refused, ValueError, TypeError, KeyError):
        raise Refused("invalid_check_output") from None


def _check_group_signal(child, start_time, sig):
    # The direct child is intentionally not reaped until group cleanup completes.
    # A zombie pins its PID too, so exited checkers cannot cause group-ID reuse.
    info = process_info(child.pid)
    require(info["uid"] == os.getuid() and info["start_time"] == start_time
            and info["pgid"] == child.pid and info["session"] == child.pid, "check_failed")
    os.killpg(child.pid, sig)


def inspect_check():
    child = None
    final = None
    start_time = None
    cancel = None
    def emit(value, checking=True):
        # A stopped native reader must not block EOF cancellation or the deadline.
        data = memoryview(encoded(value) + b"\n")
        output = sys.stdout.fileno()
        deadline = time.monotonic() + (2 if checking else .5)
        with selectors.DefaultSelector() as writer:
            writer.register(output, selectors.EVENT_WRITE)
            while data:
                if checking and cancel is not None:
                    require(not cancel.is_set(), "check_cancelled")
                require(time.monotonic() < deadline, "check_failed")
                if writer.select(.05):
                    try:
                        data = data[os.write(output, data):]
                    except BlockingIOError:
                        pass
    try:
        os.set_blocking(sys.stdout.fileno(), False)
        line = sys.stdin.buffer.readline(SMALL_INPUT_CAP + 1)
        require(line.endswith(b"\n") and len(line) <= SMALL_INPUT_CAP, "invalid_config")
        request = read_json(io.BytesIO(line), SMALL_INPUT_CAP)
        exact(request, ("script_path", "python_path", "model_dir", "native_lib"))
        for value in request.values():
            absolute(value)
        validate_bundle(request["script_path"])
        checker = str(Path(request["script_path"]).parent / "runtime_check.py")
        cancel = threading.Event()
        threading.Thread(target=watch_lifeline, args=(cancel,), daemon=True).start()
        env = os.environ.copy()
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        if os.path.isdir("/usr/lib/wsl/lib"):
            old = env.get("LD_LIBRARY_PATH", "")
            if "/usr/lib/wsl/lib" not in old.split(":"):
                env["LD_LIBRARY_PATH"] = "/usr/lib/wsl/lib" + (":" + old if old else "")
        child = subprocess.Popen([
            request["python_path"], checker, "--models", request["model_dir"],
            "--native-lib", request["native_lib"], "--device", "auto", "--progress"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            start_new_session=True, close_fds=True, env=env)
        start_time = process_info(child.pid)["start_time"]
        deadline = time.monotonic() + INSPECT_TIMEOUT
        buffer = b""
        total = sent = 0
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while final is None:
                require(not cancel.is_set(), "check_cancelled")
                require(time.monotonic() < deadline, "check_timeout")
                for key, _ in selector.select(timeout=min(.05, max(0, deadline - time.monotonic()))):
                    chunk = os.read(key.fileobj.fileno(), INSPECT_LINE_CAP)
                    if not chunk:
                        require(False, "invalid_check_output")
                    total += len(chunk)
                    require(total <= INSPECT_OUTPUT_CAP, "check_output_too_large")
                    buffer += chunk
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        require(len(line) <= INSPECT_LINE_CAP, "check_output_too_large")
                        event = check_event(line)
                        if event["kind"] == "result":
                            final = event
                            break
                        sent += len(encoded(event)) + 1
                        require(sent <= INSPECT_OUTPUT_CAP - 1024, "check_output_too_large")
                        emit(event)
                    require(len(buffer) <= INSPECT_LINE_CAP, "check_output_too_large")
    except Refused as error:
        code = error.code if error.code in {
            "check_cancelled", "check_timeout", "check_output_too_large", "invalid_check_output"} else "invalid_config"
        final = {"kind": "result", "environment_ok": False, "models_ok": False,
                 "gpu_name": None, "error_code": code}
    except BaseException:
        final = {"kind": "result", "environment_ok": False, "models_ok": False,
                 "gpu_name": None, "error_code": "check_failed"}
    finally:
        if child is not None:
            try:
                if start_time is None:
                    start_time = process_info(child.pid)["start_time"]
                _check_group_signal(child, start_time, signal.SIGTERM)
                # Do not poll()/wait() here: keep this exact PID pinned through KILL.
                threading.Event().wait(.5)
                _check_group_signal(child, start_time, signal.SIGKILL)
            except (OSError, Refused, ValueError, IndexError):
                pass
            finally:
                child.stdout.close()
                try:
                    child.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    pass
    try:
        emit(final, checking=False)
    except (Refused, BrokenPipeError, OSError):
        pass


def main():
    action = sys.argv[1:]  # python -c leaves argv[0] == '-c'.
    if action == ["--launch-held"]:
        launch_held()
        return
    if action == ["--inspect"]:
        inspect_check()
        return
    if action == ["--supervise"]:
        try:
            supervise(read_json(sys.stdin.buffer, SMALL_INPUT_CAP))
        except BaseException:
            pass
        return
    actions = {"--stage": stage, "--launch": launch,
               "--stop": stop, "--probe-owned": probe_owned}
    try:
        require(len(action) == 1 and action[0] in actions)
        request = read_json(sys.stdin.buffer, STAGE_INPUT_CAP if action == ["--stage"] else SMALL_INPUT_CAP)
        result = actions[action[0]](request)
    except Refused as error:
        result = {"ok": False, "error": error.code}
    except BaseException:
        result = {"ok": False, "error": "runtime_error"}
    # Errors are fixed codes, never raw exception text, paths or child stderr.
    output = encoded(result)
    if len(output) > SMALL_INPUT_CAP:
        output = b'{"ok":false,"error":"output_too_large"}'
    try:
        pending = memoryview(output + b"\n")
        while pending:
            pending = pending[os.write(sys.stdout.fileno(), pending):]
    except OSError:
        if action == ["--launch"] and result.get("ok"):
            # The app never received its private ownership credentials.
            try:
                stop({"instance_id": result["instance_id"],
                      "control_token": result["control_token"]})
            except BaseException:
                pass


if __name__ == "__main__":
    main()
