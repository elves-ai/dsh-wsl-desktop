"""Pinned qwentts.cpp ABI 6, buffered CUDA/ROCm Base voice cloning.

Importing this module uses only the standard library. The parent owns process
isolation, admission control and the hard kill fallback; callbacks only request
cooperative cancellation. No native diagnostic or input text is forwarded.
"""
from __future__ import annotations

from array import array
import ctypes as C
import os
import hashlib
import importlib
import io
import math
from pathlib import Path
import re
import struct
import sys
import threading
import time
import wave

PINNED_COMMIT = "5916bf7c79dbb4e66fc059cdc507a79a23a28bb4"
NATIVE_VERSION = b"5916bf7 (2026-10-16)"
ABI_VERSION = 6
MODEL_SHA256 = {
    "qwen-talker-1.7b-base-Q8_0.gguf": "4b9a33a236908dd9435a42f7a396e38038329d053b704342a6413c08544c4fda",
    "qwen-tokenizer-12hz-Q8_0.gguf": "1883beeed99348fc35e23dd225e9082f93f6f8c109330a33d935baa8acdbfd94",
}
REFERENCE_SHA256 = "1d7b3268b755fd9ec261f885b3886c47a3f0cb3fc927de33bd9641127ce223f8"
REFERENCE_TEXT = "欸？你回来啦……我才没有一直等你呢！嘿嘿，好像又说漏嘴了。今天也要一起加油哦！"
SAMPLE_RATE = 24000
CODEC_HOP = 1920
MAX_FRAMES = 360
MAX_SECONDS = 30
MAX_WAV_BYTES = 2 * 1024 * 1024


class NativeQ8Error(Exception):
    """HTTP-compatible status and a static, non-sensitive public message."""

    def __init__(self, status: int, error: str):
        self.status, self.error = status, error
        super().__init__(error)


CancelCallback = C.CFUNCTYPE(C.c_bool, C.c_void_p)
ChunkCallback = C.CFUNCTYPE(C.c_bool, C.POINTER(C.c_float), C.c_int, C.c_void_p)
LogCallback = C.CFUNCTYPE(None, C.c_int, C.c_char_p, C.c_void_p)


class QtAudio(C.Structure):
    _fields_ = [("samples", C.POINTER(C.c_float)), ("n_samples", C.c_int),
                ("sample_rate", C.c_int), ("channels", C.c_int)]


class QtInitParams(C.Structure):
    _fields_ = [("abi_version", C.c_int), ("talker_path", C.c_char_p),
                ("codec_path", C.c_char_p), ("use_fa", C.c_bool),
                ("clamp_fp16", C.c_bool), ("max_batch", C.c_int),
                ("codec_chunk_sec", C.c_float), ("device", C.c_char_p)]


class QtVoiceRef(C.Structure):
    _fields_ = [("ref_spk_emb", C.POINTER(C.c_float)), ("ref_spk_dim", C.c_int),
                ("ref_codes", C.POINTER(C.c_int32)), ("ref_T", C.c_int),
                ("num_codebooks", C.c_int)]


class QtTtsParams(C.Structure):
    _fields_ = [
        ("abi_version", C.c_int), ("text", C.c_char_p), ("lang", C.c_char_p),
        ("instruct", C.c_char_p), ("speaker", C.c_char_p),
        ("ref_audio_24k", C.POINTER(C.c_float)), ("ref_n_samples", C.c_int),
        ("ref_text", C.c_char_p), ("seed", C.c_int64),
        ("max_new_tokens", C.c_int), ("temperature", C.c_float),
        ("top_k", C.c_int), ("top_p", C.c_float),
        ("repetition_penalty", C.c_float), ("subtalker_temperature", C.c_float),
        ("subtalker_top_k", C.c_int), ("subtalker_top_p", C.c_float),
        ("dump_dir", C.c_char_p), ("cancel", CancelCallback),
        ("cancel_user_data", C.c_void_p), ("on_chunk", ChunkCallback),
        ("on_chunk_user_data", C.c_void_p),
        ("ref_spk_emb", C.POINTER(C.c_float)), ("ref_spk_dim", C.c_int),
        ("ref_codes", C.POINTER(C.c_int32)), ("ref_T", C.c_int),
    ]


# The ABI's logger is process-global. Serialize all native operations, including
# init/free, so one observer can unambiguously own slot 0. Its callback uses a
# DIFFERENT lock: the native worker invokes it while the caller is blocked.
_NATIVE_LOCK = threading.RLock()
_LOG_LOCK = threading.Lock()
_LOG_TARGET = None
_LIBRARIES = []  # Keep libraries and the global callback alive for process life.
_EOS = re.compile(rb"\[Pipeline\] EOS at step ([0-9]{1,6}), stopping \(slot 0\)")
_BACKEND = re.compile(rb"\[Load\] Talker backend: ([A-Za-z0-9]+) \(CPU threads: [0-9]+\)")


class _Observation:
    def __init__(self, phase):
        self.phase = phase
        self.backends = []
        self.eos_steps = []


def _observe_log(level, message, _user_data):
    # Never print, retain or decode arbitrary native logs (they can contain text
    # and paths). Recognize only the pinned build's narrow INFO sentinels.
    if level != 1 or not message:
        return
    with _LOG_LOCK:
        target = _LOG_TARGET
        if target is None:
            return
        if target.phase == "load":
            match = _BACKEND.fullmatch(message)
            if match:
                target.backends.append(match[1])
        elif target.phase == "synthesis":
            match = _EOS.fullmatch(message)
            if match:
                target.eos_steps.append(int(match[1]))


_LOG_CALLBACK = LogCallback(_observe_log)


def _set_observer(observer):
    global _LOG_TARGET
    with _LOG_LOCK:
        _LOG_TARGET = observer


def _signature(lib, name, result, *args):
    fn = getattr(lib, name)
    fn.restype, fn.argtypes = result, list(args)


def _bind(lib):
    # qt_version has already been called and checked, before any POD writer.
    _signature(lib, "qt_log_set", None, LogCallback, C.c_void_p)
    _signature(lib, "qt_init_default_params", None, C.POINTER(QtInitParams))
    _signature(lib, "qt_init", C.c_void_p, C.POINTER(QtInitParams))
    _signature(lib, "qt_free", None, C.c_void_p)
    _signature(lib, "qt_model_type", C.c_char_p, C.c_void_p)
    _signature(lib, "qt_num_codebooks", C.c_int, C.c_void_p)
    _signature(lib, "qt_extract_voice_ref", C.c_int, C.c_void_p,
               C.POINTER(C.c_float), C.c_int, C.POINTER(QtVoiceRef))
    _signature(lib, "qt_voice_ref_free", None, C.POINTER(QtVoiceRef))
    _signature(lib, "qt_tts_default_params", None, C.POINTER(QtTtsParams))
    _signature(lib, "qt_synthesize", C.c_int, C.c_void_p,
               C.POINTER(QtTtsParams), C.POINTER(QtAudio))
    _signature(lib, "qt_audio_free", None, C.POINTER(QtAudio))


def _sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _reference_samples(path, expected_sha256):
    if (expected_sha256 != REFERENCE_SHA256 or not path.is_file()
            or path.stat().st_size > MAX_WAV_BYTES):
        raise NativeQ8Error(503, "selected voice assets do not match")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected_sha256:
        raise NativeQ8Error(503, "selected voice assets do not match")
    try:
        if (len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE"
                or struct.unpack_from("<I", data, 4)[0] != len(data) - 8):
            raise ValueError
        with wave.open(io.BytesIO(data), "rb") as wav:
            n = wav.getnframes()
            if ((wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype())
                    != (1, 2, SAMPLE_RATE, "NONE") or not CODEC_HOP <= n <= SAMPLE_RATE * MAX_SECONDS):
                raise ValueError
            pcm = wav.readframes(n)
            if len(pcm) != n * 2:
                raise ValueError
        samples = array("h")
        samples.frombytes(pcm)
        if sys.byteorder != "little":
            samples.byteswap()
        # Full selected clip, no crop, resample or embedding-only substitution.
        return (C.c_float * n)(*(sample / 32768.0 for sample in samples))
    except (wave.Error, EOFError, ValueError, struct.error):
        raise NativeQ8Error(503, "invalid selected reference WAV") from None


def _check_cancel(cancel, deadline):
    if cancel.is_set():
        raise NativeQ8Error(409, "request cancelled")
    if time.monotonic() >= deadline:
        raise NativeQ8Error(503, "synthesis deadline exceeded")


def _wav_bytes(audio):
    n = audio.n_samples
    if (audio.sample_rate != SAMPLE_RATE or audio.channels != 1
            or not audio.samples or not 0 < n <= SAMPLE_RATE * MAX_SECONDS
            or n > MAX_FRAMES * CODEC_HOP or 44 + n * 2 > MAX_WAV_BYTES):
        raise NativeQ8Error(500, "invalid native audio")
    # Bound all lengths BEFORE dereferencing the native allocation. Reject NaN
    # and infinities rather than silently converting them into playable samples.
    pcm = array("h")
    for i in range(n):
        value = audio.samples[i]
        if not math.isfinite(value):
            raise NativeQ8Error(500, "invalid native audio")
        pcm.append(round(max(-1.0, min(1.0, value)) * 32767))
    if sys.byteorder != "little":
        pcm.byteswap()
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm.tobytes())
    result = output.getvalue()
    if len(result) > MAX_WAV_BYTES:
        raise NativeQ8Error(500, "invalid native audio")
    return result


def _load_cuda_library(shortname, required=True, major=None):
    """Locate already-installed system/toolkit/nvidia-wheel libraries, without torch."""
    from ctypes.util import find_library  # lazy: Python 3.14 ctypes.util opens libc
    candidates = []
    found = find_library(shortname)
    if found and (major is None or re.search(r"\.so\." + re.escape(major) + r"(?:\.|$)", found)):
        candidates.append(found)
    versions = {"cuda": ("1",), "cudart": ("13", "12", "11.0"),
                "cublas": ("13", "12", "11"), "cublasLt": ("13", "12", "11")}
    selected = tuple(v for v in versions[shortname] if major is None or v.split(".")[0] == major)
    names = ["lib" + shortname + ".so." + v for v in selected]
    if major is None:
        names.append("lib" + shortname + ".so")
    candidates.extend(names)
    toolkits = [Path("/usr/local/cuda")]
    toolkits.extend(Path("/usr/local").glob("cuda-*"))
    for key in ("CUDA_HOME", "CUDA_PATH", "CUDAToolkit_ROOT"):
        if os.environ.get(key):
            toolkits.append(Path(os.environ[key]))
    roots = [Path("/usr/lib/wsl/lib")]
    for toolkit in toolkits:
        roots.extend((toolkit / "lib64", toolkit / "targets/x86_64-linux/lib"))
    package = "cuda_runtime" if shortname == "cudart" else "cublas"
    for entry in sys.path:
        roots.append(Path(entry) / "nvidia" / package / "lib")
    for root in roots:
        candidates.extend(str(root / name) for name in names)
    for candidate in dict.fromkeys(candidates):
        try:
            library = C.CDLL(candidate, mode=C.RTLD_GLOBAL)
            _LIBRARIES.append(library)
            return library
        except OSError:
            pass
    if required:
        raise NativeQ8Error(503, "cuda_libraries_unavailable")
    return None


def preload_backend(backend):
    """Preload only the selected backend; never initialize or load a TTS model."""
    if backend == "cuda":
        driver = _load_cuda_library("cuda")
        for major in ("13", "12", "11"):
            _load_cuda_library("cublasLt", required=False, major=major)
            blas = _load_cuda_library("cublas", required=False, major=major)
            if blas is not None:
                _load_cuda_library("cudart", required=False, major=major)
                return driver, blas
        raise NativeQ8Error(503, "cuda_libraries_unavailable")
    if backend == "rocm":
        sdk = importlib.import_module("rocm_sdk")
        sdk.initialize_process(preload_shortnames=["amdhip64", "hipblas"])
        return None
    raise NativeQ8Error(503, "unsupported_device")


class NativeQ8Engine:
    def __init__(self, model_dir, native_lib, device="ROCm0", *, reference_wav,
                 reference_text, expected_reference_sha256):
        self._lib = None
        self._context = None
        self._voice = QtVoiceRef()
        self._voice_owned = False
        self._closed = False
        with _NATIVE_LOCK:
            try:
                if not isinstance(device, str) or not re.fullmatch(r"(?:ROCm|CUDA)(?:0|[1-9][0-9]?)", device):
                    raise NativeQ8Error(503, "explicit GPU device required")
                if reference_text != REFERENCE_TEXT:
                    raise NativeQ8Error(503, "selected voice assets do not match")
                model_dir, library = Path(model_dir).resolve(), Path(native_lib).resolve()
                if not library.is_file():
                    raise NativeQ8Error(503, "native Q8 unavailable")
                models = [model_dir / name for name in MODEL_SHA256]
                for path in models:
                    if not path.is_file() or _sha256_file(path) != MODEL_SHA256[path.name]:
                        raise NativeQ8Error(503, "native Q8 model assets do not match")
                samples = _reference_samples(Path(reference_wav), expected_reference_sha256)
                # Lazy import: no ROCm/model/framework initialization at import.
                preload_backend("cuda" if device.startswith("CUDA") else "rocm")
                self._lib = C.CDLL(str(library))
                _signature(self._lib, "qt_version", C.c_char_p)
                if self._lib.qt_version() != NATIVE_VERSION:
                    raise NativeQ8Error(503, "unsupported native Q8 version")
                _bind(self._lib)
                _LIBRARIES.append(self._lib)
                self._lib.qt_log_set(_LOG_CALLBACK, None)
                observer = _Observation("load")
                _set_observer(observer)
                # Explicit buffers stay live throughout init (and as engine
                # attributes through free), regardless of ctypes ownership rules.
                self._init_strings = [C.create_string_buffer(str(p).encode("utf-8")) for p in models]
                self._device = C.create_string_buffer(device.encode("ascii"))
                self._reference_text = C.create_string_buffer(reference_text.encode("utf-8"))
                params = QtInitParams()
                self._lib.qt_init_default_params(C.byref(params))
                if params.abi_version != ABI_VERSION:
                    raise NativeQ8Error(503, "unsupported native Q8 version")
                params.talker_path = C.cast(self._init_strings[0], C.c_char_p)
                params.codec_path = C.cast(self._init_strings[1], C.c_char_p)
                params.device = C.cast(self._device, C.c_char_p)
                params.use_fa = params.clamp_fp16 = False
                params.max_batch = 1
                self._context = self._lib.qt_init(C.byref(params))
                if not self._context or observer.backends != [device.encode("ascii")]:
                    raise NativeQ8Error(503, "gpu_backend_mismatch")
                if (self._lib.qt_model_type(self._context) != b"base"
                        or self._lib.qt_num_codebooks(self._context) != 16):
                    raise NativeQ8Error(503, "unsupported native Q8 model")
                _set_observer(None)
                self._voice_owned = True  # also free partially filled error output
                rc = self._lib.qt_extract_voice_ref(self._context, samples, len(samples), C.byref(self._voice))
                if rc != 0:
                    raise NativeQ8Error(503, "native voice reference extraction failed")
                if (not self._voice.ref_spk_emb or not self._voice.ref_codes
                        or self._voice.ref_spk_dim != 2048
                        or self._voice.num_codebooks != 16
                        or self._voice.ref_T != len(samples) // CODEC_HOP):
                    raise NativeQ8Error(503, "invalid native voice reference")
                if any(not math.isfinite(self._voice.ref_spk_emb[i]) for i in range(self._voice.ref_spk_dim)):
                    raise NativeQ8Error(503, "invalid native voice reference")
            except NativeQ8Error:
                self._free()
                raise
            except Exception:
                self._free()
                raise NativeQ8Error(503, "native Q8 unavailable") from None
            finally:
                _set_observer(None)

    def _free(self):
        """Called under the operation lock; callbacks remain alive after free."""
        self._closed = True
        try:
            if self._voice_owned:
                self._voice_owned = False
                self._lib.qt_voice_ref_free(C.byref(self._voice))
        finally:
            if self._context:
                context, self._context = self._context, None
                self._lib.qt_free(context)

    def close(self):
        with _NATIVE_LOCK:
            self._free()

    def synthesize(self, text, cancel, deadline):
        with _NATIVE_LOCK:
            audio = QtAudio()
            audio_owned = False
            try:
                if self._closed:
                    raise NativeQ8Error(503, "native Q8 engine closed")
                if (not isinstance(text, str) or not text.strip() or len(text) > 80
                        or "\0" in text or any(0xD800 <= ord(c) <= 0xDFFF for c in text)):
                    raise NativeQ8Error(400, "text must contain 1..80 Unicode codepoints")
                if not isinstance(deadline, (int, float)) or not math.isfinite(deadline):
                    raise NativeQ8Error(503, "synthesis deadline exceeded")
                _check_cancel(cancel, deadline)

                def poll_cancel(_user_data):
                    # No Qt call, log or exception escapes this worker callback.
                    try:
                        return cancel.is_set() or time.monotonic() >= deadline
                    except Exception:
                        return True

                callback = CancelCallback(poll_cancel)
                text_buffer = C.create_string_buffer(text.encode("utf-8"))
                params = QtTtsParams()
                self._lib.qt_tts_default_params(C.byref(params))
                if params.abi_version != ABI_VERSION:
                    raise NativeQ8Error(503, "unsupported native Q8 version")
                params.text = C.cast(text_buffer, C.c_char_p)
                params.lang = b"chinese"
                params.instruct = params.speaker = params.dump_dir = None
                params.ref_audio_24k = C.POINTER(C.c_float)()
                params.ref_n_samples = 0
                params.ref_text = C.cast(self._reference_text, C.c_char_p)
                params.ref_spk_emb = self._voice.ref_spk_emb
                params.ref_spk_dim = self._voice.ref_spk_dim
                params.ref_codes = self._voice.ref_codes
                params.ref_T = self._voice.ref_T
                params.seed, params.max_new_tokens = 42, MAX_FRAMES
                params.cancel, params.cancel_user_data = callback, None
                params.on_chunk, params.on_chunk_user_data = ChunkCallback(), None
                observer = _Observation("synthesis")
                _set_observer(observer)
                audio_owned = True
                rc = self._lib.qt_synthesize(self._context, C.byref(params), C.byref(audio))
                _set_observer(None)
                # A cancelled request retires cleanly in the persistent C
                # context. Unexpected statuses still invalidate it, even if
                # cancellation raced that failure. Never return late audio.
                if rc not in (0, -5):
                    raise NativeQ8Error(500, "native synthesis failed")
                _check_cancel(cancel, deadline)
                if rc == -5:
                    raise NativeQ8Error(409, "request cancelled")
                # max_new_tokens exhaustion returns OK in this ABI. Only an
                # actual EOS in THIS invocation proves complete output.
                if len(observer.eos_steps) != 1 or not 0 < observer.eos_steps[0] < MAX_FRAMES:
                    raise NativeQ8Error(503, "incomplete native audio")
                result = _wav_bytes(audio)
                _check_cancel(cancel, deadline)
                return result
            except NativeQ8Error as error:
                # Bad input never touched the context; cooperative user
                # cancellation has fully retired before qt_synthesize returns.
                # Retain validated weights/reference for the next utterance.
                if error.status not in (400, 409):
                    self._free()
                raise
            except Exception:
                self._free()
                raise NativeQ8Error(500, "native synthesis failed") from None
            finally:
                _set_observer(None)
                if audio_owned:
                    self._lib.qt_audio_free(C.byref(audio))
