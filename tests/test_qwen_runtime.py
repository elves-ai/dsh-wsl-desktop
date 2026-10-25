"""Read-only runtime regressions. No installed SDK or GPU required."""
import contextlib
import ctypes
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

P = Path(__file__).resolve().parents[1] / 'services/qwen_tts/runtime_check.py'
spec = importlib.util.spec_from_file_location('qwen_runtime_under_test', P)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeTests(unittest.TestCase):
    def test_wsl2_current_and_older_kernels(self):
        for kernel in ['6.18.54.1-microsoft-standard-WSL2', '5.15.153.1-microsoft-standard-WSL2', '4.19.104-microsoft-standard']:
            self.assertTrue(runtime.is_wsl2('Linux', kernel))

    def test_other_platforms_and_wsl1_rejected(self):
        for system, kernel in [('Windows', '10'), ('Darwin', '25'), ('Linux', '6.8.0-generic'), ('Linux', '4.4.0-19041-Microsoft')]:
            self.assertFalse(runtime.is_wsl2(system, kernel))

    def test_gpu_is_actual_subprocess_probe_not_dxg_assumption(self):
        runner = mock.Mock(return_value=SimpleNamespace(returncode=0, stdout=json.dumps({'gpu_compute_verified': True, 'backend': 'rocm', 'device': 'ROCm1', 'device_index': 1, 'device_count': 2})))
        self.assertTrue(runtime.gpu_probe('ROCm1', runner)['gpu_compute_verified'])
        argv = runner.call_args.args[0]
        self.assertEqual(argv[0], sys.executable)
        self.assertEqual(argv[-1], 'ROCm1')
        self.assertEqual(argv[2], runtime.GPU_PROBE_CODE)
        self.assertEqual(runner.call_args.kwargs['timeout'], 40)
        self.assertTrue(runner.call_args.kwargs['capture_output'])
        self.assertFalse(runner.call_args.kwargs['check'])

    def test_real_math_probe_code_uses_correct_sdk_aliases_and_full_readback(self):
        code = runtime.GPU_PROBE_CODE
        compile(code, '<probe>', 'exec')
        self.assertIn("preload_shortnames=['amdhip64', 'hipblas']", code)
        self.assertIn("find_libraries('hipblas')", code)
        self.assertNotIn("find_libraries('rocblas')", code)
        for api in ['hipInit', 'hipGetDeviceCount', 'hipSetDevice', 'hipGetDevice', 'hipDeviceGetName', 'hipblasSgemm', 'hipDeviceSynchronize', 'hipMemcpy', 'hipFree', 'hipblasDestroy']:
            self.assertIn(api, code)
        self.assertIn('n = 64', code)
        self.assertIn('[2.0] * (n * n)', code)
        self.assertIn('[3.0] * (n * n)', code)
        self.assertIn('check(sgemm(handle, 111, 111', code)
        self.assertIn('check(copy(output, allocations[2], size, 2))', code)
        self.assertIn('all(value == 384.0 for value in output)', code)
        self.assertIn("math_correct and not failed", code)
        self.assertGreater(code.index("r['gpu_compute_verified'] ="), code.index('check(free(pointer))'))
        self.assertNotIn('import torch', code)
        self.assertNotIn('Vulkan', code)
        self.assertNotIn('/dev/kfd', code)

    def test_cpu_runtime_report_is_not_gpu_ready(self):
        runner = lambda *a, **k: SimpleNamespace(returncode=0, stdout='{"gpu_compute_verified":true,"backend":"cpu"}')
        self.assertFalse(runtime.gpu_probe(runner=runner)['gpu_compute_verified'])

    def test_gpu_timeout_and_invalid_output_are_fail_closed(self):
        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired(args[0], 40)
        self.assertEqual(runtime.gpu_probe(runner=timeout)['reason'], 'gpu_probe_timeout')
        for value in ['bad', '[]', '{"gpu_compute_verified":1}', '{"gpu_compute_verified":true}', 'A' * 20000]:
            out = runtime.gpu_probe(runner=lambda *a, **k: SimpleNamespace(returncode=0, stdout=value))
            self.assertFalse(out['gpu_compute_verified'])
        out = runtime.gpu_probe(runner=lambda *a, **k: SimpleNamespace(returncode=1, stdout='{"gpu_compute_verified":true,"backend":"rocm"}'))
        self.assertFalse(out['gpu_compute_verified'])
        out = runtime.gpu_probe(runner=mock.Mock(side_effect=OSError('/private/path')))
        self.assertEqual(out['reason'], 'gpu_probe_failed')

    def test_subprocess_private_diagnostics_are_not_forwarded(self):
        data = {'gpu_compute_verified': False, 'backend': 'rocm', 'device': 'ROCm0', 'reason': '/private/library/model text', 'traceback': 'private'}
        out = runtime.gpu_probe(runner=lambda *a, **k: SimpleNamespace(returncode=0, stdout=json.dumps(data)))
        self.assertEqual(out, {'gpu_compute_verified': False, 'backend': 'rocm', 'device': 'ROCm0', 'reason': 'gpu_probe_failed'})

    def test_reject_non_gpu_devices_without_subprocess(self):
        runner = mock.Mock()
        for device in ['cpu', 'mps', 'meta', 'cuda', 'cuda:0', 'ROCm', 'ROCm100', 'ROCm-1', 'ROCm00', 'ROCm01', 'ROCm0 extra', 'ROCm0\n', None]:
            self.assertFalse(runtime.gpu_probe(device, runner)['gpu_compute_verified'])
        runner.assert_not_called()
        for device in ['ROCm0', 'ROCm1', 'ROCm99']:
            self.assertTrue(runtime.valid_device(device))

    def test_non_wsl_does_not_touch_gpu(self):
        with mock.patch.object(runtime, 'is_wsl2', return_value=False), mock.patch.object(runtime, 'gpu_probe') as probe:
            out = runtime.report(True)
            self.assertFalse(out['gpu_compute_verified'])
            self.assertFalse(out['gpu_probe_run'])
            probe.assert_not_called()

    def test_wsl_with_no_gpu_bridge_does_not_claim_ready(self):
        with mock.patch.object(runtime, 'is_wsl2', return_value=True), mock.patch.object(runtime.Path, 'exists', return_value=False), mock.patch.object(runtime, 'gpu_probe') as probe:
            self.assertFalse(runtime.report(True)['gpu_compute_verified'])
            probe.assert_not_called()

    def test_wsl_gpu_report_probes_selected_device(self):
        with mock.patch.object(runtime, 'is_wsl2', return_value=True), mock.patch.object(runtime.Path, 'exists', return_value=True), mock.patch.object(runtime, 'gpu_probe', return_value={'gpu_compute_verified': True}) as probe:
            out = runtime.report(True, 'ROCm2')
            self.assertTrue(out['gpu_probe_run'])
            self.assertTrue(out['gpu_compute_verified'])
            probe.assert_called_once_with('ROCm2')

    def test_auto_uses_cuda_first_and_only_falls_back_to_verified_rocm(self):
        for success in ('CUDA0', 'ROCm0', None):
            calls = []
            def probe(device):
                calls.append(device)
                backend = 'cuda' if device.startswith('CUDA') else 'rocm'
                return {'gpu_compute_verified': device == success, 'backend': backend, 'device': device,
                        'reason': 'cuda_libraries_unavailable' if backend == 'cuda' else 'rocm_sdk_not_installed'}
            with self.subTest(success=success), mock.patch.object(runtime, 'is_wsl2', return_value=True), \
                    mock.patch.object(runtime.Path, 'exists', return_value=True), \
                    mock.patch.object(runtime, 'gpu_probe', side_effect=probe):
                result = runtime.report(check_gpu=True)
            self.assertEqual(calls, ['CUDA0'] if success == 'CUDA0' else ['CUDA0', 'ROCm0'])
            self.assertIs(result['gpu_compute_verified'], success is not None)
            if success:
                self.assertEqual(result['device'], success)
                self.assertNotIn('reason', result)
            else:
                self.assertEqual(result['reason'], 'gpu_runtime_unavailable')
                self.assertIsNone(result['backend'])
                self.assertIsNone(result['device'])

    def test_auto_does_not_retain_diagnostics_from_failed_backend(self):
        for rocm_success in (True, False):
            probes = [
                {'gpu_compute_verified': False, 'backend': 'cuda', 'device': 'CUDA0',
                 'gpu_name': 'failed CUDA', 'device_index': 9, 'device_count': 10},
                {'gpu_compute_verified': rocm_success, 'backend': 'rocm', 'device': 'ROCm0'},
            ]
            if not rocm_success:
                probes[1].update(gpu_name='failed ROCm', device_index=0, device_count=1)
            with self.subTest(rocm_success=rocm_success), mock.patch.object(runtime, 'is_wsl2', return_value=True), \
                    mock.patch.object(runtime.Path, 'exists', return_value=True), \
                    mock.patch.object(runtime, 'gpu_probe', side_effect=probes):
                result = runtime.report(check_gpu=True)
            for key in ('gpu_name', 'device_index', 'device_count'):
                self.assertNotIn(key, result)
            self.assertIs(result['gpu_compute_verified'], rocm_success)

    def test_explicit_cuda_and_rocm_never_fall_back(self):
        for device in ('CUDA0', 'CUDA99', 'ROCm0', 'ROCm99'):
            self.assertTrue(runtime.valid_device(device))
            with mock.patch.object(runtime, 'is_wsl2', return_value=True), \
                    mock.patch.object(runtime.Path, 'exists', return_value=True), \
                    mock.patch.object(runtime, 'gpu_probe', return_value={'gpu_compute_verified': False}) as probe:
                self.assertFalse(runtime.report(True, device)['gpu_compute_verified'])
                probe.assert_called_once_with(device)

    def test_subprocess_requires_exact_backend_device_and_index(self):
        good = {'gpu_compute_verified': True, 'backend': 'cuda', 'device': 'CUDA7', 'device_index': 7, 'device_count': 8}
        runner = mock.Mock(return_value=SimpleNamespace(returncode=0, stdout=json.dumps(good)))
        self.assertTrue(runtime.gpu_probe('CUDA7', runner)['gpu_compute_verified'])
        self.assertEqual(runner.call_args.args[0][2], runtime.CUDA_PROBE_CODE)
        for changed in ({'backend': 'rocm'}, {'backend': 'cpu'}, {'device': 'CUDA0'},
                        {'device_index': 0}, {'device': None}, {'device_index': None},
                        {'device_count': None}, {'device_count': True}, {'device_count': 0},
                        {'device_count': 7}, {'device_count': 101}):
            runner.return_value.stdout = json.dumps({**good, **changed})
            result = runtime.gpu_probe('CUDA7', runner)
            self.assertFalse(result['gpu_compute_verified'])
            self.assertEqual(result['reason'], 'gpu_backend_mismatch')
        runner.side_effect = subprocess.TimeoutExpired('/private/command', 40, stderr='PRIVATE')
        self.assertEqual(runtime.gpu_probe('CUDA7', runner)['reason'], 'gpu_probe_timeout')

    def simulated_cuda_probe(self, failure=None, wrong_math=False, wrong_device=False):
        # Pure Python ctypes simulation: NOT evidence of NVIDIA hardware execution.
        calls, memory = [], {}
        driver, blas = SimpleNamespace(), SimpleNamespace()
        def api(name, action=lambda *args: None):
            def invoke(*args):
                calls.append(name)
                if name == failure:
                    return 1
                action(*args)
                if name == 'malloc' and failure == 'malloc_partial':
                    return 1
                return 0
            return mock.Mock(side_effect=invoke)
        driver.cuInit = api('init')
        driver.cuDeviceGetCount = api('count', lambda out: setattr(out._obj, 'value', 100))
        driver.cuDeviceGet = api('device', lambda out, index: setattr(out._obj, 'value', index))
        driver.cuDeviceGetName = api('name', lambda out, size, device: setattr(out, 'value', b'SIMULATED NVIDIA'))
        driver.cuDevicePrimaryCtxRetain = api('retain', lambda out, device: setattr(out._obj, 'value', 42))
        driver.cuDevicePrimaryCtxRelease_v2 = api('release')
        driver.cuCtxSetCurrent = api('set_current')
        driver.cuCtxGetDevice = api('get_device', lambda out: setattr(out._obj, 'value', 0 if wrong_device else 7))
        def malloc(out, size):
            address = len(memory) + 1
            memory[address] = ctypes.create_string_buffer(size)
            out._obj.value = address
        driver.cuMemAlloc_v2 = api('malloc', malloc)
        driver.cuMemFree_v2 = api('free')
        driver.cuMemcpyHtoD_v2 = api('h2d', lambda dst, src, size: ctypes.memmove(memory[dst.value], src, size))
        driver.cuMemcpyDtoH_v2 = api('d2h', lambda dst, src, size: ctypes.memmove(dst, memory[src.value], size))
        driver.cuCtxSynchronize = api('sync')
        blas.cublasCreate_v2 = api('create', lambda out: setattr(out._obj, 'value', 43))
        blas.cublasDestroy_v2 = api('destroy')
        def gemm(handle, op_a, op_b, m, n, k, alpha, a, lda, b, ldb, beta, c, ldc):
            self.assertEqual((op_a, op_b, m, n, k, lda, ldb, ldc), (0, 0, 64, 64, 64, 64, 64, 64))
            floats = ctypes.c_float * (64 * 64)
            self.assertEqual(set(floats.from_buffer(memory[a.value])), {2.0})
            self.assertEqual(set(floats.from_buffer(memory[b.value])), {3.0})
            output = floats.from_buffer(memory[c.value])
            for index in range(len(output)):
                output[index] = 384.0
            if wrong_math:
                output[-1] = 0.0
        blas.cublasSgemm_v2 = api('gemm', gemm)
        native = SimpleNamespace(preload_backend=mock.Mock(return_value=(driver, blas)), NativeQ8Error=type('SimulatedNativeError', (Exception,), {}))
        output = io.StringIO()
        with mock.patch.dict(sys.modules, {'native_q8': native}), \
                mock.patch.object(sys, 'platform', 'win32'), \
                mock.patch.object(sys, 'argv', ['probe', 'CUDA7']), \
                mock.patch.object(sys, 'path', list(sys.path)), contextlib.redirect_stdout(output):
            exec(runtime.CUDA_PROBE_CODE, {})
        native.preload_backend.assert_called_once_with('cuda')
        return json.loads(output.getvalue()), calls

    def test_cuda_driver_sgemm_full_readback_and_cleanup_simulation(self):
        result, calls = self.simulated_cuda_probe()
        self.assertTrue(result['gpu_compute_verified'])
        self.assertEqual((result['backend'], result['device']), ('cuda', 'CUDA7'))
        self.assertEqual(calls[-6:], ['destroy', 'free', 'free', 'free', 'set_current', 'release'])
        result, calls = self.simulated_cuda_probe(wrong_math=True)
        self.assertFalse(result['gpu_compute_verified'])
        self.assertEqual(result['reason'], 'gpu_compute_failed')
        self.assertEqual(calls.count('free'), 3)
        result, calls = self.simulated_cuda_probe(wrong_device=True)
        self.assertFalse(result['gpu_compute_verified'])
        self.assertEqual(result['reason'], 'gpu_backend_mismatch')
        self.assertNotIn('gemm', calls)
        self.assertEqual(calls[-1], 'release')
        result, calls = self.simulated_cuda_probe(failure='malloc_partial')
        self.assertFalse(result['gpu_compute_verified'])
        self.assertEqual(calls.count('free'), 1)
        self.assertEqual(calls[-1], 'release')

    def test_cuda_status_and_cleanup_failures_fail_closed_simulation(self):
        for stage in ('init', 'count', 'device', 'retain', 'set_current', 'get_device', 'name',
                      'malloc', 'h2d', 'create', 'gemm', 'sync', 'd2h', 'destroy', 'free', 'release'):
            with self.subTest(stage=stage):
                result, calls = self.simulated_cuda_probe(failure=stage)
                self.assertFalse(result['gpu_compute_verified'])
                self.assertNotIn('PRIVATE', json.dumps(result))
                if stage in ('destroy', 'free', 'release'):
                    self.assertEqual(calls.count('free'), 3)
                    self.assertIn('release', calls)

    def test_basic_report_never_imports_gpu_backend(self):
        with mock.patch.object(runtime, 'gpu_probe') as probe:
            self.assertFalse(runtime.report(False)['gpu_probe_run'])
            probe.assert_not_called()

    def test_cli_default_device_and_non_wsl_exit(self):
        with mock.patch.object(runtime, 'report', return_value={'wsl2': False, 'gpu_compute_verified': False}) as report, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(runtime.main(['--gpu']), 2)
            report.assert_called_once_with(True, 'auto')
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            runtime.main(['--device', 'cpu'])
        self.assertEqual(caught.exception.code, 2)


class ConfigCheckTests(unittest.TestCase):
    def test_model_progress_is_monotonic_actual_hashed_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            contents = {'talker.gguf': b'a' * (2 * 1024 * 1024), 'codec.gguf': b'b' * (1024 * 1024)}
            manifest = {}
            for name, data in contents.items():
                (Path(directory) / name).write_bytes(data)
                manifest[name] = hashlib.sha256(data).hexdigest()
            progress = []
            self.assertEqual(runtime.model_check(directory, progress.append, manifest), (True, None))
            self.assertEqual(progress, [0, 33, 66, 100])
            (Path(directory) / 'codec.gguf').write_bytes(b'corrupted')
            self.assertEqual(runtime.model_check(directory, manifest=manifest), (False, 'models_hash_mismatch'))
            (Path(directory) / 'codec.gguf').unlink()
            self.assertEqual(runtime.model_check(directory, manifest=manifest), (False, 'models_unavailable'))
        self.assertEqual(runtime.model_check('relative', manifest={}), (False, 'models_unavailable'))

    def test_known_model_missing_and_hash_errors_use_static_role_codes(self):
        for name, role in runtime.MODEL_ROLES.items():
            with self.subTest(role=role), tempfile.TemporaryDirectory() as directory:
                expected = hashlib.sha256(b'expected').hexdigest()
                manifest = {name: expected}
                self.assertEqual(runtime.model_check(directory, manifest=manifest), (False, 'missing_' + role))
                path = Path(directory) / name
                path.write_bytes(b'corrupted')
                self.assertEqual(runtime.model_check(directory, manifest=manifest), (False, 'hash_mismatch_' + role))
                path.write_bytes(b'expected')
                self.assertEqual(runtime.model_check(directory, manifest=manifest), (True, None))
                with mock.patch.object(runtime.Path, 'open', side_effect=PermissionError('/private/model')):
                    self.assertEqual(runtime.model_check(directory, manifest=manifest), (False, 'models_unavailable'))

    def test_native_probe_checks_exact_version_and_abi_without_model_init(self):
        compile(runtime.NATIVE_PROBE_CODE, '<native probe>', 'exec')
        self.assertIn('library.qt_version() != native.NATIVE_VERSION', runtime.NATIVE_PROBE_CODE)
        self.assertIn('params.abi_version != native.ABI_VERSION', runtime.NATIVE_PROBE_CODE)
        self.assertIn('native._bind(library)', runtime.NATIVE_PROBE_CODE)
        self.assertNotIn('library.qt_init(', runtime.NATIVE_PROBE_CODE)
        self.assertNotIn('library.qt_extract_voice_ref(', runtime.NATIVE_PROBE_CODE)
        self.assertIn('prctl(1, 9', runtime.GPU_PROBE_CODE)
        self.assertIn('prctl(1, 9', runtime.NATIVE_PROBE_CODE)
        runner = mock.Mock(return_value=SimpleNamespace(returncode=0, stdout='{"native_ok":true}'))
        self.assertTrue(runtime.native_probe(P, runner))
        self.assertEqual(runner.call_args.args[0][:3], [sys.executable, '-c', runtime.NATIVE_PROBE_CODE])
        for output in ['{"native_ok":false}', '{"native_ok":1}', '{"native_ok":true,"private":"/secret"}', 'bad']:
            runner.return_value = SimpleNamespace(returncode=0, stdout=output)
            self.assertFalse(runtime.native_probe(P, runner))
        runner.side_effect = subprocess.TimeoutExpired('native', 20)
        self.assertFalse(runtime.native_probe(P, runner))

    def test_native_revision_and_abi_mismatch_are_safe_without_initializing_model(self):
        for wrong_version, wrong_abi, backend in [(v, a, b) for v, a in [(True, False), (False, True), (False, False)] for b in ('cuda', 'rocm')]:
            with self.subTest(version=wrong_version, abi=wrong_abi, backend=backend):
                library = mock.Mock()
                library.qt_version.return_value = b'wrong' if wrong_version else b'pinned'
                def defaults(pointer):
                    pointer._obj.abi_version = 5 if wrong_abi else 6
                library.qt_init_default_params.side_effect = defaults
                class Params(ctypes.Structure):
                    _fields_ = [('abi_version', ctypes.c_int)]
                native = SimpleNamespace(NATIVE_VERSION=b'pinned', ABI_VERSION=6,
                                         _signature=mock.Mock(), _bind=mock.Mock(), QtInitParams=Params, preload_backend=mock.Mock())
                sdk = SimpleNamespace(initialize_process=mock.Mock())
                output = io.StringIO()
                with mock.patch.dict(sys.modules, {'native_q8': native, 'rocm_sdk': sdk}), \
                        mock.patch.object(ctypes, 'CDLL', return_value=library), \
                        mock.patch.object(sys, 'platform', 'win32'), \
                        mock.patch.object(sys, 'argv', ['probe', '/private/native.so', '/private/source', backend]), \
                        mock.patch.object(sys, 'path', list(sys.path)), contextlib.redirect_stdout(output):
                    exec(runtime.NATIVE_PROBE_CODE, {})
                self.assertEqual(json.loads(output.getvalue()), {'native_ok': not (wrong_version or wrong_abi)})
                native.preload_backend.assert_called_once_with(backend)
                library.qt_init.assert_not_called()
                library.qt_extract_voice_ref.assert_not_called()
                self.assertNotIn('/private', output.getvalue())

    def test_config_requires_actual_gpu_and_native_revision_and_model_hashes(self):
        good = {'wsl2': True, 'gpu_compute_verified': True, 'gpu_name': 'AMD GPU', 'backend': 'rocm', 'device': 'ROCm0'}
        with mock.patch.object(runtime, 'report', return_value=good) as report, \
                mock.patch.object(runtime, 'native_probe', return_value=True), \
                mock.patch.object(runtime, 'model_check', return_value=(True, None)):
            self.assertEqual(runtime.config_check('/models', '/lib'), {
                'kind': 'result', 'environment_ok': True, 'models_ok': True,
                'gpu_name': 'AMD GPU', 'error_code': None, 'backend': 'rocm', 'device': 'ROCm0'})
            report.assert_called_once_with(check_gpu=True, device='auto')
        with mock.patch.object(runtime, 'report', return_value=good), \
                mock.patch.object(runtime, 'native_probe', return_value=False), \
                mock.patch.object(runtime, 'model_check', return_value=(True, None)):
            result = runtime.config_check('/models', '/wrong-revision')
            self.assertFalse(result['environment_ok'])
            self.assertEqual(result['error_code'], 'native_unavailable')
        with mock.patch.object(runtime, 'report', return_value={'wsl2': True, 'gpu_compute_verified': False, 'reason': '/private/source'}), \
                mock.patch.object(runtime, 'native_probe') as native, \
                mock.patch.object(runtime, 'model_check', return_value=(False, 'models_hash_mismatch')):
            result = runtime.config_check('/models', '/lib')
            self.assertEqual(result['error_code'], 'environment_unavailable')
            self.assertFalse(result['environment_ok'])
            self.assertFalse(result['models_ok'])
            native.assert_not_called()
            self.assertNotIn('/private', json.dumps(result))

    def test_config_rejects_cpu_wrong_backend_or_wrong_explicit_device(self):
        for backend, selected in (('cpu', 'CPU'), ('rocm', 'CUDA0'), ('cuda', 'CUDA1'), ('cuda', None)):
            environment = {'wsl2': True, 'gpu_compute_verified': True, 'backend': backend, 'device': selected}
            with self.subTest(backend=backend, device=selected), mock.patch.object(runtime, 'report', return_value=environment), \
                    mock.patch.object(runtime, 'native_probe') as native, \
                    mock.patch.object(runtime, 'model_check', return_value=(True, None)):
                result = runtime.config_check('/models', '/lib', device='CUDA0')
            self.assertFalse(result['environment_ok'])
            self.assertEqual(result['error_code'], 'gpu_backend_mismatch')
            self.assertIsNone(result['backend'])
            self.assertIsNone(result['device'])
            native.assert_not_called()

    def test_cuda_config_and_native_probe_use_resolved_backend_without_models(self):
        good = {'wsl2': True, 'gpu_compute_verified': True, 'gpu_name': 'SIMULATED NVIDIA',
                'backend': 'cuda', 'device': 'CUDA7'}
        with mock.patch.object(runtime, 'report', return_value=good) as report, \
                mock.patch.object(runtime, 'native_probe', return_value=True) as native, \
                mock.patch.object(runtime, 'model_check', return_value=(True, None)):
            result = runtime.config_check('/models', '/lib', device='CUDA7')
        report.assert_called_once_with(check_gpu=True, device='CUDA7')
        native.assert_called_once_with('/lib', backend='cuda')
        self.assertEqual((result['backend'], result['device']), ('cuda', 'CUDA7'))
        runner = mock.Mock(return_value=SimpleNamespace(returncode=0, stdout='{"native_ok":true}'))
        self.assertTrue(runtime.native_probe(P, runner, backend='cuda'))
        self.assertEqual(runner.call_args.args[0][-1], 'cuda')
        runner.reset_mock()
        self.assertFalse(runtime.native_probe(P, runner, backend='cpu'))
        runner.assert_not_called()

    def test_jsonl_cli_has_exact_progress_result_schema_and_safe_failures(self):
        def check(models, native, progress, device):
            self.assertEqual(device, 'auto')
            self.assertEqual((models, native), ('/models', '/lib'))
            progress(0)
            progress(49)
            progress(100)
            return {'kind': 'result', 'environment_ok': True, 'models_ok': True,
                    'gpu_name': 'GPU', 'error_code': None}
        output = io.StringIO()
        with mock.patch.object(runtime, 'config_check', side_effect=check), contextlib.redirect_stdout(output):
            self.assertEqual(runtime.main(['--models', '/models', '--native-lib', '/lib', '--progress']), 0)
        lines = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(lines[:3], [{'kind': 'progress', 'progress': value} for value in (0, 49, 100)])
        self.assertEqual(set(lines[-1]), {'kind', 'environment_ok', 'models_ok', 'gpu_name', 'error_code'})
        for args in [['--progress'], ['--models', '/private/source'],
                     ['--models', '/models', '--native-lib', '/lib', '--device', 'CPU']]:
            output = io.StringIO()
            with mock.patch.object(runtime, 'config_check') as check, contextlib.redirect_stdout(output):
                self.assertEqual(runtime.main(args), 2)
                check.assert_not_called()
            self.assertEqual(json.loads(output.getvalue())['error_code'], 'invalid_config')
            self.assertNotIn('/private', output.getvalue())
        output = io.StringIO()
        with mock.patch.object(runtime, 'config_check', side_effect=RuntimeError('/private/source/path')), contextlib.redirect_stdout(output):
            self.assertEqual(runtime.main(['--models', '/models', '--native-lib', '/lib', '--progress']), 2)
        self.assertEqual(json.loads(output.getvalue())['error_code'], 'check_failed')
        self.assertNotIn('/private', output.getvalue())
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as caught:
            runtime.main(['--private-unknown', '/private/source'])
        self.assertEqual(caught.exception.code, 2)
        self.assertEqual(json.loads(output.getvalue())['error_code'], 'invalid_config')
        self.assertNotIn('/private', output.getvalue())


if __name__ == '__main__':
    unittest.main()
