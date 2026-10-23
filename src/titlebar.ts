import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './titlebar.css';

type TitlebarState = { maximized: boolean; focused: boolean; title: string };
type WindowAction = 'state' | 'minimize' | 'maximize' | 'close' | 'drag';
type UpdateNotice = { available: boolean };

const native = isTauri();
const titlebar = document.getElementById('titlebar')!;
const dragArea = document.getElementById('drag-area')!;
const title = document.getElementById('window-title')!;
const status = document.getElementById('titlebar-status')!;
const maximize = document.getElementById('window-maximize')!;
const settingsButton = document.getElementById('titlebar-settings') as HTMLButtonElement;
const updateButton = document.getElementById('titlebar-updates') as HTMLButtonElement;
const updateDot = document.getElementById('titlebar-update-dot')!;
const actions: WindowAction[] = ['minimize', 'maximize', 'close'];
const windowButtons = actions.map(action => document.getElementById('window-' + action) as HTMLButtonElement);
let disposed = false;
let unlisten: (() => void) | undefined;
let navigationPending = false;
let unlistenUpdates: (() => void) | undefined;
let updateRevision = 0;
let stateRevision = 0;
const pendingActions = new Set<WindowAction>();
titlebar.setAttribute('data-native', String(native));

function announce(message: string) {
  if (disposed) return;
  status.textContent = message;
  title.setAttribute('title', message || title.textContent || 'DeepSeek Harness');
  dragArea.setAttribute('title', message || '拖动窗口；双击最大化或还原');
}

function applyState(state: TitlebarState) {
  if (disposed) return;
  title.textContent = state.title || 'DeepSeek Harness';
  title.setAttribute('title', status.textContent || title.textContent);
  titlebar.setAttribute('data-focused', String(state.focused));
  maximize.setAttribute('data-maximized', String(state.maximized));
  const label = state.maximized ? '还原' : '最大化';
  maximize.setAttribute('aria-label', label);
  maximize.setAttribute('title', label);
}

async function windowAction(action: WindowAction) {
  if (!native || disposed || pendingActions.has(action)) return;
  pendingActions.add(action);
  const revision = stateRevision;
  try {
    const state = await invoke<TitlebarState>('titlebar_action', { action });
    if (disposed) return;
    // An event received during the request is newer than its returned snapshot.
    if (stateRevision === revision) applyState(state);
    if (action !== 'state') announce('');
  } catch {
    announce('窗口操作失败，请重试。');
  } finally {
    pendingActions.delete(action);
  }
}

async function showSettings(section: 'environment' | 'updates' = 'environment') {
  if (disposed || navigationPending) return;
  if (!native) {
    window.location.href = section === 'updates'
      ? './index.html?view=settings&section=updates'
      : './index.html?view=settings&section=environment';
    return;
  }
  navigationPending = true;
  settingsButton.disabled = updateButton.disabled = true;
  try {
    await invoke<void>(section === 'updates' ? 'open_titlebar_updates' : 'open_titlebar_settings');
    announce('');
  } catch {
    announce(section === 'updates' ? '更新页面打开失败，请重试。' : '设置打开失败，请重试。');
  } finally {
    navigationPending = false;
    if (!disposed) settingsButton.disabled = updateButton.disabled = false;
  }
}

settingsButton.addEventListener('click', event => {
  if (event.detail <= 1) void showSettings();
});
updateButton.addEventListener('click', event => {
  if (event.detail <= 1) void showSettings('updates');
});
actions.forEach((action, index) => {
  windowButtons[index].disabled = !native;
  windowButtons[index].addEventListener('click', () => { void windowAction(action); });
});

// Only this separate flexible region owns drag handlers; controls are siblings.
dragArea.addEventListener('mousedown', event => {
  if (event.button !== 0) return;
  if (event.detail === 1 || event.detail === 2) {
    event.preventDefault();
    // Native dragging can capture the mouse before a DOM dblclick arrives.
    void windowAction(event.detail === 2 ? 'maximize' : 'drag');
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    (document.activeElement as HTMLElement | null)?.blur();
    return;
  }
});

function cleanup() {
  disposed = true;
  unlisten?.();
  unlisten = undefined;
  unlistenUpdates?.();
  unlistenUpdates = undefined;
}
window.addEventListener('beforeunload', cleanup);
window.addEventListener('pagehide', cleanup);

async function initialize() {
  if (!native) {
    title.textContent = '浏览器预览 · 窗口操作不可用';
    announce('浏览器预览：点击设置可预览页面，窗口操作仅在桌面应用可用。');
    return;
  }
  try {
    const stop = await listen<TitlebarState>('titlebar-state', event => {
      if (disposed) return;
      stateRevision += 1;
      applyState(event.payload);
    });
    // Registration can complete after the child Webview has begun unloading.
    if (disposed) { stop(); return; }
    unlisten = stop;
  } catch {
    announce('窗口状态订阅失败，请重新打开窗口。');
  }
  if (!disposed) await windowAction('state');
}
function applyUpdateNotice(notice: UpdateNotice) {
  if (disposed) return;
  const available = notice?.available === true;
  updateDot.hidden = !available;
  updateButton.setAttribute('data-update-available', String(available));
  const label = available ? '软件更新（有新版本）' : '软件更新';
  updateButton.setAttribute('aria-label', label);
  updateButton.setAttribute('title', label);
}

async function initializeUpdateNotice() {
  if (!native || disposed) return;
  try {
    const stop = await listen<UpdateNotice>('titlebar-update-state', event => {
      if (disposed) return;
      updateRevision += 1;
      applyUpdateNotice(event.payload);
    });
    if (disposed) { stop(); return; }
    unlistenUpdates = stop;
  } catch { /* The button remains usable even if the background indicator cannot subscribe. */ }
  if (disposed) return;
  const revision = updateRevision;
  try {
    const notice = await invoke<UpdateNotice>('get_titlebar_update_state');
    if (!disposed && updateRevision === revision) applyUpdateNotice(notice);
  } catch { /* Unknown availability is not an update; never block opening the update page. */ }
}

void initialize();
void initializeUpdateNotice();
