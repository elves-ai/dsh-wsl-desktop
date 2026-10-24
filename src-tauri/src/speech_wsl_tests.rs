use super::*;
fn fixture() -> Config {
    Config::parse(br#"{"Distribution":"Ubuntu","LinuxUser":"user","LinuxLauncher":"/home/user/dsh","LinuxConfig":"/home/user/config.json"}"#).unwrap()
}
#[test]
fn status_is_not_model_readiness_and_non_rocm_is_not_ready() {
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
