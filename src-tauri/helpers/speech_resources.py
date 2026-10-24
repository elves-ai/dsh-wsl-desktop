"""Fixed, stdlib-only WSL resource discovery/browser and explicit pinned Q8 download.

No shell, dependency installation, model import or native-library loading. Paths
are JSON data. Downloads require a held owner channel and never replace a file.
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
KINDS = {"model_dir", "python_path", "native_lib"}


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
                        if request["kind"] == "python_path" and not (name.startswith("python") and info.st_mode & 0o111):
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
# Probe metadata on known site directories instead of importing rocm_sdk/models.
PROBE = r'''
import sys,json,glob,os,importlib.metadata
paths = list(sys.path)
root = os.path.dirname(os.path.dirname(sys.executable))
paths += glob.glob(root + '/lib/python*/site-packages')
paths += glob.glob(sys.base_prefix + '/lib/python*/site-packages')
names = {d.metadata.get('Name','').lower().replace('_','-') for d in importlib.metadata.distributions(path=paths)}
print(json.dumps({'version': '.'.join(map(str,sys.version_info[:3])),
 'ready': sys.version_info >= (3,10) and 'rocm-sdk' in names}))
'''


def candidates(home, environ):
    result = []
    def add(path):
        if len(result) < 48 and path not in result:
            try:
                absolute(path)
                if os.path.isfile(path) and os.access(path, os.X_OK):
                    result.append(path)
            except (OSError, Refused):
                pass
    for folder in (".local/share/dsh-pet/qwen-runtime/venv", ".local/share/dsh-speech/venv", ".local/share/dsh-speech/qwen-runtime/venv"):
        add(str(home / folder / "bin/python"))
    for var in ("VIRTUAL_ENV", "CONDA_PREFIX"):
        if environ.get(var):
            add(str(Path(environ[var]) / "bin/python"))
    for folder in (".venv", "venv", ".virtualenvs", "venvs", ".conda/envs", "miniconda3/envs", "anaconda3/envs", "miniforge3/envs", "micromamba/envs", "miniconda3", "anaconda3", "miniforge3"):
        root = home / folder
        add(str(root / "bin/python"))
        try:
            with os.scandir(root) as items:
                for i, item in enumerate(items):
                    if i >= 128:
                        break
                    if item.is_dir(follow_symlinks=False):
                        add(str(Path(item.path) / "bin/python"))
        except OSError:
            pass
    try:
        with open(home / ".conda/environments.txt", "r", encoding="utf-8") as registry:
            for line in registry.read(32768).splitlines()[:128]:
                if line.startswith("/"):
                    add(str(Path(line) / "bin/python"))
    except (OSError, UnicodeError):
        pass
    # Common project-local venvs, bounded to one level; no recursive disk scan.
    try:
        with os.scandir(home) as items:
            for i, item in enumerate(items):
                if i >= 128:
                    break
                if item.is_dir(follow_symlinks=False):
                    for folder in (".venv", "venv"):
                        add(str(Path(item.path) / folder / "bin/python"))
    except OSError:
        pass
    for folder in environ.get("PATH", "").split(os.pathsep)[:64]:
        if folder.startswith("/"):
            for name in ("python3", "python"):
                add(str(Path(folder) / name))
    add("/usr/bin/python3")
    return result


def _probe_limits():
    # This action is single-threaded. Bound even a broken executable's output.
    resource.setrlimit(resource.RLIMIT_FSIZE, (8192, 8192))
    resource.setrlimit(resource.RLIMIT_CPU, (2, 2))


def probe(path):
    # Candidate binaries are user-selected executables. Do not execute .pth,
    # import packages, initialize GPU, install anything or retain raw output.
    try:
        with tempfile.TemporaryFile() as output:
            process = subprocess.Popen([path, "-I", "-S", "-c", PROBE], stdin=subprocess.DEVNULL,
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
                return {"path": path, "version": "unknown", "ready": False}
            output.seek(0)
            value = json.loads(output.read(4097))
        require(process.returncode == 0 and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", value["version"]))
        require(type(value["ready"]) is bool)
        return {"path": path, "version": value["version"], "ready": value["ready"]}
    except (OSError, ValueError, KeyError, TypeError, Refused):
        return {"path": path, "version": "unknown", "ready": False}


def discover(request):
    require(set(request) == {"python_path", "model_dir", "native_lib"})
    home = Path.home()
    model = request["model_dir"] or str(home / ".local/share/dsh-speech/models/qwen3-tts-q8")
    native = request["native_lib"] or os.environ.get("DSH_QWEN_NATIVE_LIB", "")
    absolute(model)
    if native:
        absolute(native)
    paths = candidates(home, os.environ)
    if request["python_path"]:
        selected = absolute(request["python_path"])
        paths = [selected] + [p for p in paths if p != selected]
    result = {"python_environments": [probe(p) for p in paths[:48]],
              "model_dir": model, "native_lib": native}
    while len(json.dumps(result).encode()) > 60000:
        result["python_environments"].pop()
    return result


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
        require(len(action) == 1 and action[0] in {"--resources-discover", "--resources-browse", "--resources-download"})
        line = sys.stdin.buffer.readline(16385)
        require(len(line) <= 16384)
        request = json.loads(line)
        require(isinstance(request, dict))
        if action == ["--resources-download"]:
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
            result = download(request, emit, cancelled.is_set)
        else:
            result = {"ok": True, "result": (discover if action == ["--resources-discover"] else browse)(request)}
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
