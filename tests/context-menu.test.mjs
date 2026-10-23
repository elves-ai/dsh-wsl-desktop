import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const menu = read('src-tauri/src/desktop_context_menu.rs');

test('native context menu replaces all stock entries with exactly refresh and developer tools', () => {
  assert.match(menu, /for index in \(0\.\.count\)\.rev\(\)/);
  assert.match(menu, /items\.RemoveValueAtIndex\(index\)\?/);
  assert.deepEqual([...menu.matchAll(/w!\("([^"]+)"\)/g)].map(match => match[1]), ['刷新', '打开控制台']);
  assert.equal((menu.match(/CreateContextMenuItem\(/g) || []).length, 2);
  assert.match(menu, /items\.InsertValueAtIndex\(0, &refresh\)\?/);
  assert.match(menu, /items\.InsertValueAtIndex\(1, &tools\)\?/);
  assert.match(menu, /refresh\.SetIsEnabled\(true\)\?/);
  assert.match(menu, /tools\.SetIsEnabled\(true\)\?/);
  assert.match(menu, /refresh_core\.Reload\(\)/);
  assert.match(menu, /tools_core\.OpenDevToolsWindow\(\)/);
  assert.match(menu, /SetAreDevToolsEnabled\(true\)\?/);
  assert.match(menu, /SetAreDefaultContextMenusEnabled\(true\)\?/);
  assert.doesNotMatch(menu, /debug_assertions|cfg!|open_devtools|Command::|powershell/);
});

test('native handler stays installed across page loads and fails closed without exposing remote IPC', () => {
  assert.match(menu, /with_webview/);
  assert.match(menu, /add_ContextMenuRequested/);
  assert.ok(menu.indexOf('args.SetHandled(true)?') < menu.indexOf('args.MenuItems()?'));
  assert.ok(menu.indexOf('args.SetHandled(false)') > menu.indexOf('items.InsertValueAtIndex(1'));
  assert.match(menu, /mpsc::sync_channel\(1\)/);
  assert.doesNotMatch(menu, /tauri::command|initialization_script|\.eval\(|unsafe impl Send/);
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  for (const name of config.app.security.capabilities) {
    const capability = JSON.parse(read('src-tauri/capabilities/' + name + '.json'));
    assert.equal(capability.remote, undefined);
  }
});

test('launcher, workspace, settings, and titlebar attach the same native menu once per creation', () => {
  const desktop = read('src-tauri/src/desktop.rs');
  assert.equal((desktop.match(/context_menu::attach\(&view\)\?/g) || []).length, 2);
  assert.match(read('src-tauri/src/desktop_titlebar.rs'), /context_menu::attach\(&view\)\?/);
  const settings = read('src-tauri/src/desktop_settings.rs');
  assert.match(settings, /context_menu::attach\(&page\)\.is_err\(\)/);
  const failure = settings.slice(settings.indexOf('if super::context_menu::attach'), settings.indexOf('// Keep the original visible'));
  assert.match(failure, /page\.close\(\)/);
  assert.match(failure, /REQUESTED\.fetch_and/);
  assert.doesNotMatch(desktop, /initialization_script/);
});
