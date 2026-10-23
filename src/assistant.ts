import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { canSend, initialSnapshot, mergeSnapshot, movedBeyondThreshold, statusLabel } from './assistant-model';
import { renderMarkdown } from './assistant-markdown';
import { PetRenderer } from './pet/renderer';
import { PetNotifications } from './pet/notifications';
import { PetInteractions } from './pet/interactions';
import './pet/interactions.css';
import './pet/notifications.css';
import { PetMotion, type Geometry as PetGeometry } from './pet/motion';
import { HIT_BOX, SLINGSHOT_DOUBLE_MS } from './vendor/dsh-pet/constants';
import { physics, PET_UPSTREAM_URL } from './pet/config';
import './assistant.css';

const native = isTauri();
const view = new URLSearchParams(location.search).get('view') === 'pet' ? 'pet' : 'chat';
document.body.dataset.view = view;
const root = document.querySelector<HTMLElement>('#assistant-root')!;
// Static host markup only. Real pet playback uses dsh-pet's upstream media and shared core.
// https://github.com/PC2005-cloud/dsh-pet — code MIT; assets non-commercial open-source use.
const face = '<span class="fish-mark" aria-hidden="true">🐟</span>';
const credit = '<a class="pet-credit" href="https://github.com/PC2005-cloud/dsh-pet" target="_blank" rel="noopener noreferrer" data-upstream="true">dsh-pet · PC2005-cloud ↗</a><span class="asset-license">动画素材禁止商用</span>';
root.innerHTML = view === 'pet' ?
  '<section class="pet-shell" aria-label="鲸鱼娘桌面助手"><div id="preview" class="preview" hidden>浏览器预览 · 移动仅桌面应用可用</div><div id="pet-status" class="pet-status" role="status"></div><div class="pet-stage"><div id="pet-media" class="pet-media"></div><button id="pet" class="pet-hit" aria-label="打开鲸鱼娘对话（拖动可抛掷，快速连按再拖可弹弓，右键动作）"></button></div><nav class="pet-tools" aria-label="助手操作"><button data-action="toggle_chat">聊聊</button><button data-pet-command="menu">动作</button><button data-action="open_dsh">打开 DSH</button><button data-action="hide">隐藏</button></nav><section id="pet-menu" class="pet-menu" aria-label="宠物动作" hidden><label for="pet-animation">上游动作库</label><select id="pet-animation" aria-label="选择宠物动作"></select><button id="pet-topmost" type="button" role="switch" aria-label="窗口置顶" data-pet-command="topmost">读取置顶状态…</button><button data-action="pet_settings">宠物设置</button><button data-pet-command="close-menu">关闭动作</button><p>单击回应并展开对话；拖动甩出；快速连按再拖动为弹弓。</p></section><div id="pet-bubble" hidden></div><div id="pet-interaction" hidden></div><div class="pet-attribution">' + credit + '</div><p id="notice" class="pet-notice" role="alert" hidden></p></section>' :
  `<section class="chat-shell" aria-label="鲸鱼娘对话">
<header class="chat-header"><div class="brand"><span class="mini-buddy" aria-hidden="true">${face}</span>
<div><h1>鲸鱼娘 <span>DSH 助手</span></h1><p id="status" role="status"></p></div></div>
<div class="header-actions"><button data-action="open_dsh" class="quiet">在 DSH 打开 ↗</button>
<button data-action="toggle_chat" class="icon-button" aria-label="收起对话">−</button></div></header>
<div id="preview" class="preview" hidden>浏览器预览 · 未连接原生助手，不会执行操作</div>
<div id="session-bar" class="session-bar"><label class="sr-only" for="sessions">历史对话</label>
<select id="sessions" aria-label="历史对话"><option value="">暂无对话</option></select>
<button id="new-session" data-action="new_session" class="quiet">＋ 新对话</button>
<button id="reconfigure" data-action="reconfigure" class="quiet" title="重新选择独立 WSL 项目目录">项目</button></div>
<div id="notice" class="notice" role="alert" hidden></div>
<section id="setup" class="setup" hidden><span class="setup-icon" aria-hidden="true">⌂</span><h2>给鲸鱼娘一个独立的空间</h2>
<p>启用后会在 WSL 中创建独立目录并注册 DSH 项目，与已有项目分开。聊天记录保存在 DSH 中，确认后才会执行。</p>
<form id="enable-form"><label for="workspace">WSL 目录</label>
<input id="workspace" name="workspace" value="~/DSH-Assistant" placeholder="~/DSH-Assistant" autocomplete="off" spellcheck="false" required />
<label class="consent"><input id="consent" type="checkbox" required />我确认使用此目录，允许助手在这里工作</label>
<button id="enable" class="primary" type="submit">确认并启用</button></form></section>
<section id="conversation" class="conversation" role="log" aria-label="对话消息" aria-live="polite" aria-relevant="additions text"></section>
<footer class="composer-area"><p id="runtime-message" class="runtime-message"></p>
<button id="retry" data-action="retry" class="retry" hidden>重新连接 / 重试</button>
<form id="send-form"><label class="sr-only" for="draft">给鲸鱼娘发消息</label>
<textarea id="draft" rows="3" placeholder="说说你的想法…" maxlength="100000"></textarea>
<div class="composer-bottom"><span id="draft-hint">Enter 发送 · Shift + Enter 换行</span>
<button id="cancel" type="button" data-action="cancel" class="stop" hidden>■ 停止</button>
<button id="send" class="primary" type="submit">发送 ↑</button></div></form>
<p id="composer-footnote" class="footnote">鲸鱼娘可能会出错，重要操作请在 DSH 中确认。</p><div class="chat-attribution">${credit}</div></footer></section>`;
function el<T extends HTMLElement>(id: string): T | null { return document.getElementById(id) as T | null; }
let state = initialSnapshot();
let disposed = false;
let unlisten: UnlistenFn | undefined;
let pending = false;
let composing = false;
let localError = '';
let transportFailed = false;
let sendUncertain = false;
let sendInFlight: { text: string; requestId: string; session: string | null; acknowledged: boolean } | undefined;
const cleanup = new AbortController();
let petRenderer: PetRenderer | undefined;
let petMotion: PetMotion | undefined;
let petNotifications: PetNotifications | undefined;
let petInteractions: PetInteractions | undefined;
let interactionRevision = -1;
let interactionPending = false;
let interactionIds = new Set<string>();
let interactionExpanded = false;
let unlistenPetInteractions: UnlistenFn | undefined;
let interactionFeedPending: Promise<void> | undefined;
let interactionFeedReady = false;
let surfaceDesired = false;
let surfaceApplied: boolean | undefined;
let surfacePending = false;
let bubbleEnabled = false;
let bubbleFault = false;
let bubbleRevision = -1;
let bubbleVisible = false;
let unlistenPetNotifications: UnlistenFn | undefined;
let petNotificationFeedPending: Promise<void> | undefined;
let petNotificationFeedReady = false;
let petNotificationActive = false;
let bubbleActivityEpoch = 0;
let petPreferenceRevision = -1;
let roamingEnabled: boolean | undefined;
let unlistenPetPreferences: UnlistenFn | undefined;
let petVisible = true;
let petVisibilityRevision = -1;
let petTopmost: boolean | undefined;
let petTopmostRevision = -1;
let petTopmostPending = false;
let unlistenPetVisibility: UnlistenFn | undefined;
const draft = el<HTMLTextAreaElement>('draft');
const workspace = el<HTMLInputElement>('workspace');
const storageKey = () => 'dsh-assistant:draft:' + (state.workspace_id ?? 'unassigned') + ':' + (state.session_id ?? 'new');
function loadDraft() { try { if (draft) draft.value = sessionStorage.getItem(storageKey()) ?? ''; } catch { /* restricted storage: keep memory draft */ } }
function saveDraft() { try { if (draft) { if (draft.value) sessionStorage.setItem(storageKey(), draft.value); else sessionStorage.removeItem(storageKey()); } } catch { /* never discard in-memory input */ } }
function setNotice(text: string) { localError = text; render(); }
function accept(payload: unknown) {
  if (disposed) return;
  const next = mergeSnapshot(state, payload);
  if (next === state) return;
  const changedSession = next.session_id !== state.session_id || next.workspace_id !== state.workspace_id;
  if (changedSession) saveDraft();
  if (state.enabled && !next.enabled) {
    if (workspace) workspace.value = next.workspace_path ?? state.workspace_path ?? '~/DSH-Assistant';
    const consent = el<HTMLInputElement>('consent'); if (consent) consent.checked = false;
  }
  state = next;
  transportFailed = false;
  if (changedSession) { loadDraft(); sendUncertain = false; }
  // A new authoritative user message is acknowledgement even if the IPC response is lost.
  if (sendInFlight && state.session_id === sendInFlight.session && state.messages.some(m => m.role === 'user' && m.request_id === sendInFlight!.requestId)) {
    sendInFlight.acknowledged = true;
    if (draft?.value === sendInFlight.text) { draft.value = ''; saveDraft(); }
    sendUncertain = false;
  }
  render();
}
async function refresh() {
  if (!unlisten || disposed) return;
  try { const snapshot = await invoke<unknown>('get_assistant_snapshot'); if (!disposed) { transportFailed = false; accept(snapshot); render(); } }
  catch (error) { if (!disposed) { transportFailed = true; setNotice('无法读取助手状态：' + errorText(error)); } }
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function action(actionName: string, extra: Record<string, unknown> = {}): Promise<boolean> {
  if (!native || disposed) { if (!disposed) setNotice('当前为浏览器预览，请在桌面应用中使用此操作。'); return false; }
  try {
    const result = await invoke<unknown>('assistant_action', { request: { action: actionName, ...extra } });
    if (disposed) return false;
    if (result != null) accept(result);
    if (!['drag', 'hide', 'motion_active', 'pet_source', 'pet_settings'].includes(actionName)) await refresh();
    return true;
  } catch (error) {
    if (!disposed) setNotice('操作未确认：' + errorText(error) + (actionName === 'send' ? '。草稿已保留，请先核对历史消息，避免重复发送。' : ''));
    return false;
  }
}
async function exclusive(actionName: string, extra: Record<string, unknown> = {}) {
  if (pending) return;
  pending = true; localError = ''; render();
  try {
    if (actionName === 'retry' && native && !unlisten) await ensureSubscription();
    await action(actionName, extra);
  } catch (error) {
    transportFailed = true;
    setNotice('无法订阅助手状态：' + errorText(error));
  } finally { pending = false; render(); }
}
let hitFrame = 0;
let lastHitSignature = '';
let resizeObserver: ResizeObserver | undefined;
function scheduleHitRegions() {
  if (!native || view !== 'pet' || disposed || hitFrame) return;
  hitFrame = requestAnimationFrame(() => {
    hitFrame = 0;
    if (disposed) return;
    const regions = [...root.querySelectorAll<HTMLElement>('#pet, .pet-tools button, #pet-menu, #pet-bubble, #pet-interaction, .pet-credit, #notice')]
      .filter(node => node.getClientRects().length > 0)
      .map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    const signature = JSON.stringify(regions);
    if (signature === lastHitSignature) return;
    lastHitSignature = signature;
    void invoke('assistant_action', { request: { action: 'hit_regions', regions } }).catch(error => {
      // Do not invent success or recurse through render on IPC failure.
      console.warn('助手点击区域上报失败', error);
    });
  });
}
let lastMessageSignature = '';
let lastSessionsSignature = '';
function render() {
  if (disposed) return;
  scheduleHitRegions();
  renderPetTopmost();
  const effectiveState = transportFailed ? { ...state, connected: false, phase: 'error' } : state;
  petRenderer?.updateState(effectiveState);
  const label = native ? statusLabel(effectiveState) : '浏览器预览';
  root.dataset.phase = effectiveState.running ? 'running' : effectiveState.waiting ? 'waiting' : effectiveState.connected ? 'ready' : 'offline';
  for (const id of ['status', 'pet-status']) { const item = el(id); if (item) item.textContent = label; }
  const preview = el('preview'); if (preview) preview.hidden = native;
  const notice = el('notice'); if (notice) { notice.textContent = localError; notice.hidden = !localError; }
  const setup = el('setup'); if (setup) setup.hidden = state.enabled || (native && state.phase === 'loading');
  const conversation = el('conversation'); if (conversation) conversation.hidden = !state.enabled;
  for (const id of ['session-bar', 'send-form', 'composer-footnote']) { const node = el(id); if (node) node.hidden = !state.enabled; }
  const sessions = el<HTMLSelectElement>('sessions');
  const sessionSignature = JSON.stringify([state.sessions, state.session_id]);
  if (sessions && sessionSignature !== lastSessionsSignature) {
    lastSessionsSignature = sessionSignature; sessions.replaceChildren();
    if (!state.sessions.length) sessions.add(new Option('暂无对话', ''));
    if (state.session_id && !state.sessions.some(s => s.id === state.session_id)) sessions.add(new Option('当前对话', state.session_id));
    for (const session of state.sessions) sessions.add(new Option(session.title || '未命名对话', session.id));
    sessions.value = state.session_id ?? '';
  }
  if (sessions) sessions.disabled = !native || !state.enabled || !state.workspace_id || pending || state.running || state.waiting;
  const signature = JSON.stringify([state.session_id, state.messages]);
  if (conversation && signature !== lastMessageSignature) {
    lastMessageSignature = signature;
    const follow = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 64;
    if (state.messages.length) {
      const fragment = document.createDocumentFragment();
      for (const message of state.messages) {
        const article = document.createElement('article'); article.className = 'message message-' + message.role;
        const name = document.createElement('div'); name.className = 'message-author'; name.textContent = message.role === 'user' ? '你' : message.role === 'assistant' ? '鲸鱼娘' : '系统';
        const content = document.createElement('div'); content.className = 'message-text';
        const text = message.text || (message.status === 'streaming' ? '…' : '');
        if (message.role === 'assistant') renderMarkdown(content, text, document); else content.textContent = text;
        article.append(name, content);
        if (message.status) { const status = document.createElement('span'); status.className = 'message-status'; status.textContent = message.status; article.append(status); }
        fragment.append(article);
      }
      conversation.replaceChildren(fragment);
      if (follow) conversation.scrollTop = conversation.scrollHeight;
    } else {
      conversation.replaceChildren();
      const empty = document.createElement('div'); empty.className = 'empty-state';
      const title = document.createElement('h2'); title.textContent = '想做点什么？';
      const subtitle = document.createElement('p'); subtitle.textContent = '把想法留在这里，一起慢慢完成。';
      empty.append(title, subtitle); conversation.append(empty);
    }
  }
  const runtime = el('runtime-message'); if (runtime) runtime.textContent = state.message || (state.running ? '鲸鱼娘正在处理，可以随时停止。' : '');
  const hint = el('draft-hint'); if (hint) hint.textContent = sendUncertain ? '上次发送未确认；请先核对历史，草稿仍保留' : !effectiveState.connected && native ? '连接恢复前，草稿会为你保留' : 'Enter 发送 · Shift + Enter 换行';
  const retry = el<HTMLButtonElement>('retry'); if (retry) { retry.hidden = !native || (state.connected && !transportFailed && !['error', 'failed', 'sending', 'cancelling'].includes(state.phase)); retry.disabled = pending; }
  const send = el<HTMLButtonElement>('send'); if (send) send.disabled = !native || !canSend(effectiveState, draft?.value ?? '', pending);
  const cancel = el<HTMLButtonElement>('cancel'); if (cancel) { cancel.hidden = !state.running && !state.waiting && !['sending', 'cancelling'].includes(state.phase); cancel.disabled = !native || pending || state.phase === 'cancelling'; }
  const enable = el<HTMLButtonElement>('enable'); if (enable) enable.disabled = !native || pending || state.phase === 'loading';
  const newSession = el<HTMLButtonElement>('new-session'); if (newSession) newSession.disabled = !native || pending || !state.enabled || !state.workspace_id || state.running || state.waiting;
  const reconfigure = el<HTMLButtonElement>('reconfigure'); if (reconfigure) reconfigure.disabled = !native || pending || state.running || state.waiting;
  root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
    if (!native) button.disabled = true;
  });
}
root.addEventListener('click', event => {
  const target = event.target as Element;
  const source = target.closest<HTMLElement>('[data-upstream]');
  if (source?.dataset.upstream) { if (native) { event.preventDefault(); void action('pet_source'); } return; }
  const command = target.closest<HTMLElement>('[data-pet-command]')?.dataset.petCommand;
  if (command) {
    event.preventDefault();
    const menu = el('pet-menu');
    if (command === 'topmost') { void togglePetTopmost(); return; }
    if (menu) {
      menu.hidden = command === 'close-menu' || !menu.hidden;
      if (!menu.hidden) { petMotion?.stop(); void refreshPetTopmost(); }
    }
    syncPetNotificationOverlay();
    return;
  }
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-action]');
  if (!button || button.disabled) return;
  const name = button.dataset.action!;
  if (name === 'hide') petMotion?.stop();
  void exclusive(name);
}, { signal: cleanup.signal });
el<HTMLSelectElement>('sessions')?.addEventListener('change', event => {
  const sessionId = (event.target as HTMLSelectElement).value;
  if (sessionId && sessionId !== state.session_id) void exclusive('select_session', { sessionId });
}, { signal: cleanup.signal });
el('enable-form')?.addEventListener('submit', event => {
  event.preventDefault();
  const path = workspace?.value.trim() ?? '';
  if (!el<HTMLInputElement>('consent')?.checked) return;
  if (!(path.startsWith('/') || path.startsWith('~/')) || path === '/' || path.includes('\\') || /[\u0000-\u001f]/.test(path) || path.split('/').includes('..')) { setNotice('请填写独立的 WSL 目录，例如 ~/DSH-Assistant。'); return; }
  void exclusive('enable', { path });
}, { signal: cleanup.signal });
async function send() {
  if (!native || !draft || composing || transportFailed || !canSend(state, draft.value, pending)) return;
  const text = draft.value;
  if (sendUncertain && sendInFlight?.text === text && !window.confirm('上次发送结果还未确认。请先在历史记录或 DSH 中检查，确定要再次发送吗？')) return;
  const requestId = crypto.randomUUID();
  sendInFlight = { text, requestId, session: state.session_id, acknowledged: false };
  pending = true; localError = ''; sendUncertain = false; saveDraft(); render();
  const ok = await action('send', { text, requestId, clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  if (!sendInFlight?.acknowledged && sendInFlight?.session === state.session_id) sendUncertain = true;
  if (!ok && sendInFlight?.acknowledged) localError = '';
  // Only an authoritative echoed user message clears the draft, not a successful IPC alone.
  pending = false; render();
}
el('send-form')?.addEventListener('submit', event => { event.preventDefault(); void send(); }, { signal: cleanup.signal });
draft?.addEventListener('input', () => { saveDraft(); render(); }, { signal: cleanup.signal });
draft?.addEventListener('compositionstart', () => { composing = true; }, { signal: cleanup.signal });
draft?.addEventListener('compositionend', () => { composing = false; }, { signal: cleanup.signal });
draft?.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) { event.preventDefault(); void send(); }
}, { signal: cleanup.signal });
const pet = el<HTMLButtonElement>('pet');
let pointer: { id: number; x: number; y: number; dragged: boolean; sling: boolean } | undefined;
let suppressClick = false;
let lastPress = -Infinity;
function updatePetNotificationActivity() {
  const active = native && petVisible && bubbleEnabled && !bubbleFault;
  if (active !== petNotificationActive) { petNotificationActive = active; bubbleActivityEpoch++; petNotificationFeedReady = false; interactionFeedReady = false; }
  petNotifications?.setActive(active);
  petInteractions?.setActive(active);
  requestInteractionSurface(active && interactionPending);
  if (active) { void connectPetNotificationFeed(); void connectPetInteractionFeed(); }
}
function syncPetNotificationOverlay() {
  const menuOpen = !el('pet-menu')?.hidden;
  petNotifications?.setObscured(menuOpen || interactionPending);
  petInteractions?.setObscured(menuOpen);
  if (native && petVisible && bubbleEnabled) { void connectPetNotificationFeed(); void connectPetInteractionFeed(); }
  scheduleHitRegions();
}
function requestInteractionSurface(active: boolean) {
  surfaceDesired = active;
  if (!native || view !== 'pet' || disposed || surfacePending || surfaceApplied === active) return;
  surfacePending = true;
  void (async () => {
    try {
      while (!disposed && surfaceApplied !== surfaceDesired) {
        const requested = surfaceDesired;
        await invoke('set_pet_interaction_surface', { active: requested });
        if (!disposed) surfaceApplied = requested;
      }
    } catch { /* Native broker also prepares input before publishing a live card. */ }
    finally { surfacePending = false; }
  })();
}
function acceptPetInteractions(value: unknown) {
  if (disposed || !value || typeof value !== 'object') return;
  const incoming = value as {revision?:number;connected?:boolean;items?:unknown[]};
  if (!Number.isSafeInteger(incoming.revision) || incoming.revision! < 0 || incoming.revision! <= interactionRevision || typeof incoming.connected !== 'boolean' || !Array.isArray(incoming.items) || incoming.items.length > 32) return;
  if (incoming.items.some(item => !item || typeof item !== 'object' || typeof (item as {id?:unknown}).id !== 'string')) return;
  interactionRevision = incoming.revision!;
  interactionPending = incoming.connected && incoming.items.length > 0;
  interactionIds = new Set(incoming.connected ? incoming.items.map(item => (item as {id:string}).id) : []);
  root.dataset.interactionPending = String(interactionPending);
  petInteractions?.update(value);
  if (interactionPending) petMotion?.stop();
  requestInteractionSurface(petNotificationActive && interactionPending);
  syncPetNotificationOverlay();
}
async function connectPetInteractionFeed() {
  if (!native || view !== 'pet' || disposed || !petNotificationActive) return;
  if (interactionFeedPending) return interactionFeedPending;
  if (unlistenPetInteractions && interactionFeedReady) return;
  const activityEpoch = bubbleActivityEpoch;
  interactionFeedPending = (async () => {
    try {
      if (!unlistenPetInteractions) {
        const stop = await listen('pet-interactions-state', event => acceptPetInteractions(event.payload));
        if (disposed) { stop(); return; }
        unlistenPetInteractions = stop;
      }
      if (disposed || activityEpoch !== bubbleActivityEpoch || !petNotificationActive) return;
      const snapshot = await invoke('get_pet_interactions');
      if (disposed || activityEpoch !== bubbleActivityEpoch || !petNotificationActive) return;
      acceptPetInteractions(snapshot);
      interactionFeedReady = true;
      if (localError === '交互气泡暂不可用，可打开动作菜单重试，或在 DSH 处理。') setNotice('');
    } catch {
      if (!disposed && activityEpoch === bubbleActivityEpoch && petNotificationActive) setNotice('交互气泡暂不可用，可打开动作菜单重试，或在 DSH 处理。');
    } finally {
      interactionFeedPending = undefined;
      if (!disposed && petNotificationActive && !interactionFeedReady && activityEpoch !== bubbleActivityEpoch) void connectPetInteractionFeed();
    }
  })();
  return interactionFeedPending;
}
async function connectPetNotificationFeed() {
  if (!native || view !== 'pet' || disposed || !petVisible || !bubbleEnabled || bubbleFault) return;
  if (petNotificationFeedPending) return petNotificationFeedPending;
  if (unlistenPetNotifications && petNotificationFeedReady) return;
  const activityEpoch = bubbleActivityEpoch;
  petNotificationFeedPending = (async () => {
    try {
      if (!unlistenPetNotifications) {
        const stop = await listen('pet-notification', event => {
          if (disposed) return;
          if (petNotificationActive && localError === '气泡通知暂不可用，可再次打开动作菜单重试。') setNotice('');
          const message = event.payload as {type?:unknown;ids?:unknown[]};
          if (message && message.type === 'withdraw' && Array.isArray(message.ids) && message.ids.length <= 32) {
            message.ids.forEach(id => { if (typeof id === 'string') petNotifications?.withdraw(id); });
          } else petNotifications?.enqueue(event.payload);
        });
        if (disposed) { stop(); return; }
        unlistenPetNotifications = stop;
      }
      if (disposed || activityEpoch !== bubbleActivityEpoch || !petNotificationActive) return;
      const items = await invoke<unknown>('get_pet_notifications');
      if (disposed || activityEpoch !== bubbleActivityEpoch || !petNotificationActive) return;
      if (!Array.isArray(items)) throw new Error('通知摘要格式无效。');
      items.forEach(item => petNotifications?.enqueue(item));
      petNotificationFeedReady = true;
      if (localError === '气泡通知暂不可用，可再次打开动作菜单重试。') setNotice('');
    } catch {
      if (!disposed && activityEpoch === bubbleActivityEpoch && petNotificationActive) setNotice('气泡通知暂不可用，可再次打开动作菜单重试。');
    } finally {
      petNotificationFeedPending = undefined;
      if (!disposed && petNotificationActive && !petNotificationFeedReady && activityEpoch !== bubbleActivityEpoch) void connectPetNotificationFeed();
    }
  })();
  return petNotificationFeedPending;
}
function mountPet() {
  const media = el('pet-media');
  if (view !== 'pet' || !media) return;
  if (pet) {
    pet.style.left = (HIT_BOX.x0 / 640 * 100) + '%';
    pet.style.top = (HIT_BOX.y0 / 360 * 100) + '%';
    pet.style.width = ((HIT_BOX.x1 - HIT_BOX.x0) / 640 * 100) + '%';
    pet.style.height = ((HIT_BOX.y1 - HIT_BOX.y0) / 360 * 100) + '%';
  }
  const bubble = el('pet-bubble');
  if (bubble) {
    petNotifications = new PetNotifications(bubble, {
      onOpen: async id => { if (native && !disposed) await invoke('open_pet_notification', { id }); },
      onDismiss: id => { if (native && !disposed) void invoke('dismiss_pet_notification', { id }).catch(() => {}); },
      onChange: visible => {
        if (disposed) return;
        bubbleVisible = visible;
        root.dataset.bubbleVisible = String(visible);
        if (visible) petMotion?.stopRoam();
        scheduleHitRegions();
      },
    });
    petNotifications.setActive(false);
  }
  const interaction = el('pet-interaction');
  if (interaction) {
    petInteractions = new PetInteractions(interaction, {
      onSubmit: async (id, reply) => {
        if (!native || disposed || !petNotificationActive || !interactionIds.has(id)) throw new Error('当前请求已失效，不能提交。');
        await invoke('submit_pet_interaction', { id, reply });
      },
      onOpen: async id => { if (!native || disposed) throw new Error('当前气泡不可打开。'); await invoke('open_pet_interaction', { id }); },
      onChange: expanded => {
        if (disposed) return;
        interactionExpanded = expanded;
        root.dataset.interactionExpanded = String(expanded);
        if (expanded) petMotion?.stop();
        scheduleHitRegions();
      },
    });
    petInteractions.setActive(false);
  }
  petRenderer = new PetRenderer(media, {
    fixed: native,
    onMove: (name, params, playback) => petVisible && !bubbleVisible && !interactionPending && !interactionExpanded && !!el('pet-menu')?.hidden ? (petMotion?.startRoam(name, params, playback.facing, params.durationSec, playback.video) ?? false) : false,
    onMoveEnd: () => petMotion?.stopRoam(),
    onError: error => { if (!disposed) setNotice('宠物动画加载失败：' + error.message); },
  });
  const select = el<HTMLSelectElement>('pet-animation');
  if (select) {
    select.add(new Option('选择一个动作播放…', ''));
    for (const item of petRenderer.listActions()) select.add(new Option(item.group + ' · ' + item.name, item.name));
    select.addEventListener('change', () => {
      petMotion?.stop();
      if (select.value) petRenderer?.trigger(select.value);
      const menu = el('pet-menu'); if (menu) menu.hidden = true;
      select.value = ''; syncPetNotificationOverlay();
    }, { signal: cleanup.signal });
  }
}
function renderPetTopmost() {
  if (disposed) return;
  const button = el<HTMLButtonElement>('pet-topmost');
  if (!button) return;
  button.disabled = !native || petTopmostPending;
  button.setAttribute('aria-busy', String(petTopmostPending));
  if (petTopmost === undefined) button.removeAttribute('aria-checked');
  else button.setAttribute('aria-checked', String(petTopmost));
  button.textContent = !native ? '窗口置顶（仅桌面应用）' : petTopmostPending ? '正在读取/切换置顶…' : petTopmost === undefined ? '重新读取置顶状态' : petTopmost ? '✓ 窗口置顶：开' : '窗口置顶：关';
}
function applyPetTopmost(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const incoming = value as {always_on_top?:boolean;revision?:number};
  if (typeof incoming.always_on_top !== 'boolean' || !Number.isSafeInteger(incoming.revision) || incoming.revision! < 0 || incoming.revision! < petTopmostRevision || (incoming.revision === petTopmostRevision && petTopmost !== undefined)) return;
  petTopmostRevision = incoming.revision!;
  petTopmost = incoming.always_on_top;
  renderPetTopmost();
}
async function performPetTopmost(readOnly: boolean) {
  if (!native || view !== 'pet' || disposed || petTopmostPending) return;
  const baseline = petTopmostRevision;
  const desired = petTopmost === undefined ? undefined : !petTopmost;
  petTopmostPending = true; renderPetTopmost();
  try {
    const snapshot = readOnly || desired === undefined
      ? await invoke('get_pet_preferences')
      : await invoke('set_pet_topmost', { alwaysOnTop: desired });
    if (disposed) return;
    const confirmed = snapshot as {always_on_top?:boolean;revision?:number} | null;
    if (!confirmed || typeof confirmed.always_on_top !== 'boolean' || !Number.isSafeInteger(confirmed.revision) || confirmed.revision! < 0) throw new Error('原生窗口未返回有效置顶状态。');
    applyPetPreferences(snapshot);
    if (localError.startsWith('无法读取或切换宠物置顶：')) setNotice('');
    if (petTopmost === undefined) throw new Error('原生窗口未返回有效置顶状态。');
  } catch (error) {
    if (!disposed) {
      if (petTopmostRevision <= baseline) petTopmost = undefined;
      setNotice('无法读取或切换宠物置顶：' + errorText(error));
    }
  } finally { if (!disposed) { petTopmostPending = false; renderPetTopmost(); } }
}
async function refreshPetTopmost() { await performPetTopmost(true); }
async function togglePetTopmost() { await performPetTopmost(false); }
function applyPetVisibility(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const incoming = value as {visible?:boolean;revision?:number};
  if (typeof incoming.visible !== 'boolean' || !Number.isSafeInteger(incoming.revision) || incoming.revision! < 0 || incoming.revision! <= petVisibilityRevision) return;
  petVisibilityRevision = incoming.revision!;
  petVisible = incoming.visible;
  updatePetNotificationActivity();
  if (!petVisible) petMotion?.stop();
}
function applyPetBubblePreferences(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const incoming = value as {bubble_notifications?:boolean;revision?:number;message?:string};
  if (typeof incoming.bubble_notifications !== 'boolean' || !Number.isSafeInteger(incoming.revision) || incoming.revision! < 0 || incoming.revision! <= bubbleRevision) return;
  bubbleRevision = incoming.revision!;
  bubbleEnabled = incoming.bubble_notifications;
  bubbleFault = typeof incoming.message === 'string' && !!incoming.message;
  updatePetNotificationActivity();
}
function applyPetPreferences(value: unknown) {
  if (disposed) return;
  applyPetVisibility(value);
  applyPetTopmost(value);
  applyPetBubblePreferences(value);
  if (!value || typeof value !== 'object') return;
  const incoming = value as { revision?: number; roaming_enabled?: boolean };
  if (!Number.isSafeInteger(incoming.revision) || incoming.revision! <= petPreferenceRevision || typeof incoming.roaming_enabled !== 'boolean') return;
  petPreferenceRevision = incoming.revision!;
  if (roamingEnabled !== incoming.roaming_enabled) {
    roamingEnabled = incoming.roaming_enabled;
    petRenderer?.toggleFixed(!incoming.roaming_enabled);
    if (!incoming.roaming_enabled) petMotion?.stopRoam();
  }
}
function mountPetMotion() {
  if (!native || view !== 'pet' || disposed || petMotion) return;
  petMotion = new PetMotion({
    getGeometry: () => invoke<PetGeometry>('get_pet_geometry'),
    move: (x, y) => invoke<PetGeometry>('move_pet', { x, y }),
    setActive: async active => { await invoke('assistant_action', { request: { action: 'motion_active', active } }); },
    physics,
    onDragStart: () => petRenderer?.dragStart(),
    onDragEnd: () => petRenderer?.dragEnd(),
    onBounce: () => petRenderer?.startSquash(),
    onError: error => { if (!disposed) setNotice('宠物移动失败：' + errorText(error)); },
  });
}
pet?.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  suppressClick = false;
  const now = performance.now();
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false, sling: now - lastPress < SLINGSHOT_DOUBLE_MS };
  lastPress = now;
  petMotion?.stop();
  pet.setPointerCapture(event.pointerId);
}, { signal: cleanup.signal });
pet?.addEventListener('pointermove', event => {
  if (!pointer || event.pointerId !== pointer.id || pointer.dragged) return;
  if (movedBeyondThreshold(event.clientX, event.clientY, pointer.x, pointer.y)) {
    pointer.dragged = true; suppressClick = true;
    if (petMotion) petMotion.begin(pointer.sling); else petRenderer?.dragStart();
  }
}, { signal: cleanup.signal });
pet?.addEventListener('pointerup', event => {
  if (pointer?.id !== event.pointerId) return;
  if (pointer.dragged) { suppressClick = true; if (petMotion) petMotion.end(); else petRenderer?.dragEnd(); }
  pointer = undefined;
}, { signal: cleanup.signal });
for (const name of ['pointercancel', 'lostpointercapture']) pet?.addEventListener(name, event => {
  if (pointer?.id !== (event as PointerEvent).pointerId) return;
  if (pointer.dragged) { suppressClick = true; if (!petMotion) petRenderer?.dragEnd(); }
  // Native pointer polling owns release after moving the captured window.
  pointer = undefined;
}, { signal: cleanup.signal });
pet?.addEventListener('contextmenu', event => {
  event.preventDefault(); petMotion?.stop();
  const menu = el('pet-menu'); if (menu) { menu.hidden = !menu.hidden; if (!menu.hidden) void refreshPetTopmost(); }
  syncPetNotificationOverlay();
}, { signal: cleanup.signal });
pet?.addEventListener('click', event => {
  if (event.detail !== 0 && suppressClick) { suppressClick = false; event.preventDefault(); return; }
  petRenderer?.click();
  if (event.detail > 1) return;
  void action(event.ctrlKey || event.metaKey ? 'open_dsh' : 'toggle_chat');
}, { signal: cleanup.signal });
function dispose() {
  if (disposed) return;
  saveDraft(); disposed = true; cleanup.abort(); unlisten?.(); unlisten = undefined;
  resizeObserver?.disconnect(); cancelAnimationFrame(hitFrame);
  unlistenPetVisibility?.(); unlistenPetVisibility = undefined;
  unlistenPetPreferences?.(); unlistenPetPreferences = undefined;
  unlistenPetNotifications?.(); unlistenPetNotifications = undefined;
  petNotifications?.dispose();
  unlistenPetInteractions?.(); unlistenPetInteractions = undefined;
  petInteractions?.dispose();
  if (native && view === 'pet') void invoke('set_pet_interaction_surface', { active: false }).catch(() => {});
  petMotion?.dispose(); petRenderer?.dispose();
}
window.addEventListener('pagehide', dispose, { once: true });
window.addEventListener('beforeunload', dispose, { once: true });
if (import.meta.hot) import.meta.hot.dispose(dispose);
if (native && view === 'pet') {
  resizeObserver = new ResizeObserver(scheduleHitRegions);
  resizeObserver.observe(root);
  root.querySelectorAll('#pet, .pet-tools, #notice, #pet-menu, #pet-bubble, #pet-interaction, .pet-attribution').forEach(node => resizeObserver!.observe(node));
  window.addEventListener('resize', scheduleHitRegions, { signal: cleanup.signal });
}
mountPet(); loadDraft(); render();
async function ensureSubscription() {
  if (unlisten || disposed) return;
  const stop = await listen<unknown>('assistant-state', event => accept(event.payload));
  if (disposed) { stop(); return; }
  unlisten = stop;
}
async function start() {
  if (!native) { state = { ...state, phase: 'preview', message: '预览不会连接 WSL，也不会发送消息。' }; render(); return; }
  try {
    // Subscribe before fetching: a newer event always wins over an older in-flight response.
    await ensureSubscription();
    if (view === 'pet') {
      const stop = await listen('pet-visibility', event => { if (!disposed) applyPetVisibility(event.payload); });
      if (disposed) { stop(); return; } else unlistenPetVisibility = stop;
      const stopPreferences = await listen('pet-settings-state', event => { if (!disposed) applyPetPreferences(event.payload); });
      if (disposed) { stopPreferences(); return; } else unlistenPetPreferences = stopPreferences;
      applyPetPreferences(await invoke('get_pet_preferences'));
      await connectPetNotificationFeed();
      await connectPetInteractionFeed();
    }
    await refresh();
  } catch (error) {
    if (!disposed) { transportFailed = true; setNotice('无法订阅助手状态：' + errorText(error) + '。可点击重试重新连接。'); }
  } finally { mountPetMotion(); }
}
void start();
