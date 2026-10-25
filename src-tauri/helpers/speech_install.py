"""Explicit user-space installation. Bundled resources/build script arrive via stdin.
Never imports an ambient checkout, uses sudo/apt, or starts the speech service.
"""
import base64
import ctypes
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import types
import urllib.request

QWEN_COMMIT = "5916bf7c79dbb4e66fc059cdc507a79a23a28bb4"
GGML_COMMIT = "cc5df49a6b878db2b68b9a7b45976e279594627d"
CUDA_VERSION = "12.8.1"
CUDA_ARCHES = {50, 52, 53, 60, 61, 62, 70, 72, 75, 80, 86, 87, 89, 90, 100, 101, 120}
INSTALL_COMMAND = "sudo apt-get update && sudo apt-get install -y python3 python3-venv git build-essential coreutils bash"
CUDA_BASE = "https://developer.download.nvidia.com/compute/cuda/redist/"
AMD_INDEX = "https://stable.repo.amd.com/rocm/whl-next/"
PYPI = "https://pypi.org/simple"
STAGES = {"prepare": "准备默认语音环境", "gpu": "识别可用显卡", "dependencies": "安装固定版本依赖",
          "source": "获取固定版本源码", "build": "编译原生语音库", "models": "下载并校验模型"}

class InstallError(Exception):
    pass

def require(ok, code):
    if not ok:
        raise InstallError(code)

def environment(venv=None):
    env = {"HOME": str(Path.home()), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
           "PIP_CONFIG_FILE": os.devnull, "PIP_DISABLE_PIP_VERSION_CHECK": "1",
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
           "GIT_TERMINAL_PROMPT": "0", "PYTHONDONTWRITEBYTECODE": "1"}
    if venv:
        env["PATH"] = str(venv / "bin") + ":" + env["PATH"]
    env["LD_LIBRARY_PATH"] = "/usr/lib/wsl/lib"
    return env

def run(argv, cancelled, code, env=None, timeout=1800, optional=False):
    require(not cancelled(), "cancelled")
    # File-backed bounded output avoids pipe deadlock and unbounded memory. Never disclose stderr.
    with tempfile.TemporaryFile() as output:
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=output,
            stderr=output, start_new_session=True, env=env or environment(), umask=0o077,
            close_fds=True)
        try:
            deadline = time.monotonic() + timeout
            # waitid keeps the leader unreaped until all descendants have been killed.
            while os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
                require(not cancelled(), "cancelled")
                require(os.fstat(output.fileno()).st_size < 4 * 1024**2, code)
                require(time.monotonic() < deadline, code + "_timeout")
                threading.Event().wait(.05)
            require(not cancelled(), "cancelled")
        finally:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
        if optional and child.returncode != 0:
            return None
        require(child.returncode == 0, code)
        output.seek(0)
        return output.read(65537).decode("utf-8", "replace").strip()

CUDA_PROBE = '''import ctypes as C,json
try:
 d=C.CDLL('/usr/lib/wsl/lib/libcuda.so.1'); n=C.c_int(); v=C.c_int(); dev=C.c_int(); major=C.c_int(); minor=C.c_int()
 assert d.cuInit(0)==0 and d.cuDeviceGetCount(C.byref(n))==0 and n.value>0
 assert d.cuDriverGetVersion(C.byref(v))==0 and d.cuDeviceGet(C.byref(dev),0)==0
 assert d.cuDeviceGetAttribute(C.byref(major),75,dev)==0 and d.cuDeviceGetAttribute(C.byref(minor),76,dev)==0
 print(json.dumps({'version':v.value,'arch':major.value*10+minor.value}))
except Exception: raise SystemExit(2)
'''
ROCM_PROBE = '''import ctypes as C,rocm_sdk
rocm_sdk.initialize_process(preload_shortnames=['amdhip64'])
h=C.CDLL(str(rocm_sdk.find_libraries('amdhip64')[0])); n=C.c_int(); p=C.create_string_buffer(16384)
assert h.hipInit(0)==0 and h.hipGetDeviceCount(C.byref(n))==0 and n.value>0
assert h.hipGetDeviceProperties(p,0)==0
assert b'gfx1201' in p.raw
print('gfx1201')
'''

def select_cuda(cancelled):
    value = run(["/usr/bin/python3", "-I", "-S", "-c", CUDA_PROBE], cancelled,
                "gpu_probe_failed", timeout=20, optional=True)
    if value is None:
        return None
    try:
        result = json.loads(value)
        require(result["version"] >= 12080, "cuda_driver_old")
        require(result["arch"] in CUDA_ARCHES, "cuda_arch_unsupported")
        return str(result["arch"])
    except (ValueError, KeyError, TypeError):
        raise InstallError("gpu_probe_failed") from None

def read_system(path, cap=16384):
    """Bounded reads of fixed OS/kernel files; never source os-release as shell."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                return ""
            data = os.read(fd, cap + 1)
            return data.decode("ascii", "strict") if len(data) <= cap else ""
        finally:
            os.close(fd)
    except (OSError, UnicodeError):
        return ""


def debian_or_ubuntu():
    # ID_LIKE is deliberately not accepted: derivatives need their own guidance.
    ids = re.findall(r'^ID=(?:"([a-z0-9_-]+)"|([a-z0-9_-]+))$',
                     read_system("/etc/os-release"), re.MULTILINE)
    return len(ids) == 1 and (ids[0][0] or ids[0][1]) in {"debian", "ubuntu"}


def wsl_gpu_bridge():
    try:
        return stat.S_ISCHR(os.stat("/dev/dxg").st_mode)
    except OSError:
        return False


def amd_gpu_arch():
    # KFD topology is kernel evidence, not a marketing GPU name or ambient SDK.
    # A CPU node, absent GPU id, another vendor or unknown ISA is not supported.
    try:
        with os.scandir("/sys/class/kfd/kfd/topology/nodes") as nodes:
            for index, node in enumerate(nodes):
                if index >= 64:
                    break
                if not re.fullmatch(r"[0-9]{1,4}", node.name):
                    continue
                props = read_system(node.path + "/properties")
                fields = dict(re.findall(r"^([a-z_]+) ([0-9]+)$", props, re.MULTILINE))
                gpu_id = read_system(node.path + "/gpu_id", 64).strip()
                if (fields.get("gfx_target_version", "").isdigit()
                        and int(fields["gfx_target_version"]) > 0
                        and fields.get("vendor_id") == "4098"
                        and fields.get("simd_count", "0").isdigit()
                        and int(fields.get("simd_count", "0")) > 0
                        and gpu_id.isdigit() and int(gpu_id) > 0):
                    return int(fields["gfx_target_version"])
    except OSError:
        pass
    return None


def readonly_probe(code, cancelled, timeout=5):
    """Only fixed isolated system-Python probes; bounded pipe, no temp files."""
    require(not cancelled(), "cancelled")
    try:
        child = subprocess.Popen(["/usr/bin/python3", "-I", "-S", "-B", "-c", code],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            start_new_session=True, close_fds=True,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
                 "LD_LIBRARY_PATH": "/usr/lib/wsl/lib"})
    except OSError:
        return None
    data = bytearray()
    try:
        os.set_blocking(child.stdout.fileno(), False)
        deadline = time.monotonic() + timeout
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            eof = False
            while True:
                require(not cancelled(), "cancelled")
                if time.monotonic() >= deadline:
                    return None
                for key, _ in selector.select(.05):
                    chunk = os.read(key.fd, 4097 - len(data))
                    if not chunk:
                        selector.unregister(key.fileobj)
                        eof = True
                    else:
                        data.extend(chunk)
                        if len(data) > 4096:
                            return None
                if eof and os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                    break
    finally:
        # Keep the leader unreaped until its whole probe group has been stopped.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        child.stdout.close()
    require(not cancelled(), "cancelled")
    if child.returncode != 0:
        return None
    try:
        return data.decode("ascii", "strict").strip()
    except UnicodeError:
        return None


PYTHON_PROBE = "import sys,venv;print('ready' if sys.version_info >= (3,10) else 'old')"


def preflight(cancelled):
    """Prerequisites to TRY installation, not model/inference/service readiness."""
    require(not cancelled(), "cancelled")
    checks = []
    def check(id, status, detail):
        checks.append({"id": id, "status": status, "detail": detail})
    platform_ok = (platform.machine() == "x86_64"
                   and "microsoft" in read_system("/proc/sys/kernel/osrelease").lower()
                   and wsl_gpu_bridge())
    check("platform", "ready" if platform_ok else "unsupported",
          "已发现 x86_64 WSL GPU 桥接。" if platform_ok else
          "需要 x86_64 WSL2 和 GPU 桥接；请更新 WSL 与 Windows 显卡驱动后重试。")
    python_ok = readonly_probe(PYTHON_PROBE, cancelled) == "ready"
    check("python", "ready" if python_ok else "action",
          "系统 Python ≥ 3.10 且支持 venv。" if python_ok else
          "请在当前 WSL 安装或更新系统 Python ≥ 3.10 和 python3-venv，再重新检查。")
    missing = [tool for tool in ("git", "bash", "make", "cc", "c++", "realpath")
               if shutil.which(tool, path="/usr/bin:/bin") is None]
    check("tools", "action" if missing else "ready",
          "请在当前 WSL 补齐构建工具：" + "、".join(missing) + "，再重新检查。" if missing else
          "git、bash、make、C/C++ 编译器和 realpath 已就绪。")
    if not platform_ok:
        check("gpu", "unsupported", "请先启用 WSL2 GPU 桥接并更新 Windows 显卡驱动。")
    else:
        value = readonly_probe(CUDA_PROBE, cancelled, timeout=8)
        try:
            cuda = json.loads(value) if value else None
        except (ValueError, TypeError):
            cuda = None
        if (isinstance(cuda, dict) and set(cuda) == {"version", "arch"}
                and type(cuda["version"]) is int and type(cuda["arch"]) is int):
            if cuda["version"] < 12080:
                check("gpu", "action", "请更新 Windows NVIDIA 驱动，使其支持 CUDA 12.8 或更新版本。")
            elif cuda["arch"] not in CUDA_ARCHES:
                check("gpu", "unsupported", "此 NVIDIA 架构不支持固定 CUDA 12.8 安装；请使用受支持显卡。")
            else:
                check("gpu", "ready", "NVIDIA 驱动和 GPU 架构符合 CUDA 12.8 安装要求。")
        elif value is not None:
            check("gpu", "action", "无法读取 GPU 驱动信息；请检查 Windows 显卡驱动与 WSL 后重新检查。")
        else:
            amd = amd_gpu_arch()
            if amd == 120001:
                check("gpu", "ready", "已发现 AMD gfx1201；安装组件时将验证 ROCm 10.1 支持。")
            elif amd is not None:
                check("gpu", "unsupported", "此 AMD 架构不支持固定 ROCm 10.1 安装；目前仅支持 gfx1201。")
            else:
                # WSL normally has no KFD topology, including known-working AMD.
                # Ready only permits trying the installer, NOT verified GPU support.
                # Its mandatory SDK/HIP probe still rejects unsupported hardware.
                check("gpu", "ready", "WSL GPU 桥接已就绪，显卡兼容性待安装组件时验证（AMD 仅 gfx1201）。")
    require(not cancelled(), "cancelled")
    return {"ready": all(c["status"] == "ready" for c in checks), "checks": checks,
            "install_command": INSTALL_COMMAND if (not python_ok or missing) and debian_or_ubuntu() else None}


class OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        require(newurl.startswith(CUDA_BASE), "sdk_redirect_refused")
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def fetch(url, destination, cancelled, expected=None, limit=3 * 1024**3):
    require(url.startswith(CUDA_BASE), "sdk_redirect_refused")
    digest = hashlib.sha256()
    size = 0
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), OfficialRedirect()).open(url, timeout=15) as response:
        with open(destination, "xb") as output:
            while True:
                require(not cancelled(), "cancelled")
                chunk = response.read(256 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                require(size <= limit, "sdk_too_large")
                digest.update(chunk)
                output.write(chunk)
    require(expected is None or digest.hexdigest() == expected, "sdk_hash_mismatch")


def extract_cuda(archive, target, cancelled):
    # Strip only the vendor's one archive root. Reject traversal/devices/hardlinks.
    with tarfile.open(archive, "r|xz") as tar:
        count = size = 0
        for m in tar:
            require(not cancelled(), "cancelled")
            count += 1
            size += m.size
            require(count < 100000 and size < 8 * 1024**3, "unsafe_sdk_archive")
            p = PurePosixPath(m.name)
            require(not p.is_absolute() and ".." not in p.parts and len(p.parts) >= 1, "unsafe_sdk_archive")
            if len(p.parts) == 1:
                require(m.isdir(), "unsafe_sdk_archive")
                continue
            relative = PurePosixPath(*p.parts[1:])
            path = target / relative
            require(m.isfile() or m.isdir() or m.issym(), "unsafe_sdk_archive")
            if m.issym():
                link = PurePosixPath(m.linkname)
                require(not link.is_absolute() and ".." not in link.parts, "unsafe_sdk_archive")
            # No archive member may traverse previously installed symlinks.
            parent = target
            for part in relative.parts[:-1]:
                parent = parent / part
                require(not parent.is_symlink(), "unsafe_sdk_archive")
            require(not path.is_symlink(), "unsafe_sdk_archive")
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if m.isdir():
                path.mkdir(exist_ok=True, mode=0o700)
            elif m.issym():
                require(not path.exists(), "unsafe_sdk_archive")
                path.symlink_to(m.linkname)
            else:
                # Metadata/license duplicates may occur across vendor components.
                data = tar.extractfile(m)
                with open(path, "wb") as out:
                    while True:
                        require(not cancelled(), "cancelled")
                        chunk = data.read(256 * 1024)
                        if not chunk:
                            break
                        out.write(chunk)
                path.chmod(0o700 if m.mode & 0o111 else 0o600)


def install_cuda(root, cancelled):
    sdk = root / ("cuda-" + CUDA_VERSION)
    if sdk.exists() or sdk.is_symlink():
        info = sdk.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
                and not info.st_mode & 0o077, "sdk_conflict")
        try:
            fd = os.open(sdk / ".complete", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError:
            raise InstallError("sdk_conflict") from None
        try:
            marker = os.fstat(fd)
            require(stat.S_ISREG(marker.st_mode) and marker.st_uid == os.getuid()
                    and marker.st_nlink == 1 and not marker.st_mode & 0o022
                    and os.read(fd, 32) == CUDA_VERSION.encode(), "sdk_conflict")
        finally:
            os.close(fd)
        return sdk
    # Temporary staging is private and unique; only this context removes its own tree.
    with tempfile.TemporaryDirectory(prefix=".cuda-", dir=root) as folder:
        work = Path(folder)
        manifest = work / "manifest.json"
        fetch(CUDA_BASE + "redistrib_" + CUDA_VERSION + ".json", manifest, cancelled, limit=1024**2)
        meta = json.loads(manifest.read_text())
        tree = work / "sdk"
        tree.mkdir(mode=0o700)
        for component in ("cuda_nvcc", "cuda_cudart", "cuda_cccl", "libcublas"):
            item = meta[component]["linux-x86_64"]
            relative = item["relative_path"]
            require(isinstance(relative, str) and re.fullmatch(r"[A-Za-z0-9_./-]+", relative)
                    and not relative.startswith("/") and ".." not in relative.split("/"), "sdk_manifest_invalid")
            require(re.fullmatch(r"[0-9a-f]{64}", item["sha256"]) is not None, "sdk_manifest_invalid")
            archive = work / (component + ".tar.xz")
            fetch(CUDA_BASE + relative, archive, cancelled, item["sha256"])
            extract_cuda(archive, tree, cancelled)
        require((tree / "bin/nvcc").is_file() and (tree / "include/cuda_runtime.h").is_file(), "sdk_manifest_invalid")
        # NVIDIA archives use lib; CMake and the runtime use lib64.
        if not (tree / "lib64").exists():
            (tree / "lib64").symlink_to("lib")
        (tree / ".complete").write_text(CUDA_VERSION)
        (tree / ".complete").chmod(0o600)
        require(not cancelled(), "cancelled")
        os.rename(tree, sdk)
    return sdk


def checkout(parent, name, url, commit, cancelled, env):
    path = parent / name
    if not path.exists():
        path.mkdir(mode=0o700)
        run(["git", "init", str(path)], cancelled, "source_fetch_failed", env)
    require(not path.is_symlink() and (path / ".git").is_dir() and not (path / ".git").is_symlink(), "source_conflict")
    # Re-fetch exact objects; never follow a branch, submodule URL, or user git config.
    run(["git", "-C", str(path), "-c", "core.hooksPath=/dev/null", "fetch", "--depth=1", url, commit], cancelled, "source_fetch_failed", env)
    run(["git", "-C", str(path), "-c", "core.hooksPath=/dev/null", "checkout", "--detach", commit], cancelled, "source_conflict", env)
    require(run(["git", "-C", str(path), "rev-parse", "HEAD"], cancelled, "source_conflict", env) == commit, "source_conflict")
    run(["git", "-C", str(path), "diff", "--exit-code"], cancelled, "source_conflict", env)
    return path


def bootstrap_pip(python, root, cancelled, env):
    """Pinned official wheel, release metadata SHA256, no get-pip.py or system pip."""
    class PipRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            require(newurl.startswith("https://files.pythonhosted.org/"), "pip_missing")
            return super().redirect_request(req, fp, code, msg, headers, newurl)
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}), PipRedirect())
    with client.open("https://pypi.org/pypi/pip/25.3/json", timeout=15) as response:
        data = response.read(1024**2 + 1)
        require(len(data) <= 1024**2, "pip_missing")
        meta = json.loads(data)
    wheels = [f for f in meta["urls"] if f["filename"] == "pip-25.3-py3-none-any.whl"]
    require(len(wheels) == 1, "pip_missing")
    wheel = wheels[0]
    require(wheel["url"].startswith("https://files.pythonhosted.org/")
            and re.fullmatch(r"[0-9a-f]{64}", wheel["digests"]["sha256"]), "pip_missing")
    with tempfile.TemporaryDirectory(prefix=".pip-", dir=root) as folder:
        path = Path(folder) / wheel["filename"]
        digest = hashlib.sha256()
        size = 0
        with client.open(wheel["url"], timeout=15) as response, open(path, "xb") as output:
            while True:
                require(not cancelled(), "cancelled")
                chunk = response.read(256 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                require(size <= 8 * 1024**2, "pip_missing")
                output.write(chunk)
                digest.update(chunk)
        require(digest.hexdigest() == wheel["digests"]["sha256"], "pip_missing")
        run([python, "-I", "-c", "import sys;sys.path.insert(0,sys.argv[1]);from pip._internal.cli.main import main;sys.exit(main(sys.argv[2:]))",
             str(path), "install", "--no-index", "--no-deps", str(path)], cancelled, "pip_missing", env)


def install(resources, build_script, cancelled, emit):
    require(not cancelled(), "cancelled")
    require(platform.machine() == "x86_64" and sys.version_info >= (3, 10), "platform_unsupported")
    require(os.path.exists("/dev/dxg"), "wsl_gpu_unavailable")
    for tool in ("git", "bash", "make", "cc", "c++", "realpath"):
        require(shutil.which(tool, path="/usr/bin:/bin") is not None, "missing_tool_" + tool.replace("+", "x"))
    def stage(name, downloaded=0, total=None):
        emit({"stage": STAGES[name], "downloaded_bytes": downloaded, "total_bytes": total})
    home = Path.home()
    speech = resources.initialize_root(home, create=True)
    lock = os.open(".initialize.lock", os.O_RDWR | os.O_CREAT | resources.NOFOLLOW, 0o600, dir_fd=speech)
    try:
        resources.check_owned(os.fstat(lock), file=True)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise InstallError("initialize_busy") from None
        stage("prepare")
        root = home / resources.SPEECH_ROOT
        # Do not touch initialization's config.json: it may refer to a valid old configuration.
        runtime = resources.initialize_directory(speech, "runtime", create=True)
        os.close(runtime)
        managed = str(root / "runtime/venv/bin/python")
        if os.path.isfile(managed) and resources.unmanaged_runtime_venv(speech, managed):
            raise InstallError("unmanaged_venv")
        runtime = resources.initialize_directory(speech, "runtime")
        try:
            complete = resources.read_initialize_json(runtime, resources.INIT_COMPLETE)
            if complete is not None:
                require(complete == {"schema_version": 1, "venv_path": str(root / "runtime/venv"), "base_python": "/usr/bin/python3"}, "unmanaged_venv")
                fd = resources.directory(str(root / "runtime/venv/bin"))
                os.close(fd)
                resources.check_owned(os.stat(managed, follow_symlinks=False))
                require(stat.S_ISREG(os.stat(managed, follow_symlinks=False).st_mode), "unmanaged_venv")
                python = managed
            else:
                python, _ = resources.initialize_venv(home, speech, ["/usr/bin/python3"], cancelled)
        finally:
            os.close(runtime)
        venv = root / "runtime/venv"
        env = environment(venv)
        stage("gpu")
        arch = select_cuda(cancelled)
        stage("dependencies")
        # ensurepip may be absent in Debian/Ubuntu; bootstrap a pinned official pip wheel,
        # never get-pip.py or a shell installer. zipimport runs only this exact pip release.
        if run([python, "-I", "-m", "pip", "--version"], cancelled, "pip_missing", env, optional=True) is None:
            try:
                bootstrap_pip(python, root, cancelled, env)
            except InstallError:
                raise
            except Exception:
                raise InstallError("pip_missing") from None
        run([python, "-I", "-m", "pip", "install", "--index-url", PYPI, "--only-binary=:all:",
             "pip==25.3", "cmake==3.31.6", "ninja==1.11.1.3"], cancelled, "dependencies_failed", env)
        if arch is None:
            run([python, "-I", "-m", "pip", "install", "--index-url", AMD_INDEX, "--only-binary=:all:",
                 "rocm[libraries,devel,device-gfx1201]==10.1.0"], cancelled, "rocm_dependencies_failed", env)
            require(run([python, "-I", "-c", ROCM_PROBE], cancelled, "rocm_gpu_unsupported", env, timeout=30, optional=True) == "gfx1201", "rocm_gpu_unsupported")
            run([str(venv / "bin/rocm-sdk"), "init"], cancelled, "rocm_sdk_failed", env)
            sdk = run([str(venv / "bin/rocm-sdk"), "path", "--root"], cancelled, "rocm_sdk_failed", env)
            resources.absolute(sdk)
            backend_args = ["--backend", "rocm", "--sdk-root", sdk]
            backend = "rocm"
        else:
            sdk = install_cuda(root, cancelled)
            backend_args = ["--backend", "cuda", "--cuda-root", str(sdk), "--cuda-architectures", arch]
            backend = "cuda"
        stage("source")
        # Per-attempt build trees are retained for diagnostics/retry; never overwrite an old library.
        native_fd = resources.initialize_directory(speech, "native", create=True)
        os.close(native_fd)
        work = Path(tempfile.mkdtemp(prefix="install-", dir=root / "native"))
        source = checkout(work, "qwentts.cpp", "https://github.com/ServeurpersoCom/qwentts.cpp.git", QWEN_COMMIT, cancelled, env)
        # The upstream commit pins this ggml object; use its official repository explicitly.
        ggml = source / "ggml"
        if ggml.exists() and not any(ggml.iterdir()):
            ggml.rmdir()
        checkout(source, "ggml", "https://github.com/ggml-org/ggml.git", GGML_COMMIT, cancelled, env)
        run(["git", "-C", str(source), "submodule", "init", "--", "ggml"], cancelled, "source_conflict", env)
        script = work / "build_native.sh"
        script.write_bytes(build_script)
        script.chmod(0o600)
        stage("build")
        build = work / ("build-" + backend)
        run(["bash", str(script), "--source-dir", str(source), "--build-dir", str(build),
             "--cmake", str(venv / "bin/cmake"), "--jobs", "2"] + backend_args,
             cancelled, "native_build_failed", env, timeout=3600)
        model = root / "models/qwen3-tts-q8"
        stage("models")
        resources.download({"model_dir": str(model)},
            lambda p: stage("models", p["downloaded_bytes"], p["total_bytes"]), cancelled)
        require(not cancelled(), "cancelled")
        return {"python_path": python, "native_lib": str(build / "libqwen.so"), "model_dir": str(model)}
    finally:
        os.close(lock)
        os.close(speech)


def main():
    cancel = threading.Event()
    output = sys.stdout.fileno()
    os.set_blocking(output, False)
    def emit(value):
        data = memoryview((json.dumps(value, ensure_ascii=True) + "\n").encode())
        deadline = time.monotonic() + 2
        with selectors.DefaultSelector() as selector:
            selector.register(output, selectors.EVENT_WRITE)
            while data:
                require(time.monotonic() < deadline, "owner_unavailable")
                if selector.select(.05):
                    try:
                        data = data[os.write(output, data):]
                    except BlockingIOError:
                        pass
    try:
        line = sys.stdin.buffer.readline(262145)
        require(len(line) <= 262144 and line.endswith(b"\n"), "invalid_request")
        request = json.loads(line)
        mode = sys.argv[1:]
        require(mode in (["--resources-install"], ["--resources-preflight"], []), "invalid_request")
        readonly = mode == ["--resources-preflight"]
        require(isinstance(request, dict) and set(request) == (set() if readonly else {"resources", "build_script"}), "invalid_request")
        def owner():
            try:
                os.read(sys.stdin.fileno(), 1)
            finally:
                cancel.set()
        threading.Thread(target=owner, daemon=True).start()
        signal.signal(signal.SIGTERM, lambda *_: cancel.set())
        signal.signal(signal.SIGINT, lambda *_: cancel.set())
        if readonly:
            result = preflight(cancel.is_set)
        else:
            resources = types.ModuleType("speech_resources")
            exec(compile(base64.b64decode(request["resources"], validate=True), "<bundled-speech-resources>", "exec"), resources.__dict__)
            build = base64.b64decode(request["build_script"], validate=True)
            result = install(resources, build, cancel.is_set, emit)
        emit({"ok": True, "result": result})
    except BaseException as error:
        code = str(error) if isinstance(error, (InstallError, getattr(locals().get("resources"), "Refused", InstallError))) else "install_failed"
        try:
            emit({"ok": False, "error": code})
        except BaseException:
            pass

if __name__ == "__main__":
    main()
