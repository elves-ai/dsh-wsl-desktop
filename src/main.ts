import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import './style.css';

interface Snapshot {
  state: string;
  phase: string;
  message: string;
  busy: boolean;
  managed: boolean;
  origin: string;
  last_error: string | null;
  logs: string[];
}

interface UpdateSnapshot {
  current_version: string;
  phase: 'idle' | 'checking' | 'available' | 'up_to_date' | 'downloading' | 'installing' | 'error';
  version: string | null;
  notes: string | null;
  downloaded: number;
  total: number | null;
  message: string;
  busy: boolean;
}

type Action = 'open' | 'start' | 'stop' | 'restart' | 'logs' | 'quit' | 'exit';
const native = isTauri();
const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('缺少应用挂载节点');

// Only this fixed, developer-owned template uses innerHTML. Native data is text only.
app.innerHTML = `
  <main class="launcher">
    <header class="header">
      <div class="brand"><span class="brand-mark" aria-hidden="true">D<span></span></span><div><h1>DSH <span>/ WSL Desktop</span></h1><p>本地工作空间，从这里开始。</p></div></div>
      <span class="environment" id="environment">本地控制</span>
    </header>

    <section class="preview-note" id="preview-note" hidden role="note">浏览器演示模式 · 仅预览界面，不会连接或操作本地服务。</section>

    <section class="status-card" aria-labelledby="service-heading">
      <div class="section-heading"><h2 id="service-heading">WSL 服务</h2><span class="status-badge" id="status-badge"><span class="status-dot" aria-hidden="true"></span><span id="status-label">正在连接</span></span></div>
      <div class="status-body" role="status" aria-live="polite" aria-atomic="true">
        <div class="service-symbol" aria-hidden="true"><span></span><span></span><span></span></div>
        <div class="status-copy"><p class="eyebrow">DEEPSEEK HARNESS</p><h3 id="status-title">正在读取服务状态</h3><p id="status-message">正在与本地启动器建立连接，请稍候。</p></div>
      </div>
      <div class="phase-row"><span class="phase-indicator" aria-hidden="true"></span><span class="field-label">当前阶段</span><span id="phase">连接启动器</span><span class="busy-label" id="busy-label" hidden>处理中</span></div>
      <div class="error-notice" id="error-notice" hidden role="alert"></div>
      <button class="button primary open-button" type="button" id="open" disabled><span>打开 DSH</span><span aria-hidden="true">↗</span></button>
      <p class="open-hint">在独立的 DSH 窗口中继续工作</p>
      <div class="service-actions" aria-label="服务操作"><button class="button secondary" id="start" type="button" disabled>启动服务</button><button class="button secondary" id="stop" type="button" disabled>停止</button><button class="button secondary" id="restart" type="button" disabled>重启</button></div>
    </section>

    <section class="connection-card" aria-label="连接信息">
      <div><span class="field-label">服务地址</span><code id="origin">尚未连接</code></div>
      <div><span class="field-label">进程归属</span><span class="ownership" id="ownership">等待检查</span></div>
      <p id="ownership-hint">只有由本启动器管理的服务才能停止或重启。</p>
    </section>

    <details class="update-panel" id="updates-panel"><summary><span>启动器更新</span><span class="update-version" id="update-current-version">正在读取版本</span></summary><div class="update-content">
      <p class="update-new-version" id="update-new-version" hidden></p>
      <p id="update-message" role="status" aria-live="polite" tabindex="-1">正在读取更新状态。</p>
      <pre id="update-notes" aria-label="更新说明" hidden></pre>
      <div id="update-progress-row" hidden><progress id="update-progress" aria-label="更新下载进度"></progress><span id="update-progress-label"></span></div>
      <div class="update-actions"><button class="button secondary" type="button" id="check-update" disabled>检查更新</button><button class="button primary" type="button" id="install-update" hidden disabled>下载并安装</button></div>
      <p class="update-hint">仅更新 Windows 启动器，不会更新或停止 WSL 服务；安装前会请求系统确认。</p>
    </div></details>

    <details class="logs-panel" id="logs-panel"><summary><span><span class="log-symbol" aria-hidden="true">≡</span>操作日志 <span class="log-count" id="log-count">0</span></span><span class="log-summary-hint">脱敏显示 <span class="chevron" aria-hidden="true">⌄</span></span></summary><div class="logs-content"><div class="logs-toolbar"><span>仅显示本地启动与控制记录</span><button class="text-button" id="logs" type="button" disabled>刷新日志</button></div><pre id="log-output" tabindex="0" aria-label="脱敏操作日志">暂无操作日志</pre></div></details>

    <footer class="footer"><div class="background-note"><span aria-hidden="true">◌</span><p>关闭窗口后，服务仍可在后台运行。<br><span>需要停止服务时，请选择“停止”或“停止并退出”。</span></p></div><div class="exit-actions"><button class="text-button" type="button" id="quit" disabled>退出启动器</button><span aria-hidden="true">/</span><button class="text-button danger" type="button" id="exit" disabled>停止并退出</button></div></footer>
  </main>
`;

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error('缺少界面节点：' + id);
  return node as T;
}
const actions: Action[] = ['open', 'start', 'stop', 'restart', 'logs', 'quit', 'exit'];
const buttons = Object.fromEntries(actions.map(action => [action, element<HTMLButtonElement>(action)])) as Record<Action, HTMLButtonElement>;
let snapshot: Snapshot = { state: 'unknown', phase: '连接启动器', message: '正在与本地启动器建立连接，请稍候。', busy: true, managed: false, origin: '', last_error: null, logs: [] };
let pending = false;
let connected = false;
let localError = '';
let eventRevision = 0;
let unlisten: UnlistenFn | undefined;
let unlistenShowLogs: UnlistenFn | undefined;
let unlistenUpdates: UnlistenFn | undefined;
let unlistenShowUpdates: UnlistenFn | undefined;
let updateSnapshot: UpdateSnapshot = { current_version: '', phase: 'idle', version: null, notes: null, downloaded: 0, total: null, message: '正在读取更新状态。', busy: false };
let updateConnected = false;
let updatePending: 'check_update' | 'install_update' | null = null;
let updateError = '';
let updateRevision = 0;
const checkUpdateButton = element<HTMLButtonElement>('check-update');
const installUpdateButton = element<HTMLButtonElement>('install-update');

function updateLocksService(): boolean {
  return updatePending === 'install_update' || ['downloading', 'installing'].includes(updateSnapshot.phase);
}

const states: Record<string, { label: string; title: string }> = {
  stopped: { label: '未运行', title: '工作空间尚未启动' },
  starting: { label: '启动中', title: '正在准备你的工作空间' },
  ready: { label: '运行中', title: '工作空间已就绪' },
  error: { label: '启动异常', title: '服务需要处理' },
  unknown: { label: '待检查', title: '暂时无法确认服务状态' },
};

// Defense in depth: Rust owns redaction; do not expose common credential forms in UI.
function redact(value: string): string {
  return value
    .replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1[已隐藏]')
    .replace(/((?:[?&]|\b)(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|password|secret|authorization)\s*[=:]\s*)([^\s&#"'<>]+)/gi, '$1[已隐藏]')
    .replace(/(["'](?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|password|secret|authorization)["']\s*:\s*["'])[^"']*/gi, '$1[已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@');
}

function safeOrigin(origin: string): string {
  if (!origin) return '尚未连接';
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : '地址不可用';
  } catch { return '地址不可用'; }
}

function render(): void {
  const knownState = Object.prototype.hasOwnProperty.call(states, snapshot.state) ? snapshot.state : 'unknown';
  const status = states[knownState] ?? { label: '待检查', title: '暂时无法确认服务状态' };
  const busy = snapshot.busy || pending;
  const disabled = !native || !connected || busy || updateLocksService();
  const ready = snapshot.state === 'ready';
  const running = ready || snapshot.state === 'starting';
  element('status-badge').dataset.state = knownState;
  element('status-label').textContent = connected ? status.label : '正在连接';
  element('status-title').textContent = connected ? status.title : '正在读取服务状态';
  element('status-message').textContent = redact(snapshot.message || '等待本地服务报告状态。');
  element('phase').textContent = redact(snapshot.phase || '等待状态更新');
  element('busy-label').hidden = !busy;
  element('origin').textContent = safeOrigin(snapshot.origin);
  element('ownership').textContent = snapshot.managed ? '由启动器管理' : ready ? '外部服务 · 只读管理' : '未托管';
  element('ownership-hint').textContent = ready && !snapshot.managed ? '已发现现有服务，可以打开 DSH；本启动器不会停止或重启外部服务。' : '仅控制由当前或旧启动器托管的服务；外部实例不会被停止。';
  const error = redact(localError || snapshot.last_error || '');
  element('error-notice').hidden = !error;
  element('error-notice').textContent = error;
  buttons.open.disabled = disabled;
  buttons.start.disabled = disabled || running;
  buttons.start.textContent = ['error', 'unknown'].includes(snapshot.state) ? '重试启动' : '启动服务';
  buttons.stop.disabled = disabled || !snapshot.managed || snapshot.state === 'stopped';
  buttons.restart.disabled = disabled || !snapshot.managed;
  buttons.logs.disabled = disabled;
  buttons.quit.disabled = disabled;
  buttons.exit.disabled = disabled || (snapshot.state !== 'stopped' && !snapshot.managed);
  buttons.stop.title = buttons.restart.title = snapshot.managed ? '操作前将显示系统确认对话框' : '不能控制非本启动器管理的服务';
  buttons.quit.title = '仅退出启动器，不停止 WSL 服务';
  buttons.exit.title = '由系统确认后停止服务并退出';
  const output = element<HTMLPreElement>('log-output');
  const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 30;
  const lines = snapshot.logs.map(line => redact(line));
  output.textContent = lines.length ? lines.join('\n') : '暂无操作日志';
  element('log-count').textContent = String(lines.length);
  if (atBottom) output.scrollTop = output.scrollHeight;
  renderUpdate();
}

function renderUpdate(): void {
  const update = updateSnapshot;
  const busy = update.busy || updatePending !== null || ['checking', 'downloading', 'installing'].includes(update.phase);
  const available = Boolean(update.version) && update.phase === 'available';
  element('update-current-version').textContent = update.current_version ? '当前版本 ' + update.current_version : native ? '版本待读取' : '仅桌面应用可用';
  element('update-new-version').hidden = !update.version;
  element('update-new-version').textContent = update.version ? '新版本 ' + update.version : '';
  element('update-message').textContent = !native ? '浏览器预览不检查更新，也不会下载或安装。' : redact(updateError || update.message || '可检查启动器更新。');
  element('update-message').dataset.error = String(Boolean(updateError) || update.phase === 'error');
  // Release notes are untrusted plain text, never HTML or rendered Markdown.
  element('update-notes').textContent = update.notes || '';
  element('update-notes').hidden = !update.notes;
  const downloading = update.phase === 'downloading';
  element('update-progress-row').hidden = !downloading && update.phase !== 'installing';
  const progress = element<HTMLProgressElement>('update-progress');
  if (downloading && update.total !== null && update.total > 0) {
    progress.max = update.total;
    progress.value = Math.min(Math.max(0, update.downloaded), update.total);
    element('update-progress-label').textContent = Math.floor(progress.value / update.total * 100) + '% · ' + formatBytes(update.downloaded) + ' / ' + formatBytes(update.total);
  } else {
    progress.removeAttribute('value');
    element('update-progress-label').textContent = downloading ? '已下载 ' + formatBytes(update.downloaded) + ' · 总大小未知' : '正在安装…';
  }
  checkUpdateButton.disabled = !native || !updateConnected || busy;
  checkUpdateButton.textContent = update.phase === 'checking' || updatePending === 'check_update' ? '正在检查…' : '检查更新';
  installUpdateButton.hidden = !available;
  installUpdateButton.disabled = !native || !updateConnected || !available || busy || !connected || snapshot.busy || pending;
}

function formatBytes(bytes: number): string {
  const safe = Math.max(0, bytes);
  return safe < 1024 * 1024 ? (safe / 1024).toFixed(1) + ' KB' : (safe / (1024 * 1024)).toFixed(1) + ' MB';
}

function showUpdates(): void {
  element<HTMLDetailsElement>('updates-panel').open = true;
  element('update-message').focus({ preventScroll: true });
  element('updates-panel').scrollIntoView({ block: 'nearest' });
}

async function performUpdate(command: 'check_update' | 'install_update'): Promise<void> {
  const button = command === 'check_update' ? checkUpdateButton : installUpdateButton;
  if (!native || button.disabled || updatePending !== null) return;
  updatePending = command;
  updateError = '';
  render();
  const revision = updateRevision;
  try {
    // Rust alone owns confirmation, release validation, download, and installation.
    const result = await invoke<UpdateSnapshot>(command);
    if (updateRevision === revision) updateSnapshot = result;
  } catch (error) {
    if (updateRevision === revision) updateError = '更新操作未完成，可重试：' + String(error);
  } finally {
    updatePending = null;
    render();
  }
}

function showLogs(): void {
  element<HTMLDetailsElement>('logs-panel').open = true;
  element('log-output').focus({ preventScroll: true });
}

async function perform(action: Action): Promise<void> {
  if (!native || buttons[action].disabled || pending) return;
  if (action === 'logs') showLogs();
  pending = true;
  localError = '';
  render();
  const revision = eventRevision;
  try {
    // Confirmation for stop/restart/exit is exclusively handled by Rust.
    const result = await invoke<Snapshot>('perform_action', { action });
    if (eventRevision === revision) snapshot = result;
  } catch (error) {
    localError = '操作未完成：' + String(error);
  } finally {
    pending = false;
    render();
  }
}

for (const action of actions) buttons[action].addEventListener('click', () => { void perform(action); });

async function initialize(): Promise<void> {
  if (!native) {
    element('environment').textContent = '浏览器预览';
    element('preview-note').hidden = false;
    connected = true;
    snapshot = { state: 'ready', phase: '演示 · 服务已就绪', message: '这是本地启动器的界面演示。实际服务状态与操作仅在桌面应用中可用。', busy: false, managed: true, origin: 'http://127.0.0.1:3080', last_error: null, logs: ['[演示] 检查 WSL 环境', '[演示] 本地服务已就绪；未执行任何实际操作'] };
    render();
    return;
  }
  try {
    // Subscribe first so startup transitions cannot be lost during the first query.
    unlisten = await listen<Snapshot>('launcher-state', event => {
      eventRevision += 1;
      snapshot = event.payload;
      connected = true;
      localError = '';
      render();
    });
  } catch (error) {
    localError = '无法订阅状态更新：' + String(error);
  }
  try {
    unlistenShowLogs = await listen('launcher-show-logs', showLogs);
  } catch (error) {
    localError = '无法订阅日志窗口请求：' + String(error);
  }
  const revision = eventRevision;
  try {
    const initial = await invoke<Snapshot>('get_snapshot');
    if (eventRevision === revision) snapshot = initial;
    connected = true;
  } catch (error) {
    if (!connected) {
      connected = true;
      snapshot = { ...snapshot, busy: false, state: 'unknown', phase: '读取状态失败', message: '未能获取本地服务状态，可重试启动或退出启动器。' };
    }
    localError = '无法获取服务状态：' + String(error);
  }
  render();
}

checkUpdateButton.addEventListener('click', () => { void performUpdate('check_update'); });
installUpdateButton.addEventListener('click', () => { void performUpdate('install_update'); });

async function initializeUpdates(): Promise<void> {
  if (!native) return;
  try {
    // Listen before querying: a late query/command reply must not replace newer events.
    unlistenUpdates = await listen<UpdateSnapshot>('launcher-update-state', event => {
      updateRevision += 1;
      updateSnapshot = event.payload;
      updateConnected = true;
      updateError = '';
      render();
    });
    unlistenShowUpdates = await listen('launcher-show-updates', showUpdates);
  } catch (error) {
    updateError = '无法订阅更新状态，请重新打开启动器：' + String(error);
    render();
    return;
  }
  const revision = updateRevision;
  try {
    const initial = await invoke<UpdateSnapshot>('get_update_snapshot');
    if (updateRevision === revision) updateSnapshot = initial;
  } catch (error) {
    if (updateRevision === revision) updateError = '无法读取更新状态，可重试检查：' + String(error);
  }
  updateConnected = true;
  render();
  // A tray reveal can precede subscriptions during startup; recover from the snapshot.
  if (updateSnapshot.phase === 'available') showUpdates();
  // Checking is safe alongside service startup. Never download without a user action.
  if (!checkUpdateButton.disabled && ['idle', 'up_to_date', 'error'].includes(updateSnapshot.phase)) await performUpdate('check_update');
}

window.addEventListener('beforeunload', () => { unlisten?.(); unlistenShowLogs?.(); unlistenUpdates?.(); unlistenShowUpdates?.(); }, { once: true });
render();
void initialize();
void initializeUpdates();
