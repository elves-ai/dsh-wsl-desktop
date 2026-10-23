import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './titlebar.css';

type TitlebarState = { maximized: boolean; focused: boolean; title: string };
type WindowAction = 'state' | 'minimize' | 'maximize' | 'close' | 'drag';

const native = isTauri();
const titlebar = document.getElementById('titlebar')!;
const dragArea = document.getElementById('drag-area')!;
const title = document.getElementById('window-title')!;
const status = document.getElementById('titlebar-status')!;
const maximize = document.getElementById('window-maximize')!;
const menuButton = document.getElementById('app-menu') as HTMLButtonElement;
const actions: WindowAction[] = ['minimize', 'maximize', 'close'];
const windowButtons = actions.map(action => document.getElementById('window-' + action) as HTMLButtonElement);
let disposed = false;
let unlisten: (() => void) | undefined;
let menuPending = false;
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

async function showMenu() {
  if (!native || disposed || menuPending) return;
  menuPending = true;
  menuButton.disabled = true;
  try {
    await invoke<void>('show_titlebar_menu', { x: menuButton.getBoundingClientRect().left });
    announce('');
  } catch {
    announce('菜单打开失败，请重试。');
  } finally {
    menuPending = false;
    if (!disposed) menuButton.disabled = false;
  }
}

menuButton.disabled = !native;
menuButton.addEventListener('click', event => {
  if (event.detail <= 1) void showMenu();
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
  if (!native || disposed || !event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
  if (event.key.toLowerCase() === 'm') {
    event.preventDefault();
    void showMenu();
  }
});

function cleanup() {
  disposed = true;
  unlisten?.();
  unlisten = undefined;
}
window.addEventListener('beforeunload', cleanup);
window.addEventListener('pagehide', cleanup);

async function initialize() {
  if (!native) {
    title.textContent = '浏览器预览 · 原生功能不可用';
    announce('浏览器预览：菜单及窗口操作仅在桌面应用可用。');
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
void initialize();
