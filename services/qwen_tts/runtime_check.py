"""Read-only WSL2 CUDA/cuBLAS and ROCm HIP/hipBLAS probes; never loads a TTS model."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import re
import subprocess
import sys


# Isolated because even initialization or a driver call may hang/crash. All GPU
# statuses, including resource cleanup, must succeed before readiness is reported.
GPU_PROBE_CODE = r'''
import ctypes as C
import json
import sys
import os
# A cancelled config helper must not leave an orphan GPU probe behind.
if sys.platform == 'linux':
    parent = int(os.environ.get('DSH_QWEN_CHECK_PARENT', os.getppid()))
    C.CDLL(None).prctl(1, 9, 0, 0, 0)  # PR_SET_PDEATHSIG, SIGKILL
    if parent == 1 or os.getppid() != parent:
        sys.exit(2)

r = {"gpu_compute_verified": False, "backend": "rocm", "device": sys.argv[1]}
hip = blas = None
allocations = []
handle = C.c_void_p()
math_correct = False
failed = False

def check(status):
    if status != 0:
        raise RuntimeError("gpu_status_failed")

def bind(lib, name, args):
    fn = getattr(lib, name)
    fn.argtypes = args
    fn.restype = C.c_int
    return fn

try:
    import rocm_sdk
    rocm_sdk.initialize_process(preload_shortnames=['amdhip64', 'hipblas'])
    # SDK exposes hipblas, not a rocblas alias. hipBLAS locates its own dependency.
    hip_paths = rocm_sdk.find_libraries('amdhip64')
    blas_paths = rocm_sdk.find_libraries('hipblas')
    hip = C.CDLL(str(hip_paths[0]))
    blas = C.CDLL(str(blas_paths[0]))
    init = bind(hip, 'hipInit', [C.c_uint])
    count_fn = bind(hip, 'hipGetDeviceCount', [C.POINTER(C.c_int)])
    set_device = bind(hip, 'hipSetDevice', [C.c_int])
    get_device = bind(hip, 'hipGetDevice', [C.POINTER(C.c_int)])
    get_name = bind(hip, 'hipDeviceGetName', [C.c_void_p, C.c_int, C.c_int])
    malloc = bind(hip, 'hipMalloc', [C.POINTER(C.c_void_p), C.c_size_t])
    free = bind(hip, 'hipFree', [C.c_void_p])
    copy = bind(hip, 'hipMemcpy', [C.c_void_p, C.c_void_p, C.c_size_t, C.c_int])
    sync = bind(hip, 'hipDeviceSynchronize', [])
    create = bind(blas, 'hipblasCreate', [C.POINTER(C.c_void_p)])
    destroy = bind(blas, 'hipblasDestroy', [C.c_void_p])
    sgemm = bind(blas, 'hipblasSgemm', [C.c_void_p, C.c_int, C.c_int,
        C.c_int, C.c_int, C.c_int, C.POINTER(C.c_float), C.c_void_p,
        C.c_int, C.c_void_p, C.c_int, C.POINTER(C.c_float), C.c_void_p, C.c_int])
    check(init(0))
    count = C.c_int()
    check(count_fn(C.byref(count)))
    index = int(sys.argv[1][4:])
    if not 0 <= index < count.value:
        r['reason'] = 'gpu_device_unavailable'
        raise RuntimeError("device_unavailable")
    check(set_device(index))
    actual = C.c_int(-1)
    check(get_device(C.byref(actual)))
    if actual.value != index:
        r['reason'] = 'gpu_backend_mismatch'
        raise RuntimeError("wrong_device")
    name = C.create_string_buffer(256)
    check(get_name(name, len(name), index))
    r.update(gpu_name=name.value.decode('utf-8', 'replace'),
             device_index=index, device_count=count.value)
    n = 64
    size = n * n * C.sizeof(C.c_float)
    a = (C.c_float * (n * n))(*([2.0] * (n * n)))
    b = (C.c_float * (n * n))(*([3.0] * (n * n)))
    output = (C.c_float * (n * n))()
    for _ in range(3):
        pointer = C.c_void_p()
        check(malloc(C.byref(pointer), size))
        allocations.append(pointer)
    check(copy(allocations[0], a, size, 1))  # hipMemcpyHostToDevice
    check(copy(allocations[1], b, size, 1))
    check(copy(allocations[2], output, size, 1))
    check(create(C.byref(handle)))
    alpha, beta = C.c_float(1.0), C.c_float(0.0)
    # HIPBLAS_OP_N = 111. Constant matrices remove storage-order ambiguity.
    check(sgemm(handle, 111, 111, n, n, n, C.byref(alpha),
                allocations[0], n, allocations[1], n, C.byref(beta), allocations[2], n))
    check(sync())
    check(copy(output, allocations[2], size, 2))  # hipMemcpyDeviceToHost
    math_correct = all(value == 384.0 for value in output)
    if not math_correct:
        r['reason'] = 'gpu_compute_failed'
except ImportError:
    failed = True
    r['reason'] = 'rocm_sdk_not_installed'
except Exception:
    failed = True
    r.setdefault('reason', 'gpu_probe_failed')
finally:
    if handle.value:
        try:
            check(destroy(handle))
        except Exception:
            failed = True
    for pointer in reversed(allocations):
        try:
            check(free(pointer))
        except Exception:
            failed = True
r['gpu_compute_verified'] = math_correct and not failed
if not r['gpu_compute_verified']:
    r.setdefault('reason', 'gpu_probe_failed')
print(json.dumps(r))
'''


CUDA_PROBE_CODE = "import sys; sys.path.insert(0, " + repr(str(Path(__file__).resolve().parent)) + ")\n" + r'''
import ctypes as C
import json
import os
if sys.platform == 'linux':
    parent = int(os.environ.get('DSH_QWEN_CHECK_PARENT', os.getppid()))
    C.CDLL(None).prctl(1, 9, 0, 0, 0)
    if parent == 1 or os.getppid() != parent:
        sys.exit(2)
from native_q8 import preload_backend, NativeQ8Error
r = {'gpu_compute_verified': False, 'backend': 'cuda', 'device': sys.argv[1]}
allocations = []
handle, context = C.c_void_p(), C.c_void_p()
device = C.c_int()
failed, math_correct = False, False

def check(status):
    if status != 0:
        raise RuntimeError('gpu_status_failed')

def bind(lib, name, args):
    fn = getattr(lib, name)
    fn.argtypes, fn.restype = args, C.c_int
    return fn

try:
    driver, blas = preload_backend('cuda')
    init = bind(driver, 'cuInit', [C.c_uint])
    count_fn = bind(driver, 'cuDeviceGetCount', [C.POINTER(C.c_int)])
    device_get = bind(driver, 'cuDeviceGet', [C.POINTER(C.c_int), C.c_int])
    get_name = bind(driver, 'cuDeviceGetName', [C.c_void_p, C.c_int, C.c_int])
    retain = bind(driver, 'cuDevicePrimaryCtxRetain', [C.POINTER(C.c_void_p), C.c_int])
    release = bind(driver, 'cuDevicePrimaryCtxRelease_v2', [C.c_int])
    set_current = bind(driver, 'cuCtxSetCurrent', [C.c_void_p])
    get_device = bind(driver, 'cuCtxGetDevice', [C.POINTER(C.c_int)])
    malloc = bind(driver, 'cuMemAlloc_v2', [C.POINTER(C.c_uint64), C.c_size_t])
    free = bind(driver, 'cuMemFree_v2', [C.c_uint64])
    h2d = bind(driver, 'cuMemcpyHtoD_v2', [C.c_uint64, C.c_void_p, C.c_size_t])
    d2h = bind(driver, 'cuMemcpyDtoH_v2', [C.c_void_p, C.c_uint64, C.c_size_t])
    sync = bind(driver, 'cuCtxSynchronize', [])
    create = bind(blas, 'cublasCreate_v2', [C.POINTER(C.c_void_p)])
    destroy = bind(blas, 'cublasDestroy_v2', [C.c_void_p])
    sgemm = bind(blas, 'cublasSgemm_v2', [C.c_void_p, C.c_int, C.c_int,
        C.c_int, C.c_int, C.c_int, C.POINTER(C.c_float), C.c_void_p,
        C.c_int, C.c_void_p, C.c_int, C.POINTER(C.c_float), C.c_void_p, C.c_int])
    check(init(0))
    count = C.c_int()
    check(count_fn(C.byref(count)))
    index = int(sys.argv[1][4:])
    if not 0 <= index < count.value:
        r['reason'] = 'gpu_device_unavailable'
        raise RuntimeError('unavailable')
    check(device_get(C.byref(device), index))
    check(retain(C.byref(context), device))
    check(set_current(context))
    actual = C.c_int(-1)
    check(get_device(C.byref(actual)))
    if actual.value != device.value:
        r['reason'] = 'gpu_backend_mismatch'
        raise RuntimeError('wrong_device')
    name = C.create_string_buffer(256)
    check(get_name(name, len(name), device))
    r.update(gpu_name=name.value.decode('utf-8', 'replace'), device_index=index, device_count=count.value)
    n = 64
    size = n * n * C.sizeof(C.c_float)
    a = (C.c_float * (n * n))(*([2.0] * (n * n)))
    b = (C.c_float * (n * n))(*([3.0] * (n * n)))
    output = (C.c_float * (n * n))()
    for _ in range(3):
        pointer = C.c_uint64()
        status = malloc(C.byref(pointer), size)
        if pointer.value:
            allocations.append(pointer)
        check(status)
        if not pointer.value:
            raise RuntimeError("invalid_allocation")
    check(h2d(allocations[0], a, size))
    check(h2d(allocations[1], b, size))
    check(h2d(allocations[2], output, size))
    check(create(C.byref(handle)))
    alpha, beta = C.c_float(1.0), C.c_float(0.0)
    check(sgemm(handle, 0, 0, n, n, n, C.byref(alpha),
                C.c_void_p(allocations[0].value), n, C.c_void_p(allocations[1].value), n,
                C.byref(beta), C.c_void_p(allocations[2].value), n))
    check(sync())
    check(d2h(output, allocations[2], size))
    math_correct = all(value == 384.0 for value in output)
    if not math_correct:
        r['reason'] = 'gpu_compute_failed'
except NativeQ8Error:
    failed = True
    r['reason'] = 'cuda_libraries_unavailable'
except Exception:
    failed = True
    r.setdefault('reason', 'gpu_probe_failed')
finally:
    if handle.value:
        try:
            check(destroy(handle))
        except Exception:
            failed = True
    for pointer in reversed(allocations):
        try:
            check(free(pointer))
        except Exception:
            failed = True
    if context.value:
        try:
            check(set_current(None))
        except Exception:
            failed = True
        try:
            check(release(device))
        except Exception:
            failed = True
r['gpu_compute_verified'] = math_correct and not failed
if not r['gpu_compute_verified']:
    r.setdefault('reason', 'gpu_probe_failed')
print(json.dumps(r))
'''


def is_wsl2(system=None, release=None):
    system = platform.system() if system is None else system
    release = platform.release() if release is None else release
    kernel = release.lower()
    return system == 'Linux' and 'microsoft' in kernel and (
        'wsl2' in kernel or 'microsoft-standard' in kernel)


def valid_device(device):
    return isinstance(device, str) and re.fullmatch(r'(?:ROCm|CUDA)(?:0|[1-9][0-9]?)', device) is not None


def gpu_probe(device='ROCm0', runner=None):
    if not valid_device(device):
        return {'gpu_compute_verified': False, 'reason': 'unsupported_device'}
    backend = 'cuda' if device.startswith('CUDA') else 'rocm'
    failure = {'gpu_compute_verified': False, 'reason': 'gpu_probe_failed'}
    try:
        result = (runner or subprocess.run)(
            [sys.executable, '-c', CUDA_PROBE_CODE if backend == 'cuda' else GPU_PROBE_CODE, device], capture_output=True,
            text=True, timeout=40, check=False,
            env={**os.environ, 'DSH_QWEN_CHECK_PARENT': str(os.getpid())})
        if result.returncode != 0 or len(result.stdout) > 16384:
            return failure
        data = json.loads(result.stdout)
        if not isinstance(data, dict) or type(data.get('gpu_compute_verified')) is not bool:
            return failure
        if data.get('backend') != backend or data.get('device') != device:
            return {**failure, 'reason': 'gpu_backend_mismatch'}
        if data.get('gpu_compute_verified') and (
                type(data.get('device_index')) is not int
                or data['device_index'] != int(device[4:])
                or type(data.get('device_count')) is not int
                or not data['device_index'] < data['device_count'] <= 100):
            return {**failure, 'reason': 'gpu_backend_mismatch'}
        # Never forward exception details, external library paths, or arbitrary
        # subprocess fields. Only these diagnostic fields form the public report.
        safe = {'gpu_compute_verified': data['gpu_compute_verified'], 'backend': backend, 'device': device}
        reasons = {'gpu_probe_failed', 'gpu_compute_failed', 'gpu_device_unavailable', 'rocm_sdk_not_installed',
                   'cuda_libraries_unavailable', 'gpu_backend_mismatch'}
        if not safe['gpu_compute_verified']:
            safe['reason'] = data.get('reason') if data.get('reason') in reasons else 'gpu_probe_failed'
        name = data.get('gpu_name')
        if isinstance(name, str) and len(name) <= 256 and name.isprintable():
            safe['gpu_name'] = name
        for key in ('device_index', 'device_count'):
            if type(data.get(key)) is int and 0 <= data[key] <= 100:
                safe[key] = data[key]
        return safe
    except subprocess.TimeoutExpired:
        return {'gpu_compute_verified': False, 'reason': 'gpu_probe_timeout'}
    except (OSError, ValueError, TypeError, AttributeError):
        return failure


def report(check_gpu=False, device='auto'):
    data = {'platform': platform.system(), 'kernel': platform.release(), 'wsl2': is_wsl2(),
            'dxg_present': Path('/dev/dxg').exists(), 'python': sys.version.split()[0],
            'isolated_environment': sys.prefix != sys.base_prefix, 'gpu_probe_run': False}
    try:
        osinfo = platform.freedesktop_os_release()
        data.update(distribution=osinfo.get('ID', ''), distribution_version=osinfo.get('VERSION_ID', ''))
    except (OSError, AttributeError):
        pass
    if check_gpu and device != 'auto' and not valid_device(device):
        data.update(gpu_compute_verified=False, reason='unsupported_device')
    elif check_gpu and data['wsl2'] and data['dxg_present']:
        for candidate in (('CUDA0', 'ROCm0') if device == 'auto' else (device,)):
            for key in ('gpu_name', 'device_index', 'device_count'):
                data.pop(key, None)
            probe = gpu_probe(candidate)
            data.update(probe)
            if probe.get('gpu_compute_verified') is True:
                data.pop('reason', None)
                break
        if device == 'auto' and data.get('gpu_compute_verified') is not True:
            data.update(reason='gpu_runtime_unavailable', backend=None, device=None)
            for key in ('gpu_name', 'device_index', 'device_count'):
                data.pop(key, None)
        data['gpu_probe_run'] = True
    elif check_gpu:
        data.update(gpu_compute_verified=False, reason='wsl2_gpu_bridge_required')
    return data


NATIVE_PROBE_CODE = r'''
import ctypes as C
import json
import os
import sys
if sys.platform == 'linux':
    parent = int(os.environ.get('DSH_QWEN_CHECK_PARENT', os.getppid()))
    C.CDLL(None).prctl(1, 9, 0, 0, 0)
    if parent == 1 or os.getppid() != parent:
        sys.exit(2)
sys.path.insert(0, sys.argv[2])
try:
    import native_q8 as native
    native.preload_backend(sys.argv[3])
    library = C.CDLL(sys.argv[1])
    native._signature(library, 'qt_version', C.c_char_p)
    if library.qt_version() != native.NATIVE_VERSION:
        raise ValueError()
    native._bind(library)
    params = native.QtInitParams()
    library.qt_init_default_params(C.byref(params))
    if params.abi_version != native.ABI_VERSION:
        raise ValueError()
    # Deliberately never qt_init/qt_extract_voice_ref/model loading.
    print(json.dumps({'native_ok': True}))
except Exception:
    print(json.dumps({'native_ok': False}))
'''


def native_probe(library, runner=None, backend='rocm'):
    if backend not in ('cuda', 'rocm'):
        return False
    try:
        if not Path(library).is_absolute() or not Path(library).is_file():
            return False
        result = (runner or subprocess.run)(
            [sys.executable, '-c', NATIVE_PROBE_CODE, str(library), str(Path(__file__).resolve().parent), backend],
            capture_output=True, text=True, timeout=20, check=False,
            env={**os.environ, 'DSH_QWEN_CHECK_PARENT': str(os.getpid())})
        if result.returncode != 0 or len(result.stdout) > 4096:
            return False
        data = json.loads(result.stdout)
        return isinstance(data, dict) and set(data) == {'native_ok'} and data['native_ok'] is True
    except (OSError, ValueError, TypeError, AttributeError, subprocess.TimeoutExpired):
        return False


MODEL_ROLES = {
    'qwen-talker-1.7b-base-Q8_0.gguf': 'talker',
    'qwen-tokenizer-12hz-Q8_0.gguf': 'codec',
}


def model_check(directory, progress=None, manifest=None):
    """Hash the pinned files read-only; percentage represents bytes actually read."""
    if manifest is None:
        if __package__:
            from .native_q8 import MODEL_SHA256
        else:
            from native_q8 import MODEL_SHA256
        manifest = MODEL_SHA256
    try:
        root = Path(directory)
        if not root.is_absolute() or not root.is_dir():
            return False, 'models_unavailable'
        paths = [(root / name, expected) for name, expected in manifest.items()]
        sizes = []
        for path, _ in paths:
            if not path.is_file():
                role = MODEL_ROLES.get(path.name)
                return False, 'missing_' + role if role else 'models_unavailable'
            sizes.append(path.stat().st_size)
        total = sum(sizes)
        if not sizes or min(sizes) <= 0:
            return False, 'models_unavailable'
        done, last = 0, -1
        def emit(value):
            nonlocal last
            if progress is not None and value != last:
                progress(value)
            last = value
        emit(0)
        for (path, expected), size in zip(paths, sizes):
            digest, read = hashlib.sha256(), 0
            with path.open('rb') as source:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    read += len(chunk)
                    if read > size:
                        return False, 'models_changed'
                    digest.update(chunk)
                    done += len(chunk)
                    emit(min(100, done * 100 // total))
                if read != size or os.fstat(source.fileno()).st_size != size:
                    return False, 'models_changed'
            if digest.hexdigest() != expected:
                role = MODEL_ROLES.get(path.name)
                return False, 'hash_mismatch_' + role if role else 'models_hash_mismatch'
        return True, None
    except (OSError, ValueError, TypeError):
        return False, 'models_unavailable'


def config_check(models, native_lib, progress=None, device='auto'):
    # Always verify genuine math; a device node or successful HTTP health is not readiness.
    environment = report(check_gpu=True, device=device)
    environment_ok = environment.get('wsl2') is True and environment.get('gpu_compute_verified') is True
    selected = environment.get('device')
    selection_ok = (valid_device(selected)
                    and environment.get('backend') == ('cuda' if selected.startswith('CUDA') else 'rocm')
                    and (device == 'auto' or device == selected))
    reasons = {'wsl2_gpu_bridge_required', 'rocm_sdk_not_installed', 'gpu_probe_timeout',
               'gpu_probe_failed', 'gpu_compute_failed', 'gpu_device_unavailable',
               'unsupported_device', 'cuda_libraries_unavailable', 'gpu_backend_mismatch', 'gpu_runtime_unavailable'}
    error = None if environment_ok else environment.get('reason')
    if environment_ok and not selection_ok:
        environment_ok, error = False, 'gpu_backend_mismatch'
    if not environment_ok and error not in reasons:
        error = 'environment_unavailable'
    if environment_ok and not native_probe(native_lib, backend=environment.get('backend')):
        environment_ok, error = False, 'native_unavailable'
    models_ok, model_error = model_check(models, progress)
    name = environment.get('gpu_name')
    if not isinstance(name, str) or len(name) > 256 or not name.isprintable():
        name = None
    return {'kind': 'result', 'environment_ok': environment_ok, 'models_ok': models_ok,
            'gpu_name': name, 'error_code': error or model_error,
            'backend': environment.get('backend') if environment_ok else None,
            'device': environment.get('device') if environment_ok else None}


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's default error includes arbitrary offending arguments/paths.
        print(json.dumps({'kind': 'result', 'environment_ok': False, 'models_ok': False,
                          'gpu_name': None, 'error_code': 'invalid_config'}), flush=True)
        raise SystemExit(2)


def main(argv=None):
    parser = SafeArgumentParser(description=__doc__)
    parser.add_argument('--gpu', action='store_true', help='verify actual 64x64 CUDA/cuBLAS or HIP/hipBLAS SGEMM')
    parser.add_argument('--device', default='auto', help='auto, CUDA0..99 or ROCm0..99; no CPU fallback')
    parser.add_argument('--models', help='absolute local pinned Q8 model directory')
    parser.add_argument('--native-lib', help='absolute local pinned native Q8 library')
    parser.add_argument('--progress', action='store_true', help='emit bounded JSONL hash progress and final result')
    args = parser.parse_args(argv)
    if args.models is not None or args.native_lib is not None or args.progress:
        if not args.models or not args.native_lib or (args.device != 'auto' and not valid_device(args.device)):
            print(json.dumps({'kind': 'result', 'environment_ok': False, 'models_ok': False,
                              'gpu_name': None, 'error_code': 'invalid_config'}), flush=True)
            return 2
        def progress(value):
            print(json.dumps({'kind': 'progress', 'progress': value}), flush=True)
        try:
            result = config_check(args.models, args.native_lib, progress if args.progress else None, device=args.device)
        except Exception:
            # Import/filesystem/SDK details never escape the JSONL wire.
            result = {'kind': 'result', 'environment_ok': False, 'models_ok': False,
                      'gpu_name': None, 'error_code': 'check_failed'}
        print(json.dumps(result, ensure_ascii=True), flush=True)
        return 0 if result['environment_ok'] and result['models_ok'] else 2
    if args.device != 'auto' and not valid_device(args.device):
        parser.error('device must be auto, CUDA0..99 or ROCm0..99')
    result = report(args.gpu, args.device)
    print(json.dumps(result, ensure_ascii=True))
    return 0 if result['wsl2'] and (not args.gpu or result.get('gpu_compute_verified')) else 2


if __name__ == '__main__':
    raise SystemExit(main())
