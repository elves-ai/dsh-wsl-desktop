"""Fixed WSL browser, offline initialization and pinned Q8 download.

No shell, dependency downloads, model import or native-library loading. Paths
are JSON data. Downloads/initialization require a held owner channel. Offline
initialization creates only a standard venv, bundled pip and local configuration.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import resource
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request

REVISION = "b7ee2e8c7459c3bea99da23e3d178125a7d1713c"
BASE_URL = "https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF/resolve/" + REVISION + "/"
# Must stay identical to services/qwen_tts/native_q8.py MODEL_SHA256.
MODELS = {
    "qwen-talker-1.7b-base-Q8_0.gguf": "4b9a33a236908dd9435a42f7a396e38038329d053b704342a6413c08544c4fda",
    "qwen-tokenizer-12hz-Q8_0.gguf": "1883beeed99348fc35e23dd225e9082f93f6f8c109330a33d935baa8acdbfd94",
}
MAX_FILE = 3 * 1024**3
MAX_ENTRIES = 200
MAX_SCAN = 4096
NOFOLLOW = os.O_NOFOLLOW | os.O_CLOEXEC
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW
CONFIG_FIELDS = {"model_dir", "python_path", "native_lib"}
KINDS = {"model_dir", "native_lib"}
SPEECH_ROOT = ".dsh-wsl-desktop/speech"


class Refused(Exception):
    pass


def require(ok, code="invalid_request"):
    if not ok:
        raise Refused(code)


def absolute(value):
    require(isinstance(value, str) and 0 < len(value) <= 4096)
    require(value.startswith("/") and not value.startswith("//"))
    require(not any(ord(c) < 32 or 127 <= ord(c) <= 159 or c in "\\:" for c in value))
    require(str(PurePosixPath(value)) == value and ".." not in PurePosixPath(value).parts)
    return value


def allowed(path):
    absolute(path)
    require(PurePosixPath(path).parts[1:2] not in [("proc",), ("sys",), ("dev",), ("run",)], "unsafe_path")
    return path


def directory(path, create=False):
    """Pin each component without following symlinks, including on /mnt drives."""
    allowed(path)
    fd = os.open("/", DIR_FLAGS)
    try:
        for part in PurePosixPath(path).parts[1:]:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def browse(request):
    require(set(request) == {"path", "kind"} and request["kind"] in KINDS)
    path = str(Path.home()) if request["path"] is None else absolute(request["path"])
    fd = directory(path)
    entries = []
    scanned = 0
    truncated = False
    try:
        with os.scandir(fd) as items:
            for item in items:
                scanned += 1
                if scanned > MAX_SCAN:
                    truncated = True
                    break
                try:
                    name = item.name
                    child = str(PurePosixPath(path) / name)
                    allowed(child)
                    info = item.stat(follow_symlinks=False)
                    is_dir = stat.S_ISDIR(info.st_mode)
                    # Never traverse symlink directories. Python launchers and .so
                    # names commonly are file symlinks; expose only safe regular targets.
                    if stat.S_ISLNK(info.st_mode) and request["kind"] != "model_dir":
                        allowed(os.path.realpath(child))
                        target = item.stat(follow_symlinks=True)
                        if stat.S_ISREG(target.st_mode):
                            info = target
                    if not is_dir and not stat.S_ISREG(info.st_mode):
                        continue
                    if not is_dir:
                        if request["kind"] == "model_dir":
                            continue
                        if request["kind"] == "native_lib" and not (name.endswith(".so") or ".so." in name):
                            continue
                    entries.append({"name": name, "path": child, "directory": is_dir})
                    if len(entries) > MAX_ENTRIES:
                        truncated = True
                        break
                except (OSError, Refused):
                    continue
    finally:
        os.close(fd)
    entries.sort(key=lambda item: (not item["directory"], item["name"].casefold()))
    # Keep the whole protocol line bounded even for hostile long names.
    result = {"path": path, "parent": None if path == "/" else str(PurePosixPath(path).parent),
              "entries": entries[:MAX_ENTRIES], "truncated": truncated}
    while len(json.dumps(result).encode()) > 60000:
        result["entries"].pop()
        result["truncated"] = True
    return result


# -I suppresses cwd, PYTHONPATH and user site. -S skips site/.pth startup code.
# Initialization needs only a modern Python with the standard-library venv module.
PROBE = r'''
import sys,json,venv
print(json.dumps({'version': '.'.join(map(str,sys.version_info[:3]))}))
'''


def candidates(home):
    """Managed runtime plus system interpreters used only to create that runtime."""
    result = []
    for path in (str(home / SPEECH_ROOT / "runtime/venv/bin/python"),
                 "/usr/bin/python3", "/usr/local/bin/python3"):
        if os.path.isfile(path) and os.access(path, os.X_OK):
            result.append(path)
    return result


def _probe_limits():
    # This action is single-threaded. Bound even a broken executable's output.
    resource.setrlimit(resource.RLIMIT_FSIZE, (8192, 8192))
    resource.setrlimit(resource.RLIMIT_CPU, (2, 2))


def python_status(version):
    return "python_too_old" if tuple(map(int, version.split(".")[:2])) < (3, 10) else "ready"


def probe(path):
    # Never execute .pth, import third-party packages, inspect GPU metadata or
    # libraries, or retain raw executable output.
    try:
        with tempfile.TemporaryFile() as output:
            process = subprocess.Popen([path, "-I", "-S", "-B", "-c", PROBE], stdin=subprocess.DEVNULL,
                stdout=output, stderr=subprocess.DEVNULL, start_new_session=True, preexec_fn=_probe_limits,
                env={"PATH": "/usr/bin:/bin", "HOME": str(Path.home())})
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
                return {"path": path, "version": "unknown", "ready": False, "status": "probe_failed"}
            output.seek(0)
            value = json.loads(output.read(4097))
        require(process.returncode == 0 and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", value["version"]))
        status = python_status(value["version"])
        return {"path": path, "version": value["version"], "ready": status == "ready", "status": status}
    except (OSError, ValueError, KeyError, TypeError, Refused):
        return {"path": path, "version": "unknown", "ready": False, "status": "probe_failed"}


def python_usable(result):
    """Only a modern executable with standard-library venv is usable."""
    return result["status"] == "ready"


def validate_config(request):
    require(isinstance(request, dict) and set(request) == CONFIG_FIELDS)
    for value in request.values():
        require(isinstance(value, str))
        if value:
            allowed(value)
    return dict(request)


def default_python(home):
    """Check only the application runtime, never an ambient development venv."""
    path = str(home / SPEECH_ROOT / "runtime/venv/bin/python")
    return [path] if os.path.isfile(path) and os.access(path, os.X_OK) else []


# Initialization owns only its fixed runtime, never a selected external environment.
# Intent/complete records live outside the venv: it must be built in its final
# location because pip and activation scripts contain absolute interpreter paths.
INIT_INTENT = ".initialize-venv.json"
INIT_COMPLETE = ".initialize-venv-complete.json"


def check_owned(info, private=False, file=False):
    require(info.st_uid == os.getuid() and not info.st_mode & (0o077 if private else 0o022),
            "unsafe_initialize_file" if file else "unsafe_initialize_directory")
    if file:
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600, "unsafe_initialize_file")


def initialize_directory(parent, name, create=False, private=False):
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
            os.fsync(parent)
        except FileExistsError:
            pass
    try:
        child = os.open(name, DIR_FLAGS, dir_fd=parent)
    except FileNotFoundError:
        raise
    except OSError:
        raise Refused("unsafe_initialize_directory") from None
    try:
        check_owned(os.fstat(child), private=private)
        return child
    except BaseException:
        os.close(child)
        raise


def initialize_root(home, create=False):
    fd = directory(str(home))
    try:
        check_owned(os.fstat(fd))
        for name in (".dsh-wsl-desktop", "speech"):
            child = initialize_directory(fd, name, create=create, private=True)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_initialize_json(fd, name):
    try:
        file = os.open(name, os.O_RDONLY | os.O_NONBLOCK | NOFOLLOW, dir_fd=fd)
    except FileNotFoundError:
        return None
    except OSError:
        raise Refused("unsafe_initialize_file") from None
    try:
        check_owned(os.fstat(file), file=True)
        data = os.read(file, 16385)
        require(len(data) <= 16384, "initialize_config_conflict")
        value = json.loads(data)
        require(isinstance(value, dict), "initialize_config_conflict")
        return value
    finally:
        os.close(file)


def config_record(value):
    try:
        require(isinstance(value, dict) and set(value) == {"schema_version", "config"})
        require(type(value["schema_version"]) is int and value["schema_version"] == 1)
        config = validate_config(value["config"])
        require(config["python_path"] and config["model_dir"])
        # Legacy Python references are inert; only model/native paths are configurable.
        config["python_path"] = str(Path.home() / SPEECH_ROOT / "runtime/venv/bin/python")
        return config
    except (Refused, TypeError, KeyError):
        raise Refused("initialize_config_conflict") from None


def publish_initialize_json(fd, name, value, cancelled):
    """No-replace publication. Only this call's temporary/new file can be removed."""
    temporary = ".initialize-" + os.urandom(16).hex() + ".tmp"
    file = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=fd)
    committed = False
    try:
        os.fchmod(file, 0o600)
        data = memoryview((json.dumps(value, ensure_ascii=True) + "\n").encode())
        while data:
            data = data[os.write(file, data):]
        os.fsync(file)
        require(not cancelled(), "cancelled")
        try:
            os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
        except FileExistsError:
            raise Refused("initialize_config_conflict") from None
        committed = True
        os.fsync(fd)
        require(not cancelled(), "cancelled")
    except BaseException:
        if committed:
            current = os.stat(name, dir_fd=fd, follow_symlinks=False)
            ours = os.fstat(file)
            if (current.st_dev, current.st_ino) == (ours.st_dev, ours.st_ino):
                os.unlink(name, dir_fd=fd)
        raise
    finally:
        os.close(file)
        os.unlink(temporary, dir_fd=fd)


def run_initialize(command, cancelled, error, timeout=120, optional=False):
    """Offline subprocess with no output disclosure and cancellable process group."""
    require(not cancelled(), "cancelled")
    try:
        # venv/ensurepip must not inherit a group-writable launcher umask (e.g.
        # CI uses 0002). Set it in the child only; never change process-global
        # umask in this helper, which also has cancellation/watch threads.
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, start_new_session=True, umask=0o077,
            env={"PATH": "/usr/bin:/bin", "HOME": str(Path.home()),
                 "PIP_NO_INDEX": "1", "PIP_DISABLE_PIP_VERSION_CHECK": "1"})
    except OSError:
        raise Refused(error) from None
    deadline = time.monotonic() + timeout
    try:
        while True:
            require(not cancelled(), "cancelled")
            require(time.monotonic() < deadline, "initialize_timeout")
            try:
                code = process.wait(timeout=0.05)
                break
            except subprocess.TimeoutExpired:
                pass
        require(not cancelled(), "cancelled")
        if optional:
            return code == 0
        require(code == 0, error)
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        raise


def existing_venv(path):
    # A selected plain system interpreter is a base, not a speech environment.
    try:
        fd = directory(str(Path(path).parent.parent))
        try:
            file = os.open("pyvenv.cfg", os.O_RDONLY | os.O_NONBLOCK | NOFOLLOW, dir_fd=fd)
            try:
                info = os.fstat(file)
                return (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                        and not info.st_mode & 0o022 and b"home =" in os.read(file, 8192))
            finally:
                os.close(file)
        finally:
            os.close(fd)
    except (OSError, Refused):
        return False


def unmanaged_runtime_venv(speech, path):
    """Read-only compatibility for a user-created venv at the documented path.

    Any initializer record reserves the runtime for managed recovery; a partial
    venv must not become reusable merely because its interpreter/metadata exists.
    """
    try:
        runtime = initialize_directory(speech, "runtime")
    except FileNotFoundError:
        return False
    try:
        for name in (INIT_INTENT, INIT_COMPLETE):
            try:
                os.stat(name, dir_fd=runtime, follow_symlinks=False)
            except FileNotFoundError:
                continue
            return False
        venv = initialize_directory(runtime, "venv")
        os.close(venv)
        return existing_venv(path)
    finally:
        os.close(runtime)


def normalize_managed_permissions(path):
    """Tighten only trusted child output; pin every ancestor, never follow links."""
    count = 0
    def visit(fd, depth):
        nonlocal count
        require(depth <= 256, "initialize_runtime_conflict")
        with os.scandir(fd) as entries:
            for entry in entries:
                count += 1
                require(count <= 50000, "initialize_runtime_conflict")
                info = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode):
                    require(depth == 0 and entry.name == "lib64"
                            and os.readlink(entry.name, dir_fd=fd) == "lib", "initialize_runtime_conflict")
                    continue
                is_dir = stat.S_ISDIR(info.st_mode)
                require(info.st_uid == os.getuid() and (is_dir or stat.S_ISREG(info.st_mode))
                        and (is_dir or info.st_nlink == 1), "initialize_runtime_conflict")
                flags = os.O_RDONLY | os.O_NONBLOCK | NOFOLLOW
                if is_dir:
                    flags |= os.O_DIRECTORY
                child = os.open(entry.name, flags, dir_fd=fd)
                try:
                    opened = os.fstat(child)
                    require((opened.st_dev, opened.st_ino, opened.st_uid,
                             stat.S_IFMT(opened.st_mode), opened.st_nlink)
                            == (info.st_dev, info.st_ino, os.getuid(),
                                stat.S_IFMT(info.st_mode), info.st_nlink), "initialize_runtime_conflict")
                    # CPython copies activation-template modes, bypassing umask.
                    # Strip write bits in the managed copy, never its source.
                    if opened.st_mode & 0o022:
                        os.fchmod(child, stat.S_IMODE(opened.st_mode) & ~0o022)
                    check_owned(os.fstat(child))
                    if is_dir:
                        visit(child, depth + 1)
                finally:
                    os.close(child)
    try:
        fd = directory(str(path))
        try:
            check_owned(os.fstat(fd), private=True)
            visit(fd, 0)
        finally:
            os.close(fd)
    except OSError:
        raise Refused("initialize_runtime_conflict") from None


def check_managed_venv(path, normalize_permissions=False):
    if normalize_permissions:
        # Used only after our successful offline subprocess. Existing trees are
        # always checked strictly before that subprocess; they are not repaired.
        normalize_managed_permissions(path)
    # --copies avoids Python symlinks. The sole standard venv directory symlink
    # is lib64 -> lib; never follow arbitrary links left in an interrupted tree.
    count = 0
    def failed(_error):
        raise Refused("initialize_runtime_conflict")
    for folder, dirs, files in os.walk(path, followlinks=False, onerror=failed):
        for name in dirs + files:
            count += 1
            require(count <= 50000, "initialize_runtime_conflict")
            child = Path(folder) / name
            info = child.lstat()
            if stat.S_ISLNK(info.st_mode):
                require(child == path / "lib64" and os.readlink(child) == "lib",
                        "initialize_runtime_conflict")
            else:
                require(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode),
                        "initialize_runtime_conflict")
                check_owned(info)
                require(not stat.S_ISREG(info.st_mode) or info.st_nlink == 1,
                        "initialize_runtime_conflict")


def initialize_venv(home, speech, bases, cancelled):
    runtime = initialize_directory(speech, "runtime", create=True)
    path = home / SPEECH_ROOT / "runtime/venv"
    target = str(path / "bin/python")
    try:
        intent = read_initialize_json(runtime, INIT_INTENT)
        if intent is None:
            try:
                os.stat("venv", dir_fd=runtime, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise Refused("initialize_runtime_conflict")
            base = None
            for candidate in bases:
                require(not cancelled(), "cancelled")
                if run_initialize([candidate, "-I", "-S", "-B", "-c", "import venv"],
                                  cancelled, "initialize_python_unavailable", timeout=5, optional=True):
                    base = candidate
                    break
            require(base is not None, "initialize_python_unavailable")
            intent = {"schema_version": 1, "venv_path": str(path), "base_python": base}
            publish_initialize_json(runtime, INIT_INTENT, intent, cancelled)
        require(isinstance(intent, dict) and set(intent) == {"schema_version", "venv_path", "base_python"}
                and type(intent["schema_version"]) is int and intent["schema_version"] == 1
                and intent["venv_path"] == str(path), "initialize_runtime_conflict")
        base = allowed(intent["base_python"])
        venv_fd = initialize_directory(runtime, "venv", create=True)
        os.close(venv_fd)
        check_managed_venv(path)
        complete = read_initialize_json(runtime, INIT_COMPLETE)
        if complete is not None:
            require(complete == intent, "initialize_runtime_conflict")
            if os.path.isfile(target) and os.access(target, os.X_OK):
                require(python_usable(probe(target)), "initialize_venv_failed")
                return target, False
            # Remove only the validated completion record in this pinned runtime.
            # A missing interpreter must be rebuilt, and a failed rebuild stays partial.
            require(not cancelled(), "cancelled")
            os.unlink(INIT_COMPLETE, dir_fd=runtime)
            os.fsync(runtime)
        require(not cancelled(), "cancelled")
        run_initialize([base, "-I", "-S", "-B", "-m", "venv", "--copies", "--without-pip", str(path)],
                       cancelled, "initialize_venv_failed")
        check_managed_venv(path, normalize_permissions=True)
        require(python_usable(probe(target)), "initialize_venv_failed")
        # ensurepip uses only wheels bundled with this Python. No pip install,
        # package index, downloader, SDK/driver installation or network request.
        if run_initialize([target, "-I", "-S", "-B", "-c",
                           "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('ensurepip') else 1)"],
                          cancelled, "initialize_pip_failed", timeout=5, optional=True):
            run_initialize([target, "-I", "-B", "-m", "ensurepip", "--upgrade", "--default-pip"],
                           cancelled, "initialize_pip_failed")
        check_managed_venv(path, normalize_permissions=True)
        publish_initialize_json(runtime, INIT_COMPLETE, intent, cancelled)
        return target, True
    finally:
        os.close(runtime)


def initialize(request, cancelled=lambda: False):
    request = validate_config(request)
    require(not cancelled(), "cancelled")
    home = Path.home()
    speech = initialize_root(home, create=True)
    lock = None
    try:
        try:
            lock = os.open(".initialize.lock", os.O_CREAT | os.O_RDWR | os.O_NONBLOCK | NOFOLLOW,
                           0o600, dir_fd=speech)
        except OSError:
            raise Refused("unsafe_initialize_file") from None
        check_owned(os.fstat(lock), file=True)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused("initialize_busy") from None
        try:
            record = read_initialize_json(speech, "config.json")
            saved = config_record(record) if record is not None else None
        except (ValueError, UnicodeError):
            raise Refused("initialize_config_conflict") from None
        config_path = str(home / SPEECH_ROOT / "config.json")
        if saved is not None:
            require(all(not request[key] or request[key] == saved[key] for key in ("model_dir", "native_lib")),
                    "initialize_config_conflict")
            require(not cancelled(), "cancelled")
            if default_python(home) and unmanaged_runtime_venv(speech, saved["python_path"]):
                return {"config": saved, "config_path": config_path, "reused_python": True, "created_venv": False}
            request = saved
        paths = candidates(home)
        bases = []
        selected = None
        managed = str(home / SPEECH_ROOT / "runtime/venv/bin/python")
        for path in paths[:48]:
            require(not cancelled(), "cancelled")
            result = probe(path)  # version and standard-library venv only
            if not python_usable(result):
                continue
            # A managed partial runtime cannot bypass its completion record.
            # A manually created documented venv is reusable read-only, not adopted.
            if path == managed and unmanaged_runtime_venv(speech, path):
                selected = path
                break
            if path != managed:
                bases.append(path)
        created = False
        if selected is None:
            selected, created = initialize_venv(home, speech, bases, cancelled)
        model = request["model_dir"] or str(home / SPEECH_ROOT / "models/qwen3-tts-q8")
        if model == str(home / SPEECH_ROOT / "models/qwen3-tts-q8"):
            models = initialize_directory(speech, "models", create=True)
            try:
                models_q8 = initialize_directory(models, "qwen3-tts-q8", create=True)
                os.close(models_q8)
            finally:
                os.close(models)
        # Explicit model/library values are references only: no file is loaded,
        # created, moved or repaired outside the application's managed root.
        config = {"python_path": selected, "model_dir": model, "native_lib": request["native_lib"]}
        if saved is None:
            publish_initialize_json(speech, "config.json", {"schema_version": 1, "config": config}, cancelled)
        return {"config": config, "config_path": config_path,
                "reused_python": not created, "created_venv": created}
    finally:
        if lock is not None:
            os.close(lock)
        os.close(speech)


def trusted_url(url):
    value = urllib.parse.urlsplit(url)
    host = (value.hostname or "").lower()
    require(value.scheme == "https" and value.port in (None, 443) and value.username is None
            and value.password is None and (host == "huggingface.co" or host.endswith(".huggingface.co")
            or host.endswith(".hf.co")), "untrusted_download_redirect")
    return url


class TrustedRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        trusted_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def opener(url):
    trusted_url(url)
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), TrustedRedirect()).open(url, timeout=15)


def digest(fd, cancelled):
    value = hashlib.sha256()
    size = 0
    os.lseek(fd, 0, os.SEEK_SET)
    while True:
        require(not cancelled(), "cancelled")
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            return value.hexdigest(), size
        size += len(chunk)
        require(size <= MAX_FILE, "model_too_large")
        value.update(chunk)


def existing(fd, name, expected, cancelled):
    try:
        file = os.open(name, os.O_RDONLY | os.O_NONBLOCK | NOFOLLOW, dir_fd=fd)
    except FileNotFoundError:
        return None
    try:
        require(stat.S_ISREG(os.fstat(file).st_mode), "unsafe_model_file")
        value, size = digest(file, cancelled)
        require(value == expected, "existing_model_mismatch")
        return size
    finally:
        os.close(file)


def download(request, emit, cancelled, open_url=opener):
    require(set(request) == {"model_dir"})
    path = absolute(request["model_dir"])
    fd = directory(path, create=True)
    lock = None
    downloaded = 0
    try:
        info = os.fstat(fd)
        require(info.st_uid == os.getuid() and not info.st_mode & 0o022, "unsafe_download_directory")
        lock = os.open(".dsh-q8-download.lock", os.O_CREAT | os.O_RDWR | NOFOLLOW, 0o600, dir_fd=fd)
        require(stat.S_ISREG(os.fstat(lock).st_mode), "unsafe_download_directory")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused("download_busy") from None
        for name, expected in MODELS.items():
            require(not cancelled(), "cancelled")
            size = existing(fd, name, expected, cancelled)
            if size is not None:
                downloaded += size
                emit({"file": name, "downloaded_bytes": downloaded, "total_bytes": None})
                continue
            temporary = ".dsh-q8-" + os.urandom(16).hex() + ".part"
            output = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | NOFOLLOW, 0o600, dir_fd=fd)
            try:
                value = hashlib.sha256()
                size = 0
                last = 0
                with open_url(BASE_URL + name) as response:
                    length = response.headers.get("Content-Length")
                    length = int(length) if length and length.isdecimal() else None
                    require(length is None or 0 < length <= MAX_FILE, "model_too_large")
                    while True:
                        require(not cancelled(), "cancelled")
                        chunk = response.read(256 * 1024)
                        if not chunk:
                            break
                        size += len(chunk)
                        require(size <= MAX_FILE, "model_too_large")
                        pending = memoryview(chunk)
                        while pending:
                            pending = pending[os.write(output, pending):]
                        value.update(chunk)
                        now = time.monotonic()
                        if now - last >= 0.5:
                            # total covers the current file only when last file is known;
                            # keep aggregate total unknown until the complete pair exists.
                            emit({"file": name, "downloaded_bytes": downloaded + size, "total_bytes": None})
                            last = now
                    require(length is None or size == length, "incomplete_download")
                require(value.hexdigest() == expected, "model_hash_mismatch")
                require(not cancelled(), "cancelled")
                os.fsync(output)
                # link is an atomic no-replace commit (unlike replace/rename).
                try:
                    os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                except FileExistsError:
                    existing(fd, name, expected, cancelled)
                os.fsync(fd)
                downloaded += size
                emit({"file": name, "downloaded_bytes": downloaded, "total_bytes": None})
            finally:
                os.close(output)
                os.unlink(temporary, dir_fd=fd)
        emit({"file": None, "downloaded_bytes": downloaded, "total_bytes": downloaded})
        return {"ok": True}
    finally:
        if lock is not None:
            os.close(lock)
        os.close(fd)


def main():
    def emit(value):
        print(json.dumps(value, ensure_ascii=True), flush=True)
    try:
        action = sys.argv[1:]
        require(len(action) == 1 and action[0] in {"--resources-browse", "--resources-download", "--resources-initialize"})
        line = sys.stdin.buffer.readline(16385)
        require(len(line) <= 16384)
        request = json.loads(line)
        require(isinstance(request, dict))
        if action in (["--resources-download"], ["--resources-initialize"]):
            cancelled = threading.Event()
            def owner():
                # EOF is cancellation; no command language on this channel.
                # Raw fd read: a daemon must not retain the buffered-stdin lock
                # while a successful download exits with its owner still attached.
                try:
                    os.read(sys.stdin.fileno(), 1)
                finally:
                    cancelled.set()
            threading.Thread(target=owner, daemon=True).start()
            result = (download(request, emit, cancelled.is_set) if action == ["--resources-download"] else
                      {"ok": True, "result": initialize(request, cancelled.is_set)})
        else:
            result = {"ok": True, "result": browse(request)}
    except Refused as error:
        result = {"ok": False, "error": str(error)}
    except BaseException:
        result = {"ok": False, "error": "resource_operation_failed"}
    try:
        emit(result)
    except (BrokenPipeError, OSError):
        pass


if __name__ == "__main__":
    main()
