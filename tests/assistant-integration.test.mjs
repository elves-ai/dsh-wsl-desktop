import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('removed narration exposes no frontend integration, native commands or IPC grants', () => {
  for (const path of ['src/assistant.ts', 'src/main.ts']) {
    assert.doesNotMatch(read(path), /QwenSpeech|PetSpeech|SpeechSettings|speechSynthesis|new Audio\(|assistant_speech_|(?:get|set)_speech_preferences|launcher-speech-/);
  }
  const desktop = read('src-tauri/src/desktop.rs');
  const build = read('src-tauri/build.rs');
  assert.doesNotMatch(desktop + build, /assistant_speech_|(?:get|set)_speech_preferences|install_speech|check_speech_prerequisites|desktop_speech/);
  for (const file of readdirSync(new URL('../src-tauri/capabilities/', import.meta.url)).filter(file => file.endsWith('.json'))) {
    const capability = JSON.parse(read('src-tauri/capabilities/' + file));
    assert.ok(!capability.permissions.some(permission => /speech|tts/.test(permission)), file);
  }
  for (const path of ['src/pet/speech.ts', 'src/pet/qwen-speech.ts', 'src/speech-settings.ts', 'src/speech-resources.ts', 'src-tauri/capabilities/pet-speech.json', 'src-tauri/capabilities/speech-settings.json', 'src-tauri/capabilities/speech-preferences.json']) {
    assert.equal(existsSync(new URL('../' + path, import.meta.url)), false, path);
  }
});

test('assistant gets dedicated bundled capabilities, not launcher or remote privileges', () => {
  const capability = JSON.parse(read('src-tauri/capabilities/assistant.json'));
  assert.equal(capability.local, true);
  assert.equal(capability.remote, undefined);
  assert.equal(capability.windows, undefined);
  assert.deepEqual(capability.webviews, ['assistant-pet', 'assistant-chat']);
  assert.deepEqual(capability.permissions, ['core:event:allow-listen', 'core:event:allow-unlisten', 'allow-get-assistant-snapshot', 'allow-assistant-action']);
  assert.ok(!JSON.parse(read('src-tauri/capabilities/launcher.json')).webviews.includes('assistant-chat'));
  assert.ok(!capability.permissions.includes('allow-perform-action'));
  const native = read('src-tauri/src/desktop_assistant.rs');
  assert.ok(native.includes('assert_assistant(&view)?'));
  assert.ok(native.includes('view.label() != view.window().label()'));
  assert.ok(native.includes('url.path() != "/assistant.html"'));
  assert.ok(native.includes('pairs.len() == 1'));
  assert.ok(native.includes('deny_unknown_fields'));
});

test('pet workspace creation and restored bindings cannot select a custom directory', () => {
  const native = read('src-tauri/src/desktop_assistant.rs');
  const action = native.slice(native.indexOf('pub(super) enum Action {'), native.indexOf('fn action_allowed('));
  assert.match(action, /Enable \{\}/);
  assert.doesNotMatch(action, /Reconfigure|path: String/);
  const directory = native.slice(native.indexOf('fn default_directory('), native.indexOf('fn id()'));
  assert.match(directory, /config: &Config, create: bool/);
  assert.match(directory, /if !create \{[\s\S]*?args\.push\("--inspect"/);
  assert.doesNotMatch(directory, /path\.to_owned/);
  const runAction = native.slice(native.indexOf('fn run_action('), native.indexOf('fn open_session('));
  const initializer = native.slice(native.indexOf('fn initialize_locked('), native.indexOf('fn run_action('));
  assert.ok(initializer.includes('default_directory(&backend, true)?'));
  assert.match(initializer, /state\s*\.store\(\)\s*\.load\(\)/);
  assert.ok(initializer.includes('require_session(&rows, &binding)?'));
  const enable = runAction.slice(runAction.indexOf('Action::Enable {} =>'), runAction.indexOf('Action::Retry =>'));
  assert.ok(enable.includes('return Err('));
  const access = native.slice(native.indexOf('fn action_allowed('), native.indexOf('fn document_allowed('));
  assert.ok(access.includes('Action::Enable { .. } => false'));
  const checked = native.slice(native.indexOf('fn checked_binding('), native.indexOf('fn default_directory('));
  assert.ok(checked.includes('require_default_workspace'));
  assert.ok(checked.includes('default_directory(config, false)?'));
  const follower = native.slice(native.indexOf('pub(super) fn start('), native.indexOf('// Independent status observation'));
  assert.ok(follower.indexOf('require_default_workspace') < follower.indexOf('let rpc = client'));
  assert.ok(follower.includes('follow_state.require_setup'));
  const reset = native.slice(native.indexOf('fn require_setup('), native.indexOf('fn wait('));
  assert.ok(reset.includes('data.generation != generation'));
  assert.ok(reset.includes('data.projection.set_enabled(false)'));
  assert.doesNotMatch(reset, /\.save\(|\.clear\(|fs::|workspace_create|session_create/);
  const retry = runAction.slice(runAction.indexOf('Action::Retry =>'), runAction.indexOf('Action::NewSession =>'));
  assert.ok(retry.includes('bound_workspace'));
  assert.ok(retry.includes('state.require_setup'));
  assert.doesNotMatch(retry, /default_directory\(&config, true\)|workspace_create/);
});

test('status polling preserves missing-workspace initialization guidance', () => {
  const native = read('src-tauri/src/desktop_assistant.rs');
  const polling = native.slice(native.indexOf('// Independent status observation'), native.indexOf('// Native hit testing'));
  assert.match(polling, /default_directory\(&config, false\)/);
  assert.match(polling, /Err\(error\) => \{[\s\S]*?workspace_error_phase\(&error, "offline"\)/);
  assert.doesNotMatch(polling, /set_connection\(false, "offline", &error\)/);
});

test('show queues one initialization that waits for backend readiness and operation leases', () => {
  const native = read('src-tauri/src/desktop_assistant.rs');
  const reveal = native.slice(native.indexOf('pub(super) fn reveal_pet('), native.indexOf('pub(super) fn show('));
  assert.ok(reveal.includes('state.initialize_requested.store(true, Ordering::SeqCst)'));
  const worker = native.slice(native.indexOf('pub(super) fn start('), native.indexOf('// One follower per selected generation.'));
  assert.ok(worker.includes('init_controller.snapshot().state == "ready"'));
  assert.ok(worker.includes('crate::pet_memory::operation_mutex().try_lock()'));
  assert.ok(worker.includes('init_state.operation.try_lock()'));
  assert.ok(worker.includes('.swap(false, Ordering::SeqCst)'));
  assert.ok(worker.includes('initialize_locked(&init_app, &init_state)'));
  const initialize = native.slice(native.indexOf('fn initialize_locked('), native.indexOf('fn run_action('));
  assert.ok(initialize.includes('current != Some(&binding)'));
  for (const unsafe of ['session_prompt(', 'session_delete(', 'remove_dir', 'remove_file']) assert.ok(!initialize.includes(unsafe));
});
test('assistant is built, staged, and registered with generated command permissions', () => {
  assert.ok(read('vite.config.ts').includes("assistant: 'assistant.html'"));
  assert.ok(read('scripts/Build-Windows.ps1').includes("'assistant.html'"));
  assert.ok(read('assistant.html').includes('/src/assistant.ts'));
  for (const name of ['get_assistant_snapshot', 'assistant_action']) {
    assert.ok(read('src-tauri/build.rs').includes('"' + name + '"'));
    assert.ok(read('src-tauri/src/desktop.rs').includes('assistant::' + name));
    assert.ok(read('src-tauri/permissions/autogenerated/' + name + '.toml').includes('commands.allow = ["' + name + '"]'));
  }
  assert.ok(read('src-tauri/src/desktop.rs').includes('"桌面助手…"'));
});

test('session follow stays read-only and explicit interaction transport never becomes arbitrary frontend RPC', () => {
  const source = read('src-tauri/src/assistant_transport.rs');
  assert.ok(source.includes('/api/remote.mux'));
  assert.ok(source.includes('"session/follow"'));
  assert.ok(source.includes('assistantStream'));
  assert.ok(!source.includes('pub fn call('));
  const follow=source.slice(source.indexOf('pub fn session_follow('),source.indexOf('pub fn interaction_events('));
  assert.ok(follow.includes('session/follow'));assert.ok(!follow.includes('$events'));
  assert.ok(source.includes('pub fn interaction_events('));assert.ok(source.includes('pub fn interaction_result('));
  const native = read('src-tauri/src/desktop_assistant.rs');
  assert.ok(native.includes('notifications::auth_cookie'));
  assert.ok(native.includes('pending_exists'));
  assert.ok(native.includes('assistant_policy::catalog'));
  assert.ok(native.includes('assistant_policy::send_allowed'));
  assert.ok(!native.includes('notifications::Notifications'));
  assert.ok(native.includes('set_ignore_cursor_events'));
});

test('physical movement is pet-only and releases preserve upstream credit and resources', () => {
  const motion=JSON.parse(read('src-tauri/capabilities/pet-motion.json'));
  assert.equal(motion.local,true);
  assert.equal(motion.remote,undefined);
  assert.deepEqual(motion.webviews,['assistant-pet']);
  assert.deepEqual(motion.permissions,['allow-get-pet-geometry','allow-move-pet','allow-drag-pet','allow-get-pet-preferences','allow-set-pet-topmost','allow-set-pet-slingshot-enabled']);
  const native=read('src-tauri/src/desktop_pet.rs');
  assert.ok(native.includes('assert_assistant(view)?'));
  assert.ok(native.includes('view.label() != "assistant-pet"'));
  assert.ok(native.includes('view.window().label() != "assistant-pet"'));
  assert.ok(native.includes('url.query() != Some("view=pet")'));
  assert.ok(native.includes('clamp_pet_position'));
  for(const name of ['get_pet_geometry','move_pet','drag_pet']) {
    assert.ok(read('src-tauri/build.rs').includes('"'+name+'"'));
    assert.ok(read('src-tauri/src/desktop.rs').includes('pet::'+name));
    assert.ok(read('src-tauri/permissions/autogenerated/'+name+'.toml').includes('commands.allow = ["'+name+'"]'));
  }
  assert.ok(read('scripts/Build-Windows.ps1').includes("'public', 'third-party'"));
  assert.ok(read('.github/workflows/windows-build.yml').includes('https://github.com/PC2005-cloud/dsh-pet'));
  assert.ok(read('LICENSE').includes('prohibit commercial use'));
  const ui=read('src/assistant.ts');
  assert.ok(ui.includes('new PetRenderer'));
  assert.ok(ui.includes('new PetMotion'));
  assert.ok(ui.includes('data-upstream'));
  assert.ok(!read('src/assistant.css').includes('.buddy-body'));
});


test('fused dragging keeps pet-only authorization and release/no-op/cache safeguards on the native path', () => {
  const native=read('src-tauri/src/desktop_pet.rs');
  const drag=native.slice(native.indexOf('pub(super) fn drag_pet('),native.indexOf('pub(super) fn move_pet('));
  assert.ok(drag.includes('pet_window(&view, &app)?'));
  assert.ok(drag.includes('valid_grab(grab)'));
  assert.ok(drag.indexOf('valid_grab(grab)') < drag.indexOf('geometry(&window, &app)?'));
  assert.ok(drag.includes('if !actual.cursor_down'));
  assert.ok(drag.indexOf('if !actual.cursor_down') < drag.indexOf('move_to('));
  assert.ok(native.includes('clamped_move_target(requested, actual.position, actual.size, &actual.areas)'));
  assert.ok(native.includes('if dragging && !left_button_down()'));
  const assistant=read('src-tauri/src/desktop_assistant.rs');
  assert.ok(assistant.includes('WindowEvent::ScaleFactorChanged { .. } | WindowEvent::Resized(_)'));
  assert.ok(assistant.includes('super::pet::invalidate_work_areas()'));
  const policy=read('src-tauri/src/pet_native_policy.rs');
  assert.ok(policy.includes('Duration::from_millis(350)'));
  for(const capability of ['assistant','launcher']) assert.ok(!read('src-tauri/capabilities/'+capability+'.json').includes('allow-drag-pet'));
});

test('native horizontal padding matches the visible shared-core character and survives restore/DPI changes', () => {
  const constants = read('src/vendor/dsh-pet/constants.ts');
  const hit = constants.match(/HIT_BOX = \{ x0: (\d+), y0: \d+, x1: (\d+), y1: \d+ \}/);
  assert.ok(hit);
  const [left, right] = hit.slice(1).map(Number);
  assert.equal(left, 640 - right);
  const geometry = read('src-tauri/src/pet_geometry.rs');
  assert.ok(geometry.includes('size.width * (' + left + '.0 / 640.0)'));
  const native = read('src-tauri/src/desktop_pet.rs');
  assert.ok(native.includes('horizontal_inset: pet_horizontal_inset(size)'));
  assert.ok(native.includes('clamp_pet_position(actual.position, actual.size, &actual.areas)'));
  const assistant = read('src-tauri/src/desktop_assistant.rs');
  assert.ok(assistant.includes('super::pet::constrain_pet_position('));
  assert.ok(assistant.includes('// Preserve the live drag location across DPI changes;'));
});

test('pet controls share actual visibility without inheriting DSH or service privileges', () => {
  const cap=JSON.parse(read('src-tauri/capabilities/pet-settings.json'));
  assert.equal(cap.local,true);assert.equal(cap.remote,undefined);assert.equal(cap.windows,undefined);
  assert.deepEqual(cap.webviews,['launcher-settings','dsh-settings']);
  assert.deepEqual(cap.permissions,['allow-get-pet-memory','allow-pet-memory-action','allow-initialize-pet-workspace','allow-get-pet-workspace','allow-open-pet-workspace','allow-get-pet-settings','allow-set-pet-settings','allow-set-pet-visibility']);
  const source=read('src-tauri/src/desktop_pet_settings.rs');
  assert.ok(source.includes('assert_local(view)?'));
  assert.ok(source.includes('"launcher-settings" | "dsh-settings"'));
  assert.ok(source.includes('window.is_visible()'));
  assert.ok(source.includes('.is_minimized()'));
  assert.ok(source.includes('assistant::reveal_pet(app)?'));
  assert.ok(!source.includes('assistant::show(app)'));
  assert.ok(source.includes('"launcher-titlebar", "dsh-titlebar"'));
  assert.ok(source.includes('"titlebar-pet-state"'));
  assert.ok(source.includes('"pet-settings-state"'));
  assert.ok(source.includes('"pet-settings.json"'));
  assert.ok(!source.includes('ensure_ready('));assert.ok(!source.includes('session_prompt('));
  for(const command of ['get_pet_settings','set_pet_settings','set_pet_visibility','get_pet_preferences','set_pet_topmost','get_titlebar_pet_state','toggle_titlebar_pet','get_pet_notifications','open_pet_notification','dismiss_pet_notification']) {
    assert.ok(read('src-tauri/build.rs').includes('"'+command+'"'));
    assert.ok(read('src-tauri/permissions/autogenerated/'+command+'.toml').includes('commands.allow = ["'+command+'"]'));
  }
  const assistant=read('src-tauri/src/desktop_assistant.rs');
  assert.ok(!assistant.includes('if state.snapshot().enabled {'));
  assert.ok(assistant.includes('super::pet_settings::PetControls'));
  assert.ok(assistant.includes('set_visible(&app, false)'));
});


test('slingshot toggle is a narrow authenticated pet command and publishes durable shared settings', () => {
  const source=read('src-tauri/src/desktop_pet_settings.rs');
  const command=source.slice(source.indexOf('pub(super) async fn set_pet_slingshot_enabled('),source.indexOf('pub(super) async fn set_pet_topmost('));
  assert.match(command,/enabled: bool,\s*\) -> Result<PetSettingsSnapshot, String>/);
  assert.doesNotMatch(command,/(?:patch|label|url|path):/);
  assert.ok(command.includes('assistant::assert_assistant(&view)?'));
  assert.ok(command.includes('view.label() != "assistant-pet"'));
  assert.ok(command.indexOf('assistant::assert_assistant(&view)?') < command.indexOf('state.inner().clone()'));
  assert.ok(command.indexOf('view.label() != "assistant-pet"') < command.indexOf('state.inner().clone()'));
  assert.match(command,/spawn_blocking\(move \|\| \{\s*state\.set_preferences\(\s*&app,\s*PetSettingsPatch \{\s*slingshot_enabled: Some\(enabled\),\s*\.\.Default::default\(\)\s*\},\s*\)\s*\}\)\s*\.await/);
  const setter=source.slice(source.indexOf('fn set_preferences('),source.indexOf('fn set_visible_locked('));
  assert.ok(setter.includes('self.publish(app)'));
  assert.ok(setter.includes('Ok(self.snapshot())'));
  assert.ok(source.includes('for label in ["launcher-settings", "dsh-settings", "assistant-pet"]'));
  assert.ok(source.includes('"pet-settings-state", &snapshot'));
  const generic=source.slice(source.indexOf('pub(super) async fn set_pet_settings('),source.indexOf('pub(super) async fn set_pet_visibility('));
  assert.ok(generic.includes('assert_settings(&view)?'));
  assert.ok(!generic.includes('assert_assistant'));
  const cap=JSON.parse(read('src-tauri/capabilities/pet-motion.json'));
  assert.equal(cap.local,true);assert.equal(cap.remote,undefined);assert.equal(cap.windows,undefined);
  assert.deepEqual(cap.webviews,['assistant-pet']);
  assert.ok(cap.permissions.includes('allow-set-pet-slingshot-enabled'));
  assert.ok(!cap.permissions.includes('allow-set-pet-settings'));
  for(const capability of ['assistant','launcher','pet-settings']) {
    assert.ok(!read('src-tauri/capabilities/'+capability+'.json').includes('allow-set-pet-slingshot-enabled'));
  }
  const name='set_pet_slingshot_enabled';
  assert.ok(read('src-tauri/build.rs').includes('"'+name+'"'));
  assert.ok(read('src-tauri/src/desktop.rs').includes('pet_settings::'+name));
  const permission=read('src-tauri/permissions/autogenerated/'+name+'.toml');
  assert.ok(permission.includes('commands.allow = ["'+name+'"]'));
  assert.ok(permission.includes('commands.deny = ["'+name+'"]'));
});

test('topmost bridge targets only the authenticated pet and reads back native state', () => {
  const source=read('src-tauri/src/desktop_pet_settings.rs');
  const setter=source.slice(source.indexOf('fn set_topmost('),source.indexOf('pub(super) fn set_visible('));
  assert.ok(setter.includes('self.operation.lock()'));
  assert.ok(setter.includes('get_window("assistant-pet")'));
  assert.ok(setter.includes('set_always_on_top(always_on_top)'));
  assert.ok(setter.includes('self.reconcile(app)?'));
  assert.ok(!setter.includes('self.store.save'));
  assert.match(source, /window\s*\.is_always_on_top\(\)/);
  const command=source.slice(source.indexOf('async fn set_pet_topmost('),source.indexOf('fn get_pet_preferences('));
  assert.ok(command.includes('assistant::assert_assistant(&view)?'));
  assert.ok(command.includes('view.label() != "assistant-pet"'));
  assert.ok(!command.includes('label:'));assert.ok(!command.includes('url:'));
  const cap=JSON.parse(read('src-tauri/capabilities/pet-motion.json'));
  assert.deepEqual(cap.webviews,['assistant-pet']);
  assert.ok(cap.permissions.includes('allow-set-pet-topmost'));
  const snapshot=read('src-tauri/src/pet_settings.rs');
  assert.ok(snapshot.includes('pub always_on_top: bool'));
  assert.ok(!snapshot.slice(snapshot.indexOf('pub struct PetPreferences {'),snapshot.indexOf('impl Default for PetPreferences')).includes('always_on_top'));
});


test('bubble notifications are pet-only opaque-id actions and suppress automatic system toasts', () => {
  const cap=JSON.parse(read('src-tauri/capabilities/pet-notifications.json'));
  assert.equal(cap.local,true);assert.equal(cap.remote,undefined);assert.equal(cap.windows,undefined);
  assert.deepEqual(cap.webviews,['assistant-pet']);
  assert.deepEqual(cap.permissions,['allow-get-pet-notifications','allow-open-pet-notification','allow-dismiss-pet-notification']);
  const bridge=read('src-tauri/src/desktop_pet_notifications.rs');
  assert.equal((bridge.match(/assistant::assert_assistant/g)||[]).length,3);
  assert.ok(bridge.includes('view.window().label() != PET'));
  assert.ok(bridge.includes('Some("view=pet")'));
  assert.ok(bridge.includes('open_notified_session(&app, &target)'));
  assert.ok(bridge.includes('spawn_blocking'));
  assert.ok(bridge.includes('"pet-notification"'));
  const open=bridge.slice(bridge.indexOf('async fn open_pet_notification('),bridge.indexOf(') -> Result',bridge.indexOf('async fn open_pet_notification(')));
  assert.ok(open.includes('id: String'));assert.doesNotMatch(open,/(?:target|url|path|session_id):/);
  const native=read('src-tauri/src/desktop_notifications.rs');
  assert.ok(native.includes('ChannelGate::route'));
  assert.ok(native.includes('channels.system_delivery(state.gate(app), is_foreground, notify_when_focused)'));
  assert.ok(native.includes('SystemDelivery::SoundOnly => super::toasts::play_notification_sound(kind)'));
  const soundBranch=native.slice(native.indexOf('SystemDelivery::SoundOnly =>'),native.indexOf('SystemDelivery::Toast =>'));
  assert.ok(!soundBranch.includes('toasts.show'));
  const toastBranch=native.slice(native.indexOf('SystemDelivery::Toast =>'),native.indexOf('if let Err(message) = result'));
  assert.ok(toastBranch.includes('state.toasts.show(&app_id, title, body, kind, move ||'));
  assert.ok(!toastBranch.includes('play_notification_sound'));
  assert.ok(native.includes('BubbleKind::Waiting'));assert.ok(native.includes('BubbleKind::Completed'));assert.ok(native.includes('BubbleKind::Failed'));
  const baseline=native.slice(native.indexOf('if !channels.continuous'),native.indexOf('generation = Some(channels)'));
  assert.ok(baseline.includes('attention.disconnected()'));assert.ok(!baseline.includes('attention.reset()'));
  assert.ok(read('src/assistant.ts').includes('#pet-bubble'));
});


test('interactive answers are native-correlated, one-time, visible-only and never auto-retried', () => {
  const cap=JSON.parse(read('src-tauri/capabilities/pet-interactions.json'));
  assert.equal(cap.local,true);assert.equal(cap.remote,undefined);assert.equal(cap.windows,undefined);
  assert.deepEqual(cap.webviews,['assistant-pet']);
  assert.deepEqual(cap.permissions,['allow-get-pet-interactions','allow-submit-pet-interaction','allow-open-pet-interaction','allow-set-pet-interaction-surface']);
  const native=read('src-tauri/src/desktop_pet_interactions.rs');
  assert.ok(native.includes('assistant::assert_assistant(view)?'));
  assert.ok(native.includes('view.window().label() != PET'));
  assert.ok(native.includes('Some("view=pet")'));
  assert.ok(native.includes('interaction_enabled(&app)'));assert.ok(native.includes('pet_visible(&app)'));
  assert.ok(native.includes('model::validate_reply(&entry.card, &reply)?'));
  assert.ok(native.includes('entry.submitting = true'));
  assert.ok(native.includes('model::tool_details'));
  assert.ok(native.includes('connection.cancel.load'));
  assert.ok(native.includes('current(&app, &connection)?'));
  assert.ok(native.includes('state.invalidate(&app, Some(connection.generation))'));
  assert.ok(native.includes('interaction_wait'));
  const passive=native.slice(native.indexOf('fn update_focusable('),native.indexOf('pub(super) fn set_composer_active('));
  assert.ok(passive.includes('FocusChange::Refresh'));
  assert.ok(!passive.includes('set_focus()'));
  assert.ok(native.includes('matches!(change, FocusChange::Composer(true))'));
  assert.match(native, /if activate && focusable \{[\s\S]*?window\.set_focus\(\)[\s\S]*?get_webview\(PET\)[\s\S]*?\.set_focus\(\)/);
  for(const command of ['get_pet_interactions','submit_pet_interaction','open_pet_interaction','set_pet_interaction_surface']) {
    assert.ok(read('src-tauri/build.rs').includes('"'+command+'"'));
    assert.ok(read('src-tauri/permissions/autogenerated/'+command+'.toml').includes('commands.allow = ["'+command+'"]'));
  }
  const submit=native.slice(native.indexOf('async fn submit_pet_interaction('),native.indexOf(') -> Result',native.indexOf('async fn submit_pet_interaction(')));
  assert.ok(submit.includes('id: String'));assert.ok(submit.includes('reply: Reply'));
  assert.doesNotMatch(submit,/(?:event_id|client_id|url|path|cookie|agent_id):/);
});
