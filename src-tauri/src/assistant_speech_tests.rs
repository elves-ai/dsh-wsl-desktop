use super::*;
use std::{
    io::{BufRead, BufReader, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{mpsc, Arc},
    thread,
};

fn request(id: &str) -> SpeechRequest {
    SpeechRequest {
        request_id: id.into(),
        text: "你好，今天也要开心。".into(),
    }
}
fn wav(pcm_bytes: usize) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend(b"RIFF");
    b.extend(((36 + pcm_bytes) as u32).to_le_bytes());
    b.extend(b"WAVEfmt ");
    b.extend(16u32.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(24_000u32.to_le_bytes());
    b.extend(48_000u32.to_le_bytes());
    b.extend(2u16.to_le_bytes());
    b.extend(16u16.to_le_bytes());
    b.extend(b"data");
    b.extend((pcm_bytes as u32).to_le_bytes());
    b.resize(44 + pcm_bytes, 0);
    b
}
fn riff_length(b: &mut [u8]) {
    let n = b.len() as u32 - 8;
    b[4..8].copy_from_slice(&n.to_le_bytes());
}
fn receive(stream: &TcpStream) -> (String, serde_json::Value) {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let first = line.clone();
    let mut len = 0;
    loop {
        line.clear();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            len = value.trim().parse::<usize>().unwrap();
        }
    }
    assert!(len <= 1024);
    let mut body = vec![0; len];
    reader.read_exact(&mut body).unwrap();
    let json = if body.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&body).unwrap()
    };
    (first, json)
}
fn respond(mut stream: TcpStream, status: &str, headers: &str, body: &[u8]) {
    let head = format!("HTTP/1.1 {status}\r\nConnection: close\r\n{headers}\r\n");
    stream.write_all(head.as_bytes()).unwrap();
    // The bounded client may close early intentionally.
    let _ = stream.write_all(body);
}
fn fixture(f: impl FnOnce(TcpStream) + Send + 'static) -> (SocketAddr, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let job = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        f(stream);
    });
    (address, job)
}

#[test]
fn timings_serialize_as_numeric_milliseconds_with_submillisecond_precision() {
    let timings = SpeechTimings::from_durations(
        Duration::from_micros(1250),
        Duration::from_millis(2500),
        Duration::from_micros(125),
        Duration::from_millis(2600),
    );
    assert_eq!(
        serde_json::to_value(timings).unwrap(),
        serde_json::json!({
            "readiness_ms": 1.25,
            "synthesis_ms": 2500.0,
            "encode_ms": 0.125,
            "total_ms": 2600.0,
        })
    );
}

#[test]
fn timing_duration_bounds_remain_finite_nonnegative_json_numbers() {
    for duration in [Duration::ZERO, Duration::from_nanos(1), Duration::MAX] {
        let timings = SpeechTimings::from_durations(duration, duration, duration, duration);
        let value = serde_json::to_value(timings).unwrap();
        let fields = value.as_object().unwrap();
        assert_eq!(fields.len(), 4);
        for number in fields.values() {
            let milliseconds = number.as_f64().expect("numeric milliseconds, never null");
            assert!(milliseconds.is_finite() && milliseconds >= 0.0);
            if !duration.is_zero() {
                assert!(milliseconds > 0.0);
            }
        }
    }
}

#[test]
fn ids_are_ascii_bounded_and_not_urls_or_paths() {
    for id in ["Ab_19--x".to_string(), "a".repeat(80)] {
        assert!(validate_id(&id).is_ok());
    }
    for id in [
        "a".repeat(7),
        "a".repeat(81),
        "请求编号八字".into(),
        "http://a".into(),
        "../abcde".into(),
        "abc defg".into(),
        "abc%20ef".into(),
        "abcd\nefgh".into(),
    ] {
        assert!(validate_id(&id).is_err(), "{id:?}");
    }
}
#[test]
fn text_uses_unicode_scalars_and_rejects_empty_or_overlong() {
    let mut r = request("text-001");
    r.text = "😀".repeat(80);
    assert!(r.validate().is_ok());
    r.text.push('中');
    assert!(r.validate().is_err());
    for text in ["", " \n\t", "a\0b"] {
        r.text = text.into();
        assert!(r.validate().is_err());
    }
    assert!(serde_json::from_value::<SpeechRequest>(
        serde_json::json!({"request_id":"text-002","text":"好","endpoint":"http://example.com"})
    )
    .is_err());
}
#[test]
fn caller_guard_is_exact_pet_document_and_native_labels() {
    let url = url::Url::parse("http://tauri.localhost/assistant.html?view=pet").unwrap();
    assert!(pet_caller(PET_VIEW, PET_VIEW, &url));
    for label in [
        "assistant-chat",
        "launcher",
        "dsh",
        "assistant-pet-child",
        "remote",
    ] {
        assert!(!pet_caller(label, PET_VIEW, &url));
        assert!(!pet_caller(PET_VIEW, label, &url));
    }
    for value in [
        "http://example.com/assistant.html?view=pet",
        "http://127.0.0.1:18765/assistant.html?view=pet",
        "http://tauri.localhost/assistant.html?view=chat",
        "http://tauri.localhost/assistant.html?view=%70et",
        "http://tauri.localhost/assistant.html?view=pet&x=1",
        "http://tauri.localhost/assistant.html?view=pet#x",
        "http://user@tauri.localhost/assistant.html?view=pet",
        "http://tauri.localhost/index.html?view=pet",
    ] {
        assert!(
            !pet_caller(PET_VIEW, PET_VIEW, &url::Url::parse(value).unwrap()),
            "{value}"
        );
    }
}
#[test]
fn health_requires_service_protocol_and_selected_voice() {
    let valid = serde_json::json!({"service":"dsh-pet-qwen","protocol":1,"voice_id":VOICE_ID});
    assert!(validate_health(valid.to_string().as_bytes()).is_ok());
    for (key, value) in [
        ("service", serde_json::json!("other")),
        ("protocol", serde_json::json!(2)),
        ("voice_id", serde_json::json!("system")),
        ("protocol", serde_json::json!("1")),
    ] {
        let mut bad = valid.clone();
        bad[key] = value;
        assert_eq!(
            validate_health(bad.to_string().as_bytes()).unwrap_err(),
            IDENTITY
        );
    }
    assert_eq!(
        validate_health(b"malformed REMOTE_SECRET").unwrap_err(),
        IDENTITY
    );
    assert_eq!(validate_health(b"{}").unwrap_err(), IDENTITY);
}
#[test]
fn wav_accepts_only_complete_pcm16_mono_24k_within_30_seconds() {
    assert!(validate_wav(&wav(2)).is_ok());
    assert!(validate_wav(&wav(MAX_PCM)).is_ok());
    for n in [0, 1, MAX_PCM + 2] {
        assert!(validate_wav(&wav(n)).is_err());
    }
    let original = wav(8);
    for (offset, value) in [
        (0, b'X'),
        (8, b'X'),
        (20, 3),
        (22, 2),
        (24, 1),
        (28, 0),
        (32, 4),
        (34, 8),
    ] {
        let mut bad = original.clone();
        bad[offset] = value;
        assert!(validate_wav(&bad).is_err());
    }
    for n in 0..original.len() {
        assert!(validate_wav(&original[..n]).is_err());
    }
    let mut extra = original.clone();
    extra.push(0);
    assert!(validate_wav(&extra).is_err());
    let mut huge_chunk = original.clone();
    huge_chunk[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(validate_wav(&huge_chunk).is_err());
    let mut huge_riff = original.clone();
    huge_riff[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(validate_wav(&huge_riff).is_err());
}
#[test]
fn wav_checks_chunks_padding_duplicates_and_short_format_without_panics() {
    let mut valid = wav(4);
    valid.extend(b"JUNK");
    valid.extend(1u32.to_le_bytes());
    valid.extend([9, 0]);
    riff_length(&mut valid);
    assert!(validate_wav(&valid).is_ok());
    valid.pop();
    riff_length(&mut valid);
    assert!(validate_wav(&valid).is_err());
    for chunk in [wav(2)[12..36].to_vec(), wav(2)[36..].to_vec()] {
        let mut duplicate = wav(2);
        duplicate.extend(chunk);
        riff_length(&mut duplicate);
        assert!(validate_wav(&duplicate).is_err());
    }
    for size in 0..16u32 {
        let mut short = wav(2);
        short[16..20].copy_from_slice(&size.to_le_bytes());
        assert!(validate_wav(&short).is_err());
    }
    let mut extended = wav(2);
    extended.splice(36..36, [0, 0]);
    extended[16..20].copy_from_slice(&18u32.to_le_bytes());
    riff_length(&mut extended);
    assert!(validate_wav(&extended).is_ok());
    extended[36] = 1;
    assert!(validate_wav(&extended).is_err());
    let mut oversized = wav(2);
    oversized.resize(MAX_AUDIO + 1, 0);
    riff_length(&mut oversized);
    assert!(validate_wav(&oversized).is_err());
}
#[test]
fn cancel_before_start_is_remembered_and_unrelated_cancel_is_isolated() {
    let bridge = SpeechBridge::default();
    bridge.cancel("future-1").unwrap();
    assert!(bridge.begin(&request("future-1")).is_err());
    let (ticket, _) = bridge.begin(&request("current1")).unwrap();
    bridge.cancel("unrelate").unwrap();
    assert!(bridge.is_current(&ticket));
    bridge.cancel("current1").unwrap();
    assert!(!bridge.is_current(&ticket));
    assert!(bridge.acquire(&ticket).is_err());
    assert!(bridge.begin(&request("current1")).is_err());
    for n in 0..HISTORY + 10 {
        bridge.cancel(&format!("cancel-{n:08}")).unwrap();
    }
    assert_eq!(bridge.requests.lock().unwrap().history.len(), HISTORY);
}
#[test]
fn only_one_active_and_latest_pending_survive_supersession() {
    let bridge = Arc::new(SpeechBridge::default());
    let (first, _) = bridge.begin(&request("first-01")).unwrap();
    bridge.acquire(&first).unwrap();
    let (pending, old) = bridge.begin(&request("pending1")).unwrap();
    assert_eq!(old, ["first-01"]);
    let worker_bridge = bridge.clone();
    let pending_ticket = pending.clone();
    let (tx, rx) = mpsc::channel();
    let job = thread::spawn(move || tx.send(worker_bridge.acquire(&pending_ticket)).unwrap());
    let (latest, old) = bridge.begin(&request("latest-1")).unwrap();
    assert_eq!(old, ["pending1"]);
    assert!(rx.recv_timeout(Duration::from_secs(2)).unwrap().is_err());
    job.join().unwrap();
    assert!(!bridge.is_current(&first));
    assert!(!bridge.is_current(&pending));
    assert!(bridge.is_current(&latest));
    {
        let state = bridge.requests.lock().unwrap();
        assert_eq!(state.active.as_ref().unwrap().id, "first-01");
        assert_eq!(state.pending.as_ref().unwrap().id, "latest-1");
    }
    bridge.release(&first);
    bridge.acquire(&latest).unwrap();
    bridge.release(&latest);
    assert!(bridge.begin(&request("latest-1")).is_err());
}
#[test]
fn continuation_requires_the_still_current_predecessor_even_after_audio_is_released() {
    let bridge = SpeechBridge::default();
    let (first, _) = bridge.begin(&request("pet-first")).unwrap();
    bridge.acquire(&first).unwrap();
    bridge.release(&first);
    let (second, replaced) = bridge
        .begin_after(&request("pet-next1"), Some("pet-first"))
        .unwrap();
    assert_eq!(replaced, ["pet-first"]);
    assert!(bridge.is_current(&second));
    let (audition, replaced) = bridge.begin(&request("audition1")).unwrap();
    assert_eq!(replaced, ["pet-next1"]);
    // The UI has not received stop(pet-next1) yet and tries to prefetch another segment.
    assert_eq!(
        bridge
            .begin_after(&request("pet-next2"), Some("pet-next1"))
            .err()
            .unwrap(),
        CANCELLED
    );
    assert!(bridge.is_current(&audition));
    // Cleanup of a rejected continuation must not cancel the newer audition either.
    bridge.cancel("pet-next2").unwrap();
    assert!(bridge.is_current(&audition));
    bridge.acquire(&audition).unwrap();
    bridge.release(&audition);
}

#[test]
fn cancelled_invalidated_and_mismatched_predecessors_cannot_restart_narration() {
    for invalidate in [false, true] {
        let bridge = SpeechBridge::default();
        bridge.begin(&request("pet-first")).unwrap();
        if invalidate {
            bridge.invalidate();
        } else {
            bridge.cancel("pet-first").unwrap();
        }
        assert_eq!(
            bridge
                .begin_after(&request("pet-next1"), Some("pet-first"))
                .err()
                .unwrap(),
            CANCELLED
        );
        assert!(bridge.requests.lock().unwrap().current.is_none());
    }
    let bridge = SpeechBridge::default();
    let (current, _) = bridge.begin(&request("pet-first")).unwrap();
    assert_eq!(
        bridge
            .begin_after(&request("pet-next1"), Some("not-first"))
            .err()
            .unwrap(),
        CANCELLED
    );
    assert!(bridge
        .begin_after(&request("pet-next1"), Some("bad"))
        .is_err());
    assert!(bridge.is_current(&current));
    let (next, _) = bridge
        .begin_after(&request("pet-next1"), Some("pet-first"))
        .unwrap();
    // No branching or duplicate continuation from an earlier link in the chain.
    assert_eq!(
        bridge
            .begin_after(&request("pet-next2"), Some("pet-first"))
            .err()
            .unwrap(),
        CANCELLED
    );
    assert!(bridge.is_current(&next));
}

#[test]
fn new_user_request_wins_both_atomic_orderings_against_old_background_continuation() {
    for _ in 0..32 {
        let bridge = Arc::new(SpeechBridge::default());
        bridge.begin(&request("pet-first")).unwrap();
        let gate = Arc::new(std::sync::Barrier::new(2));
        let worker = bridge.clone();
        let worker_gate = gate.clone();
        let old = thread::spawn(move || {
            worker_gate.wait();
            worker.begin_after(&request("pet-next1"), Some("pet-first"))
        });
        gate.wait();
        let (newest, _) = bridge.begin(&request("audition1")).unwrap();
        let _ = old.join().unwrap();
        assert!(bridge.is_current(&newest));
    }
}

#[test]
fn native_lifetime_invalidation_rejects_current_and_pending() {
    let bridge = SpeechBridge::default();
    let (active, _) = bridge.begin(&request("active-1")).unwrap();
    bridge.acquire(&active).unwrap();
    let (pending, _) = bridge.begin(&request("pending2")).unwrap();
    let ids = bridge.invalidate();
    assert!(ids.contains(&"active-1".into()));
    assert!(ids.contains(&"pending2".into()));
    assert!(!bridge.is_current(&active));
    assert!(!bridge.is_current(&pending));
    assert!(bridge.acquire(&pending).is_err());
    bridge.release(&active);
}
#[test]
fn transport_posts_only_expected_json_and_returns_validated_wav() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let audio = wav(48);
    let expected = audio.clone();
    let job = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        assert!(receive(&stream).0.starts_with("GET /health "));
        let health = serde_json::json!({"service":"dsh-pet-qwen","protocol":1,"voice_id":VOICE_ID})
            .to_string();
        respond(
            stream,
            "200 OK",
            &format!("Content-Length: {}\r\n", health.len()),
            health.as_bytes(),
        );
        let (stream, _) = listener.accept().unwrap();
        let (path, json) = receive(&stream);
        assert!(path.starts_with("POST /v1/synthesize "));
        assert_eq!(json, serde_json::to_value(request("network1")).unwrap());
        respond(
            stream,
            "200 OK",
            &format!(
                "Content-Length: {}\r\nContent-Type: audio/wav\r\n",
                audio.len()
            ),
            &audio,
        );
    });
    let bridge = SpeechBridge::default();
    let r = request("network1");
    let (ticket, _) = bridge.begin(&r).unwrap();
    assert_eq!(
        bridge
            .synthesize_with(&ticket, &r, &[], || Ok(Transport::for_test(address)))
            .unwrap(),
        expected
    );
    job.join().unwrap();
}
#[test]
fn transport_rejects_redirect_and_malformed_health_without_reflecting_body() {
    for status in ["302 Found", "200 OK"] {
        let (address, job) = fixture(move |stream| {
            assert!(receive(&stream).0.starts_with("GET /health "));
            respond(
                stream,
                status,
                "Location: http://192.0.2.1/\r\nContent-Length: 13\r\n",
                b"REMOTE_SECRET",
            );
        });
        assert_eq!(Transport::for_test(address).health().unwrap_err(), IDENTITY);
        job.join().unwrap();
    }
}
#[test]
fn transport_audio_is_bounded_with_or_without_content_length() {
    for declared in [true, false] {
        let (address, job) = fixture(move |stream| {
            let _ = receive(&stream);
            let body = vec![0; MAX_AUDIO + 1];
            let headers = if declared {
                format!("Content-Length: {}\r\n", body.len())
            } else {
                String::new()
            };
            respond(stream, "200 OK", &headers, &body);
        });
        assert_eq!(
            Transport::for_test(address)
                .synthesize(&request("bounded1"))
                .unwrap_err(),
            AUDIO_ERROR
        );
        job.join().unwrap();
    }
}
#[test]
fn synthesis_http_errors_are_actionable_and_never_echo_remote_body() {
    for (status, expected) in [
        ("409 Conflict", CANCELLED),
        ("429 Too Many Requests", "Qwen 语音服务繁忙，请稍后重试。"),
        (
            "503 Service Unavailable",
            "Qwen 模型尚未就绪或合成超过服务期限，请检查本机语音服务后重试。",
        ),
        (
            "500 Internal Server Error",
            "Qwen 合成引擎运行失败，请检查本机服务日志、模型及依赖后重试。",
        ),
        (
            "400 Bad Request",
            "Qwen 语音服务拒绝了合成请求，请检查本机服务后重试。",
        ),
    ] {
        let (address, job) = fixture(move |stream| {
            let _ = receive(&stream);
            respond(stream, status, "Content-Length: 13\r\n", b"REMOTE_SECRET");
        });
        let error = Transport::for_test(address)
            .synthesize(&request("status-1"))
            .unwrap_err();
        assert_eq!(error, expected);
        assert_ne!(error, AUDIO_ERROR);
        assert!(!error.contains("REMOTE_SECRET"));
        assert!(!error.contains("WAV"));
        job.join().unwrap();
    }
}

#[test]
fn transport_rejects_truncated_response_and_wrong_wav() {
    for truncated in [true, false] {
        let (address, job) = fixture(move |stream| {
            let _ = receive(&stream);
            let body = if truncated {
                wav(4)
            } else {
                b"REMOTE_SECRET".to_vec()
            };
            let length = body.len() + usize::from(truncated);
            respond(
                stream,
                "200 OK",
                &format!("Content-Length: {length}\r\n"),
                &body,
            );
        });
        assert_eq!(
            Transport::for_test(address)
                .synthesize(&request("invalid1"))
                .unwrap_err(),
            AUDIO_ERROR
        );
        job.join().unwrap();
    }
}
#[test]
fn supersession_sends_exact_cancel_before_waiting_for_active_slot() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (cancel_tx, cancel_rx) = mpsc::channel();
    let server = thread::spawn(move || {
        let health = serde_json::json!({"service":"dsh-pet-qwen","protocol":1,"voice_id":VOICE_ID})
            .to_string();
        for stage in 0..4 {
            let (stream, _) = listener.accept().unwrap();
            let (path, json) = receive(&stream);
            match stage {
                0 | 2 => {
                    assert!(path.starts_with("GET /health "));
                    respond(
                        stream,
                        "200 OK",
                        &format!("Content-Length: {}\r\n", health.len()),
                        health.as_bytes(),
                    );
                }
                1 => {
                    assert!(path.starts_with("POST /v1/cancel "));
                    assert_eq!(json, serde_json::json!({"request_id":"old-http"}));
                    respond(stream, "200 OK", "Content-Length: 2\r\n", b"{}");
                    cancel_tx.send(()).unwrap();
                }
                _ => {
                    assert!(path.starts_with("POST /v1/synthesize "));
                    assert_eq!(json["request_id"], "new-http");
                    let audio = wav(4);
                    respond(
                        stream,
                        "200 OK",
                        &format!("Content-Length: {}\r\n", audio.len()),
                        &audio,
                    );
                }
            }
        }
    });
    let bridge = Arc::new(SpeechBridge::default());
    let (old, _) = bridge.begin(&request("old-http")).unwrap();
    bridge.acquire(&old).unwrap();
    let r = request("new-http");
    let (ticket, superseded) = bridge.begin(&r).unwrap();
    let worker = bridge.clone();
    let job = thread::spawn(move || {
        worker.synthesize_with(&ticket, &r, &superseded, || {
            Ok(Transport::for_test(address))
        })
    });
    cancel_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    // Cancellation arrived while the old slot was still occupied; no global network lock.
    assert_eq!(
        bridge.requests.lock().unwrap().active.as_ref().unwrap().id,
        "old-http"
    );
    bridge.release(&old);
    assert!(job.join().unwrap().is_ok());
    server.join().unwrap();
}

#[test]
fn cancellation_posts_exact_id_even_without_local_synthesis() {
    let (address, job) = fixture(|stream| {
        let (path, json) = receive(&stream);
        assert!(path.starts_with("POST /v1/cancel "));
        assert_eq!(json, serde_json::json!({"request_id":"future-2"}));
        respond(stream, "200 OK", "Content-Length: 2\r\n", b"{}");
    });
    let bridge = SpeechBridge::default();
    bridge.cancel("future-2").unwrap();
    Transport::for_test(address).cancel("future-2").unwrap();
    job.join().unwrap();
    assert!(bridge.begin(&request("future-2")).is_err());
}
#[test]
fn cancellation_while_network_waits_never_returns_stale_audio_or_holds_state_lock() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (finish_tx, finish_rx) = mpsc::channel();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let _ = receive(&stream);
        let health = serde_json::json!({"service":"dsh-pet-qwen","protocol":1,"voice_id":VOICE_ID})
            .to_string();
        respond(
            stream,
            "200 OK",
            &format!("Content-Length: {}\r\n", health.len()),
            health.as_bytes(),
        );
        let (stream, _) = listener.accept().unwrap();
        let _ = receive(&stream);
        started_tx.send(()).unwrap();
        finish_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let audio = wav(4);
        respond(
            stream,
            "200 OK",
            &format!("Content-Length: {}\r\n", audio.len()),
            &audio,
        );
    });
    let bridge = Arc::new(SpeechBridge::default());
    let r = request("cancel-3");
    let (ticket, _) = bridge.begin(&r).unwrap();
    let worker = bridge.clone();
    let job = thread::spawn(move || {
        worker.synthesize_with(&ticket, &r, &[], || Ok(Transport::for_test(address)))
    });
    started_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    bridge.cancel("cancel-3").unwrap();
    let (current, _) = bridge.begin(&request("fresh-03")).unwrap();
    assert!(bridge.is_current(&current));
    bridge.cancel("cancel-3").unwrap();
    assert!(bridge.is_current(&current));
    finish_tx.send(()).unwrap();
    assert_eq!(job.join().unwrap().unwrap_err(), CANCELLED);
    server.join().unwrap();
}

/// Explicitly opt in after starting the fixed-voice WSL GPU service. Default tests
/// stay offline and never load a model, download weights, or change a driver.
#[test]
#[ignore = "requires DSH_QWEN_LIVE_TEST=1 and the local WSL ROCm service"]
fn live_wsl_rocm_transport_synthesizes_and_cancels() {
    assert_eq!(std::env::var("DSH_QWEN_LIVE_TEST").as_deref(), Ok("1"));
    let transport = Transport::new().unwrap();
    transport
        .health()
        .expect("fixed service and selected voice identity");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros();
    let prefix = format!("live_rocm_{}_{}", std::process::id(), stamp);
    let utterance = SpeechRequest {
        request_id: format!("{prefix}_audio"),
        text: "欸？我才没有发呆呢，刚刚只是在想事情啦。".into(),
    };
    utterance.validate().unwrap();
    let start = std::time::Instant::now();
    let audio = transport
        .synthesize(&utterance)
        .expect("real GPU WAV response");
    validate_wav(&audio).unwrap();
    assert!(audio.len() > 48_000, "not a placeholder or empty fragment");
    assert!(audio[44..]
        .chunks_exact(2)
        .any(|p| i16::from_le_bytes([p[0], p[1]]) != 0));
    if let Ok(directory) = std::env::var("DSH_QWEN_LIVE_OUTPUT_DIR") {
        let directory = std::path::PathBuf::from(directory);
        assert!(
            directory.is_dir(),
            "explicit output directory must already exist"
        );
        std::fs::write(directory.join("native-transport.wav"), &audio).unwrap();
    }
    println!(
        "real WSL ROCm transport: {} bytes in {:.3}s",
        audio.len(),
        start.elapsed().as_secs_f64()
    );
    let cancelled = format!("{prefix}_cancel");
    transport.cancel(&cancelled).unwrap();
    let result = transport.synthesize(&SpeechRequest {
        request_id: cancelled,
        text: "这段已经取消，不应该生成或播放。".into(),
    });
    assert_eq!(result.unwrap_err(), CANCELLED);
    // A cancel tombstone must not poison the resident model or unrelated IDs.
    let next = transport
        .synthesize(&SpeechRequest {
            request_id: format!("{prefix}_next"),
            text: "你好呀，今天也要一起加油哦！".into(),
        })
        .expect("a later request still succeeds");
    validate_wav(&next).unwrap();
}
