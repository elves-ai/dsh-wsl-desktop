import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import './style.css';
import appIconUrl from '../app-icon.png';

interface EnvironmentCheck {
  id: string;
  label: string;
  status: 'pending' | 'passed' | 'error' | 'skipped';
  message: string;
  hint: string;
}
interface EnvironmentReport { checks: EnvironmentCheck[]; repository: string | null }
const environmentItems = [
  ['wsl', 'WSL'], ['config', '启动器配置'], ['distribution', 'Linux 发行版'],
  ['user', 'Linux 用户'], ['python', 'Python'], ['launcher', '服务管理脚本'],
  ['linux_config', 'WSL 服务配置'], ['repository', 'DeepSeek Harness 项目'],
  ['node', 'Node.js'], ['dependencies', '项目依赖'], ['web_assets', 'Web 页面产物'],
] as const;
const pendingEnvironment = (): EnvironmentReport => ({ checks: environmentItems.map(([id, label]) => ({ id, label, status: 'pending', message: '等待检测', hint: '' })), repository: null });

interface Snapshot {
  state: string;
  phase: string;
  message: string;
  busy: boolean;
  managed: boolean;
  origin: string;
  last_error: string | null;
  logs: string[];
  environment: EnvironmentReport;
  environment_checking: boolean;
  config_path: string;
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

interface NotificationSnapshot {
  enabled: boolean;
  phase: 'disabled' | 'connecting' | 'listening' | 'error';
  message: string;
}

type Action = 'check' | 'open' | 'start' | 'stop' | 'restart' | 'logs' | 'quit' | 'exit';
const native = isTauri();
const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('缺少应用挂载节点');

const parameters = new URL(window.location.href).searchParams;
const settingsView = parameters.get('view') === 'settings';
const settingsSections = ['environment', 'notifications', 'updates', 'logs'] as const;
type SettingsSection = typeof settingsSections[number];
let settingsSection: SettingsSection = settingsSections.find(section => section === parameters.get('section')) || 'environment';
const mark = `<img src="${appIconUrl}" width="36" height="36" alt="" />`;
// Templates contain only developer-owned markup. All native values use textContent/value.
app.innerHTML = settingsView ? `
<main class="settings-shell" id="settings-shell">
  <aside class="settings-sidebar"><div class="settings-brand"><span class="small-mark">${mark}</span><span>DSH<small>应用设置</small></span></div><nav aria-label="设置分类">${settingsSections.map((section,index) => `<button class="settings-nav" id="nav-${section}" type="button"><span class="nav-index" aria-hidden="true">0${index+1}</span>${['环境与目录','系统通知','软件更新','诊断日志'][index]}</button>`).join('')}</nav><p class="settings-sidebar-note">设置保存在本机<br>不会上传到维护者</p></aside>
  <div class="settings-content">
    <header class="settings-heading"><p class="eyebrow">应用设置</p><h1 id="settings-title" tabindex="-1">环境与目录</h1><p id="settings-description">指定已有的 DSH 项目，查看本地运行配置。</p></header>
    <div class="error-notice" id="error-notice" role="alert" hidden></div>
    <section id="settings-environment" aria-label="环境与目录">
      <div class="setting-group"><h2>DSH 项目目录</h2><p id="repository-help">填写 WSL 内的绝对路径，不是 Windows 路径。</p><label class="visually-hidden" for="repository-input">DSH 项目目录</label><input id="repository-input" type="text" placeholder="/home/用户名/deepseek-harness" autocomplete="off" spellcheck="false" maxlength="4096" aria-describedby="repository-help repository-notice" disabled><p class="setting-help" id="repository-notice" role="status" aria-live="polite">正在读取配置。</p><button class="button primary" id="save-repository" type="button" disabled>保存并重新检测</button></div>
      <div class="setting-group"><div class="group-heading"><h2>运行环境</h2><span id="status-label" class="muted">读取中</span></div><dl class="connection-info"><div><dt>服务地址</dt><dd><code id="origin">尚未连接</code></dd></div><div><dt>进程归属</dt><dd id="ownership">等待检查</dd></div><div><dt>启动配置</dt><dd id="config-location">尚未读取</dd></div></dl><p class="setting-help" id="ownership-hint">仅管理由启动器托管的服务。</p><button class="button secondary" id="check" type="button" disabled>重新检测并进入 DSH</button></div>
      <p class="setting-help">不自动安装软件、克隆项目或安装依赖。修改目录前，请通过托盘右键菜单停止服务。</p>
    </section>
    <section id="settings-notifications" aria-label="系统通知" hidden><div class="setting-group"><div class="toggle-row"><div><h2>后台任务通知</h2><p>DSH 不在前台时，提醒任务结束、失败，以及需要你选择、回答或确认计划。</p></div><label class="switch"><input id="notifications-enabled" type="checkbox" aria-label="启用系统通知" disabled><span></span></label></div><p id="notification-message" class="setting-help" role="status" aria-live="polite">正在读取通知设置。</p><button class="button secondary" id="test-notification" type="button" disabled>发送测试通知</button></div><p class="setting-help">默认关闭。通知不显示任务正文；本轮结束不代表整个长任务完成。退出启动器后不再提醒。</p><p class="setting-help">若未看到横幅，请检查 Windows 通知权限及勿扰模式。</p></section>
    <section id="settings-updates" aria-label="软件更新" hidden><div class="setting-group"><div class="group-heading"><h2>DSH WSL Desktop</h2><span id="update-current-version" class="muted">正在读取版本</span></div><p id="update-new-version" hidden></p><p id="update-message" role="status" aria-live="polite" tabindex="-1">正在读取更新状态。</p><pre id="update-notes" aria-label="更新说明" hidden></pre><div id="update-progress-row" hidden><progress id="update-progress" aria-label="更新下载进度"></progress><span id="update-progress-label"></span></div><div class="setting-actions"><button class="button secondary" id="check-update" type="button" disabled>检查更新</button><button class="button primary" id="install-update" type="button" hidden disabled>下载并安装</button></div></div><p class="setting-help">仅更新 Windows 启动器，不会更新或停止 WSL 中的 DSH。安装前需要你确认。</p></section>
    <section id="settings-logs" aria-label="诊断日志" hidden><div class="group-heading"><h2>启动与服务操作</h2><button class="text-button" id="logs" type="button" disabled>刷新</button></div><p class="setting-help">只显示启动器的脱敏记录，不包含 DSH 对话内容。</p><pre id="log-output" tabindex="0" aria-label="脱敏操作日志">暂无操作日志</pre></section>
    <p class="settings-preview" id="settings-preview" hidden>浏览器预览 · 不会连接或操作本地服务</p>
  </div>
</main>
` : `
<main class="startup" id="startup-shell">
  <header class="startup-brand"><div class="app-mark">${mark}</div><span>DeepSeek Harness<small>WSL Desktop</small></span></header>
  <section class="startup-content" aria-labelledby="status-title">
    <div class="startup-heading"><span class="eyebrow">启动工作空间</span><h1 id="status-title">正在启动 DSH</h1><p id="status-message" role="status" aria-live="polite">正在检查本地运行环境，请稍候。</p></div>
    <ol class="startup-steps" aria-label="启动进度">
      <li id="stage-environment" data-state="active"><span class="step-marker" id="stage-environment-mark" aria-hidden="true"></span><span>检查运行环境</span><span class="step-status" id="stage-environment-state">正在检测</span></li>
      <li id="stage-service" data-state="pending"><span class="step-marker" id="stage-service-mark" aria-hidden="true"></span><span>准备本地服务</span><span class="step-status" id="stage-service-state">等待中</span></li>
      <li id="stage-window" data-state="pending"><span class="step-marker" id="stage-window-mark" aria-hidden="true"></span><span>打开 DSH</span><span class="step-status" id="stage-window-state">等待中</span></li>
    </ol>
    <div class="startup-progress" id="startup-progress" role="progressbar" aria-label="正在启动，无需手动操作"><span></span></div>
    <div class="error-notice" id="error-notice" role="alert" hidden></div>
    <details class="check-details" id="environment-panel"><summary><span>环境检查</span><span id="environment-summary">11 项</span></summary><ul class="environment-list" aria-label="环境检查结果">${environmentItems.map(([id,label]) => `<li class="environment-item" id="check-${id}" data-status="pending"><div class="check-heading"><span>${label}</span><span class="check-state" id="check-${id}-state">待检测</span></div><p class="check-message" id="check-${id}-message" hidden></p><p class="check-hint" id="check-${id}-hint" hidden></p></li>`).join('')}</ul></details>
    <div class="startup-actions" id="startup-actions" hidden><button class="button primary" id="check" type="button" disabled>重新检测</button><button class="button secondary" id="open-settings" type="button">打开设置</button><button class="button primary" id="open" type="button" hidden disabled>打开 DSH</button></div>
  </section>
  <footer class="startup-footer"><span id="preview-note">本地运行 · 不自动安装</span><span id="phase">准备启动</span></footer>
</main>
`;

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error('缺少界面节点：' + id);
  return node as T;
}
const actions: Action[] = settingsView ? ['check', 'logs'] : ['check', 'open'];
const buttons = Object.fromEntries(actions.map(action => [action, element<HTMLButtonElement>(action)])) as Partial<Record<Action, HTMLButtonElement>>;
let snapshot: Snapshot = { state: 'unknown', phase: '连接启动器', message: '正在与本地启动器建立连接，请稍候。', busy: true, managed: false, origin: '', last_error: null, logs: [], environment: pendingEnvironment(), environment_checking: true, config_path: '' };
let pending = false;
let repositoryPending = false;
let repositoryDirty = false;
let settingsRequestPending = false;
const repositoryInput = document.getElementById('repository-input') as HTMLInputElement;
const saveRepositoryButton = document.getElementById('save-repository') as HTMLButtonElement;
let connected = false;
let localError = '';
let eventRevision = 0;
let unlisten: UnlistenFn | undefined;
let unlistenShowLogs: UnlistenFn | undefined;
let unlistenShowSettings: UnlistenFn | undefined;
let unlistenUpdates: UnlistenFn | undefined;
let unlistenShowUpdates: UnlistenFn | undefined;
let updateSnapshot: UpdateSnapshot = { current_version: '', phase: 'idle', version: null, notes: null, downloaded: 0, total: null, message: '正在读取更新状态。', busy: false };
let updateConnected = false;
let updatePending: 'check_update' | 'install_update' | null = null;
let updateError = '';
let updateRevision = 0;
const checkUpdateButton = document.getElementById('check-update') as HTMLButtonElement;
const installUpdateButton = document.getElementById('install-update') as HTMLButtonElement;
const notificationsEnabled = document.getElementById('notifications-enabled') as HTMLInputElement;
const testNotificationButton = document.getElementById('test-notification') as HTMLButtonElement;
let notificationSnapshot: NotificationSnapshot = { enabled: false, phase: 'disabled', message: '未启用系统通知。' };
let notificationPending = false;
let notificationRevision = 0;
let notificationError = '';
let notificationNotice = '';
let unlistenNotifications: UnlistenFn | undefined;
let notificationsDisposed = false;

function updateLocksService(): boolean {
  return updatePending === 'install_update' || ['downloading', 'installing'].includes(updateSnapshot.phase);
}

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

function environmentPassed(): boolean {
  return environmentItems.every(([id]) => snapshot.environment.checks.some(item => item.id === id && item.status === 'passed'));
}
function render(): void {
  const busy = snapshot.busy || pending || repositoryPending;
  const disabled = !native || !connected || busy || updateLocksService();
  const passed = environmentPassed();
  const error = redact(localError || snapshot.last_error || '');
  if (settingsView) renderSettings(disabled, passed, error);
  else renderStartup(disabled, passed, busy, error);
  if (buttons.check) buttons.check.disabled = disabled;
  if (buttons.open) buttons.open.disabled = disabled || !passed;
  if (buttons.logs) buttons.logs.disabled = disabled;
  renderUpdate();
  renderNotifications();
}
function renderStartup(disabled: boolean, passed: boolean, busy: boolean, error: string): void {
  // A completed operation's error must win over a stale environment-checking flag.
  const failed = !busy && (snapshot.state === 'error' || Boolean(error));
  const idle = !busy && (!snapshot.environment_checking || passed || failed || snapshot.state === 'stopped');
  const stopped = snapshot.state === 'stopped' && idle && !failed;
  const ready = snapshot.state === 'ready' && idle && !failed;
  const stopping = busy && /停止|退出/.test(snapshot.phase);
  // Windows reachability and authentication still belong to service preparation.
  // The backend preserves the operation phase on failure.
  const windowStage = passed && snapshot.phase === '打开工作窗口';
  element('startup-shell').dataset.state = failed ? 'error' : ready ? 'ready' : stopped ? 'stopped' : 'starting';
  element('status-title').textContent = failed ? '操作未能完成' : ready ? 'DSH 已就绪' : stopped ? '工作空间已停止' : stopping ? '正在停止服务' : windowStage ? '正在打开工作空间' : passed ? '正在连接本地服务' : '正在启动 DSH';
  const failures = snapshot.environment.checks.filter(item => item.status === 'error');
  element('status-message').textContent = failed && failures.length ? '发现 ' + failures.length + ' 项环境问题，请处理后重新检测。' : failed ? '请检查下方提示后重新检测，或打开设置查看诊断日志。' : stopped ? '重新打开即可继续，原有配置和会话不会丢失。' : redact(snapshot.message) || (ready ? 'DSH 已就绪，可以打开工作窗口。' : passed ? '运行环境已准备好，正在连接本地服务。' : '正在检查本地运行环境，就绪后自动进入。');
  element('phase').textContent = redact(snapshot.phase || '准备启动');
  const stageStates = [
    passed ? 'passed' : failed ? 'error' : idle ? 'pending' : 'active',
    !passed || stopped ? 'pending' : ready || windowStage ? 'passed' : failed ? 'error' : 'active',
    ready ? 'passed' : windowStage ? failed ? 'error' : 'active' : 'pending',
  ];
  const stageLabels: Record<string, string> = { pending: '等待中', active: '进行中', passed: '已完成', error: '未通过' };
  ['environment', 'service', 'window'].forEach((id,index) => {
    const state = stageStates[index] || 'pending';
    element('stage-' + id).dataset.state = state;
    element('stage-' + id + '-state').textContent = stageLabels[state] || '等待中';
    element('stage-' + id + '-mark').textContent = state === 'passed' ? '✓' : state === 'error' ? '!' : '';
  });
  const detail = localError ? error : failures.length ? failures.map(item => item.label + '：' + item.message + (item.hint ? '\n' + item.hint : '')).join('\n\n') : error || snapshot.message || '操作未能完成，请重新检测或在设置中查看诊断日志。';
  element('error-notice').hidden = !failed;
  element('error-notice').textContent = redact(detail);
  element('startup-progress').hidden = idle || failed;
  element('startup-actions').hidden = !idle && !failed;
  element('open-settings').hidden = !failed;
  element<HTMLButtonElement>('open-settings').disabled = settingsRequestPending;
  element('open').hidden = !passed || failed;
  element('check').hidden = !failed && passed;
  if (buttons.check) buttons.check.textContent = '重新检测';
  element('environment-summary').textContent = snapshot.environment_checking && !passed && !failed && !stopped ? '检测中' : failures.length ? failures.length + ' 项需处理' : passed ? '全部通过' : '等待检测';
  const statuses = { pending: '待检测', passed: '已通过', error: '需处理', skipped: '等待前置项' };
  for (const [id] of environmentItems) {
    const item = snapshot.environment.checks.find(check => check.id === id);
    const status = item && Object.prototype.hasOwnProperty.call(statuses, item.status) ? item.status : 'pending';
    element('check-' + id).dataset.status = status;
    element('check-' + id + '-state').textContent = statuses[status];
    element('check-' + id + '-message').textContent = redact(item?.message || '');
    element('check-' + id + '-message').hidden = status !== 'error';
    element('check-' + id + '-hint').textContent = redact(item?.hint || '');
    element('check-' + id + '-hint').hidden = true; // Actionable hints are already in the error summary.
  }
}
function renderSettings(disabled: boolean, passed: boolean, error: string): void {
  element('error-notice').hidden = !error;
  element('error-notice').textContent = error;
  const running = snapshot.state === 'ready' || snapshot.state === 'starting';
  if (!repositoryDirty) repositoryInput.value = snapshot.environment.repository || '';
  const canConfigure = ['config', 'distribution', 'user', 'python'].every(id => snapshot.environment.checks.some(item => item.id === id && item.status === 'passed'));
  repositoryInput.disabled = disabled || !canConfigure || running;
  const path = repositoryInput.value.trim();
  const valid = path.startsWith('/') && !path.startsWith('//') && path.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(path);
  saveRepositoryButton.disabled = repositoryInput.disabled || !valid || !repositoryDirty;
  element('repository-notice').textContent = repositoryPending ? '正在保存并重新检测…' : running ? '修改目录前，请先通过托盘右键菜单停止服务。' : !canConfigure ? '请先准备好 WSL、启动器配置和 Python，再设置项目目录。' : repositoryDirty && !valid ? '请输入有效的 WSL 绝对路径，不能包含控制字符。' : '仅保存到现有服务配置；不会克隆项目或安装依赖。';
  element('status-label').textContent = snapshot.environment_checking ? '检测中' : passed ? '检查通过' : '需要检查';
  element('origin').textContent = safeOrigin(snapshot.origin);
  element('ownership').textContent = snapshot.managed ? '由启动器管理' : snapshot.state === 'ready' ? '未验证归属' : '未托管';
  element('ownership-hint').textContent = snapshot.state === 'ready' && !snapshot.managed ? '尚未验证该服务是否由启动器管理，不会自动停止或重启。' : '服务操作位于托盘右键菜单；停止或重启前会再次确认。';
  element('config-location').textContent = redact(snapshot.config_path || '尚未读取');
  const output = element('log-output');
  const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 30;
  output.textContent = snapshot.logs.length ? snapshot.logs.map(redact).join('\n') : '暂无操作日志';
  if (atBottom) output.scrollTop = output.scrollHeight;
}
function renderUpdate(): void {
  if (!settingsView) return;
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
  installUpdateButton.disabled = !native || !updateConnected || !available || busy || !connected || snapshot.busy || pending || repositoryPending;
}

function renderNotifications(): void {
  if (!settingsView) return;
  const state = notificationSnapshot;
  const labels = { disabled: '未启用', connecting: '连接中', listening: '正在检查', error: '通知异常' };
  notificationsEnabled.checked = state.enabled;
  notificationsEnabled.disabled = !native || notificationPending || notificationsDisposed;
  testNotificationButton.disabled = notificationsEnabled.disabled || !state.enabled;
  testNotificationButton.textContent = notificationPending ? '处理中…' : '测试通知';
  const message = element('notification-message');
  message.dataset.error = String(Boolean(notificationError) || state.phase === 'error');
  message.dataset.phase = state.phase;
  message.textContent = !native ? '浏览器预览不连接通知服务，也不会请求网页通知权限。' : redact(notificationError || notificationNotice || labels[state.phase] + ' · ' + state.message);
}

async function subscribeNotifications(): Promise<boolean> {
  if (notificationsDisposed) return false;
  if (unlistenNotifications) return true;
  const stop = await listen<NotificationSnapshot>('launcher-notification-state', event => {
    if (notificationsDisposed) return;
    notificationRevision += 1;
    notificationSnapshot = event.payload;
    notificationError = '';
    notificationNotice = '';
    renderNotifications();
  });
  // The window may close while the native listener registration is in flight.
  if (notificationsDisposed) { stop(); return false; }
  unlistenNotifications = stop;
  return true;
}

async function performNotification(command: 'get_notification_snapshot' | 'set_notifications_enabled' | 'test_notification', enabled?: boolean): Promise<void> {
  if (!native || notificationsDisposed || notificationPending || (command === 'test_notification' && testNotificationButton.disabled)) {
    renderNotifications();
    return;
  }
  notificationPending = true;
  notificationError = '';
  notificationNotice = '';
  renderNotifications();
  // Capture before subscribing, not after: events delivered during registration win too.
  const revision = notificationRevision;
  try {
    if (!await subscribeNotifications() || notificationsDisposed) return;
    const result = await invoke<NotificationSnapshot>(command, command === 'set_notifications_enabled' ? { enabled } : undefined);
    if (!notificationsDisposed && notificationRevision === revision) {
      notificationSnapshot = result;
      if (command === 'test_notification' && result.phase !== 'error') notificationNotice = result.message + ' · 测试通知已提交，不保证显示横幅；Windows 勿扰模式可能屏蔽。';
    }
  } catch (error) {
    if (!notificationsDisposed && notificationRevision === revision) notificationError = '通知操作未完成，可重试：' + String(error);
  } finally {
    notificationPending = false;
    if (!notificationsDisposed) renderNotifications();
  }
}

function formatBytes(bytes: number): string {
  const safe = Math.max(0, bytes);
  return safe < 1024 * 1024 ? (safe / 1024).toFixed(1) + ' KB' : (safe / (1024 * 1024)).toFixed(1) + ' MB';
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

function selectSettings(section: string, focus = false): void {
  if (!settingsView) return;
  const selected = settingsSections.find(item => item === section);
  if (!selected) return;
  settingsSection = selected;
  const index = settingsSections.indexOf(selected);
  element('settings-title').textContent = ['环境与目录', '系统通知', '软件更新', '诊断日志'][index] || '';
  element('settings-description').textContent = ['指定已有的 DSH 项目，查看本地运行配置。', '管理后台任务的系统提醒。', '检查并安装 Windows 启动器的新版本。', '查看本次启动和服务操作的脱敏记录。'][index] || '';
  for (const item of settingsSections) {
    element('settings-' + item).hidden = item !== selected;
    element('nav-' + item).dataset.active = String(item === selected);
    element('nav-' + item).setAttribute('aria-current', item === selected ? 'page' : 'false');
  }
  if (focus) element('settings-title').focus({ preventScroll: true });
}
function showUpdates(): void { selectSettings('updates'); }
function showLogs(): void { selectSettings('logs'); }
async function openSettings(): Promise<void> {
  if (settingsRequestPending) return;
  if (!native) { window.location.search = '?view=settings&section=environment'; return; }
  settingsRequestPending = true;
  render();
  try { await invoke('open_settings', { section: 'environment' }); }
  catch (error) { localError = '无法打开设置：' + String(error); }
  finally { settingsRequestPending = false; render(); }
}
async function perform(action: Action): Promise<void> {
  const button = buttons[action];
  if (!native || !button || button.disabled || pending || repositoryPending) return;
  pending = true; localError = ''; render();
  const revision = eventRevision;
  try {
    const result = await invoke<Snapshot>('perform_action', { action });
    if (eventRevision === revision) snapshot = result;
  } catch (error) { localError = '操作未完成：' + String(error); }
  finally { pending = false; render(); }
}
async function saveRepository(): Promise<void> {
  if (!native || saveRepositoryButton.disabled || pending || repositoryPending) return;
  repositoryPending = true;
  localError = '';
  render();
  const revision = eventRevision;
  try {
    const result = await invoke<Snapshot>('set_project_directory', { repository: repositoryInput.value.trim() });
    if (eventRevision === revision) snapshot = result;
    repositoryDirty = false;
  } catch (error) {
    localError = '目录保存或检测未完成：' + String(error);
  } finally {
    repositoryPending = false;
    render();
  }
}

function previewSnapshot(): Snapshot {
  const preview = parameters.get('preview');
  const checks = pendingEnvironment().checks.map(item => ({ ...item, status: 'passed' as EnvironmentCheck['status'], message: '检查通过' }));
  const ready = preview === 'ready';
  const failed = preview === 'error';
  if (failed) for (const item of checks) {
    if (item.id === 'repository') Object.assign(item, { status: 'error', message: '未找到配置的 DSH 项目。', hint: '请在设置中填写已有项目的 WSL 绝对路径。' });
    if (['node','dependencies','web_assets'].includes(item.id)) Object.assign(item, { status: 'skipped', message: '等待项目目录检查通过。' });
  }
  if (!settingsView && !failed && !ready) for (const item of checks) item.status = 'pending';
  return { state: failed ? 'error' : ready ? 'ready' : settingsView ? 'stopped' : 'unknown', phase: failed ? '等待处理环境问题' : ready ? '已就绪' : '检测运行环境', message: '', busy: !settingsView && !failed && !ready, managed: ready, origin:'http://127.0.0.1:3080', last_error:failed ? '运行环境尚未准备好。' : null, logs:['[预览] 此处仅展示脱敏启动记录，未操作实际服务。'], environment:{checks,repository:'/home/user/deepseek-harness'}, environment_checking:!settingsView && !failed && !ready, config_path:'%APPDATA%/io.local.dsh-wsl-desktop/config.json' };
}
async function initialize(): Promise<void> {
  if (!native) {
    connected = true;
    snapshot = previewSnapshot();
    element(settingsView ? 'settings-preview' : 'preview-note').textContent = '浏览器预览 · 不会操作本地服务';
    element(settingsView ? 'settings-preview' : 'preview-note').hidden = false;
    render(); return;
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
  try {
    unlistenShowSettings = await listen<string>('launcher-show-settings', event => selectSettings(event.payload, true));
  } catch (error) {
    localError = '无法订阅设置窗口请求：' + String(error);
  }
  const revision = eventRevision;
  try {
    const initial = await invoke<Snapshot>('get_snapshot');
    if (eventRevision === revision) snapshot = initial;
    connected = true;
  } catch (error) {
    if (!connected) {
      connected = true;
      snapshot = { ...snapshot, busy: false, environment_checking: false, state: 'error', phase: '读取状态失败', message: '未能获取本地服务状态，可重试启动或退出启动器。' };
    }
    localError = '无法获取服务状态：' + String(error);
  }
  render();
}

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
  // Available updates stay in Settings; never interrupt initialization.
  // Checking is safe alongside service startup. Never download without a user action.
  if (!settingsView && ['idle', 'up_to_date', 'error'].includes(updateSnapshot.phase)) {
    try { await invoke('check_update'); } catch { /* Updates must never block startup. */ }
  }
}

if (settingsView) {
  selectSettings(settingsSection);
  repositoryInput.addEventListener('input', () => { repositoryDirty = true; render(); });
  saveRepositoryButton.addEventListener('click', () => { void saveRepository(); });
  notificationsEnabled.addEventListener('change', () => { void performNotification('set_notifications_enabled', notificationsEnabled.checked); });
  testNotificationButton.addEventListener('click', () => { void performNotification('test_notification'); });
  checkUpdateButton.addEventListener('click', () => { void performUpdate('check_update'); });
  installUpdateButton.addEventListener('click', () => { void performUpdate('install_update'); });
  for (const section of settingsSections) element('nav-' + section).addEventListener('click', () => selectSettings(section));
} else element('open-settings').addEventListener('click', () => { void openSettings(); });
for (const action of actions) buttons[action]?.addEventListener('click', () => { void perform(action); });
window.addEventListener('beforeunload', () => {
  notificationsDisposed = true; unlistenNotifications?.(); unlistenNotifications = undefined;
  unlisten?.(); unlistenShowLogs?.(); unlistenShowSettings?.(); unlistenUpdates?.(); unlistenShowUpdates?.();
}, { once: true });
render();
void initialize();
void initializeUpdates();
if (settingsView) void performNotification('get_notification_snapshot');
