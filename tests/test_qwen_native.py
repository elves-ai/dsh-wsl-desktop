"""Offline ctypes ABI tests: no native library, SDK, model or GPU is loaded.

Run: python3 -B -m unittest discover -s tests -p test_qwen_native.py -v
"""
import contextlib
import ctypes as C
import ctypes.util
import gc
import hashlib
import io
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch
import wave
import weakref

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.qwen_tts import native_q8 as native


def wav_bytes(frames=201601, rate=24000, channels=1, width=2):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(width)
        wav.setframerate(rate)
        wav.writeframes((b"\x00\x20" * frames * channels * width)[:frames * channels * width])
    return output.getvalue()


class FakeFunction:
    """Safe Python callable with ctypes' signature attributes, no machine code.

    Enforce declarations and normalize pointer arguments just as ctypes would.
    Tests never cast arbitrary addresses or allocate native-owned resources.
    """
    def __init__(self, owner, name, implementation):
        self.owner, self.name, self.implementation = owner, name, implementation
        self.argtypes = self.restype = "UNBOUND"

    def __call__(self, *args):
        assert self.argtypes != "UNBOUND", self.name
        assert self.restype != "UNBOUND", self.name
        assert len(args) == len(self.argtypes), self.name
        converted = []
        for value, kind in zip(args, self.argtypes):
            if isinstance(kind, type) and issubclass(kind, C._Pointer):
                converted.append(C.cast(value, kind))
            elif kind is C.c_void_p:
                assert value is None or isinstance(value, (int, C.c_void_p)), self.name
                converted.append(value)
            elif isinstance(kind, type) and issubclass(kind, C._CFuncPtr):
                assert isinstance(value, kind), self.name
                converted.append(value)
            else:
                converted.append(value)
        self.owner.calls.append(self.name)
        return self.implementation(*converted)


class FakeCABI:
    def __init__(self):
        self.calls = []
        self.version = native.NATIVE_VERSION
        self.abi = 6
        self.backend = b"ROCm0"
        self.backend_line = None
        self.model_type = b"base"
        self.codebooks = 16
        self.init_result = 0x1234
        self.extract_result = 0
        self.extract_mutator = None
        self.synth_result = 0
        self.synth_hook = None
        self.eos = b"[Pipeline] EOS at step 3, stopping (slot 0)"
        self.samples = [-2.0, -0.5, 0.0, 0.5, 2.0]
        self.n_samples = None
        self.sample_rate, self.channels = 24000, 1
        self.null_audio = False
        self.log_callback = None
        self.freed_audio = self.freed_voice = self.freed_context = 0
        self.allocations = []
        functions = {
            "qt_version": lambda: self.version,
            "qt_log_set": self._log_set,
            "qt_init_default_params": self._init_default,
            "qt_init": self._init,
            "qt_free": self._free,
            "qt_model_type": lambda ctx: self.model_type,
            "qt_num_codebooks": lambda ctx: self.codebooks,
            "qt_extract_voice_ref": self._extract,
            "qt_voice_ref_free": self._voice_free,
            "qt_tts_default_params": self._tts_default,
            "qt_synthesize": self._synthesize,
            "qt_audio_free": self._audio_free,
        }
        for name, fn in functions.items():
            setattr(self, name, FakeFunction(self, name, fn))

    def _log_set(self, callback, user_data):
        assert user_data is None
        self.log_callback = callback

    def log(self, message, level=1):
        self.log_callback(level, message, None)

    def _init_default(self, ptr):
        C.memset(ptr, 0, C.sizeof(native.QtInitParams))
        ptr.contents.abi_version = self.abi
        ptr.contents.use_fa = True
        ptr.contents.max_batch = 1
        ptr.contents.codec_chunk_sec = 24.0

    def _init(self, ptr):
        p = ptr.contents
        self.init_params = {key: getattr(p, key) for key, _ in native.QtInitParams._fields_}
        line = self.backend_line
        if line is None and self.backend is not None:
            line = b"[Load] Talker backend: " + self.backend + b" (CPU threads: 8)"
        if line:
            self.log(line)
        self.log(b"PRIVATE MODEL PATH /secret/voice.wav", 3)
        return self.init_result

    def _free(self, ctx):
        assert ctx == self.init_result
        assert self.log_callback is not None
        self.log(b"PRIVATE FREE DIAGNOSTIC", 3)
        self.freed_context += 1

    def _extract(self, ctx, audio, count, out):
        self.reference_count = count
        self.reference_first, self.reference_last = audio[0], audio[count - 1]
        spk = (C.c_float * 2048)(*[0.125] * 2048)
        codes = (C.c_int32 * (16 * (count // 1920)))()
        self.allocations.extend([spk, codes])
        out.contents.ref_spk_emb = spk
        out.contents.ref_spk_dim = 2048
        out.contents.ref_codes = codes
        out.contents.ref_T = count // 1920
        out.contents.num_codebooks = 16
        if self.extract_mutator:
            self.extract_mutator(out.contents)
        return self.extract_result

    def _voice_free(self, out):
        self.freed_voice += 1
        C.memset(out, 0, C.sizeof(native.QtVoiceRef))

    def _tts_default(self, out):
        C.memset(out, 0, C.sizeof(native.QtTtsParams))
        p = out.contents
        p.abi_version = self.abi
        p.seed = -1
        p.temperature, p.top_k, p.top_p, p.repetition_penalty = 0.9, 50, 1.0, 1.05
        p.subtalker_temperature, p.subtalker_top_k, p.subtalker_top_p = 0.9, 50, 1.0

    def _synthesize(self, ctx, params, out):
        p = params.contents
        self.last_params = {key: getattr(p, key) for key, _ in native.QtTtsParams._fields_}
        self.callback_alive = weakref.ref(p.cancel)
        self.log(b"PRIVATE USER TEXT AND TRANSCRIPT", 3)
        if self.synth_hook:
            self.synth_hook(p)
        if self.eos:
            # The real library emits from its worker, not the calling thread.
            worker = threading.Thread(target=self.log, args=(self.eos,))
            worker.start()
            worker.join(2)
            assert not worker.is_alive(), "logger deadlocked"
        storage = (C.c_float * len(self.samples))(*self.samples)
        self.allocations.append(storage)
        if not self.null_audio:
            out.contents.samples = storage
        out.contents.n_samples = len(self.samples) if self.n_samples is None else self.n_samples
        out.contents.sample_rate, out.contents.channels = self.sample_rate, self.channels
        return self.synth_result

    def _audio_free(self, out):
        self.freed_audio += 1
        C.memset(out, 0, C.sizeof(native.QtAudio))


class CudaLibraryTests(unittest.TestCase):
    """Library discovery/preload mocks only; no real shared object is opened."""
    def test_system_toolkit_and_wheel_paths_are_used_without_framework(self):
        for location in ('system', 'toolkit', 'wheel'):
            with self.subTest(location=location), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                expected = {'system': 'libcublas.so.12',
                            'toolkit': str(root / 'lib64/libcublas.so.12'),
                            'wheel': str(root / 'nvidia/cublas/lib/libcublas.so.12')}[location]
                sentinel = object()
                def cdll(path, **kwargs):
                    if path != expected:
                        raise OSError('PRIVATE library path')
                    self.assertEqual(kwargs['mode'], C.RTLD_GLOBAL)
                    return sentinel
                with patch.object(ctypes.util, 'find_library', return_value='libcublas.so.12' if location == 'system' else None), \
                        patch.object(native.C, 'CDLL', side_effect=cdll) as load, \
                        patch.dict(native.os.environ, {'CUDA_HOME': directory}, clear=True), \
                        patch.object(native.sys, 'path', [directory]):
                    self.assertIs(native._load_cuda_library('cublas', major='12'), sentinel)
                    self.assertEqual(load.call_args.args[0], expected)

    def test_all_toolkit_environment_roots_and_target_library_layout(self):
        for key in ('CUDA_HOME', 'CUDA_PATH', 'CUDAToolkit_ROOT'):
            for layout in ('lib64', 'targets/x86_64-linux/lib'):
                for major in ('12', '13'):
                    with self.subTest(key=key, layout=layout, major=major), tempfile.TemporaryDirectory() as directory:
                        expected = str(Path(directory) / layout / ('libcublas.so.' + major))
                        sentinel = object()
                        def cdll(path, **kwargs):
                            if path != expected:
                                raise OSError('PRIVATE library path')
                            return sentinel
                        with patch.object(ctypes.util, 'find_library', return_value=None), \
                                patch.object(native.C, 'CDLL', side_effect=cdll), \
                                patch.dict(native.os.environ, {key: directory}, clear=True), \
                                patch.object(native.sys, 'path', []):
                            self.assertIs(native._load_cuda_library('cublas', major=major), sentinel)

    def test_unavailable_cuda_library_raises_only_static_code(self):
        with patch.object(ctypes.util, 'find_library', return_value=None), \
                patch.object(native.C, 'CDLL', side_effect=OSError('PRIVATE /path/driver')):
            with self.assertRaises(native.NativeQ8Error) as caught:
                native._load_cuda_library('cuda')
            self.assertEqual(caught.exception.error, 'cuda_libraries_unavailable')
            self.assertIsNone(native._load_cuda_library('cudart', required=False))

    def test_cuda_preload_matches_blas_runtime_major_and_never_imports_rocm(self):
        for major in ('13', '12', '11'):
            driver, blas = object(), object()
            def load(name, required=True, major=None):
                if name == 'cuda':
                    return driver
                return blas if name == 'cublas' and major == selected else None
            selected = major
            with self.subTest(major=major), patch.object(native, '_load_cuda_library', side_effect=load) as loader, \
                    patch.object(native.importlib, 'import_module', side_effect=AssertionError('must not import SDK')):
                self.assertEqual(native.preload_backend('cuda'), (driver, blas))
                loader.assert_any_call('cudart', required=False, major=major)
                loader.assert_any_call('cublasLt', required=False, major=major)
        with patch.object(native, '_load_cuda_library', return_value=None):
            with self.assertRaises(native.NativeQ8Error):
                native.preload_backend('cuda')
        with self.assertRaises(native.NativeQ8Error):
            native.preload_backend('cpu')


class NativeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.library = self.root / "libqwen.so"
        self.library.write_bytes(b"not a real library")
        self.ref = self.root / "reference.wav"
        data = wav_bytes()
        self.ref.write_bytes(data)
        self.ref_sha = hashlib.sha256(data).hexdigest()
        hashes = {}
        for name in native.MODEL_SHA256:
            data = name.encode("ascii")
            (self.root / name).write_bytes(data)
            hashes[name] = hashlib.sha256(data).hexdigest()
        self.patch(patch.dict(native.MODEL_SHA256, hashes, clear=True))
        self.patch(patch.object(native, "REFERENCE_SHA256", self.ref_sha))
        self.lib = FakeCABI()
        self.sdk = types.SimpleNamespace(initialize_process=Mock())
        self.import_module = self.patch(patch.object(native.importlib, "import_module", return_value=self.sdk))
        self.cdll = self.patch(patch.object(native.C, "CDLL", return_value=self.lib))
        self.engine = None

    def patch(self, patcher):
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def make(self, **kwargs):
        args = dict(reference_wav=self.ref, reference_text=native.REFERENCE_TEXT,
                    expected_reference_sha256=self.ref_sha)
        args.update(kwargs)
        self.engine = native.NativeQ8Engine(self.root, self.library, **args)
        self.addCleanup(self.engine.close)
        return self.engine

    def synthesize(self, **kwargs):
        args = dict(text="你好，今天也加油！", cancel=threading.Event(), deadline=time.monotonic() + 60)
        args.update(kwargs)
        return self.engine.synthesize(**args)

    def failure(self, fn, status, message=None):
        with self.assertRaises(native.NativeQ8Error) as caught:
            fn()
        error = caught.exception
        self.assertEqual(error.status, status)
        self.assertEqual(str(error), error.error)
        self.assertNotIn("PRIVATE", str(error))
        self.assertNotIn(str(self.root), str(error))
        if message:
            self.assertEqual(error.error, message)
        return error

    def test_import_is_stdlib_only_and_has_no_native_side_effect(self):
        code = """
import ctypes, sys
from unittest.mock import patch
with patch.object(ctypes, 'CDLL', side_effect=AssertionError('must not load')):
    from services.qwen_tts import native_q8
assert all(name not in sys.modules for name in ('rocm_sdk', 'numpy', 'torch', 'qwen_tts'))
"""
        result = subprocess.run([sys.executable, "-B", "-c", code], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_abi6_struct_layout_and_function_signatures(self):
        self.assertEqual(C.sizeof(C.c_void_p), 8)  # Linux ROCm x86-64 ABI
        expected = {
            native.QtAudio: (24, [0, 8, 12, 16]),
            native.QtInitParams: (48, [0, 8, 16, 24, 25, 28, 32, 40]),
            native.QtVoiceRef: (32, [0, 8, 16, 24, 28]),
            native.QtTtsParams: (176, [0, 8, 16, 24, 32, 40, 48, 56, 64,
                                    72, 76, 80, 84, 88, 92, 96, 100, 104, 112,
                                    120, 128, 136, 144, 152, 160, 168]),
        }
        for kind, (size, offsets) in expected.items():
            self.assertEqual(C.sizeof(kind), size)
            self.assertEqual([getattr(kind, name).offset for name, _ in kind._fields_], offsets)
        self.make()
        expected_signatures = {
            "qt_version": (C.c_char_p, []),
            "qt_log_set": (None, [native.LogCallback, C.c_void_p]),
            "qt_init_default_params": (None, [C.POINTER(native.QtInitParams)]),
            "qt_init": (C.c_void_p, [C.POINTER(native.QtInitParams)]),
            "qt_free": (None, [C.c_void_p]),
            "qt_model_type": (C.c_char_p, [C.c_void_p]),
            "qt_num_codebooks": (C.c_int, [C.c_void_p]),
            "qt_extract_voice_ref": (C.c_int, [C.c_void_p, C.POINTER(C.c_float), C.c_int,
                                                 C.POINTER(native.QtVoiceRef)]),
            "qt_voice_ref_free": (None, [C.POINTER(native.QtVoiceRef)]),
            "qt_tts_default_params": (None, [C.POINTER(native.QtTtsParams)]),
            "qt_synthesize": (C.c_int, [C.c_void_p, C.POINTER(native.QtTtsParams), C.POINTER(native.QtAudio)]),
            "qt_audio_free": (None, [C.POINTER(native.QtAudio)]),
        }
        for name, signature in expected_signatures.items():
            fn = getattr(self.lib, name)
            self.assertEqual((fn.restype, fn.argtypes), signature)
        self.assertIs(native.CancelCallback._restype_, C.c_bool)
        self.assertEqual(native.CancelCallback._argtypes_, (C.c_void_p,))
        self.assertEqual(native.LogCallback._argtypes_, (C.c_int, C.c_char_p, C.c_void_p))

    def test_version_mismatch_precedes_every_pod_write_or_init(self):
        for version in (None, b"5916bf7", b"5916bf7 (2026-10-17)", b"newer (2026-10-16)"):
            with self.subTest(version=version):
                self.lib.calls.clear()
                self.lib.version = version
                self.failure(self.make, 503, "unsupported native Q8 version")
                self.assertEqual(self.lib.calls, ["qt_version"])

    def test_default_abi_mismatch_and_null_init_unwind_safely(self):
        self.lib.abi = 5
        self.failure(self.make, 503, "unsupported native Q8 version")
        self.assertNotIn("qt_init", self.lib.calls)
        self.lib.abi = 6
        self.lib.init_result = None
        self.failure(self.make, 503, "gpu_backend_mismatch")
        self.assertNotIn("qt_extract_voice_ref", self.lib.calls)
        self.assertEqual(self.lib.freed_context, 0)  # NULL init self-cleans in C

    def test_synthesis_default_abi_mismatch_closes_without_native_call(self):
        self.make()
        self.lib.abi = 5
        self.failure(self.synthesize, 503, "unsupported native Q8 version")
        self.assertNotIn("qt_synthesize", self.lib.calls)
        self.assertEqual((self.lib.freed_voice, self.lib.freed_context), (1, 1))

    def test_duplicate_eos_or_wrong_severity_cannot_prove_completion(self):
        self.make()
        self.lib.synth_hook = lambda p: self.lib.log(self.lib.eos)
        self.failure(self.synthesize, 503, "incomplete native audio")
        self.lib.synth_hook = None
        self.make()
        eos = self.lib.eos
        self.lib.eos = None
        self.lib.synth_hook = lambda p: self.lib.log(eos, 3)
        self.failure(self.synthesize, 503, "incomplete native audio")

    def test_sdk_initialization_order_and_explicit_library(self):
        order = []
        self.sdk.initialize_process.side_effect = lambda **kwargs: order.append("sdk")
        self.cdll.side_effect = lambda path: order.append("cdll") or self.lib
        self.make()
        self.assertEqual(order, ["sdk", "cdll"])
        self.import_module.assert_called_once_with("rocm_sdk")
        self.sdk.initialize_process.assert_called_once_with(preload_shortnames=["amdhip64", "hipblas"])
        self.cdll.assert_called_once_with(str(self.library.resolve()))
        self.assertLess(self.lib.calls.index("qt_version"), self.lib.calls.index("qt_init_default_params"))

    def test_missing_sdk_library_or_symbol_is_controlled_unavailable(self):
        for failure in (ImportError("PRIVATE SDK ERROR"), OSError("PRIVATE LINK ERROR")):
            with self.subTest(failure=type(failure).__name__):
                self.import_module.side_effect = failure
                self.failure(self.make, 503, "native Q8 unavailable")
        self.import_module.side_effect = None
        del self.lib.qt_init
        self.failure(self.make, 503, "native Q8 unavailable")
        self.assertNotIn("qt_init_default_params", self.lib.calls)

    def test_assets_verified_before_sdk_or_native_load(self):
        for name in native.MODEL_SHA256:
            path = self.root / name
            original = path.read_bytes()
            path.write_bytes(b"tampered")
            self.failure(self.make, 503, "native Q8 model assets do not match")
            path.write_bytes(original)
        self.assertEqual(self.lib.calls, [])
        self.import_module.assert_not_called()
        self.cdll.assert_not_called()
        path = self.root / next(iter(native.MODEL_SHA256))
        path.unlink()
        self.failure(self.make, 503, "native Q8 model assets do not match")

    def test_missing_explicit_library_has_no_fallback(self):
        self.library.unlink()
        self.failure(self.make, 503, "native Q8 unavailable")
        self.cdll.assert_not_called()

    def test_reference_hash_and_full_transcript_are_pinned(self):
        self.failure(lambda: self.make(expected_reference_sha256="0" * 64), 503)
        self.failure(lambda: self.make(reference_text=native.REFERENCE_TEXT[:10]), 503)
        self.ref.write_bytes(wav_bytes(frames=1920))
        self.failure(self.make, 503, "selected voice assets do not match")
        self.cdll.assert_not_called()

    def test_reference_wav_format_length_and_hash(self):
        fixtures = [wav_bytes(rate=16000), wav_bytes(channels=2), wav_bytes(width=1),
                    wav_bytes(frames=100), wav_bytes()[:-2], b"not a WAV"]
        for data in fixtures:
            with self.subTest(size=len(data)):
                self.ref.write_bytes(data)
                sha = hashlib.sha256(data).hexdigest()
                with patch.object(native, "REFERENCE_SHA256", sha):
                    self.failure(lambda: self.make(expected_reference_sha256=sha), 503,
                                 "invalid selected reference WAV")
        self.assertEqual(self.lib.calls, [])

    def test_explicit_gpu_only_and_no_silent_cpu_fallback(self):
        for device in (None, "", "auto", "CPU", "CUDA00", "CUDA100", "Vulkan0", "ROCm", "ROCm-1",
                       "ROCm00", "ROCm01", "ROCm100", "ROCm99999999999999999999"):
            with self.subTest(device=device):
                self.failure(lambda: self.make(device=device), 503, "explicit GPU device required")
        self.assertEqual(self.lib.calls, [])
        self.lib.backend = b"CPU"
        self.failure(self.make, 503, "gpu_backend_mismatch")
        self.assertEqual(self.lib.freed_context, 1)
        self.assertNotIn("qt_extract_voice_ref", self.lib.calls)

    def test_cuda_device_exact_callback_and_lifecycle_simulation(self):
        # FakeCABI is a Python simulation, not NVIDIA hardware validation.
        for device in ('CUDA0', 'CUDA99'):
            with self.subTest(device=device), patch.object(native, '_load_cuda_library', return_value=object()) as load:
                self.lib.backend = device.encode('ascii')
                engine = self.make(device=device)
                self.assertEqual(self.lib.init_params['device'], device.encode('ascii'))
                self.import_module.assert_not_called()
                self.assertIn('cuda', [call.args[0] for call in load.call_args_list])
                self.assertIn('cublas', [call.args[0] for call in load.call_args_list])
                self.assertTrue(self.synthesize().startswith(b'RIFF'))
                engine.close()
        self.assertEqual(self.lib.freed_context, 2)
        self.assertEqual(self.lib.freed_voice, 2)

    def test_cuda_wrong_backend_or_index_is_rejected_and_freed_simulation(self):
        for backend in (b'CPU', b'ROCm0', b'CUDA1', b'CUDA00', b'CUDA0evil', None):
            with self.subTest(backend=backend), patch.object(native, '_load_cuda_library', return_value=object()):
                self.lib.backend = backend
                self.failure(lambda: self.make(device='CUDA0'), 503, 'gpu_backend_mismatch')
                self.assertNotIn('qt_extract_voice_ref', self.lib.calls)
        self.assertEqual(self.lib.freed_context, 6)
        self.import_module.assert_not_called()

    def test_cuda_loader_unavailable_does_not_import_rocm_or_leak_details(self):
        with patch.object(native, '_load_cuda_library', side_effect=native.NativeQ8Error(503, 'cuda_libraries_unavailable')):
            self.failure(lambda: self.make(device='CUDA0'), 503, 'cuda_libraries_unavailable')
        self.import_module.assert_not_called()
        self.cdll.assert_not_called()

    def test_nonzero_rocm_device_is_pinned_and_confirmed(self):
        self.lib.backend = b"ROCm3"
        self.make(device="ROCm3")
        self.assertEqual(self.lib.init_params["device"], b"ROCm3")
        self.assertFalse(self.lib.init_params["use_fa"])
        self.assertFalse(self.lib.init_params["clamp_fp16"])
        self.assertEqual(self.lib.init_params["max_batch"], 1)
        self.assertEqual(self.lib.init_params["abi_version"], 6)

    def test_backend_log_must_match_exact_approved_grammar(self):
        for line in (b"[Load] Talker backend: ROCm0evil (CPU threads: 8)",
                     b"PRIVATE [Load] Talker backend: ROCm0 (CPU threads: 8)",
                     b"[Load] Talker backend: ROCm0 (CPU threads: 8) PRIVATE", b""):
            with self.subTest(line=line):
                self.lib.backend_line = line
                self.failure(self.make, 503, "gpu_backend_mismatch")

    def test_base_model_and_sixteen_codebooks_required(self):
        self.lib.model_type = b"custom_voice"
        self.failure(self.make, 503, "unsupported native Q8 model")
        self.lib.model_type = b"base"
        self.lib.codebooks = 8
        self.failure(self.make, 503, "unsupported native Q8 model")
        self.assertEqual(self.lib.freed_context, 2)
        self.assertNotIn("qt_extract_voice_ref", self.lib.calls)

    def test_complete_reference_is_extracted_once_and_icl_reused(self):
        self.make()
        self.assertEqual(self.lib.reference_count, 201601)  # includes non-hop tail
        self.assertAlmostEqual(self.lib.reference_first, 0.25)
        self.assertAlmostEqual(self.lib.reference_last, 0.25)
        for text in ("你好", "再见"):
            self.synthesize(text=text)
            p = self.lib.last_params
            self.assertEqual(p["text"], text.encode())
            self.assertEqual(p["lang"], b"chinese")
            self.assertEqual(p["ref_text"], native.REFERENCE_TEXT.encode())
            self.assertTrue(p["ref_spk_emb"])
            self.assertTrue(p["ref_codes"])
            self.assertEqual((p["ref_spk_dim"], p["ref_T"]), (2048, 105))
            self.assertFalse(p["ref_audio_24k"])
            self.assertEqual(p["ref_n_samples"], 0)
            self.assertFalse(p["speaker"])
            self.assertFalse(p["instruct"])
            self.assertFalse(p["on_chunk"])
            self.assertFalse(p["dump_dir"])
            self.assertEqual((p["seed"], p["max_new_tokens"]), (42, 360))
        self.assertEqual(self.lib.calls.count("qt_extract_voice_ref"), 1)
        self.assertEqual(self.lib.freed_audio, 2)
        self.assertEqual(self.lib.freed_voice, 0)
        self.engine.close()
        self.engine.close()
        self.assertEqual((self.lib.freed_voice, self.lib.freed_context), (1, 1))

    def test_invalid_reference_latents_and_partial_extraction_error_free_all(self):
        mutators = [lambda r: setattr(r, "ref_spk_emb", C.POINTER(C.c_float)()),
                    lambda r: setattr(r, "ref_codes", C.POINTER(C.c_int32)()),
                    lambda r: setattr(r, "ref_spk_dim", 1024),
                    lambda r: setattr(r, "num_codebooks", 8),
                    lambda r: setattr(r, "ref_T", 104),
                    lambda r: r.ref_spk_emb.__setitem__(0, float("nan"))]
        for mutator in mutators:
            with self.subTest(mutator=mutator):
                self.lib.extract_mutator = mutator
                self.failure(self.make, 503, "invalid native voice reference")
        self.lib.extract_mutator = None
        self.lib.extract_result = -3
        self.failure(self.make, 503, "native voice reference extraction failed")
        self.assertEqual((self.lib.freed_voice, self.lib.freed_context), (7, 7))

    def test_wav_pcm16_mono24k_success_and_saturation(self):
        self.make()
        data = self.synthesize()
        self.assertEqual(struct.unpack_from("<I", data, 4)[0], len(data) - 8)
        with wave.open(io.BytesIO(data), "rb") as wav:
            self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (1, 2, 24000))
            self.assertEqual(wav.getnframes(), 5)
            self.assertEqual(struct.unpack("<5h", wav.readframes(5)), (-32767, -16384, 0, 16384, 32767))
        self.assertEqual(self.lib.freed_audio, 1)

    def test_missing_eos_and_frame_cap_ok_are_not_success(self):
        for eos in (None, b"[Pipeline] EOS at step 360, stopping (slot 0)",
                    b"[Pipeline] EOS at step 999, stopping (slot 0)",
                    b"[Pipeline] EOS at step 0, stopping (slot 0)"):
            with self.subTest(eos=eos):
                self.make()
                self.lib.eos = eos
                self.failure(self.synthesize, 503, "incomplete native audio")
                self.assertTrue(self.engine._closed)
        self.assertEqual((self.lib.freed_audio, self.lib.freed_voice, self.lib.freed_context), (4, 4, 4))

    def test_eos_is_exact_and_per_request_not_stale(self):
        self.make()
        self.synthesize()
        # Out-of-request EOS must not satisfy the next call.
        self.lib.log(b"[Pipeline] EOS at step 3, stopping (slot 0)")
        self.lib.eos = None
        self.failure(self.synthesize, 503, "incomplete native audio")
        for eos in (b"PRIVATE EOS at step 3, stopping (slot 0)",
                    b"[Pipeline] EOS at step 3, stopping (slot 1)",
                    b"[Pipeline] EOS at step 3, stopping (slot 0) PRIVATE"):
            self.make()
            self.lib.eos = eos
            self.failure(self.synthesize, 503, "incomplete native audio")

    def test_native_status_failure_rejects_even_with_eos_and_frees_partial_audio(self):
        for rc in (-1, -2, -3, -4, 1):
            with self.subTest(rc=rc):
                self.make()
                self.lib.synth_result = rc
                self.failure(self.synthesize, 500, "native synthesis failed")
        self.assertEqual((self.lib.freed_audio, self.lib.freed_voice, self.lib.freed_context), (5, 5, 5))

    def test_event_cancellation_callback_runs_on_worker_without_qt_reentry(self):
        self.make()
        cancel = threading.Event()
        def hook(p):
            count = len(self.lib.calls)
            gc.collect()  # text, transcript, params and callback must stay live
            self.assertFalse(p.cancel(None))
            cancel.set()
            result = []
            worker = threading.Thread(target=lambda: result.append(p.cancel(None)))
            worker.start()
            worker.join(2)
            self.assertFalse(worker.is_alive())
            self.assertEqual(result, [True])
            self.assertEqual(len(self.lib.calls), count)
        self.lib.synth_hook = hook
        self.lib.synth_result = -5
        self.failure(lambda: self.synthesize(cancel=cancel), 409, "request cancelled")
        self.assertEqual((self.lib.freed_audio, self.lib.freed_voice, self.lib.freed_context), (1, 0, 0))
        self.assertFalse(self.engine._closed)
        self.lib.synth_hook = None
        self.lib.synth_result = 0
        cancel.clear()
        self.assertTrue(self.synthesize(cancel=cancel).startswith(b"RIFF"))
        self.assertEqual(self.lib.calls.count("qt_init"), 1)
        self.assertEqual(self.lib.calls.count("qt_extract_voice_ref"), 1)
        self.engine.close()
        self.engine.close()
        self.assertEqual((self.lib.freed_audio, self.lib.freed_voice, self.lib.freed_context), (2, 1, 1))

    def test_deadline_callback_and_late_cancel_override_native_ok(self):
        self.make()
        clock = [10.0]
        with patch.object(native.time, "monotonic", side_effect=lambda: clock[0]):
            def hook(p):
                self.assertFalse(p.cancel(None))
                clock[0] = 20.0
                self.assertTrue(p.cancel(None))
            self.lib.synth_hook = hook
            self.failure(lambda: self.synthesize(deadline=15.0), 503, "synthesis deadline exceeded")
        self.assertEqual(self.lib.freed_audio, 1)

    def test_pre_cancel_and_pre_expired_deadline_never_enter_synthesis(self):
        self.make()
        cancel = threading.Event()
        cancel.set()
        self.failure(lambda: self.synthesize(cancel=cancel), 409, "request cancelled")
        self.make()
        self.failure(lambda: self.synthesize(deadline=time.monotonic() - 1), 503,
                     "synthesis deadline exceeded")
        self.assertNotIn("qt_synthesize", self.lib.calls)

    def test_late_cancel_after_native_ok_discards_output_and_reuses_context(self):
        self.make()
        cancel = threading.Event()
        self.lib.synth_hook = lambda p: cancel.set()
        self.failure(lambda: self.synthesize(cancel=cancel), 409, "request cancelled")
        self.assertEqual((self.lib.freed_audio, self.lib.freed_voice, self.lib.freed_context), (1, 0, 0))
        self.lib.synth_hook = None
        cancel.clear()
        self.assertTrue(self.synthesize(cancel=cancel).startswith(b"RIFF"))
        self.assertEqual(self.lib.calls.count("qt_init"), 1)
        self.assertEqual(self.lib.calls.count("qt_extract_voice_ref"), 1)

    def test_bad_input_and_pre_cancel_retain_context_for_next_valid_request(self):
        self.make()
        context = self.engine._context
        self.failure(lambda: self.synthesize(text=""), 400)
        cancel = threading.Event()
        cancel.set()
        self.failure(lambda: self.synthesize(cancel=cancel), 409, "request cancelled")
        self.assertEqual((self.lib.freed_audio, self.lib.freed_voice, self.lib.freed_context), (0, 0, 0))
        self.assertEqual(self.engine._context, context)
        self.assertTrue(self.synthesize().startswith(b"RIFF"))
        self.assertEqual(self.lib.calls.count("qt_extract_voice_ref"), 1)

    def test_unexpected_native_error_still_closes_when_cancel_races(self):
        self.make()
        cancel = threading.Event()
        self.lib.synth_hook = lambda p: cancel.set()
        self.lib.synth_result = -4
        self.failure(lambda: self.synthesize(cancel=cancel), 500, "native synthesis failed")
        self.assertTrue(self.engine._closed)
        self.assertEqual((self.lib.freed_audio, self.lib.freed_voice, self.lib.freed_context), (1, 1, 1))

    def test_native_cancelled_status_without_event_is_safe(self):
        self.make()
        self.lib.synth_result = -5
        self.failure(self.synthesize, 409, "request cancelled")
        self.assertEqual(self.lib.freed_audio, 1)

    def test_nonfinite_audio_is_rejected_and_every_allocation_freed(self):
        for value in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(value=value):
                self.make()
                self.lib.samples = [0.0, value]
                self.failure(self.synthesize, 500, "invalid native audio")
        self.assertEqual((self.lib.freed_audio, self.lib.freed_voice, self.lib.freed_context), (3, 3, 3))

    def test_bad_output_format_or_length_rejected_before_pointer_read(self):
        changes = [("sample_rate", 16000), ("channels", 2), ("null_audio", True),
                   ("n_samples", 0), ("n_samples", -1), ("n_samples", 720001),
                   ("n_samples", 691201), ("n_samples", 2**31 - 1)]
        for name, value in changes:
            with self.subTest(name=name, value=value):
                old = getattr(self.lib, name)
                setattr(self.lib, name, value)
                self.make()
                self.failure(self.synthesize, 500, "invalid native audio")
                setattr(self.lib, name, old)
        self.assertEqual(self.lib.freed_audio, len(changes))
        self.make()
        with patch.object(native, "MAX_WAV_BYTES", 45):
            self.failure(self.synthesize, 500, "invalid native audio")

    def test_invalid_text_deadline_and_closed_engine_safe_errors(self):
        for text in ("", " " * 3, "x" * 81, "PRIVATE\0", "\ud800", None):
            with self.subTest(text=repr(text)):
                self.make()
                self.failure(lambda: self.synthesize(text=text), 400)
        for deadline in (float("nan"), float("inf"), None):
            self.make()
            self.failure(lambda: self.synthesize(deadline=deadline), 503)
        self.make()
        self.engine.close()
        self.failure(self.synthesize, 503, "native Q8 engine closed")
        self.assertNotIn("qt_synthesize", self.lib.calls)

    def test_logs_are_suppressed_callback_survives_free_and_gc(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.make()
            self.synthesize(text="PRIVATE INPUT")
            callback = weakref.ref(self.lib.log_callback)
            self.engine.close()
            self.engine = None
            gc.collect()
            self.assertIsNotNone(callback())
            callback()(3, b"PRIVATE LOG AFTER FREE", None)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "")
        self.assertIsNone(native._LOG_TARGET)

    def test_native_python_exception_is_sanitized_and_cleanup_runs(self):
        self.make()
        def fail(_p):
            raise RuntimeError("PRIVATE native exception with text and path")
        self.lib.synth_hook = fail
        self.failure(self.synthesize, 500, "native synthesis failed")
        self.assertEqual((self.lib.freed_audio, self.lib.freed_voice, self.lib.freed_context), (1, 1, 1))


class PinnedAssetsTests(unittest.TestCase):
    def test_approved_asset_hashes_and_version_constants(self):
        self.assertEqual(native.PINNED_COMMIT, "5916bf7c79dbb4e66fc059cdc507a79a23a28bb4")
        self.assertEqual(native.NATIVE_VERSION, b"5916bf7 (2026-10-16)")
        self.assertEqual(native.ABI_VERSION, 6)
        self.assertEqual(native.MODEL_SHA256, {
            "qwen-talker-1.7b-base-Q8_0.gguf": "4b9a33a236908dd9435a42f7a396e38038329d053b704342a6413c08544c4fda",
            "qwen-tokenizer-12hz-Q8_0.gguf": "1883beeed99348fc35e23dd225e9082f93f6f8c109330a33d935baa8acdbfd94",
        })
        self.assertEqual(native.REFERENCE_SHA256,
                         "1d7b3268b755fd9ec261f885b3886c47a3f0cb3fc927de33bd9641127ce223f8")
        self.assertEqual((native.MAX_FRAMES, native.MAX_SECONDS, native.MAX_WAV_BYTES), (360, 30, 2097152))


if __name__ == "__main__":
    unittest.main()
