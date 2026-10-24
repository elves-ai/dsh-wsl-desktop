"""Loopback-only, offline Qwen3 Q8 ROCm narration service. No GPU import at startup.

Engine injection is an in-process testing API, never a production CLI mode.
"""
from __future__ import annotations

import argparse
from collections import OrderedDict, deque
from dataclasses import dataclass, field
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import multiprocessing
import os
from pathlib import Path
import re
import signal
import struct
import sys
import threading
import time
import wave

IDENTITY = {"service": "dsh-pet-qwen", "protocol": 1, "voice_id": "pet-airhead-v1"}
MAX_BODY = 4096
MAX_AUDIO = 2 * 1024 * 1024
SAMPLE_RATE = 24000
MAX_SECONDS = 30
REQUEST_SECONDS = 180.0
MAX_TOKENS = 360  # 12 Hz; EOS still required, never return a token-limited fragment.
VOICE_DIR = Path(__file__).resolve().parent / "voice"
REFERENCE_SHA256 = "1d7b3268b755fd9ec261f885b3886c47a3f0cb3fc927de33bd9641127ce223f8"
REFERENCE_TEXT = "欸？你回来啦……我才没有一直等你呢！嘿嘿，好像又说漏嘴了。今天也要一起加油哦！"
ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{8,80}\Z")


class ServiceError(Exception):
    def __init__(self, status: int, error: str):
        self.status, self.error = status, error
        super().__init__(error)


def check_cancel(cancel, deadline):
    if cancel.is_set():
        raise ServiceError(409, "request cancelled")
    if time.monotonic() >= deadline:
        raise ServiceError(503, "synthesis deadline exceeded")


def validate_id(value):
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise ServiceError(400, "invalid request_id")
    return value


def validate_text(value):
    if (not isinstance(value, str) or not value.strip() or len(value) > 80
            or "\0" in value or any(0xD800 <= ord(c) <= 0xDFFF for c in value)):
        raise ServiceError(400, "text must contain 1..80 Unicode codepoints")
    return value


def validate_wav(data):
    """Accept only a complete, bounded RIFF/WAVE PCM16 mono 24 kHz response."""
    if not isinstance(data, bytes) or not 44 <= len(data) <= MAX_AUDIO:
        raise ServiceError(500, "invalid generated WAV")
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE" or struct.unpack_from("<I", data, 4)[0] != len(data) - 8:
        raise ServiceError(500, "invalid generated WAV")
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            frames = wav.getnframes()
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, SAMPLE_RATE, "NONE"):
                raise ValueError("format")
            if not 0 < frames <= SAMPLE_RATE * MAX_SECONDS or len(wav.readframes(frames)) != frames * 2:
                raise ValueError("length")
    except (wave.Error, EOFError, ValueError, struct.error):
        raise ServiceError(500, "invalid generated WAV") from None
    return data


def load_voice():
    profile = json.loads((VOICE_DIR / "profile.json").read_text(encoding="utf-8"))
    audio = (VOICE_DIR / "reference.wav").read_bytes()
    if (profile.get("voice_id") != IDENTITY["voice_id"]
            or profile.get("reference_text") != REFERENCE_TEXT
            or profile.get("selected_clip") != "second_clip_style_performance"
            or profile.get("sha256") != REFERENCE_SHA256
            or hashlib.sha256(audio).hexdigest() != REFERENCE_SHA256):
        raise ServiceError(503, "selected voice assets do not match")
    validate_wav(audio)
    return profile


def guarded_talker_generate(original, criterion, criteria_list, eos_id, cancel, deadline):
    """SDK 0.1.1 discards stopping_criteria in its outer generate; attach here.

    A criterion exception unwinds torch generation immediately, skipping the SDK's
    codec decode. Codec decode itself is monolithic: the parent process supplies
    a hard cancellation/deadline fallback for that stage and model loading.
    """
    def generate(*args, **kwargs):
        check_cancel(cancel, deadline)
        existing = list(kwargs.pop("stopping_criteria", None) or [])
        kwargs["stopping_criteria"] = criteria_list(existing + [criterion])
        kwargs["max_new_tokens"] = MAX_TOKENS
        result = original(*args, **kwargs)
        check_cancel(cancel, deadline)
        # The outer SDK strips EOS/termination metadata before decoding. Inspect
        # the actual HF sequence here, and fail closed if SDK shape changes.
        if not hasattr(result, "sequences") or result.sequences.shape[0] != 1:
            raise ServiceError(500, "unsupported generation result")
        if int(result.sequences[0, -1].item()) != eos_id:
            raise ServiceError(503, "generation ended without EOS (audio/token limit)")
        return result
    return generate


class _BaseEngine:
    """Private FP32 regression diagnostic only; never used by production startup."""
    def __init__(self, model_dir, device, threads):
        # Set these BEFORE importing transformers/huggingface, also covering SDK
        # helpers that forget to forward local_files_only to nested processors.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_DATASETS_OFFLINE"] = "1"
        import torch
        from qwen_tts import Qwen3TTSModel
        self.torch = torch
        torch.set_num_threads(threads)
        torch.set_num_interop_threads(1)
        config = json.loads((Path(model_dir) / "config.json").read_text(encoding="utf-8"))
        if config.get("tts_model_type") != "base" or config.get("tokenizer_type") != "qwen3_tts_tokenizer_12hz":
            raise ServiceError(503, "model directory must contain Qwen3 12Hz Base")
        profile = load_voice()
        self.model = Qwen3TTSModel.from_pretrained(
            model_dir, device_map=device, dtype=torch.float32,
            attn_implementation="eager", local_files_only=True, trust_remote_code=False,
        )
        if self.model.model.tts_model_type != "base":
            raise ServiceError(503, "only Base voice cloning is supported")
        self.model.model.eval()
        self.prompt = self.model.create_voice_clone_prompt(
            ref_audio=str(VOICE_DIR / "reference.wav"),
            ref_text=profile["reference_text"], x_vector_only_mode=False,
        )

    def synthesize(self, text, cancel, deadline):
        from transformers import StoppingCriteria, StoppingCriteriaList
        check_cancel(cancel, deadline)

        class Stop(StoppingCriteria):
            def __call__(self, input_ids, scores, **kwargs):
                check_cancel(cancel, deadline)
                return False

        talker = self.model.model.talker
        original = talker.generate
        had_override = "generate" in talker.__dict__
        talker.generate = guarded_talker_generate(
            original, Stop(), StoppingCriteriaList,
            self.model.model.config.talker_config.codec_eos_token_id,
            cancel, deadline,
        )
        try:
            self.torch.manual_seed(42)
            wavs, rate = self.model.generate_voice_clone(
                text=text, language="Auto", voice_clone_prompt=self.prompt,
                max_new_tokens=MAX_TOKENS,
            )
        finally:
            if had_override:
                talker.generate = original
            else:
                del talker.generate
        check_cancel(cancel, deadline)
        import numpy as np
        if rate != SAMPLE_RATE or len(wavs) != 1:
            raise ServiceError(500, "invalid model audio format")
        audio = np.asarray(wavs[0])
        if (audio.ndim != 1 or not 0 < audio.size <= MAX_SECONDS * SAMPLE_RATE
                or not np.isfinite(audio).all()):
            raise ServiceError(503, "generated audio exceeds limits or is invalid")
        pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes(pcm)
        return validate_wav(output.getvalue())


def _engine_child(connection, cancel, model_dir, native_lib, device):
    engine = None
    native_error = ()
    state_messages = False

    def state(value, error=None):
        if state_messages:
            connection.send(("state", value, error))

    def discard():
        nonlocal engine
        if engine is not None:
            try:
                engine.close()
            except Exception:
                pass
        engine = None
    try:
        while True:
            message = connection.recv()
            if message is None:
                break
            # Two-field messages remain supported for in-process engine tests.
            state_messages = len(message) == 3
            action, text, deadline = message if state_messages else ("synthesize", *message)
            try:
                check_cancel(cancel, deadline)
                if engine is None:
                    state("loading")
                    # Validate the pinned voice before importing/loading native code.
                    load_voice()
                    try:
                        if __package__:
                            from .native_q8 import NativeQ8Engine, NativeQ8Error
                        else:
                            from native_q8 import NativeQ8Engine, NativeQ8Error
                        native_error = (NativeQ8Error,)
                        engine = NativeQ8Engine(
                            model_dir, native_lib, device,
                            reference_wav=str(VOICE_DIR / "reference.wav"),
                            reference_text=REFERENCE_TEXT,
                            expected_reference_sha256=REFERENCE_SHA256,
                        )
                    except (ImportError, OSError, *native_error):
                        raise ServiceError(503, "local Qwen native library not available") from None
                check_cancel(cancel, deadline)
                state("ready")
                if action == "prepare":
                    # Construction loads models and caches the full selected voice.
                    # No dummy text or synthesized audio is needed for readiness.
                    connection.send((200, None))
                else:
                    state("generating")
                    data = validate_wav(engine.synthesize(text, cancel, deadline))
                    check_cancel(cancel, deadline)
                    state("ready")
                    connection.send((200, data))
            except native_error as exc:
                # Routine rejection/cancellation leaves a healthy native context.
                # Terminal failures may have closed it; discard only those.
                if exc.status not in (400, 409):
                    discard()
                    state("error", "engine_failed")
                else:
                    state("ready" if engine is not None else "unloaded")
                # Even adapter/native diagnostics must never reach HTTP clients.
                check_status = exc.status if exc.status in (400, 409, 503) else 500
                message = {400: "invalid synthesis request", 409: "request cancelled",
                           503: "local Qwen engine unavailable",
                           500: "local Qwen engine failed"}[check_status]
                connection.send((check_status, message))
            except ServiceError as exc:
                if exc.status not in (400, 409):
                    discard()
                    state("error", "engine_failed")
                else:
                    state("ready" if engine is not None else "unloaded")
                connection.send((exc.status, exc.error))
            except Exception:
                discard()
                state("error", "engine_failed")
                # Neither tracebacks nor exception messages may disclose text.
                connection.send((500, "local Qwen engine failed"))
    except (EOFError, BrokenPipeError, OSError):
        pass
    finally:
        if engine is not None:
            try:
                engine.close()
            except Exception:
                pass
        connection.close()


def validate_engine_settings(model_dir, native_lib, device):
    """Validate local configuration without importing/loading a GPU library."""
    if not isinstance(device, str) or not re.fullmatch(r"ROCm(?:0|[1-9][0-9]?)", device):
        raise ServiceError(503, "device must be ROCm followed by 1..2 digits; no CPU fallback")
    try:
        model = Path(model_dir).expanduser().resolve()
        library = Path(native_lib).expanduser().resolve()
        if not model.is_dir():
            raise ServiceError(503, "model directory is not available")
        if not library.is_file():
            raise ServiceError(503, "local Qwen native library not available")
    except (OSError, ValueError, TypeError):
        raise ServiceError(503, "local Qwen configuration is invalid") from None
    return str(model), str(library), device


class QwenEngine:
    """Lazy resident process; hard bounds even if loading/codec decode stalls."""
    def __init__(self, model_dir, native_lib, device="ROCm0"):
        self.settings = validate_engine_settings(model_dir, native_lib, device)
        self.context = multiprocessing.get_context("spawn")
        self.lock = threading.Lock()
        self.process = self.connection = self.cancel_event = None
        self.closed = False
        self.state_lock = threading.Lock()
        self.model_state, self.error_code = "unloaded", None

    def _state(self, state, error=None):
        with self.state_lock:
            if not self.closed:
                self.model_state, self.error_code = state, error

    def status(self):
        # Cached IPC state only: no imports, subprocess, model or filesystem work.
        with self.state_lock:
            return {"model_state": self.model_state, "error_code": self.error_code}

    def _start(self):
        with self.lock:
            if self.closed:
                raise ServiceError(503, "service shutting down")
            if self.process is not None and not self.process.is_alive():
                self.connection.close()
                self.process.join(timeout=0)
                self.process = self.connection = self.cancel_event = None
            if self.process is None:
                parent, child = self.context.Pipe()
                cancel = self.context.Event()
                process = self.context.Process(target=_engine_child,
                    args=(child, cancel, *self.settings), daemon=True)
                process.start()
                child.close()
                self.connection, self.cancel_event, self.process = parent, cancel, process
                threading.Thread(target=self._watch_process, args=(process,),
                                 name="qwen-child-state", daemon=True).start()
            return self.process, self.connection, self.cancel_event

    def _watch_process(self, process):
        # Observe idle child crashes independently of HTTP; refresh remains cached.
        process.join()
        with self.lock:
            if self.process is process and not self.closed:
                self._state("error", "engine_exited")

    def _stop(self, graceful=False):
        with self.lock:
            if self.process is not None:
                self.cancel_event.set()
                if graceful and self.process.is_alive():
                    try:
                        self.connection.send(None)
                    except (EOFError, BrokenPipeError, OSError):
                        pass
                    self.process.join(timeout=2.0)
                if self.process.is_alive():
                    self.process.terminate()
                self.process.join(timeout=1)
                if self.process.is_alive():
                    self.process.kill()
                    self.process.join(timeout=1)
                self.connection.close()
                self.process = self.connection = self.cancel_event = None
        self._state("unloaded")

    def prepare(self, cancel, deadline):
        return self._exchange("prepare", None, cancel, deadline)

    def synthesize(self, text, cancel, deadline):
        return self._exchange("synthesize", text, cancel, deadline)

    def _exchange(self, action, text, cancel, deadline):
        check_cancel(cancel, deadline)
        process, connection, shared_cancel = self._start()
        shared_cancel.clear()
        cancelled_at = None
        try:
            connection.send((action, text, deadline))
            while True:
                now = time.monotonic()
                if now >= deadline:
                    shared_cancel.set()
                    self._stop()
                    self._state("error", "deadline_exceeded")
                    raise ServiceError(503, "synthesis deadline exceeded")
                if cancel.is_set():
                    shared_cancel.set()
                    if cancelled_at is None:
                        cancelled_at = now
                    if now - cancelled_at >= 2.0:
                        self._stop()
                        raise ServiceError(409, "request cancelled")
                if connection.poll(min(0.05, max(0, deadline - now))):
                    message = connection.recv()
                    if len(message) == 3 and message[0] == "state":
                        _, state, error = message
                        self._state(state, error)
                        continue
                    status, result = message
                    check_cancel(cancel, deadline)
                    if status != 200:
                        raise ServiceError(status, result)
                    return None if action == "prepare" else validate_wav(result)
                if not process.is_alive():
                    self._stop()
                    self._state("error", "engine_exited")
                    raise ServiceError(503, "local Qwen engine exited")
        except (EOFError, BrokenPipeError, OSError):
            self._stop()
            self._state("error", "engine_exited")
            raise ServiceError(503, "local Qwen engine unavailable") from None

    def close(self):
        with self.lock:
            self.closed = True
        self._stop(graceful=True)
        with self.state_lock:
            self.model_state, self.error_code = "unloaded", None


@dataclass
class Job:
    request_id: str
    text: str
    deadline: float
    cancel: threading.Event = field(default_factory=threading.Event)
    done: threading.Event = field(default_factory=threading.Event)
    audio: bytes | None = None
    error: ServiceError | None = None
    prepare: bool = False


class SynthesisService:
    def __init__(self, engine, runtime=REQUEST_SECONDS):
        self.engine, self.runtime = engine, runtime
        self.condition = threading.Condition()
        self.queue = deque()
        self.active = None
        self.recent = OrderedDict()  # bounded tombstones: cancelled AND used IDs
        self.closed = False
        self.worker = threading.Thread(target=self._work, name="qwen-worker", daemon=True)
        self.worker.start()

    def _remember(self, request_id, cancel=None):
        self.recent[request_id] = cancel if cancel is not None else threading.Event()
        self.recent.move_to_end(request_id)
        while len(self.recent) > 256:
            self.recent.popitem(last=False)

    def submit(self, request_id, text):
        validate_id(request_id)
        validate_text(text)
        with self.condition:
            if self.closed:
                raise ServiceError(503, "service shutting down")
            if (request_id in self.recent
                    or (self.active and self.active.request_id == request_id)
                    or any(job.request_id == request_id for job in self.queue)):
                raise ServiceError(409, "request_id already used or cancelled")
            if len(self.queue) >= 1:
                raise ServiceError(429, "synthesis queue full")
            job = Job(request_id, text, time.monotonic() + self.runtime)
            self._remember(request_id, job.cancel)
            self.queue.append(job)
            self.condition.notify_all()
            return job

    def status(self):
        with self.condition:
            cached = self.engine.status() if hasattr(self.engine, "status") else {
                "model_state": "unknown", "error_code": None}
            return {**cached, "active": self.active is not None, "pending": len(self.queue)}

    def prepare(self):
        with self.condition:
            if self.closed:
                raise ServiceError(503, "service shutting down")
            if self.active is not None or self.queue:
                raise ServiceError(409, "service busy")
            job = Job("", "", time.monotonic() + self.runtime, prepare=True)
            self.queue.append(job)
            self.condition.notify_all()
        if not job.done.wait(max(0, job.deadline - time.monotonic())):
            job.cancel.set()
            raise ServiceError(503, "preparation deadline exceeded")
        with self.condition:
            if self.closed:
                raise ServiceError(503, "service shutting down")
            if job.error:
                raise job.error
            check_cancel(job.cancel, job.deadline)

    def cancel(self, request_id):
        validate_id(request_id)
        with self.condition:
            token = self.recent.get(request_id)
            self._remember(request_id, token)  # includes cancel-before-submit race
            self.recent[request_id].set()
            jobs = list(self.queue)
            if self.active is not None:
                jobs.append(self.active)
            for job in jobs:
                if job.request_id == request_id:
                    job.cancel.set()
                    job.audio = None
                    job.error = ServiceError(409, "request cancelled")
                    job.done.set()
                    if job in self.queue:
                        self.queue.remove(job)
            self.condition.notify_all()

    def _work(self):
        while True:
            with self.condition:
                self.condition.wait_for(lambda: self.closed or bool(self.queue))
                if self.closed:
                    return
                job = self.queue.popleft()
                self.active = job
                self.condition.notify_all()
            try:
                check_cancel(job.cancel, job.deadline)
                if job.prepare:
                    self.engine.prepare(job.cancel, job.deadline)
                    audio = None
                else:
                    audio = validate_wav(self.engine.synthesize(job.text, job.cancel, job.deadline))
                check_cancel(job.cancel, job.deadline)
                with self.condition:
                    check_cancel(job.cancel, job.deadline)
                    job.audio = audio
            except ServiceError as exc:
                job.error = exc
            except Exception:
                job.error = ServiceError(500, "synthesis failed")
            finally:
                # Never retain spoken input after the request finishes.
                job.text = ""
                with self.condition:
                    self.active = None
                    job.done.set()
                    self.condition.notify_all()

    def result(self, job):
        remaining = max(0, job.deadline - time.monotonic())
        if not job.done.wait(remaining):
            self.cancel(job.request_id)
            raise ServiceError(503, "synthesis deadline exceeded")
        with self.condition:
            if job.cancel.is_set():
                raise ServiceError(409, "request cancelled")
            if job.error:
                raise job.error
            if job.audio is None:
                raise ServiceError(500, "synthesis failed")
            return job.audio

    def close(self):
        with self.condition:
            self.closed = True
            for job in list(self.queue) + ([self.active] if self.active else []):
                job.cancel.set()
                job.audio = None
                job.text = ""
                job.error = ServiceError(503, "service shutting down")
                job.done.set()
            self.queue.clear()
            self.condition.notify_all()
        self.engine.close()
        self.worker.join(timeout=3)


class QwenHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    allow_reuse_address = True
    request_queue_size = 16

    def __init__(self, port, service, *, managed=None, gpu_name=None):
        self.service = service
        self._managed = validate_managed_identity(managed) if managed is not None else None
        self.device = getattr(service.engine, "settings", (None, None, "ROCm0"))[2]
        self.gpu_name = gpu_name if (isinstance(gpu_name, str) and len(gpu_name) <= 256
                                     and gpu_name.isprintable()) else None
        self.shutdown_started = threading.Event()
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(("127.0.0.1", port), Handler)

    def status(self):
        return {**IDENTITY, "status_protocol": 1,
                "instance_id": self._managed["instance_id"] if self._managed else None,
                "backend": "rocm", "device": self.device, "gpu_name": self.gpu_name,
                **self.service.status()}

    def managed_shutdown(self):
        if not self.shutdown_started.is_set():
            self.shutdown_started.set()
            # ACK has already been sent. Close interrupts active init/generation,
            # including the helper's bounded cooperative/hard-kill fallback.
            def stop():
                self.service.close()
                self.shutdown()
            threading.Thread(target=stop, name="qwen-shutdown", daemon=True).start()

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            body = b'{"error":"too many connections"}'
            try:
                request.settimeout(0.2)
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def server_close(self):
        self.service.close()
        super().server_close()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "dsh-pet-qwen"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, format, *args):
        pass  # Paths, invalid request lines, and exceptions can contain text.

    def send_error(self, code, message=None, explain=None):
        # Includes malformed request lines and unsupported methods; no HTML.
        self._json(code if code in (400, 403, 409, 429, 503, 500) else 400,
                   {"error": "invalid HTTP request"})

    def _reply(self, status, payload, content_type):
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    def _json(self, status, payload):
        self._reply(status, json.dumps(payload, ensure_ascii=True).encode(), "application/json")

    def _security(self):
        if self.headers.get_all("Origin") is not None:
            raise ServiceError(403, "Origin is forbidden")
        hosts = self.headers.get_all("Host", [])
        if hosts != [f"127.0.0.1:{self.server.server_port}"]:
            raise ServiceError(403, "unexpected Host")
        if self.headers.get_all("Transfer-Encoding") is not None:
            raise ServiceError(400, "transfer encoding is forbidden")
        if self.headers.get_all("Expect") is not None:
            raise ServiceError(400, "Expect is forbidden")

    def handle_expect_100(self):
        self._json(400, {"error": "Expect is forbidden"})
        return False

    def _body(self):
        types = self.headers.get_all("Content-Type", [])
        if len(types) != 1 or types[0].strip().lower() != "application/json":
            raise ServiceError(400, "Content-Type must be application/json")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,4}", lengths[0]):
            raise ServiceError(400, "invalid Content-Length")
        length = int(lengths[0])
        if not 0 < length <= MAX_BODY:
            raise ServiceError(400, "request body exceeds limits")
        try:
            raw = self.rfile.read(length)
        except (TimeoutError, OSError):
            raise ServiceError(400, "incomplete request body") from None
        if len(raw) != length:
            raise ServiceError(400, "incomplete request body")

        def unique(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError("duplicate key")
                value[key] = item
            return value
        try:
            value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique,
                               parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, RecursionError):
            raise ServiceError(400, "invalid JSON") from None
        if not isinstance(value, dict):
            raise ServiceError(400, "JSON object required")
        return value

    def do_GET(self):
        try:
            self._security()
            if self.path not in ("/health", "/v1/status") or self.headers.get_all("Content-Length") not in (None, ["0"]):
                raise ServiceError(400, "unknown or invalid endpoint")
            self._json(200, IDENTITY if self.path == "/health" else self.server.status())
        except ServiceError as exc:
            self._json(exc.status, {"error": exc.error})

    def _control(self, body):
        managed = self.server._managed
        tokens = self.headers.get_all("X-DSH-Speech-Control", [])
        token = tokens[0] if len(tokens) == 1 else ""
        instance = body.get("instance_id")
        # Compare BOTH fields in constant time, including a wrong instance.
        # Restrict to bounded ASCII before compare_digest (which rejects Unicode).
        token = token if re.fullmatch(r"[0-9a-f]{64}", token) else ""
        instance = instance if isinstance(instance, str) and ID_PATTERN.fullmatch(instance) else ""
        token_ok = hmac.compare_digest(token, managed["control_token"] if managed else "!disabled")
        instance_ok = hmac.compare_digest(instance, managed["instance_id"] if managed else "!disabled")
        if not (token_ok & instance_ok):
            raise ServiceError(403, "management forbidden")
        if set(body) != {"instance_id", "action"} or body["action"] not in ("status", "prepare", "shutdown"):
            raise ServiceError(400, "unexpected control fields or action")
        action = body["action"]
        if action == "prepare":
            self.server.service.prepare()
        self._json(200, self.server.status())
        if action == "shutdown":
            self.wfile.flush()
            self.server.managed_shutdown()

    def do_POST(self):
        job = None
        try:
            self._security()
            if self.path not in ("/v1/synthesize", "/v1/cancel", "/v1/control"):
                raise ServiceError(400, "unknown endpoint")
            body = self._body()
            if self.path == "/v1/control":
                self._control(body)
                return
            expected = {"request_id", "text"} if self.path == "/v1/synthesize" else {"request_id"}
            if set(body) != expected:
                raise ServiceError(400, "unexpected request fields")
            request_id = validate_id(body["request_id"])
            if self.path == "/v1/cancel":
                self.server.service.cancel(request_id)
                self._json(200, {"request_id": request_id, "cancelled": True})
            else:
                job = self.server.service.submit(request_id, validate_text(body["text"]))
                self._reply(200, self.server.service.result(job), "audio/wav")
        except ServiceError as exc:
            self._json(exc.status, {"error": exc.error})
        except (OSError, ValueError):
            if job:
                self.server.service.cancel(job.request_id)
            self._json(400, {"error": "invalid request"})


def validate_managed_identity(value):
    if (not isinstance(value, dict) or set(value) != {"instance_id", "control_token"}
            or not isinstance(value["instance_id"], str)
            or not ID_PATTERN.fullmatch(value["instance_id"])
            or not isinstance(value["control_token"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", value["control_token"])):
        raise ServiceError(400, "invalid managed startup identity")
    return dict(value)


def read_managed_identity(source):
    # This secret is bound to inherited stdin only; never argv, env, HTTP or logs.
    raw = source.readline(1025)
    if len(raw) > 1024 or not raw.endswith(b"\n"):
        raise ServiceError(400, "invalid managed startup identity")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError()
            result[key] = value
        return result
    try:
        return validate_managed_identity(json.loads(raw.decode("utf-8"), object_pairs_hook=unique))
    except (ValueError, RecursionError):
        raise ServiceError(400, "invalid managed startup identity") from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", default=os.environ.get("DSH_QWEN_MODEL_DIR"),
                        help="explicit local Qwen3 12Hz Base directory (or DSH_QWEN_MODEL_DIR)")
    parser.add_argument("--native-lib", default=os.environ.get("DSH_QWEN_NATIVE_LIB"),
                        help="external Q8 ROCm shared library (or DSH_QWEN_NATIVE_LIB)")
    parser.add_argument("--device", default="ROCm0", help="ROCm GPU device, e.g. ROCm0 (no CPU fallback)")
    parser.add_argument("--port", type=int, default=18765)
    parser.add_argument("--managed-stdin", action="store_true", help="read private management identity from bound stdin")
    args = parser.parse_args(argv)
    managed = None
    if args.managed_stdin:
        try:
            managed = read_managed_identity(sys.stdin.buffer)
        except ServiceError:
            parser.error("invalid managed startup identity")
    if not args.model_dir:
        parser.error("--model-dir or DSH_QWEN_MODEL_DIR is required")
    if not args.native_lib:
        parser.error("--native-lib or DSH_QWEN_NATIVE_LIB is required")
    if not 1 <= args.port <= 65535:
        parser.error("port must be 1..65535")
    try:
        settings = validate_engine_settings(args.model_dir, args.native_lib, args.device)
    except ServiceError as exc:
        parser.error(exc.error)
    if __package__:
        from .runtime_check import is_wsl2, report
    else:
        from runtime_check import is_wsl2, report
    if not is_wsl2():
        parser.error("Qwen inference must run inside WSL2; Windows only hosts the desktop UI")
    probe = report(check_gpu=True, device=args.device)
    if not probe.get("gpu_compute_verified"):
        parser.error("WSL ROCm GPU compute is not ready; check the ROCm 10.1 runtime. No CPU fallback")
    try:
        load_voice()
    except Exception:
        parser.error("selected voice assets are unavailable or invalid")
    service = SynthesisService(QwenEngine(*settings))
    try:
        server = QwenHTTPServer(args.port, service, managed=managed, gpu_name=probe.get("gpu_name"))
    except OSError:
        service.close()
        parser.error("local Qwen listener is not available")
    except BaseException:
        service.close()
        raise
    def stop_signal(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop_signal)
    print(f"dsh-pet-qwen listening on http://127.0.0.1:{args.port}; lazy offline Q8 ROCm, {args.device}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
