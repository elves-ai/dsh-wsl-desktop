import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { canSend, initialSnapshot, mergeSnapshot, movedBeyondThreshold, statusLabel } from './assistant-model';
import { renderMarkdown } from './assistant-markdown';
import { PetRenderer } from './pet/renderer';
import { PetNotifications } from './pet/notifications';
import { PetInteractions } from './pet/interactions';
import { layoutPetBubbles } from './pet/bubble-positioner';
import { PetMenuController } from './pet/menu';
import { conversationCue, speechReadingTime, type ConversationCue } from './pet/conversation';
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
  `<section class="pet-shell" aria-label="鲸鱼娘桌面助手"><div id="preview" class="preview" hidden>浏览器预览 · 移动仅桌面应用可用</div><div class="pet-stage"><div id="pet-media" class="pet-media"></div><button id="pet" class="pet-hit" aria-label="跟鲸鱼娘说话（拖动可抛掷，快速连按再拖可弹弓，右键菜单）" aria-controls="pet-dialogue pet-composer pet-menu" aria-expanded="false"></button></div><section id="pet-menu" class="pet-menu" aria-label="桌宠菜单" hidden>
<header class="pet-menu-header"><span>桌宠</span><button type="button" class="pet-menu-close" data-pet-command="close-menu" aria-label="关闭菜单"><svg class="pet-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m6 6 12 12M6 18 18 6"/></svg></button></header>
<button type="button" data-pet-command="talk"><svg class="pet-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 11a8 8 0 0 1-8 8H4l1.5-4A8 8 0 1 1 20 11Z"/></svg><span class="pet-menu-label">说句话</span></button>
<button type="button" data-pet-command="replay"><svg class="pet-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 10a8 8 0 1 1 1 7M4 4v6h6"/></svg><span class="pet-menu-label">重看上一句</span></button>
<button type="button" data-action="toggle_chat"><svg class="pet-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg><span class="pet-menu-label">对话历史</span></button>
<button type="button" data-action="open_dsh"><svg class="pet-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14 4h6v6M20 4l-9 9M10 4H4v16h16v-6"/></svg><span class="pet-menu-label">打开 DSH</span></button>
<hr class="pet-menu-separator">
<button id="pet-animation-trigger" type="button" aria-haspopup="menu" aria-controls="pet-animation" aria-expanded="false"><svg class="pet-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9 5 11 7-11 7Z"/></svg><span class="pet-menu-label">选择动作</span><svg class="pet-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9 6 6 6-6 6"/></svg></button>
<button id="pet-slingshot" type="button" role="switch" aria-label="允许弹弓" data-pet-command="slingshot" disabled><svg class="pet-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m5 3 7 7 7-7M12 10v11M5 3l2 10 5 4 5-4 2-10"/></svg><span class="pet-menu-label">允许弹弓</span><span class="pet-menu-indicator" aria-hidden="true"></span></button>
<button id="pet-topmost" type="button" role="switch" aria-label="窗口置顶" data-pet-command="topmost"><svg class="pet-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M8 3h8l-1 6 4 4v2H5v-2l4-4ZM12 15v6"/></svg><span class="pet-menu-label">窗口置顶</span><span class="pet-menu-indicator" aria-hidden="true"></span></button>
<hr class="pet-menu-separator">
<button type="button" data-action="pet_settings"><svg class="pet-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--ui-bg)"/><circle cx="15" cy="17" r="3" fill="var(--ui-bg)"/></svg><span class="pet-menu-label">宠物设置</span></button>
<button type="button" data-action="hide"><svg class="pet-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 3l18 18M10 5a11 11 0 0 1 11 7 14 14 0 0 1-3 4M6 6a14 14 0 0 0-3 6 11 11 0 0 0 14 6M10 10a3 3 0 0 0 4 4"/></svg><span class="pet-menu-label">隐藏宠物</span></button>
</section><section id="pet-animation" class="pet-menu pet-submenu" role="menu" aria-label="选择宠物动作" hidden><button type="button" class="pet-submenu-back" data-submenu-back aria-label="返回桌宠菜单">‹ 返回</button><div id="pet-animation-list" role="presentation"></div></section>` +
  '<section id="pet-dialogue" class="pet-dialogue" aria-label="与鲸鱼娘说话" hidden><section id="pet-speech" class="pet-speech" hidden><header class="pet-speech-header"><span id="pet-speech-label">鲸鱼娘</span><button id="cancel" type="button" data-action="cancel" class="pet-speech-stop" hidden>停止</button><button id="pet-speech-close" type="button" aria-label="收起这句话">×</button></header><div id="pet-speech-text" class="pet-speech-text" role="status" aria-live="polite" aria-atomic="true"></div><div class="pet-speech-actions"><button id="pet-speech-expand" type="button" aria-controls="pet-speech-text" aria-expanded="false" hidden>展开全文</button><button id="pet-initialize" type="button" data-action="pet_settings" hidden>去设置初始化</button><button id="retry" type="button" data-action="retry" hidden>重新连接 / 重试</button></div></section></section>' +
  '<section id="pet-composer" class="pet-composer" aria-label="给鲸鱼娘输入消息" hidden><button id="pet-enable" type="button" data-action="pet_settings" hidden>去设置初始化</button><form id="send-form"><label class="sr-only" for="draft">跟鲸鱼娘说点什么</label><div class="pet-compose-row"><textarea id="draft" rows="1" placeholder="跟我说点什么…" maxlength="100000"></textarea><button id="send" type="submit" class="primary" aria-label="发送消息">↑</button><button id="pet-input-close" type="button" aria-label="收起输入，保留草稿">×</button></div><p id="draft-hint">Enter 发送 · Shift + Enter 换行</p></form></section><div id="pet-bubble" hidden></div><div id="pet-interaction" hidden></div><p id="notice" class="pet-notice" role="alert" hidden></p></section>' :
  `<section class="chat-shell" aria-label="鲸鱼娘对话">
<header class="chat-header"><div class="brand"><span class="mini-buddy" aria-hidden="true">${face}</span>
<div><h1>鲸鱼娘 <span>DSH 助手</span></h1><p id="status" role="status"></p></div></div>
<div class="header-actions"><button data-action="open_dsh" class="quiet">在 DSH 打开 ↗</button>
<button data-action="toggle_chat" class="icon-button" aria-label="收起对话">−</button></div></header>
<div id="preview" class="preview" hidden>浏览器预览 · 未连接原生助手，不会执行操作</div>
<div id="session-bar" class="session-bar"><label class="sr-only" for="sessions">历史对话</label>
<select id="sessions" aria-label="历史对话"><option value="">暂无对话</option></select>
<button id="new-session" data-action="new_session" class="quiet">＋ 新对话</button></div>
<div id="notice" class="notice" role="alert" hidden></div>
<section id="setup" class="setup" hidden><span class="setup-icon" aria-hidden="true">⌂</span><h2>先初始化宠物目录</h2>
<p id="workspace-help">请到“设置 → 桌面宠物 → 对话工作目录”初始化。开启宠物时也会自动初始化，固定使用 ~/.dsh-wsl-desktop/assistant。已有目录和对话历史不会被清空。</p>
<button id="initialize" class="primary" type="button" data-action="pet_settings">去设置初始化</button></section>
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
let petMenu: PetMenuController | undefined;
let petInput: PetMenuController | undefined;
let petInputOpen = false;
let petSpeechVisible = false;
let petSpeechExpanded = false;
let petSpeechHovered = false;
let petSpeechSelected = false;
let dismissedSpeechKey: string | undefined;
let petCue: ConversationCue | undefined;
let speechTimer: ReturnType<typeof setTimeout> | undefined;
let inputGeneration = 0;
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
let slingshotEnabled = false;
let slingshotKnown = false;
let slingshotPending = false;
let unlistenPetPreferences: UnlistenFn | undefined;
let petVisible = true;
let petVisibilityRevision = -1;
let petTopmost: boolean | undefined;
let petTopmostRevision = -1;
let petTopmostPending = false;
let unlistenPetVisibility: UnlistenFn | undefined;
const draft = el<HTMLTextAreaElement>('draft');
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
  state = next;
  transportFailed = false;
  if (changedSession) { loadDraft(); sendUncertain = false; }
  // A new authoritative user message is acknowledgement even if the IPC response is lost.
  if (sendInFlight && state.session_id === sendInFlight.session && state.messages.some(m => m.role === 'user' && m.request_id === sendInFlight!.requestId)) {
    sendInFlight.acknowledged = true;
    if (draft?.value === sendInFlight.text) { draft.value = ''; saveDraft(); petInput?.close(); }
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
    if (!['drag', 'hide', 'motion_active', 'pet_source', 'pet_settings', 'pet_input'].includes(actionName)) await refresh();
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
  if (view !== 'pet' || disposed || hitFrame) return;
  hitFrame = requestAnimationFrame(() => {
    hitFrame = 0;
    if (disposed) return;
    if (pet) layoutPetBubbles(root, pet, petOverlayInsets);
    positionPetMenu();
    if (!native) return;
    const regions = [...root.querySelectorAll<HTMLElement>('#pet, #pet-menu, #pet-animation, #pet-bubble, #pet-interaction, #pet-dialogue, #pet-composer, #notice')]
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
function clearSpeechTimer() {
  if (speechTimer !== undefined) window.clearTimeout(speechTimer);
  speechTimer = undefined;
}
function armSpeechTimer() {
  clearSpeechTimer();
  if (!petSpeechVisible || !petCue || petCue.busy || petCue.kind !== 'reply' || petInputOpen || petSpeechExpanded || petSpeechHovered || petSpeechSelected || el('pet-dialogue')?.hidden) return;
  const delay = speechReadingTime(petCue.text);
  if (delay === null) return;
  speechTimer = window.setTimeout(() => { speechTimer = undefined; petSpeechVisible = false; renderPetConversation(); }, delay);
}
let inputNativeTask = Promise.resolve();
function requestPetInput(active: boolean) {
  const generation = ++inputGeneration;
  if (!native) { if (active) draft?.focus(); return; }
  // Serialize focus changes: a delayed open must never undo a newer close.
  inputNativeTask = inputNativeTask.then(async () => {
    if (active && (disposed || generation !== inputGeneration || !petInputOpen)) return;
    try {
      await invoke('assistant_action', { request: { action: 'pet_input', active } });
      if (active && !disposed && generation === inputGeneration && petInputOpen) {
        draft?.focus();
        if (localError.startsWith('暂时无法输入：')) setNotice('');
      }
    } catch (error) {
      if (active && !disposed && generation === inputGeneration) {
        petInput?.close(); setNotice('暂时无法输入：' + errorText(error));
      }
    }
  });
}
async function openPetInput() {
  if (disposed || view !== 'pet' || !petVisible || interactionPending) return;
  petMenu?.close(); petMotion?.stop(); dismissedSpeechKey = undefined; petSpeechVisible = true;
  if (!petInputOpen) petInput?.toggle(); else requestPetInput(true);
  renderPetConversation();
}
function renderPetConversation() {
  if (view !== 'pet' || disposed) return;
  const effective = transportFailed ? { ...state, connected: false } : state;
  const cue = localError ? { key: 'local:' + localError, kind: 'error' as const, text: localError, busy: false } : conversationCue(effective);
  const changed = cue.key !== petCue?.key || cue.text !== petCue?.text || cue.busy !== petCue?.busy;
  if (changed) {
    // Loading saved history is not a new reply and must not interrupt the desktop.
    const scope = [state.workspace_id, state.session_id].join(':');
    if (scope !== petConversationSession) petConversationHydrated = false;
    const baseline = !petCue || scope !== petConversationSession || (!petConversationHydrated && effective.connected);
    if (baseline && !petInputOpen && !cue.busy && !localError) petSpeechVisible = false;
    if ((!baseline || cue.busy || localError) && cue.key !== dismissedSpeechKey) petSpeechVisible = true;
    if (effective.connected) petConversationHydrated = true;
    if (cue.key !== petCue?.key) { petSpeechExpanded = false; petSpeechSelected = false; }
    petCue = cue;
    petConversationSession = [state.workspace_id, state.session_id].join(':');
  }
  const host = el('pet-dialogue'), speech = el('pet-speech'), text = el('pet-speech-text');
  const visible = petVisible && !!el('pet-menu')?.hidden && !interactionPending && petSpeechVisible;
  if (host) { host.hidden = !visible; host.dataset.expanded = String(petSpeechExpanded); host.dataset.inputOpen = String(petInputOpen); host.dataset.kind = cue.kind; }
  if (speech) speech.hidden = !petSpeechVisible;
  if (text && text.textContent !== cue.text) text.textContent = cue.text;
  const label = el('pet-speech-label'); if (label) label.textContent = cue.kind === 'thinking' ? '鲸鱼娘 · 想一想' : cue.kind === 'error' ? '鲸鱼娘 · 没连上' : '鲸鱼娘';
  const expand = el('pet-speech-expand');
  if (expand) { expand.hidden = !petSpeechExpanded; expand.textContent = petSpeechExpanded ? '收起全文' : '展开全文'; expand.setAttribute('aria-expanded', String(petSpeechExpanded)); }
  const needsInitialization = (!state.enabled && state.phase !== 'loading') || state.phase === 'workspace_missing';
  for (const id of ['pet-enable', 'pet-initialize']) { const button = el<HTMLButtonElement>(id); if (button) { button.hidden = !needsInitialization; button.disabled = !native || pending; } }
  const hint = el('draft-hint'); if (hint && !native) hint.textContent = '浏览器预览 · 不会发送消息';
  syncPetNotificationOverlay();
  if (changed) armSpeechTimer();
}
let petConversationSession: string | null = null;
let petConversationHydrated = false;
function mountPetConversation() {
  const composer = el('pet-composer');
  if (!composer) return;
  petInput = new PetMenuController(composer, {
    // Native window/WebView focus transfer is not an outside click. Keep typing open
    // through blur; DOM/native outside presses, Escape and explicit close still dismiss.
    dismissOnBlur: false,
    dismissBoundary: el('pet-dialogue') ?? composer,
    getGeometry: native ? async () => {
      const geometry = await requestPetGeometry('get_pet_geometry');
      return composing ? { ...geometry, escape_down: false } : geometry;
    } : undefined,
    onChange: open => {
      if (disposed) return;
      petInputOpen = open;
      if (open) { petSpeechVisible = true; petSpeechExpanded = false; petMotion?.stop(); clearSpeechTimer(); }
      else { saveDraft(); draft?.blur(); }
      requestPetInput(open); renderPetConversation();
      if (!open) armSpeechTimer();
    },
  });
  el('pet-input-close')?.addEventListener('click', () => petInput?.close(), { signal: cleanup.signal });
  el('pet-speech-close')?.addEventListener('click', () => { dismissedSpeechKey = petCue?.key; petSpeechVisible = false; clearSpeechTimer(); renderPetConversation(); }, { signal: cleanup.signal });
  el('pet-speech-expand')?.addEventListener('click', () => { petSpeechExpanded = !petSpeechExpanded; renderPetConversation(); armSpeechTimer(); }, { signal: cleanup.signal });
  const host = el('pet-dialogue');
  host?.addEventListener('pointerenter', () => { petSpeechHovered = true; clearSpeechTimer(); }, { signal: cleanup.signal });
  host?.addEventListener('pointerleave', () => { petSpeechHovered = false; armSpeechTimer(); }, { signal: cleanup.signal });
  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();
    petSpeechSelected = !!selection && !selection.isCollapsed && !!el('pet-speech-text')?.contains(selection.anchorNode);
    if (petSpeechSelected) clearSpeechTimer(); else armSpeechTimer();
  }, { signal: cleanup.signal });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing || composing) return;
    petInput?.close(); dismissedSpeechKey = petCue?.key; petSpeechVisible = false; clearSpeechTimer(); renderPetConversation();
  }, { signal: cleanup.signal });
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
  const status = el('status'); if (status) status.textContent = label;
  const preview = el('preview'); if (preview) preview.hidden = native;
  const notice = el('notice'); if (notice) { notice.textContent = localError; notice.hidden = !localError || view === 'pet'; }
  const needsInitialization = (!state.enabled && state.phase !== 'loading') || state.phase === 'workspace_missing';
  const setup = el('setup'); if (setup) setup.hidden = !needsInitialization;
  const initialize = el<HTMLButtonElement>('initialize'); if (initialize) initialize.disabled = !native || pending;
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
  const retry = el<HTMLButtonElement>('retry'); if (retry) { retry.hidden = !native || needsInitialization || (state.phase === 'loading' && !transportFailed) || (state.connected && !transportFailed && !['error', 'failed', 'sending', 'cancelling'].includes(state.phase)); retry.disabled = pending; }
  const send = el<HTMLButtonElement>('send'); if (send) send.disabled = !native || !canSend(effectiveState, draft?.value ?? '', pending);
  const cancel = el<HTMLButtonElement>('cancel'); if (cancel) { cancel.hidden = !state.running && !state.waiting && !['sending', 'cancelling'].includes(state.phase); cancel.disabled = !native || pending || state.phase === 'cancelling'; }
  const newSession = el<HTMLButtonElement>('new-session'); if (newSession) newSession.disabled = !native || pending || !state.enabled || !state.workspace_id || state.running || state.waiting;
  renderPetConversation();
  root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
    if (!native) button.disabled = true;
  });
}
root.addEventListener('click', event => {
  const target = event.target as Element;
  const source = target.closest<HTMLElement>('[data-upstream]');
  if (source?.dataset.upstream) { petMenu?.close(); if (native) { event.preventDefault(); void action('pet_source'); } return; }
  const command = target.closest<HTMLElement>('[data-pet-command]')?.dataset.petCommand;
  if (command) {
    event.preventDefault();
    if (command === 'talk') { petMenu?.close(); void openPetInput(); return; }
    if (command === 'replay') { petMenu?.close(); dismissedSpeechKey = undefined; petSpeechVisible = true; renderPetConversation(); return; }
    if (command === 'slingshot') { petMenu?.close(); void togglePetSlingshot(); return; }
    if (command === 'topmost') { petMenu?.close(); void togglePetTopmost(); return; }
    if (command === 'close-menu') petMenu?.close();
    else petMenu?.toggle();
    return;
  }
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-action]');
  if (!button || button.disabled) return;
  const name = button.dataset.action!;
  petMenu?.close();
  if (name === 'hide') petMotion?.stop();
  void exclusive(name);
}, { signal: cleanup.signal });
el<HTMLSelectElement>('sessions')?.addEventListener('change', event => {
  const sessionId = (event.target as HTMLSelectElement).value;
  if (sessionId && sessionId !== state.session_id) void exclusive('select_session', { sessionId });
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
  const dialogue = el('pet-dialogue');
  pet?.setAttribute('aria-expanded', String(petInputOpen || menuOpen));
  const wasHidden = dialogue?.hidden;
  const available = petVisible && !menuOpen && !interactionPending;
  const speaking = available && petSpeechVisible;
  const typing = available && petInputOpen;
  if (dialogue) dialogue.hidden = !speaking;
  const composer = el('pet-composer'); if (composer) composer.hidden = !typing;
  if (!speaking) clearSpeechTimer();
  else if (wasHidden) armSpeechTimer();
  petNotifications?.setObscured(menuOpen || interactionPending || speaking || typing);
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
  if (interactionPending) { petMotion?.stop(); petInput?.close(); }
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
  const menu = el('pet-menu');
  const trigger = el('pet-animation-trigger'), panel = el('pet-animation');
  if (menu) petMenu = new PetMenuController(menu, {
    submenu: trigger && panel ? { trigger, panel } : undefined,
    onLayout: scheduleHitRegions,
    getGeometry: native ? () => requestPetGeometry('get_pet_geometry') : undefined,
    onChange: open => {
      if (disposed) return;
      pet?.setAttribute('aria-expanded', String(open));
      if (open) { petInput?.close(); petMotion?.stop(); positionPetMenu(); void refreshPetTopmost(); }
      syncPetNotificationOverlay();
    },
  });
  mountPetConversation();
  renderPetSlingshot();
  for (const surface of [menu, panel]) surface?.addEventListener('contextmenu', event => { event.preventDefault(); petMenu?.close(); }, { signal: cleanup.signal });
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
    onMove: (name, params, playback) => petVisible && !bubbleVisible && !petInputOpen && !petSpeechVisible && !interactionPending && !interactionExpanded && !!el('pet-menu')?.hidden ? (petMotion?.startRoam(name, params, playback.facing, params.durationSec, playback.video) ?? false) : false,
    onMoveEnd: () => petMotion?.stopRoam(),
    onError: error => { if (!disposed) setNotice('宠物动画加载失败：' + error.message); },
  });
  const list = el('pet-animation-list');
  if (list) {
    const groups = new Map<string, HTMLElement>();
    const groupLabels: Record<string, string> = { idle: '待机', turn: '转向', clicks: '点击回应', drag: '拖拽', move: '移动', balance: '余额', whisper: '碎碎念', workStatus: '工作状态' };
    for (const item of petRenderer.listActions()) {
      let group = groups.get(item.group);
      if (!group) {
        group = document.createElement('div');
        group.setAttribute('role', 'group');
        const label = groupLabels[item.group] ?? item.group;
        group.setAttribute('aria-label', label);
        const heading = document.createElement('div');
        heading.className = 'pet-submenu-heading'; heading.textContent = label;
        heading.setAttribute('aria-hidden', 'true');
        group.append(heading); list.append(group); groups.set(item.group, group);
      }
      const button = document.createElement('button');
      button.type = 'button'; button.setAttribute('role', 'menuitem'); button.tabIndex = -1;
      button.textContent = item.name; button.title = item.name;
      button.addEventListener('click', () => {
        petMotion?.stop(); petRenderer?.trigger(item.name); petMenu?.close();
        syncPetNotificationOverlay();
      }, { signal: cleanup.signal });
      group.append(button);
    }
  }
}
function renderPetSlingshot() {
  if (disposed) return;
  const button = el<HTMLButtonElement>('pet-slingshot');
  if (!button) return;
  button.disabled = !native || slingshotPending;
  button.setAttribute('aria-busy', String(slingshotPending));
  if (slingshotKnown) button.setAttribute('aria-checked', String(slingshotEnabled));
  else button.removeAttribute('aria-checked');
  button.setAttribute('data-state', !native ? 'unavailable' : slingshotKnown ? 'ready' : 'unknown');
  button.title = !native ? '仅桌面应用可用' : slingshotPending ? '正在读取/切换弹弓…' : !slingshotKnown ? '重新读取弹弓设置' : slingshotEnabled ? '弹弓已开启，快速连按再拖可蓄力弹射' : '弹弓已关闭，拖动松手即停，不再弹射或甩抛';
  button.setAttribute('aria-description', button.title);
}
async function togglePetSlingshot() {
  if (!native || view !== 'pet' || disposed || slingshotPending) return;
  const baseline = petPreferenceRevision;
  const desired = slingshotKnown ? !slingshotEnabled : undefined;
  slingshotPending = true; renderPetSlingshot();
  try {
    const snapshot = desired === undefined
      ? await invoke('get_pet_preferences')
      : await invoke('set_pet_slingshot_enabled', { enabled: desired });
    if (disposed) return;
    const confirmed = snapshot as { slingshot_enabled?: boolean; roaming_enabled?: boolean; revision?: number } | null;
    if (!confirmed || typeof confirmed.slingshot_enabled !== 'boolean' || typeof confirmed.roaming_enabled !== 'boolean' || !Number.isSafeInteger(confirmed.revision) || confirmed.revision! < 0) throw new Error('原生端未返回有效弹弓设置。');
    applyPetPreferences(snapshot);
    if (!slingshotKnown) throw new Error('原生端未返回有效弹弓设置。');
    if (localError.startsWith('无法读取或切换宠物弹弓：')) setNotice('');
  } catch (error) {
    if (!disposed) {
      if (petPreferenceRevision <= baseline) slingshotKnown = false;
      setNotice('无法读取或切换宠物弹弓：' + errorText(error));
    }
  } finally { if (!disposed) { slingshotPending = false; renderPetSlingshot(); } }
}
function renderPetTopmost() {
  if (disposed) return;
  const button = el<HTMLButtonElement>('pet-topmost');
  if (!button) return;
  button.disabled = !native || petTopmostPending;
  button.setAttribute('aria-busy', String(petTopmostPending));
  if (petTopmost === undefined) button.removeAttribute('aria-checked');
  else button.setAttribute('aria-checked', String(petTopmost));
  button.setAttribute('data-state', !native ? 'unavailable' : petTopmost === undefined ? 'unknown' : 'ready');
  button.title = !native ? '仅桌面应用可用' : petTopmostPending ? '正在读取/切换置顶…' : petTopmost === undefined ? '重新读取置顶状态' : petTopmost ? '窗口置顶已开启' : '窗口置顶已关闭';
  button.setAttribute('aria-description', button.title);
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
  if (!petVisible) { petMenu?.close(); petInput?.close(); petSpeechVisible = false; clearSpeechTimer(); petMotion?.stop(); renderPetConversation(); }
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
  const incoming = value as { revision?: number; roaming_enabled?: boolean; slingshot_enabled?: boolean };
  if (!Number.isSafeInteger(incoming.revision) || incoming.revision! < petPreferenceRevision || (incoming.revision === petPreferenceRevision && slingshotKnown) || typeof incoming.roaming_enabled !== 'boolean' || typeof incoming.slingshot_enabled !== 'boolean') return;
  petPreferenceRevision = incoming.revision!;
  slingshotKnown = true;
  if (slingshotEnabled !== incoming.slingshot_enabled) {
    slingshotEnabled = incoming.slingshot_enabled;
    petMotion?.setSlingshotEnabled(slingshotEnabled);
    // Do not carry a double-press or armed pull across a preference change.
    lastPress = -Infinity;
    if (pointer) pointer.sling = false;
  }
  if (roamingEnabled !== incoming.roaming_enabled) {
    roamingEnabled = incoming.roaming_enabled;
    petRenderer?.toggleFixed(!incoming.roaming_enabled);
    if (!incoming.roaming_enabled) petMotion?.stopRoam();
  }
  renderPetSlingshot();
}
// Native geometry uses physical pixels; overlay layout and hit regions use CSS pixels.
let petGeometryRequest = 0;
let petOverlayInsets: { left: number; right: number } | undefined;
async function requestPetGeometry(command: 'get_pet_geometry' | 'move_pet' | 'drag_pet', args?: { x: number; y: number } | { grabX: number; grabY: number }): Promise<PetGeometry> {
  const request = ++petGeometryRequest;
  const geometry = await invoke<PetGeometry>(command, args);
  if (!disposed && request === petGeometryRequest) updatePetOverlayBounds(geometry);
  return geometry;
}
function updatePetOverlayBounds(geometry: PetGeometry) {
  const { position, size, scale, areas } = geometry;
  if (!position || !size || !Number.isFinite(position.x) || !Number.isFinite(position.y) ||
      !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0 ||
      !Number.isFinite(scale) || scale <= 0 || !Array.isArray(areas)) return;
  // Use the real work area containing most of the window, never the expanded motion bounds.
  let overlap = 0;
  let area: PetGeometry['areas'][number] | undefined;
  for (const candidate of areas) {
    if (!candidate || ![candidate.x, candidate.y, candidate.width, candidate.height].every(Number.isFinite) || candidate.width <= 0 || candidate.height <= 0) continue;
    const width = Math.max(0, Math.min(position.x + size.width, candidate.x + candidate.width) - Math.max(position.x, candidate.x));
    const height = Math.max(0, Math.min(position.y + size.height, candidate.y + candidate.height) - Math.max(position.y, candidate.y));
    if (width * height > overlap) { overlap = width * height; area = candidate; }
  }
  if (!area) return;
  const left = Math.max(0, area.x - position.x) / scale;
  const right = Math.max(0, position.x + size.width - area.x - area.width) / scale;
  if (petOverlayInsets?.left === left && petOverlayInsets.right === right) return;
  petOverlayInsets = { left, right };
  root.style.setProperty('--pet-visible-left', left + 'px');
  root.style.setProperty('--pet-visible-right', right + 'px');
  // Position-only changes do not trigger ResizeObserver. Report the shifted controls too.
  scheduleHitRegions();
}
function positionPetMenu() {
  const host = root.querySelector<HTMLElement>('.pet-shell');
  if (!host || !petMenu) return;
  const shell = host.getBoundingClientRect(), viewport = root.getBoundingClientRect();
  const left = Math.max(shell.left, viewport.left + (petOverlayInsets?.left ?? 0)) + 6;
  const right = Math.min(shell.right, viewport.right - (petOverlayInsets?.right ?? 0)) - 6;
  const top = Math.max(shell.top, viewport.top) + 6;
  const bottom = Math.min(shell.bottom, viewport.bottom) - 6;
  petMenu.position({ x: left, y: top, width: right - left, height: bottom - top }, { x: shell.left, y: shell.top });
}
function mountPetMotion() {
  if (!native || view !== 'pet' || disposed || petMotion) return;
  petMotion = new PetMotion({
    getGeometry: () => requestPetGeometry('get_pet_geometry'),
    move: (x, y) => requestPetGeometry('move_pet', { x, y }),
    drag: (grabX, grabY) => requestPetGeometry('drag_pet', { grabX, grabY }),
    setActive: async active => { await invoke('assistant_action', { request: { action: 'motion_active', active } }); },
    physics,
    onDragStart: () => petRenderer?.dragStart(),
    onDragEnd: () => petRenderer?.dragEnd(),
    onBounce: () => petRenderer?.startSquash(),
    onError: error => { if (!disposed) setNotice('宠物移动失败：' + errorText(error)); },
  });
  petMotion.setSlingshotEnabled(slingshotEnabled);
}
pet?.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  suppressClick = false;
  const now = performance.now();
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false, sling: slingshotEnabled && now - lastPress < SLINGSHOT_DOUBLE_MS };
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
  event.preventDefault();
  petMenu?.toggle(event.clientX, event.clientY);
}, { signal: cleanup.signal });
pet?.addEventListener('click', event => {
  if (event.detail !== 0 && suppressClick) { suppressClick = false; event.preventDefault(); return; }
  petRenderer?.click();
  if (event.detail > 1) return;
  if (event.ctrlKey || event.metaKey) void action('open_dsh'); else void openPetInput();
}, { signal: cleanup.signal });
function dispose() {
  if (disposed) return;
  saveDraft(); petInput?.close(); clearSpeechTimer(); disposed = true; cleanup.abort(); unlisten?.(); unlisten = undefined;
  resizeObserver?.disconnect(); cancelAnimationFrame(hitFrame);
  unlistenPetVisibility?.(); unlistenPetVisibility = undefined;
  unlistenPetPreferences?.(); unlistenPetPreferences = undefined;
  unlistenPetNotifications?.(); unlistenPetNotifications = undefined;
  petNotifications?.dispose();
  unlistenPetInteractions?.(); unlistenPetInteractions = undefined;
  petInteractions?.dispose();
  if (native && view === 'pet') void invoke('set_pet_interaction_surface', { active: false }).catch(() => {});
  petInput?.dispose(); petMenu?.dispose(); petMotion?.dispose(); petRenderer?.dispose();
}
window.addEventListener('pagehide', dispose, { once: true });
window.addEventListener('beforeunload', dispose, { once: true });
if (import.meta.hot) import.meta.hot.dispose(dispose);
if (view === 'pet') {
  resizeObserver = new ResizeObserver(scheduleHitRegions);
  resizeObserver.observe(root);
  root.querySelectorAll('#pet, #notice, #pet-menu, #pet-animation, #pet-bubble, #pet-interaction, #pet-dialogue, #pet-composer, #pet-speech-text, #pet-read-status, #draft').forEach(node => resizeObserver!.observe(node));
  window.addEventListener('resize', scheduleHitRegions, { signal: cleanup.signal });
}
mountPet();
// Observe natural content as well as the positioned boxes (which may have a fixed fitted height).
root.querySelectorAll('.pet-notification-open, .pet-interactions-summary').forEach(node => resizeObserver?.observe(node));
loadDraft(); render();
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
