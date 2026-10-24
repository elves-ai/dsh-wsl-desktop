import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('speech settings management and pet preferences have separate exact local capabilities',()=>{
 const settings=JSON.parse(read('src-tauri/capabilities/speech-settings.json'));
 const pet=JSON.parse(read('src-tauri/capabilities/speech-preferences.json'));
 const enabled=JSON.parse(read('src-tauri/tauri.conf.json')).app.security.capabilities;
 for(const name of ['pet-speech','speech-settings','speech-preferences']) assert.ok(enabled.includes(name),name+' must be enabled in the packaged application');
 assert.equal(settings.local,true);assert.equal(settings.remote,undefined);assert.deepEqual(settings.webviews,['launcher-settings','dsh-settings']);
 assert.deepEqual(pet.webviews,['assistant-pet']);assert.equal(pet.local,true);assert.equal(pet.remote,undefined);
 assert.deepEqual(pet.permissions,['allow-get-speech-preferences','allow-set-speech-preferences']);
 for(const name of ['get_speech_settings','save_speech_config','speech_action','get_speech_preferences','set_speech_preferences','test_speech','cancel_speech_test']){
  assert.ok(settings.permissions.includes('allow-'+name.replaceAll('_','-')));
  assert.ok(read('src-tauri/build.rs').includes('"'+name+'"'));
  assert.ok(read('src-tauri/src/desktop.rs').includes('speech_settings::'+name));
 }
 for(const p of settings.permissions)assert.doesNotMatch(p,/shell|http|fs|perform-action|set-project/);
});
test('speech settings stay in the current trusted settings navigation and not the titlebar',()=>{
 assert.ok(read('src/main.ts').includes("'pet', 'speech', 'updates'"));
 assert.ok(read('src-tauri/src/desktop.rs').includes('"pet" | "speech" | "updates"'));
 assert.ok(read('src-tauri/src/desktop_settings.rs').includes('"speech" => "speech"'));
 assert.doesNotMatch(read('titlebar.html'),/speech-model|speech-start|speech-volume/);
 assert.doesNotMatch(read('src-tauri/tauri.conf.json'),/18765/);
});
test('native speech management guards settings callers and auditions only fixed text',()=>{
 const s=read('src-tauri/src/desktop_speech_settings.rs');
 assert.ok(s.includes('settings_page::label(view.window().label())'));
 assert.ok(s.includes('settings_page::is_active(view.window().label())'));
 for(const name of ['get_speech_settings','save_speech_config','speech_action','test_speech','cancel_speech_test']){
  const from=s.indexOf('fn '+name+'(');assert.ok(from>=0,name);
  const body=s.slice(from,s.indexOf('#[tauri::command]',from+4)<0?undefined:s.indexOf('#[tauri::command]',from+4));
  assert.ok(body.includes('assert_page(&view,'),name+' exact trusted settings guard');
 }
 assert.ok(s.includes('你好呀，今天也要一起加油哦！'));
 const audition=s.slice(s.indexOf('fn test_speech('),s.indexOf('fn cancel_speech_test('));
 assert.doesNotMatch(audition,/(?:text|url|command|port): String/);
 assert.ok(s.includes('super::speech::stop(view.app_handle())'));
 assert.ok(read('src-tauri/src/desktop.rs').includes('speech_settings::shutdown(app)'));
});
test('only small trusted bridge sources are embedded, not models or executable shell templates',()=>{
 const native=read('src-tauri/src/speech_wsl.rs');
 assert.doesNotMatch(native,/include_bytes!\([^)]*\.gguf/);
 assert.ok(native.includes('--launch-held'));assert.ok(native.includes('--inspect'));
 assert.ok(native.includes('no_proxy()'));assert.ok(native.includes('Policy::none()'));
 assert.ok(native.includes('X-DSH-Speech-Control'));
 assert.doesNotMatch(read('src/speech-settings.ts'),/fetch\(|XMLHttpRequest|http:\/\/127\.0\.0\.1:18765/);
 assert.ok(read('scripts/Build-Windows.ps1').includes("'services/qwen_tts'"));
 assert.ok(read('scripts/Build-Windows.ps1').includes("'src-tauri/helpers'"));
});
