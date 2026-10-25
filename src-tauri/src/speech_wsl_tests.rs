use super::*;

#[test]
fn refused_loopback_port_is_stopped_not_a_timeout() {
    // In particular, run this on Windows: refusal takes slightly over 2 seconds,
    // unlike Linux's immediate ECONNREFUSED. The old connect timeout failed here.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let runtime = WslSpeechRuntime::new(Arc::new(|| panic!("status must not spawn WSL"))).unwrap();
    let status = runtime
        .status_at(&endpoint, &Cancellation::default())
        .unwrap();
    assert_eq!(status.service_state, ServiceState::Stopped);
    assert_eq!(status.model_state, ModelState::Unloaded);
    assert!(!status.identity_valid);
}

#[test]
fn unresponsive_loopback_listener_is_not_stopped() {
    // Keep the bound listener alive without accepting/replying: TCP connects,
    // but HTTP must time out. Increasing the refusal budget must not allow
    // installation to mutate dependencies under a hung or foreign service.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let runtime = WslSpeechRuntime::new(Arc::new(|| panic!("status must not spawn WSL"))).unwrap();
    let error = runtime
        .status_at(&endpoint, &Cancellation::default())
        .unwrap_err();
    assert!(error.contains("暂不能确认运行状态"));
}

#[test]
fn status_cancellation_does_not_probe_a_port() {
    let runtime = WslSpeechRuntime::new(Arc::new(|| panic!("status must not spawn WSL"))).unwrap();
    let cancel = Cancellation::default();
    cancel.cancel();
    assert!(runtime
        .status_at("not a URL", &cancel)
        .unwrap_err()
        .contains("取消"));
}

fn fixture() -> Config {
    Config::parse(br#"{"Distribution":"Ubuntu","LinuxUser":"user","LinuxLauncher":"/home/user/dsh","LinuxConfig":"/home/user/config.json"}"#).unwrap()
}
#[test]
fn default_python_failure_guides_initialization_without_leaking_paths() {
    let result = WslSpeechRuntime::parse_inspection(&json!({
        "kind":"result", "environment_ok":false, "models_ok":false,
        "gpu_name":null, "error_code":"default_python_required"
    }))
    .unwrap();
    assert!(result.error.unwrap().contains("初始化默认语音环境"));
}
#[test]
fn inspect_and_start_refuse_external_python_before_any_wsl_transport() {
    let runtime = WslSpeechRuntime::new(Arc::new(|| panic!("must not access WSL"))).unwrap();
    let config = SpeechConfig {
        python_path: "/usr/bin/python3".into(),
        model_dir: "/manual/models".into(),
        native_lib: "/manual/libqwen.so".into(),
    };
    assert!(runtime
        .inspect(&config, &Cancellation::default(), &|_| {})
        .unwrap_err()
        .contains("初始化"));
    assert!(runtime
        .start(&config, &Cancellation::default())
        .err()
        .unwrap()
        .contains("初始化"));
}
#[test]
fn status_is_not_model_readiness_and_non_gpu_is_not_ready() {
    let identity = json!({"service":"dsh-pet-qwen","protocol":1,"voice_id":"pet-airhead-v1"});
    let old = WslSpeechRuntime::parse_status(&identity);
    assert!(old.identity_valid);
    assert_eq!(old.model_state, ModelState::Unknown);
    let mut cpu = identity;
    cpu["status_protocol"] = json!(1);
    cpu["backend"] = json!("cpu");
    cpu["device"] = json!("CPU");
    cpu["model_state"] = json!("ready");
    assert_eq!(
        WslSpeechRuntime::parse_status(&cpu).model_state,
        ModelState::Unknown
    );
    cpu["backend"] = json!("rocm");
    cpu["device"] = json!("ROCm0");
    assert_eq!(
        WslSpeechRuntime::parse_status(&cpu).model_state,
        ModelState::Ready
    );
    cpu["gpu_name"] = json!("bad\nname");
    assert_eq!(WslSpeechRuntime::parse_status(&cpu).gpu_name, None);
}
#[test]
fn cuda_and_rocm_statuses_require_exact_backend_device_pairs() {
    let mut value = json!({"service":"dsh-pet-qwen","protocol":1,"voice_id":"pet-airhead-v1",
        "status_protocol":1,"backend":"cuda","device":"CUDA0","model_state":"ready",
        "instance_id":"fixture","gpu_name":"NVIDIA fixture"});
    for (backend, device) in [
        ("cuda", "CUDA0"),
        ("cuda", "CUDA99"),
        ("rocm", "ROCm0"),
        ("rocm", "ROCm12"),
    ] {
        value["backend"] = json!(backend);
        value["device"] = json!(device);
        let status = WslSpeechRuntime::parse_status(&value);
        assert_eq!(status.model_state, ModelState::Ready);
        assert_eq!(status.instance_id.as_deref(), Some("fixture"));
    }
    for (backend, device) in [
        ("cuda", "ROCm0"),
        ("rocm", "CUDA0"),
        ("cpu", "CPU"),
        ("cuda", "auto"),
        ("cuda", "CUDA00"),
        ("cuda", "CUDA-1"),
        ("cuda", "CUDA100"),
        ("cuda", "CUDA1\n"),
        ("cuda", "CUDA１"),
        ("CUDA", "CUDA0"),
        ("rocm", "ROCm"),
    ] {
        value["backend"] = json!(backend);
        value["device"] = json!(device);
        let status = WslSpeechRuntime::parse_status(&value);
        assert_eq!(
            status.model_state,
            ModelState::Unknown,
            "{backend}/{device}"
        );
        assert_eq!(status.instance_id, None);
        assert_eq!(status.gpu_name, None);
    }
}

#[test]
fn inspection_readiness_requires_a_concrete_matching_gpu_backend() {
    let mut value = json!({"kind":"result","environment_ok":true,"models_ok":true,
        "backend":"cuda","device":"CUDA0","gpu_name":"NVIDIA fixture","error_code":null});
    assert!(
        WslSpeechRuntime::parse_inspection(&value)
            .unwrap()
            .environment_ok
    );
    value["backend"] = json!("rocm");
    assert!(WslSpeechRuntime::parse_inspection(&value).is_err());
    value["device"] = json!("ROCm0");
    assert!(
        WslSpeechRuntime::parse_inspection(&value)
            .unwrap()
            .environment_ok
    );
    value.as_object_mut().unwrap().remove("device");
    assert!(WslSpeechRuntime::parse_inspection(&value).is_err());
    value["environment_ok"] = json!(false);
    value["backend"] = Value::Null;
    value["device"] = Value::Null;
    for code in [
        "cuda_libraries_unavailable",
        "gpu_backend_mismatch",
        "gpu_runtime_unavailable",
    ] {
        value["error_code"] = json!(code);
        let result = WslSpeechRuntime::parse_inspection(&value).unwrap();
        assert!(!result.environment_ok);
        assert!(result.error.is_some());
    }
}

#[test]
fn helper_modes_are_closed_and_launcher_values_are_separate_args() {
    let mut config = fixture();
    config.distribution = "Ubuntu; echo not-a-shell".into();
    assert!(WslSpeechRuntime::command(&config, "--arbitrary-command").is_err());
    let command = WslSpeechRuntime::command(&config, "--stage").unwrap();
    let args: Vec<_> = command
        .get_args()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    assert_eq!(args[1], config.distribution);
    assert!(args.iter().any(|s| s == "/usr/bin/python3"));
    assert!(!args.iter().any(|s| s == "sh" || s == "bash"));
    assert!(BOOTSTRAP.len() < 4096);
}
#[test]
fn preflight_is_fixed_and_does_not_require_service_ownership_or_speech_config() {
    let command = WslSpeechRuntime::command(&fixture(), "--resources-preflight").unwrap();
    let args: Vec<_> = command
        .get_args()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    assert_eq!(args.last().unwrap(), "--resources-preflight");
    assert!(args.iter().any(|s| s == "/usr/bin/python3"));
    let runtime = WslSpeechRuntime::new(Arc::new(|| Err("WSL unavailable".into()))).unwrap();
    let result = runtime.check_prerequisites().unwrap();
    assert!(!result.ready);
    assert_eq!(result.checks.len(), 4);
    assert!(result.install_command.is_none());
}
#[test]
#[ignore = "requires DSH_SPEECH_INTEROP_LIVE=1, explicit local runtime paths and a free18765"]
fn live_wsl_owned_lifecycle() {
    assert_eq!(std::env::var("DSH_SPEECH_INTEROP_LIVE").as_deref(), Ok("1"));
    let config = Config::parse(
        std::env::var("DSH_SPEECH_LAUNCHER_JSON")
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let paths: SpeechConfig =
        serde_json::from_str(&std::env::var("DSH_SPEECH_PATHS_JSON").unwrap()).unwrap();
    let runtime = WslSpeechRuntime::new(Arc::new(move || Ok(config.clone()))).unwrap();
    let cancel = Cancellation::default();
    assert_eq!(
        runtime.status(&cancel).unwrap().service_state,
        ServiceState::Stopped,
        "operator must stop only their own existing test service first"
    );
    let progress = std::sync::atomic::AtomicU8::new(0);
    let check = runtime
        .inspect(&paths, &cancel, &|p| {
            progress.store(p, std::sync::atomic::Ordering::SeqCst);
        })
        .unwrap();
    assert!(
        check.environment_ok && check.models_ok,
        "actual GPU/ABI/model check must pass"
    );
    assert_eq!(progress.load(std::sync::atomic::Ordering::SeqCst), 100);
    let session = runtime.start(&paths, &cancel).unwrap();
    struct Guard<'a> {
        runtime: &'a WslSpeechRuntime,
        session: Option<ManagedSession>,
    }
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            if let Some(s) = &self.session {
                let _ = self.runtime.stop(s);
            }
        }
    }
    let mut guard = Guard {
        runtime: &runtime,
        session: Some(session.clone()),
    };
    let start = Instant::now();
    loop {
        let s = runtime.status(&cancel).unwrap();
        if s.service_state == ServiceState::Running {
            assert_eq!(s.instance_id.as_deref(), Some(session.instance_id()));
            assert_eq!(s.model_state, ModelState::Unloaded);
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(45));
        thread::sleep(Duration::from_millis(100));
    }
    // A lightweight refresh cannot load a voice model.
    assert_eq!(
        runtime.status(&cancel).unwrap().model_state,
        ModelState::Unloaded
    );
    let ready = runtime.prepare(&session, &cancel).unwrap();
    assert_eq!(ready.model_state, ModelState::Ready);
    let request = crate::assistant_speech::SpeechRequest {
        request_id: format!("owned_live_{}", std::process::id()),
        text: "你好呀，今天也要一起加油哦！".into(),
    };
    let bridge = crate::assistant_speech::SpeechBridge::default();
    let (ticket, old) = bridge.begin(&request).unwrap();
    let audio = bridge.synthesize(&ticket, &request, &old).unwrap();
    assert!(audio.len() > 48000);
    runtime.stop(&session).unwrap();
    guard.session.take();
    assert_eq!(
        runtime.status(&cancel).unwrap().service_state,
        ServiceState::Stopped
    );
    println!("real owned WSL lifecycle: environment+SHA passed, refresh unloaded, prepare ready, {} WAV bytes, stopped",audio.len());
}
