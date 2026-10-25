"""Offline service tests: stdlib only, no torch/model required.

Run: python3 -m unittest discover -s tests -p test_qwen_tts.py -v
"""
import concurrent.futures
import http.client
import io
import json
import os
from pathlib import Path
import socket
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

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.qwen_tts import server as qwen


def wav_bytes(frames=240, rate=24000, channels=1, width=2):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(width)
        wav.setframerate(rate)
        wav.writeframes(b"\0" * frames * channels * width)
    return output.getvalue()


class NativeError(Exception):
    def __init__(self, status, error):
        self.status, self.error = status, error
        super().__init__(error)


class FakeEngine:
    def __init__(self, block=False, output=None, failure=None):
        self.block, self.output, self.failure = block, output, failure
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = []
        self.closed = False

    def synthesize(self, text, cancel, deadline):
        self.calls.append(text)
        self.started.set()
        if self.block:
            self.release.wait(3)  # deterministic bounded event; no sleep/poll
        qwen.check_cancel(cancel, deadline)
        if self.failure:
            raise self.failure
        return wav_bytes() if self.output is None else self.output

    def close(self):
        self.closed = True
        self.release.set()


class TestValidation(unittest.TestCase):
    def test_import_and_cli_help_do_not_import_torch(self):
        code = ("import sys; from services.qwen_tts import server; "
                "assert 'torch' not in sys.modules; assert 'qwen_tts' not in sys.modules; "
                "assert 'services.qwen_tts.native_q8' not in sys.modules; "
                "assert server.QwenEngine('.', server.__file__).process is None")
        result = subprocess.run([sys.executable, "-c", code], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run([sys.executable, str(Path(qwen.__file__)), "--help"],
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(b"--fake", result.stdout)
        self.assertNotIn(b"--host", result.stdout)
        self.assertNotIn(b"--threads", result.stdout)
        self.assertNotIn(b"FP32", result.stdout)
        self.assertIn(b"--native-lib", result.stdout)
        self.assertIn(b"ROCm", result.stdout)

    def test_cli_requires_explicit_local_model_directory(self):
        env = dict(os.environ)
        env.pop("DSH_QWEN_MODEL_DIR", None)
        result = subprocess.run([sys.executable, str(Path(qwen.__file__))], env=env,
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"--model-dir", result.stderr)

    def test_selected_portable_voice_integrity(self):
        profile = qwen.load_voice()
        self.assertEqual(profile["reference_text"], qwen.REFERENCE_TEXT)
        self.assertEqual(profile["reference_audio"], "reference.wav")
        self.assertEqual((qwen.VOICE_DIR / "reference.wav").stat().st_size, 403244)

    def test_base_loader_uses_only_selected_reference_and_offline_fp32(self):
        calls = {}
        class Model:
            model = types.SimpleNamespace(tts_model_type="base", eval=lambda: calls.update(eval=True))
            def create_voice_clone_prompt(self, **kwargs):
                calls["prompt"] = kwargs
                return ["cached-selected-prompt"]
        class SDK:
            @classmethod
            def from_pretrained(cls, path, **kwargs):
                calls["load"] = kwargs
                return Model()
        torch = types.SimpleNamespace(float32="fp32", set_num_threads=lambda n: calls.update(threads=n),
                                      set_num_interop_threads=lambda n: None)
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "config.json").write_text(json.dumps({
                "tts_model_type": "base", "tokenizer_type": "qwen3_tts_tokenizer_12hz"}))
            with patch.dict(sys.modules, {"torch": torch, "qwen_tts": types.SimpleNamespace(Qwen3TTSModel=SDK)}), \
                    patch.dict(os.environ):
                engine = qwen._BaseEngine(directory, "cpu", 6)
                self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
                self.assertEqual(os.environ["TRANSFORMERS_OFFLINE"], "1")
        self.assertEqual(calls["threads"], 6)
        self.assertEqual(calls["load"], {"device_map": "cpu", "dtype": "fp32",
                                       "attn_implementation": "eager", "local_files_only": True,
                                       "trust_remote_code": False})
        self.assertTrue(calls["eval"])
        self.assertEqual(calls["prompt"], {"ref_audio": str(qwen.VOICE_DIR / "reference.wav"),
                                         "ref_text": qwen.REFERENCE_TEXT, "x_vector_only_mode": False})
        self.assertEqual(engine.prompt, ["cached-selected-prompt"])

    def test_each_synthesis_reseeds_torch_and_preserves_auto_language(self):
        seeds = []
        generations = []
        class Talker:
            def generate(self, **kwargs):
                pass
        talker = Talker()
        inner = types.SimpleNamespace(talker=talker, config=types.SimpleNamespace(
            talker_config=types.SimpleNamespace(codec_eos_token_id=99)))
        def generate(**kwargs):
            self.assertEqual(seeds[-1], 42)
            generations.append(kwargs)
            raise RuntimeError("stop fake before waveform decoding")
        engine = qwen._BaseEngine.__new__(qwen._BaseEngine)
        engine.torch = types.SimpleNamespace(manual_seed=seeds.append)
        engine.prompt = ["selected-reference"]
        engine.model = types.SimpleNamespace(model=inner, generate_voice_clone=generate)
        transformers = types.SimpleNamespace(StoppingCriteria=object, StoppingCriteriaList=list)
        with patch.dict(sys.modules, {"transformers": transformers}):
            for _ in range(2):
                with self.assertRaisesRegex(RuntimeError, "stop fake"):
                    engine.synthesize("hello", threading.Event(), time.monotonic() + 5)
                self.assertNotIn("generate", talker.__dict__)
        self.assertEqual(seeds, [42, 42])
        self.assertEqual([kwargs["language"] for kwargs in generations], ["Auto", "Auto"])
        self.assertTrue(all(kwargs["voice_clone_prompt"] is engine.prompt for kwargs in generations))

    def test_resident_child_loads_base_once_and_reuses_it(self):
        deadline = time.monotonic() + 5
        messages = iter([("one", deadline), ("two", deadline), None])
        results = []
        connection = types.SimpleNamespace(recv=lambda: next(messages), send=results.append,
                                           close=lambda: None)
        fake = FakeEngine()
        load = Mock(return_value=fake)
        module = types.SimpleNamespace(NativeQ8Engine=load, NativeQ8Error=NativeError)
        with patch.dict(sys.modules, {"services.qwen_tts.native_q8": module}):
            qwen._engine_child(connection, threading.Event(), "local-model", "native.so", "ROCm0")
        load.assert_called_once_with("local-model", "native.so", "ROCm0",
                                     reference_wav=str(qwen.VOICE_DIR / "reference.wav"),
                                     reference_text=qwen.REFERENCE_TEXT,
                                     expected_reference_sha256=qwen.REFERENCE_SHA256)
        self.assertTrue(fake.closed)
        self.assertEqual(fake.calls, ["one", "two"])
        self.assertEqual([status for status, _ in results], [200, 200])

    def test_native_load_errors_are_safe_503_and_retryable(self):
        private = "/private/model/path secret input"
        for error in [OSError(private), ImportError(private), NativeError(503, private)]:
            results = []
            messages = iter([("hello", time.monotonic() + 5), None])
            connection = types.SimpleNamespace(recv=lambda: next(messages), send=results.append, close=Mock())
            loader = Mock(side_effect=error)
            module = types.SimpleNamespace(NativeQ8Engine=loader, NativeQ8Error=NativeError)
            with patch.dict(sys.modules, {"services.qwen_tts.native_q8": module}):
                qwen._engine_child(connection, threading.Event(), "/private/model", "/private/lib.so", "ROCm0")
            self.assertEqual(results, [(503, "local Qwen native library not available")])
            connection.close.assert_called_once()

    def test_native_failure_drops_context_and_scrubs_private_errors(self):
        broken = FakeEngine(failure=NativeError(503, "/private/model secret text"))
        fresh = FakeEngine()
        results = []
        deadline = time.monotonic() + 5
        messages = iter([("one", deadline), ("two", deadline), None])
        connection = types.SimpleNamespace(recv=lambda: next(messages), send=results.append, close=Mock())
        loader = Mock(side_effect=[broken, fresh])
        module = types.SimpleNamespace(NativeQ8Engine=loader, NativeQ8Error=NativeError)
        with patch.dict(sys.modules, {"services.qwen_tts.native_q8": module}):
            qwen._engine_child(connection, threading.Event(), "model", "lib.so", "ROCm0")
        self.assertEqual([status for status, _ in results], [503, 200])
        self.assertEqual(results[0][1], "local Qwen engine unavailable")
        self.assertEqual(loader.call_count, 2)
        self.assertTrue(broken.closed and fresh.closed)

    def test_native_cancel_or_rejection_then_reuse_healthy_context(self):
        for status in (400, 409):
            with self.subTest(status=status):
                engine = FakeEngine()
                synthesize = Mock(side_effect=[NativeError(status, "/private/text"), wav_bytes()])
                engine.synthesize = synthesize
                loader = Mock(return_value=engine)
                results = []
                deadline = time.monotonic() + 5
                messages = iter([("one", deadline), ("two", deadline), None])
                def receive():
                    # Engine must remain open until the child's final cleanup.
                    self.assertFalse(engine.closed)
                    return next(messages)
                connection = types.SimpleNamespace(recv=receive, send=results.append, close=Mock())
                module = types.SimpleNamespace(NativeQ8Engine=loader, NativeQ8Error=NativeError)
                with patch.dict(sys.modules, {"services.qwen_tts.native_q8": module}):
                    qwen._engine_child(connection, threading.Event(), "model", "lib.so", "ROCm0")
                loader.assert_called_once()
                self.assertEqual(synthesize.call_count, 2)
                self.assertEqual([code for code, _ in results], [status, 200])
                self.assertNotIn("/private", results[0][1])
                self.assertTrue(engine.closed)

    def test_voice_validation_precedes_native_constructor(self):
        loader = Mock()
        messages = iter([("hello", time.monotonic() + 5), None])
        results = []
        connection = types.SimpleNamespace(recv=lambda: next(messages), send=results.append, close=Mock())
        module = types.SimpleNamespace(NativeQ8Engine=loader, NativeQ8Error=NativeError)
        with patch.dict(sys.modules, {"services.qwen_tts.native_q8": module}), \
                patch.object(qwen, "load_voice", side_effect=qwen.ServiceError(503, "selected voice assets do not match")):
            qwen._engine_child(connection, threading.Event(), "model", "lib.so", "ROCm0")
        loader.assert_not_called()
        self.assertEqual(results, [(503, "selected voice assets do not match")])

    def test_cli_auto_resolves_actual_device_before_creating_worker(self):
        from services.qwen_tts import runtime_check
        for device in ('CUDA0', 'ROCm0', 'CUDA99'):
            backend = 'cuda' if device.startswith('CUDA') else 'rocm'
            probe = {'gpu_compute_verified': True, 'backend': backend, 'device': device, 'gpu_name': 'SIMULATED GPU'}
            with self.subTest(device=device), patch.object(runtime_check, 'is_wsl2', return_value=True), \
                    patch.object(runtime_check, 'report', return_value=probe) as report, \
                    patch.object(qwen, 'load_voice') as voice, patch.object(qwen, 'QwenEngine') as engine, \
                    patch.object(qwen, 'SynthesisService') as service, patch.object(qwen, 'QwenHTTPServer') as http, \
                    patch.object(qwen.signal, 'signal'), patch('builtins.print'):
                args = ['--model-dir', '.', '--native-lib', qwen.__file__]
                if device == 'CUDA99':
                    args.extend(['--device', device])
                qwen.main(args)
                report.assert_called_once_with(check_gpu=True, device=device if device == 'CUDA99' else 'auto')
                self.assertEqual(engine.call_args.args[2], device)
                voice.assert_called_once_with()
                http.return_value.serve_forever.assert_called_once_with()

    def test_cli_refuses_failed_math_cpu_or_wrong_device_without_loading(self):
        from services.qwen_tts import runtime_check
        probes = [
            {'gpu_compute_verified': False, 'backend': 'cuda', 'device': 'CUDA0'},
            {'gpu_compute_verified': True, 'backend': 'cpu', 'device': 'CPU'},
            {'gpu_compute_verified': True, 'backend': 'rocm', 'device': 'CUDA0'},
            {'gpu_compute_verified': True, 'backend': 'cuda', 'device': 'CUDA1'},
            {'gpu_compute_verified': True, 'backend': 'cuda', 'device': 'CUDA00'},
        ]
        for probe in probes:
            with self.subTest(probe=probe), patch.object(runtime_check, 'is_wsl2', return_value=True), \
                    patch.object(runtime_check, 'report', return_value=probe), \
                    patch.object(qwen, 'load_voice') as voice, patch.object(qwen, 'QwenEngine') as engine, \
                    patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit):
                qwen.main(['--model-dir', '.', '--native-lib', qwen.__file__, '--device', 'CUDA0'])
            voice.assert_not_called()
            engine.assert_not_called()

    def test_status_reports_dynamic_actual_backend_and_refuses_cpu(self):
        for device in ('CUDA0', 'CUDA99', 'ROCm0', 'ROCm99'):
            service = types.SimpleNamespace(engine=types.SimpleNamespace(settings=('.', 'native', device)),
                                            status=lambda: {'model_state': 'unloaded'})
            with patch.object(qwen.ThreadingHTTPServer, '__init__', return_value=None):
                server = qwen.QwenHTTPServer(0, service)
                result = server.status()
            self.assertEqual(result['device'], device)
            self.assertEqual(result['backend'], 'cuda' if device.startswith('CUDA') else 'rocm')
        service.engine.settings = ('.', 'native', 'CPU')
        with self.assertRaises(qwen.ServiceError):
            qwen.QwenHTTPServer(0, service)

    def test_production_configuration_has_no_cpu_or_legacy_fallback(self):
        for device in ["cpu", "cuda", "ROCm", "ROCm100", "ROCm-1", "ROCm00", "ROCm01", "ROCm0\n"]:
            with self.assertRaises(qwen.ServiceError):
                qwen.QwenEngine(".", qwen.__file__, device)
        engine = qwen.QwenEngine(".", qwen.__file__)
        self.assertEqual(engine.settings[2], "ROCm0")
        self.assertIsNone(engine.process)
        with self.assertRaises(qwen.ServiceError) as caught:
            qwen.QwenEngine("/private/absent/model", qwen.__file__)
        self.assertNotIn("/private", caught.exception.error)
        with self.assertRaises(qwen.ServiceError) as caught:
            qwen.QwenEngine(".", "/private/absent/lib.so")
        self.assertEqual(caught.exception.error, "local Qwen native library not available")

    def test_voice_substitution_rejected(self):
        with patch.object(qwen, "REFERENCE_SHA256", "0" * 64):
            with self.assertRaises(qwen.ServiceError):
                qwen.load_voice()

    def test_ids_and_unicode_codepoints(self):
        for value in ["a" * 8, "f" * 32, "12345678-abcdef_0", "x" * 80]:
            self.assertEqual(qwen.validate_id(value), value)
        for value in [None, 8, "a" * 7, "x" * 81, "1234567/", "12345678\n", "中文12345678"]:
            with self.subTest(value=value), self.assertRaises(qwen.ServiceError):
                qwen.validate_id(value)
        self.assertEqual(qwen.validate_text("😀" * 80), "😀" * 80)
        for value in [None, 1, "", " \n", "😀" * 81, "\ud800", "hello\0world"]:
            with self.subTest(value=repr(value)), self.assertRaises(qwen.ServiceError):
                qwen.validate_text(value)

    def test_wav_validation(self):
        good = wav_bytes()
        self.assertEqual(qwen.validate_wav(good), good)
        truncated = bytearray(good[:-2])
        struct.pack_into("<I", truncated, 4, len(truncated) - 8)
        cases = [b"", b"RIFF" * 20, good[:-1], good + b"extra", bytes(truncated),
                 wav_bytes(rate=22050), wav_bytes(channels=2), wav_bytes(width=1),
                 wav_bytes(frames=0), wav_bytes(frames=720001), b"0" * (qwen.MAX_AUDIO + 1)]
        for data in cases:
            with self.subTest(length=len(data)), self.assertRaises(qwen.ServiceError):
                qwen.validate_wav(data)

    def test_generation_boundary_injects_criteria_and_requires_eos(self):
        cancel = threading.Event()
        criterion = object()
        captured = {}

        class Sequence:
            shape = (1, 4)
            def __getitem__(self, item):
                return types.SimpleNamespace(item=lambda: 99)

        def original(**kwargs):
            captured.update(kwargs)
            return types.SimpleNamespace(sequences=Sequence())

        guarded = qwen.guarded_talker_generate(original, criterion, list, 99, cancel, time.monotonic() + 5)
        guarded(stopping_criteria=["old"], max_new_tokens=9999)
        self.assertEqual(captured["stopping_criteria"], ["old", criterion])
        self.assertEqual(captured["max_new_tokens"], 360)
        guarded = qwen.guarded_talker_generate(original, criterion, list, 100, cancel, time.monotonic() + 5)
        with self.assertRaises(qwen.ServiceError) as caught:
            guarded()
        self.assertEqual(caught.exception.status, 503)

    def test_cancellation_criterion_unwinds_generation_without_audio(self):
        cancel = threading.Event()
        after_decode = []
        deadline = time.monotonic() + 5
        def criterion(*args, **kwargs):
            qwen.check_cancel(cancel, deadline)
            return False
        def torch_decode(**kwargs):
            cancel.set()  # represents a concurrent cancel during token decode
            kwargs["stopping_criteria"][-1](None, None)
            after_decode.append(True)
        guarded = qwen.guarded_talker_generate(torch_decode, criterion, list, 99, cancel, deadline)
        with self.assertRaises(qwen.ServiceError) as caught:
            guarded()
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(after_decode, [])

    def test_process_engine_deadline_and_cancellation_fallback(self):
        for cancellation, clock, status in [
                (False, [0, 20], 503),
                (True, [0, 1, 4], 409)]:
            engine = qwen.QwenEngine(".", qwen.__file__)
            cancel = threading.Event()
            shared = threading.Event()
            process = types.SimpleNamespace(is_alive=lambda: True)
            class Connection:
                def send(self, message):
                    if cancellation:
                        cancel.set()
                def poll(self, timeout):
                    return False
            with patch.object(engine, "_start", return_value=(process, Connection(), shared)), \
                    patch.object(engine, "_stop") as stop, \
                    patch.object(qwen.time, "monotonic", side_effect=clock):
                with self.assertRaises(qwen.ServiceError) as caught:
                    engine.synthesize("hello", cancel, 10)
                self.assertEqual(caught.exception.status, status)
                self.assertTrue(shared.is_set())
                stop.assert_called_once()


class TestQueue(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine(block=True)
        self.service = qwen.SynthesisService(self.engine)
        self.addCleanup(self.service.close)

    def active(self):
        job = self.service.submit("active_01", "hello")
        self.assertTrue(self.engine.started.wait(2))
        return job

    def error_status(self, status, operation):
        with self.assertRaises(qwen.ServiceError) as caught:
            operation()
        self.assertEqual(caught.exception.status, status)

    def test_one_active_one_queued_then_reject(self):
        active = self.active()
        queued = self.service.submit("queued_01", "next")
        self.error_status(429, lambda: self.service.submit("third_001", "third"))
        self.error_status(409, lambda: self.service.submit("active_01", "duplicate"))
        self.service.cancel(queued.request_id)
        self.error_status(409, lambda: self.service.result(queued))
        self.assertEqual(self.engine.calls, ["hello"])
        self.engine.release.set()
        self.assertEqual(self.service.result(active)[:4], b"RIFF")

    def test_cancel_active_never_returns_truncated_audio_and_fresh_job_runs(self):
        active = self.active()
        self.service.cancel(active.request_id)
        self.error_status(409, lambda: self.service.result(active))
        fresh = self.service.submit("fresh_001", "fresh")
        self.engine.release.set()
        self.assertEqual(self.service.result(fresh), wav_bytes())
        self.assertIsNone(active.audio)
        self.assertEqual(self.engine.calls, ["hello", "fresh"])

    def test_cancel_before_submit_and_bounded_tombstones(self):
        self.service.cancel("future_01")
        self.error_status(409, lambda: self.service.submit("future_01", "late"))
        for i in range(300):
            self.service.cancel(f"cancel_{i:04}")
        self.assertEqual(len(self.service.recent), 256)

    def test_active_id_cannot_be_reused_after_tombstone_eviction(self):
        self.active()
        for i in range(300):
            self.service.cancel(f"cancel_{i:04}")
        self.error_status(409, lambda: self.service.submit("active_01", "duplicate"))

    def test_cancel_after_generation_before_response(self):
        job = self.active()
        self.engine.release.set()
        self.assertTrue(job.done.wait(2))
        self.service.cancel(job.request_id)
        self.error_status(409, lambda: self.service.result(job))

    def test_deadline_does_not_return_audio(self):
        job = self.active()
        job.deadline = time.monotonic() - 1
        self.error_status(503, lambda: self.service.result(job))
        self.assertTrue(job.cancel.is_set())
        self.assertIsNone(job.audio)

    def test_shutdown_cleans_active_and_queued(self):
        active = self.active()
        queued = self.service.submit("queued_01", "next")
        self.service.close()
        self.assertTrue(active.done.is_set())
        self.assertTrue(queued.done.is_set())
        self.assertFalse(self.service.worker.is_alive())
        self.assertTrue(self.engine.closed)
        self.assertFalse(self.service.queue)
        self.error_status(503, lambda: self.service.submit("closed_01", "no"))


class TestHTTP(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()
        self.service = qwen.SynthesisService(self.engine)
        self.server = qwen.QwenHTTPServer(0, self.service)
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.engine.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.assertFalse(self.thread.is_alive())
        self.assertFalse(self.service.worker.is_alive())

    def request(self, method="POST", path="/v1/synthesize", value=None, raw=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        if raw is None and value is not None:
            raw = json.dumps(value, ensure_ascii=False).encode("utf-8")
        final = {"Content-Type": "application/json"}
        final.update(headers or {})
        try:
            connection.request(method, path, body=raw, headers=final)
            response = connection.getresponse()
            data = response.read()
            return response.status, dict(response.getheaders()), data
        finally:
            connection.close()

    def raw_request(self, extra_headers, body=b"{}", path="/v1/cancel", method="POST"):
        with socket.create_connection(("127.0.0.1", self.server.server_port), timeout=3) as sock:
            sock.sendall(f"{method} {path} HTTP/1.1\r\n".encode()
                         + extra_headers + b"\r\n" + body)
            sock.shutdown(socket.SHUT_WR)
            response = http.client.HTTPResponse(sock)
            response.begin()
            return response.status, dict(response.getheaders()), response.read()

    def assert_error(self, response, status):
        actual, headers, data = response
        self.assertEqual(actual, status, data)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(set(json.loads(data)), {"error"})
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertNotIn("Location", headers)

    def test_health_exact_contract_and_wav(self):
        status, headers, data = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data), qwen.IDENTITY)
        self.assertEqual(self.engine.calls, [])
        status, headers, data = self.request(value={"request_id": "f" * 32, "text": "你好😀"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "audio/wav")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(qwen.validate_wav(data), data)
        self.assertEqual(self.engine.calls, ["你好😀"])

    def test_origin_and_unexpected_host_forbidden(self):
        for headers in [{"Origin": "null"}, {"Origin": ""}, {"Host": "evil.example"},
                        {"Host": f"localhost:{self.server.server_port}"}]:
            self.assert_error(self.request("GET", "/health", headers=headers), 403)

    def test_duplicate_missing_host_and_transfer_headers(self):
        host = f"Host: 127.0.0.1:{self.server.server_port}\r\n".encode()
        for headers, status in [
            (b"", 403), (host + host, 403),
            (host + b"Transfer-Encoding: chunked\r\n", 400),
            (host + b"Transfer-Encoding: identity\r\n", 400),
            (host + b"Expect: 100-continue\r\n", 400),
            (host + b"Content-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 2\r\n", 400),
        ]:
            with self.subTest(headers=headers):
                self.assert_error(self.raw_request(headers), status)

    def test_malformed_json_schema_and_text(self):
        invalid = [b"{", b"[]", b"null", b"\xff", b'{"request_id":"abcdefgh","request_id":"ijklmnop","text":"x"}',
                   b'{"request_id":"abcdefgh","text":NaN}',
                   json.dumps({"request_id": "abcdefgh", "text": "\ud800"}).encode()]
        for raw in invalid:
            with self.subTest(raw=raw):
                self.assert_error(self.request(raw=raw), 400)
        for value in [{}, {"request_id": "abcdefgh", "text": "x", "path": "/tmp/audio"},
                      {"request_id": "bad", "text": "x"},
                      {"request_id": "abcdefgh", "text": ""},
                      {"request_id": "abcdefgh", "text": "x" * 81}]:
            with self.subTest(value=value):
                self.assert_error(self.request(value=value), 400)
        self.assertEqual(self.engine.calls, [])

    def test_non_json_large_and_truncated_bodies(self):
        self.assert_error(self.request(raw=b"{}", headers={"Content-Type": "text/plain"}), 400)
        self.assert_error(self.request(raw=b" " * 4097), 400)
        host = f"Host: 127.0.0.1:{self.server.server_port}\r\nContent-Type: application/json\r\n".encode()
        for length in [b"", b"Content-Length: -2\r\n", b"Content-Length: 100\r\n"]:
            self.assert_error(self.raw_request(host + length), 400)

    def test_unknown_methods_paths_and_no_execution_endpoints(self):
        for path in ["/", "/health?x=1", "/v1/synthesize?text=x", "/file", "/exec"]:
            self.assert_error(self.request("GET", path), 400)
        self.assert_error(self.request("GET", "http://evil.example/health"), 403)
        self.assert_error(self.request("OPTIONS", "/health"), 400)
        self.assert_error(self.request("POST", "/v1/file", value={}), 400)

    def test_health_and_cancel_fast_while_generation_is_blocked(self):
        self.engine.block = True
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.request, value={"request_id": "active_01", "text": "hello"})
            self.assertTrue(self.engine.started.wait(2))
            started = time.monotonic()
            self.assertEqual(self.request("GET", "/health")[0], 200)
            status, headers, data = self.request(path="/v1/cancel", value={"request_id": "active_01"})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(data), {"request_id": "active_01", "cancelled": True})
            self.assertLess(time.monotonic() - started, 1)
            self.assert_error(future.result(timeout=2), 409)
            self.engine.release.set()

    def test_cancel_before_submit_over_http(self):
        self.assertEqual(self.request(path="/v1/cancel", value={"request_id": "future_01"})[0], 200)
        self.assert_error(self.request(value={"request_id": "future_01", "text": "stale"}), 409)
        self.assertEqual(self.engine.calls, [])

    def test_queue_full_over_http(self):
        self.engine.block = True
        self.service.submit("active_01", "hello")
        self.assertTrue(self.engine.started.wait(2))
        self.service.submit("queued_01", "next")
        self.assert_error(self.request(value={"request_id": "third_001", "text": "third"}), 429)
        self.engine.release.set()

    def test_engine_failure_and_invalid_wav_never_escape_as_audio(self):
        self.engine.failure = RuntimeError("PRIVATE SPOKEN TEXT")
        response = self.request(value={"request_id": "failure_1", "text": "PRIVATE SPOKEN TEXT"})
        self.assert_error(response, 500)
        self.assertNotIn(b"PRIVATE", response[2])
        self.engine.failure = None
        self.engine.output = b"not a wav"
        self.assert_error(self.request(value={"request_id": "failure_2", "text": "hello"}), 500)


class TestManagedIdentity(unittest.TestCase):
    def test_stdin_identity_is_bounded_exact_and_secret_not_cli(self):
        identity = {"instance_id": "instance_123", "control_token": "a" * 64}
        self.assertEqual(qwen.read_managed_identity(io.BytesIO(json.dumps(identity).encode() + b"\n")), identity)
        invalid = [b"{}\n", b"{}", b"x" * 1025 + b"\n",
                   b'{"instance_id":"instance_123","instance_id":"instance_456","control_token":"' + b'a' * 64 + b'"}\n']
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(qwen.ServiceError):
                qwen.read_managed_identity(io.BytesIO(value))
        for value in [{**identity, "model_dir": "/private"}, {**identity, "control_token": "bad"},
                      {**identity, "instance_id": "é" * 10}]:
            with self.assertRaises(qwen.ServiceError):
                qwen.validate_managed_identity(value)

    def test_child_explicit_prepare_reports_state_without_synthesizing(self):
        engine = FakeEngine()
        messages = iter([("prepare", None, time.monotonic() + 5), None])
        results = []
        connection = types.SimpleNamespace(recv=lambda: next(messages), send=results.append, close=Mock())
        module = types.SimpleNamespace(NativeQ8Engine=Mock(return_value=engine), NativeQ8Error=NativeError)
        with patch.dict(sys.modules, {"services.qwen_tts.native_q8": module}):
            qwen._engine_child(connection, threading.Event(), "model", "lib", "ROCm0")
        self.assertEqual(results, [("state", "loading", None), ("state", "ready", None), (200, None)])
        self.assertEqual(engine.calls, [])
        self.assertTrue(engine.closed)

    def test_child_terminal_error_resets_and_cooperative_errors_retain_context(self):
        for status in (400, 409, 503, 500):
            with self.subTest(status=status):
                first = FakeEngine(failure=NativeError(status, "/private/revision/path"))
                fresh = FakeEngine()
                loader = Mock(side_effect=[first, fresh])
                deadline = time.monotonic() + 5
                messages = iter([("synthesize", "private text", deadline), ("prepare", None, deadline), None])
                results = []
                connection = types.SimpleNamespace(recv=lambda: next(messages), send=results.append, close=Mock())
                module = types.SimpleNamespace(NativeQ8Engine=loader, NativeQ8Error=NativeError)
                with patch.dict(sys.modules, {"services.qwen_tts.native_q8": module}):
                    qwen._engine_child(connection, threading.Event(), "model", "lib", "ROCm0")
                states = [message[1] for message in results if message[0] == "state"]
                self.assertEqual(loader.call_count, 1 if status in (400, 409) else 2)
                self.assertEqual("error" in states, status not in (400, 409))
                self.assertNotIn("private", repr(results))
                self.assertEqual(results[-1], (200, None))

    def test_cached_status_does_not_start_worker_or_touch_files(self):
        engine = qwen.QwenEngine(".", qwen.__file__)
        with patch.object(engine, "_start", side_effect=AssertionError("must remain lazy")), \
                patch.object(qwen.Path, "is_file", side_effect=AssertionError("no I/O")):
            self.assertEqual(engine.status(), {"model_state": "unloaded", "error_code": None})
        engine._state("loading")
        self.assertEqual(engine.status()["model_state"], "loading")
        engine.close()
        engine._state("ready")  # a late child message cannot undo shutdown
        self.assertEqual(engine.status()["model_state"], "unloaded")

    def test_idle_child_exit_updates_cached_state_without_status_side_effects(self):
        engine = qwen.QwenEngine(".", qwen.__file__)
        process = types.SimpleNamespace(join=Mock())
        engine.process = process
        engine._state("ready")
        engine._watch_process(process)
        process.join.assert_called_once_with()
        self.assertEqual(engine.status(), {"model_state": "error", "error_code": "engine_exited"})
        engine.process = None
        engine._state("unloaded")
        engine._watch_process(process)
        self.assertEqual(engine.status()["model_state"], "unloaded")

    def test_parent_caches_actual_child_states_and_retry_clears_error(self):
        engine = qwen.QwenEngine(".", qwen.__file__)
        messages = iter([("state", "loading", None), ("state", "error", "engine_failed"),
                         (503, "local Qwen engine unavailable"),
                         ("state", "loading", None), ("state", "ready", None), (200, None),
                         ("state", "ready", None), ("state", "generating", None),
                         ("state", "ready", None), (200, wav_bytes())])
        observed = []
        def recv():
            observed.append(engine.status())
            return next(messages)
        connection = types.SimpleNamespace(send=Mock(), poll=lambda _: True, recv=recv)
        process = types.SimpleNamespace(is_alive=lambda: True)
        with patch.object(engine, "_start", return_value=(process, connection, threading.Event())):
            with self.assertRaises(qwen.ServiceError):
                engine.prepare(threading.Event(), time.monotonic() + 5)
            self.assertEqual(engine.status(), {"model_state": "error", "error_code": "engine_failed"})
            engine.prepare(threading.Event(), time.monotonic() + 5)
            self.assertEqual(engine.status(), {"model_state": "ready", "error_code": None})
            self.assertEqual(engine.synthesize("hello", threading.Event(), time.monotonic() + 5), wav_bytes())
        self.assertIn({"model_state": "generating", "error_code": None}, observed)
        self.assertEqual(engine.status()["model_state"], "ready")

    def test_prepare_uses_same_two_second_cancellation_fallback(self):
        engine = qwen.QwenEngine(".", qwen.__file__)
        cancel, shared = threading.Event(), threading.Event()
        sent = []
        def send(message):
            sent.append(message)
            cancel.set()
        connection = types.SimpleNamespace(send=send, poll=lambda _: False)
        process = types.SimpleNamespace(is_alive=lambda: True)
        with patch.object(engine, "_start", return_value=(process, connection, shared)), \
                patch.object(engine, "_stop") as stop, \
                patch.object(qwen.time, "monotonic", side_effect=[0, 1, 4]):
            with self.assertRaises(qwen.ServiceError) as caught:
                engine.prepare(cancel, 10)
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(sent, [("prepare", None, 10)])
        self.assertTrue(shared.is_set())
        stop.assert_called_once()


class TestManagedHTTP(TestHTTP):
    def setUp(self):
        super().setUp()
        self.identity = {"instance_id": "managed_instance_123", "control_token": "a" * 64}
        self.server._managed = qwen.validate_managed_identity(self.identity)
        self.engine.model_state = "unloaded"
        self.engine.status = lambda: {"model_state": self.engine.model_state, "error_code": None}
        def prepare(cancel, deadline):
            self.engine.model_state = "loading"
            self.engine.started.set()
            if self.engine.block:
                self.engine.release.wait(3)
            qwen.check_cancel(cancel, deadline)
            self.engine.model_state = "ready"
        self.engine.prepare = Mock(side_effect=prepare)

    def control(self, action="status", *, fields=None, headers=None):
        body = {"instance_id": self.identity["instance_id"], "action": action}
        body.update(fields or {})
        auth = {"X-DSH-Speech-Control": self.identity["control_token"]}
        auth.update(headers or {})
        return self.request(path="/v1/control", value=body, headers=auth)

    def test_public_status_is_readonly_and_has_exact_safe_contract(self):
        for _ in range(3):
            status, headers, data = self.request("GET", "/v1/status")
            self.assertEqual(status, 200)
            result = json.loads(data)
            self.assertEqual(set(result), set(qwen.IDENTITY) | {
                "status_protocol", "instance_id", "backend", "device", "gpu_name", "model_state",
                "active", "pending", "error_code"})
            self.assertEqual(result["status_protocol"], 1)
            self.assertEqual(result["model_state"], "unloaded")
            self.assertFalse(result["active"])
            self.assertEqual(result["pending"], 0)
            self.assertNotIn(self.identity["control_token"].encode(), data)
        self.assertEqual(self.engine.calls, [])
        self.engine.prepare.assert_not_called()
        self.assertEqual(self.request("GET", "/health")[0], 200)
        self.assertEqual(json.loads(self.control()[2])["model_state"], "unloaded")

    def test_auth_rejects_wrong_instance_token_duplicates_and_manual_service(self):
        for fields, headers in [({"instance_id": "wrong_instance"}, {}),
                                ({"instance_id": "é" * 12}, {}),
                                ({}, {"X-DSH-Speech-Control": "b" * 64}),
                                ({}, {"X-DSH-Speech-Control": ""})]:
            self.assert_error(self.control(fields=fields, headers=headers), 403)
        self.assert_error(self.request(path="/v1/control", value={"instance_id": self.identity["instance_id"], "action": "status"}), 403)
        host = f"Host: 127.0.0.1:{self.server.server_port}\r\n".encode()
        body = json.dumps({"instance_id": self.identity["instance_id"], "action": "status"}).encode()
        auth = b"X-DSH-Speech-Control: " + b"a" * 64 + b"\r\n"
        headers = host + auth + auth + b"Content-Type: application/json\r\nContent-Length: " + str(len(body)).encode() + b"\r\n"
        self.assert_error(self.raw_request(headers, body, "/v1/control"), 403)
        with patch.object(qwen.hmac, "compare_digest", wraps=qwen.hmac.compare_digest) as compare:
            self.assert_error(self.control(fields={"instance_id": "wrong_instance"}), 403)
            self.assertEqual(compare.call_count, 2)
        self.server._managed = None
        self.assert_error(self.control(), 403)
        self.engine.prepare.assert_not_called()

    def test_control_security_schema_body_and_version_fail_closed(self):
        for fields in [{"model_dir": "/private/model"}, {"action": "prepare_v2"}, {"action": []}]:
            self.assert_error(self.control(fields=fields), 400)
        self.assert_error(self.control(headers={"Origin": "null"}), 403)
        self.assert_error(self.control(headers={"Host": "localhost:18765"}), 403)
        self.assert_error(self.control(headers={"Content-Type": "text/plain"}), 400)
        self.assert_error(self.request(path="/v2/control", value={}), 400)
        self.assert_error(self.request("GET", "/v1/status?prepare=1"), 400)
        self.engine.prepare.assert_not_called()

    def test_explicit_prepare_never_synthesizes_and_rejects_busy(self):
        response = self.control("prepare")
        self.assertEqual(response[0], 200)
        self.assertEqual(json.loads(response[2])["model_state"], "ready")
        self.engine.prepare.assert_called_once()
        self.assertEqual(self.engine.calls, [])
        self.engine.block = True
        self.service.submit("active_01", "private spoken text")
        self.assertTrue(self.engine.started.wait(2))
        self.assert_error(self.control("prepare"), 409)
        self.assertNotIn(b"private", self.request("GET", "/v1/status")[2])
        self.engine.release.set()

    def test_status_is_fast_during_prepare_and_shutdown_interrupts_it(self):
        self.engine.block = True
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.control, "prepare")
            self.assertTrue(self.engine.started.wait(2))
            started = time.monotonic()
            public = self.request("GET", "/v1/status")
            self.assertEqual(json.loads(public[2])["model_state"], "loading")
            self.assertTrue(json.loads(public[2])["active"])
            self.assert_error(self.control("prepare"), 409)
            self.assertEqual(self.control("shutdown")[0], 200)
            self.assertLess(time.monotonic() - started, 1)
            self.assert_error(pending.result(timeout=3), 503)
        self.thread.join(3)
        self.assertFalse(self.thread.is_alive())
        self.assertTrue(self.engine.closed)
        self.assertTrue(self.service.closed)


if __name__ == "__main__":
    unittest.main()
