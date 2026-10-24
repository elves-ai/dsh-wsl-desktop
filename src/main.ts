import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import './style.css';
import { SpeechSettings } from './speech-settings';
import { SpeechResources } from './speech-resources';
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
  setup_required: boolean;
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
  notify_when_focused: boolean;
  phase: 'disabled' | 'connecting' | 'listening' | 'error';
  message: string;
}

interface PowerSnapshot {
  enabled: boolean;
  active: boolean;
  phase: 'disabled' | 'connecting' | 'idle' | 'active' | 'error';
  message: string;
}

interface PetSettingsSnapshot {
  visible: boolean;
  startup_visible: boolean;
  roaming_enabled: boolean;
  bubble_notifications: boolean;
  revision: number;
  message: string;
}
type PetSettingsPatch = Partial<Pick<PetSettingsSnapshot, 'startup_visible' | 'roaming_enabled' | 'bubble_notifications'>>;

type Action = 'check' | 'open' | 'start' | 'stop' | 'restart' | 'logs' | 'quit' | 'exit';
const native = isTauri();
const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('缺少应用挂载节点');

const parameters = new URL(window.location.href).searchParams;
const settingsView = parameters.get('view') === 'settings';
const settingsSections = ['environment', 'notifications', 'power', 'pet', 'updates', 'logs'] as const;
type SettingsSection = typeof settingsSections[number];
const initialSection = parameters.get('section') === 'speech' ? 'pet' : parameters.get('section');
let settingsSection: SettingsSection = settingsSections.find(section => section === initialSection) || 'environment';
const mark = `<img src="${appIconUrl}" width="36" height="36" alt="" />`;
// Templates contain only developer-owned markup. All native values use textContent/value.
app.innerHTML = settingsView ? `
<main class="settings-shell" id="settings-shell">
  <aside class="settings-sidebar"><button class="settings-back" id="settings-back" type="button" aria-label="返回"><svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="m11.5 4.5-5.5 5.5 5.5 5.5M6 10h10" /></svg><span>返回</span></button><div class="settings-brand"><span class="small-mark">${mark}</span><span>DSH<small>应用设置</small></span></div><nav aria-label="设置分类">${settingsSections.map((section,index) => `<button class="settings-nav" id="nav-${section}" type="button"><span class="nav-index" aria-hidden="true">0${index+1}</span>${['环境与目录','系统通知','电源管理','桌面宠物','软件更新','诊断日志'][index]}</button>`).join('')}</nav><p class="settings-sidebar-note">设置保存在本机<br>不会上传到维护者</p></aside>
  <div class="settings-content">
    <header class="settings-heading"><p class="eyebrow">应用设置</p><h1 id="settings-title" tabindex="-1">环境与目录</h1><p id="settings-description">指定已有的 DSH 项目，查看本地运行配置。</p></header>
    <div class="error-notice" id="error-notice" role="alert" hidden></div>
    <section id="settings-environment" aria-label="环境与目录">
      <div class="setting-group"><h2>DSH 项目目录</h2><p id="repository-help">填写 WSL 内的绝对路径，不是 Windows 路径。</p><label class="visually-hidden" for="repository-input">DSH 项目目录</label><input id="repository-input" type="text" placeholder="/home/用户名/deepseek-harness" autocomplete="off" spellcheck="false" maxlength="4096" aria-describedby="repository-help repository-notice" disabled><p class="setting-help" id="repository-notice" role="status" aria-live="polite">正在读取配置。</p><button class="button primary" id="save-repository" type="button" disabled>保存并重新检测</button></div>
      <div class="setting-group"><div class="group-heading"><h2>运行环境</h2><span id="status-label" class="muted">读取中</span></div><dl class="connection-info"><div><dt>服务地址</dt><dd><code id="origin">尚未连接</code></dd></div><div><dt>进程归属</dt><dd id="ownership">等待检查</dd></div><div><dt>启动配置</dt><dd id="config-location">尚未读取</dd></div></dl><p class="setting-help" id="ownership-hint">仅管理由启动器托管的服务。</p><button class="button secondary" id="check" type="button" disabled>重新检测并进入 DSH</button></div>
      <p class="setting-help">不自动安装软件、克隆项目或安装依赖。修改目录前，请通过托盘右键菜单停止服务。</p>
    </section>
    <section id="settings-notifications" aria-label="系统通知" hidden><div class="setting-group"><div class="toggle-row"><div><h2>任务通知</h2><p>提醒任务结束、失败，以及需要你选择、回答或确认计划。默认仅在 DSH 不在前台时通知。</p></div><label class="switch"><input id="notifications-enabled" type="checkbox" aria-label="启用系统通知" disabled><span></span></label></div><div class="toggle-row"><div><h2>窗口聚焦时也通知</h2><p id="notifications-focused-help">同时用于桌宠气泡和系统通知。开启后，DSH 窗口聚焦时也按当前通知渠道提醒；可在系统通知关闭时配置，不会开启系统通知。</p></div><label class="switch"><input id="notifications-when-focused" type="checkbox" aria-label="窗口聚焦时也通知" aria-describedby="notifications-focused-help" disabled><span></span></label></div><p id="notification-message" class="setting-help" role="status" aria-live="polite">正在读取通知设置。</p><button class="button secondary" id="test-notification" type="button" disabled>发送测试通知</button></div><p class="setting-help">默认关闭。通知显示会话名称（未命名时显示短编号），不显示对话正文和错误详情。Windows 通知中心可能保留名称；请勿在名称中放入敏感信息。点击任务通知可定位会话（需配套 Harness 前端）；仅启动器运行中有效。本轮结束不代表整个长任务完成。退出启动器后不再提醒。</p><p class="setting-help">若未看到横幅，请检查 Windows 通知权限及勿扰模式。</p></section>
    <section id="settings-power" aria-label="电源管理" hidden><div class="setting-group"><div class="toggle-row"><div><h2>任务期间防休眠</h2><p id="power-help">默认启用。任务运行期间，仅防止系统自动休眠，屏幕仍可熄灭。</p></div><label class="switch"><input id="power-enabled" type="checkbox" aria-label="任务期间防休眠" aria-describedby="power-help power-message" checked disabled><span></span></label></div><p id="power-active" class="setting-help" role="status" aria-live="polite">正在读取保护状态。</p><p id="power-message" class="setting-help" role="status" aria-live="polite">正在读取电源设置。</p><button class="button secondary" id="power-refresh" type="button" disabled>重新检测</button></div><p class="setting-help">最小化到托盘后继续保护；退出启动器后不再保护。不阻止手动睡眠或合盖休眠。</p></section>
    <section id="settings-pet" aria-label="桌面宠物" hidden>
      <div class="setting-group">
        <div class="toggle-row"><div><h2>显示桌面宠物</h2><p id="pet-visible-help">立即显示或隐藏桌面宠物，不会停止 DSH 任务。</p></div><label class="switch"><input id="pet-visible" type="checkbox" aria-label="显示桌面宠物" aria-describedby="pet-visible-help pet-message" disabled><span></span></label></div>
        <div class="toggle-row"><div><h2>启动时显示</h2><p id="pet-startup-help">保存在本机，下次启动生效；不改变当前显示状态。</p></div><label class="switch"><input id="pet-startup-visible" type="checkbox" aria-label="启动时显示" aria-describedby="pet-startup-help pet-message" disabled><span></span></label></div>
        <div class="toggle-row"><div><h2>允许漫游</h2><p id="pet-roaming-help">保存在本机，即时生效。关闭后停止随机漫游，仍可拖拽、抛掷和点播动作。</p></div><label class="switch"><input id="pet-roaming-enabled" type="checkbox" aria-label="允许漫游" aria-describedby="pet-roaming-help pet-message" disabled><span></span></label></div>
        <div class="toggle-row"><div><h2>气泡通知</h2><p id="pet-bubble-help">任务完成、失败时显示摘要；需要回答、确认计划或授权时，可直接在气泡中选择、输入、允许一次或拒绝。待处理请求可手动收起，不会自动授权或取消。</p><p id="pet-bubble-policy" class="setting-help">独立于系统通知开关。桌宠显示时仅用气泡提醒，不发送 Windows 通知；关闭气泡则静默，不回退系统通知。桌宠隐藏时按系统通知开关提醒，不补历史气泡。普通任务提醒前台静默，沿用系统通知中的“窗口聚焦时也通知”选项；待答和授权交互会保留，直到处理或手动收起。</p></div><label class="switch"><input id="pet-bubble-notifications" type="checkbox" aria-label="气泡通知" aria-describedby="pet-bubble-help pet-bubble-policy pet-message" disabled><span></span></label></div>
        <p id="pet-message" class="setting-help" role="status" aria-live="polite">正在读取桌面宠物设置。</p><button class="button secondary" id="pet-refresh" type="button" disabled>重新读取</button>
      </div>
      <div id="settings-speech" role="region" aria-label="宠物语音设置"></div>
      <p class="setting-help pet-source">来源：<a href="https://github.com/PC2005-cloud/dsh-pet" target="_blank" rel="noopener noreferrer">PC2005-cloud/dsh-pet</a>。动画素材仅限非商业使用。</p>
    </section>
    <section id="settings-updates" aria-label="软件更新" hidden><div class="setting-group"><div class="group-heading"><h2>DSH WSL Desktop</h2><span id="update-current-version" class="muted">正在读取版本</span></div><p id="update-new-version" hidden></p><p id="update-message" role="status" aria-live="polite" tabindex="-1">正在读取更新状态。</p><pre id="update-notes" aria-label="更新说明" hidden></pre><div id="update-progress-row" hidden><progress id="update-progress" aria-label="更新下载进度"></progress><span id="update-progress-label"></span></div><div class="setting-actions"><button class="button secondary" id="check-update" type="button" disabled>检查更新</button><button class="button primary" id="install-update" type="button" hidden disabled>下载并安装</button></div></div><p class="setting-help">仅更新 Windows 启动器，不会更新或停止 WSL 中的 DSH。安装前需要你确认。</p></section>
    <section id="settings-logs" aria-label="诊断日志" hidden><div class="group-heading"><h2>启动与服务操作</h2><button class="text-button" id="logs" type="button" disabled>刷新</button></div><p class="setting-help">只显示启动器的脱敏记录，不包含 DSH 对话内容。</p><pre id="log-output" tabindex="0" aria-label="脱敏操作日志">暂无操作日志</pre></section>
    <p class="settings-preview" id="settings-preview" hidden>浏览器预览 · 不会连接或操作本地服务</p>
  </div>
</main>
` : `
<main class="startup" id="startup-shell">
  <header class="startup-brand"><div class="app-mark">${mark}</div><span>DeepSeek Harness<small>WSL Desktop</small></span></header>
  <section class="startup-content" id="startup-content" aria-labelledby="status-title">
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
  <section class="setup-content" id="setup-panel" aria-labelledby="setup-title" hidden>
    <div class="startup-heading"><span class="eyebrow">首次配置</span><h1 id="setup-title">连接已有的 WSL 工作空间</h1><p class="setting-help">准备好 WSL 发行版、Python 3.9+、ss 和 Node.js，以及已安装依赖、已构建的 Harness 项目。</p></div>
    <p class="setup-scope">仅部署内置版本 1.0.0 管理器并生成配置；不会安装依赖、克隆或构建项目，也不会修改旧数据。点击“完成配置并启动”前不会写入配置。</p>
    <form id="setup-form" novalidate>
      <div class="setup-field"><label for="setup-distribution">WSL 发行版</label><div class="setup-inline"><select id="setup-distribution" aria-describedby="setup-distribution-status" disabled><option value="">请选择发行版</option></select><button class="button secondary" id="setup-detect-distributions" type="button" disabled>重新检测</button></div><p class="setting-help" id="setup-distribution-status" role="status" aria-live="polite">等待检测发行版。</p></div>
      <div class="setup-field"><label for="setup-user">Linux 用户</label><div class="setup-inline"><input id="setup-user" type="text" placeholder="留空发现发行版默认用户" autocomplete="off" spellcheck="false" maxlength="256" aria-describedby="setup-identity-status" disabled><button class="button secondary" id="setup-detect-identity" type="button" disabled>发现用户与 Node</button></div><p class="setting-help" id="setup-identity-status" role="status" aria-live="polite">自动发现默认用户，也可填写其他用户名后重新发现。</p></div>
      <div class="setup-field"><label for="setup-repository">Harness 项目目录</label><input id="setup-repository" type="text" placeholder="/home/用户名/deepseek-harness" autocomplete="off" spellcheck="false" maxlength="4096" aria-describedby="setup-repository-help" disabled><p class="setting-help" id="setup-repository-help">填写已准备好的 Harness WSL 绝对目录，不是 Windows 路径。</p></div>
      <div class="setup-field"><label for="setup-node">Node.js 绝对路径</label><input id="setup-node" type="text" placeholder="/usr/bin/node" autocomplete="off" spellcheck="false" maxlength="4096" aria-describedby="setup-node-help" disabled><p class="setting-help" id="setup-node-help">自动发现后可修改；未发现时请手动填写。使用 nvm 时，请填写具体版本的绝对路径，例如 /home/用户名/.nvm/versions/node/v24.0.0/bin/node。</p></div>
      <details class="setup-advanced" id="setup-advanced"><summary>高级配置</summary><div class="setup-field"><label for="setup-port">本地服务端口</label><input id="setup-port" type="number" value="3080" min="1" max="65535" step="1" aria-describedby="setup-port-help" disabled><p class="setting-help" id="setup-port-help">默认 3080。如提示端口冲突，可修改后重试。</p></div></details>
      <div class="error-notice" id="setup-error" role="alert" hidden></div>
      <p class="setting-help" id="setup-submit-status" role="status" aria-live="polite"></p>
      <button class="button primary" id="setup-submit" type="submit" disabled>完成配置并启动</button>
    </form>
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
let snapshot: Snapshot = { setup_required: false, state: 'unknown', phase: '连接启动器', message: '正在与本地启动器建立连接，请稍候。', busy: true, managed: false, origin: '', last_error: null, logs: [], environment: pendingEnvironment(), environment_checking: true, config_path: '' };
let pending = false;
let repositoryPending = false;
let repositoryDirty = false;
let settingsRequestPending = false;
let settingsReturnPending = false;
let settingsDisposed = false;
let settingsReturnError = '';
let settingsReadyError = '';
let settingsSectionRevision = 0;
let settingsPageRevealed = !native;
const speechSettings = settingsView ? new SpeechSettings(document.getElementById('settings-speech')!, window, native, { invoke, listen },
  (root, onSelect, getDraft) => new SpeechResources(root, window, native, { invoke, listen }, onSelect, getDraft)) : undefined;
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
const notificationsWhenFocused = document.getElementById('notifications-when-focused') as HTMLInputElement;
const testNotificationButton = document.getElementById('test-notification') as HTMLButtonElement;
let notificationSnapshot: NotificationSnapshot = { enabled: false, notify_when_focused: false, phase: 'disabled', message: '未启用系统通知。' };
let notificationPending = false;
let notificationRevision = 0;
let notificationError = '';
let notificationNotice = '';
let unlistenNotifications: UnlistenFn | undefined;
let notificationsDisposed = false;
const powerEnabled = document.getElementById('power-enabled') as HTMLInputElement;
const powerRefreshButton = document.getElementById('power-refresh') as HTMLButtonElement;
let powerSnapshot: PowerSnapshot = { enabled: true, active: false, phase: 'connecting', message: '正在读取电源设置。' };
let powerLoaded = false;
let powerPending = false;
let powerRevision = 0;
let powerError = '';
let unlistenPower: UnlistenFn | undefined;
let powerDisposed = false;
const petVisible = document.getElementById('pet-visible') as HTMLInputElement;
const petStartupVisible = document.getElementById('pet-startup-visible') as HTMLInputElement;
const petRoamingEnabled = document.getElementById('pet-roaming-enabled') as HTMLInputElement;
const petBubbleNotifications = document.getElementById('pet-bubble-notifications') as HTMLInputElement;
const petRefreshButton = document.getElementById('pet-refresh') as HTMLButtonElement;
let petSnapshot: PetSettingsSnapshot | undefined;
let petPending = false;
let petDisposed = false;
let petError = '';
let unlistenPet: UnlistenFn | undefined;

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
interface SetupIdentity { linux_user: string; home: string; node: string }
let setupInitialized = false;
let setupDisposed = false;
let setupListing = false;
let setupDiscovering = false;
let setupSubmitting = false;
let setupStateUnknown = false;
let setupIdentityRevision = 0;
let setupNodeRevision = 0;
let setupError = '';
const setupInput = (name: string) => element<HTMLInputElement>('setup-' + name);
const setupDistribution = () => element<HTMLSelectElement>('setup-distribution');
const setupActive = () => !settingsView && !setupDisposed && snapshot.setup_required;
const absoluteLinuxPath = (value: string) => value.startsWith('/') && !value.startsWith('//') && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
function setupValidation(): string {
  if (!setupDistribution().value) return '请选择 WSL 发行版。';
  const user = setupInput('user').value.trim();
  if (!user || user.startsWith('-') || /[\s\u0000-\u001f\u007f]/.test(user)) return '请先发现默认用户，或填写有效的 Linux 用户名。';
  if (!absoluteLinuxPath(setupInput('repository').value.trim())) return '请填写 Harness 的 WSL 绝对目录。';
  if (!absoluteLinuxPath(setupInput('node').value.trim())) return '请填写 Node.js 的 WSL 绝对路径；可手动填写 nvm 中的具体路径。';
  const port = Number(setupInput('port').value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '端口必须是 1–65535 的整数。';
  return '';
}
function renderSetup(): void {
  if (settingsView) return;
  const active = setupActive();
  element('setup-panel').hidden = !active;
  element('startup-content').hidden = active;
  if (!active) return;
  element('startup-shell').dataset.state = 'setup';
  element('phase').textContent = setupSubmitting ? setupStateUnknown ? '正在确认配置状态' : '正在配置并启动' : '首次配置';
  const locked = !native || !connected || setupSubmitting || snapshot.busy || updateLocksService();
  for (const name of ['user', 'repository', 'node', 'port']) setupInput(name).disabled = locked;
  setupDistribution().disabled = locked || setupListing;
  element<HTMLButtonElement>('setup-detect-distributions').disabled = setupStateUnknown ? !native || !connected || setupSubmitting || setupListing : locked || setupListing;
  element('setup-detect-distributions').textContent = setupStateUnknown ? '重新读取状态' : '重新检测';
  element<HTMLButtonElement>('setup-detect-identity').disabled = locked || setupListing || setupDiscovering || !setupDistribution().value;
  element<HTMLButtonElement>('setup-submit').disabled = locked || setupListing || setupDiscovering || setupStateUnknown || Boolean(setupValidation());
  element('setup-form').setAttribute('aria-busy', String(setupSubmitting));
  element('setup-error').textContent = redact(setupError);
  element('setup-error').hidden = !setupError;
  element('setup-submit-status').textContent = !native ? '浏览器预览 · 不会发现环境或写入配置。' : setupStateUnknown ? setupSubmitting ? '正在只读确认配置状态，不会重复提交…' : '配置可能已保存，请先点击“重新读取状态”确认；确认前不会重复提交。' : setupSubmitting ? '正在检查环境、写入配置并启动，请稍候…' : setupValidation() || '检查以上信息后，点击下方按钮保存并启动。';
  if (native && connected && !setupInitialized) { setupInitialized = true; void detectSetupDistributions(); }
}
async function detectSetupDistributions(): Promise<void> {
  if (!native || !connected || !setupActive() || setupListing || setupSubmitting) return;
  setupListing = true;
  setupError = '';
  element('setup-distribution-status').textContent = '正在检测 WSL 发行版…';
  render();
  try {
    const distributions = await invoke<string[]>('setup_distributions');
    if (!setupActive()) return;
    const previous = setupDistribution().value;
    const available = [...new Set(distributions)];
    const choices = [document.createElement('option'), ...available.map(distribution => {
      const option = document.createElement('option');
      option.value = distribution;
      option.textContent = distribution;
      return option;
    })];
    choices[0]!.value = '';
    choices[0]!.textContent = available.length ? '请选择发行版' : '未发现发行版';
    setupDistribution().replaceChildren(...choices);
    setupDistribution().value = available.includes(previous) ? previous : available[0] || '';
    element('setup-distribution-status').textContent = available.length ? '已发现 ' + available.length + ' 个发行版。' : '未发现 WSL 发行版，请先准备好 WSL 后重新检测。';
    if (setupDistribution().value !== previous) changeSetupDistribution();
  } catch (error) {
    if (setupActive()) {
      setupError = '发行版检测失败，可重新检测：' + String(error);
      element('setup-distribution-status').textContent = '检测未完成，已保留现有选择。';
    }
  } finally { setupListing = false; if (!setupDisposed) render(); }
}
function changeSetupDistribution(): void {
  if (!setupActive() || setupSubmitting) return;
  setupIdentityRevision += 1;
  setupDiscovering = false;
  setupInput('user').value = '';
  setupInput('node').value = '';
  setupNodeRevision += 1;
  setupError = '';
  element('setup-identity-status').textContent = '等待发现所选发行版的默认用户。';
  if (setupDistribution().value) void detectSetupIdentity();
  render();
}
async function detectSetupIdentity(): Promise<void> {
  if (!native || !connected || !setupActive() || setupSubmitting || !setupDistribution().value) return;
  const revision = ++setupIdentityRevision;
  const nodeRevision = setupNodeRevision;
  const distribution = setupDistribution().value;
  const linuxUser = setupInput('user').value.trim();
  setupDiscovering = true;
  setupError = '';
  element('setup-identity-status').textContent = '正在发现用户、主目录和 Node.js…';
  render();
  try {
    const identity = await invoke<SetupIdentity>('setup_identity', { distribution, linuxUser });
    if (!setupActive() || revision !== setupIdentityRevision) return;
    setupInput('user').value = identity.linux_user;
    if (nodeRevision === setupNodeRevision) setupInput('node').value = identity.node;
    element('setup-identity-status').textContent = '用户：' + identity.linux_user + ' · 主目录：' + identity.home + (identity.node ? ' · 已发现 Node.js，可手动修改。' : ' · 未发现 Node.js，请手动填写绝对路径（支持 nvm）。');
  } catch (error) {
    if (setupActive() && revision === setupIdentityRevision) {
      setupError = '用户或 Node.js 发现失败，可重试或手动填写：' + String(error);
      element('setup-identity-status').textContent = '发现未完成，已保留表单。';
    }
  } finally {
    if (revision === setupIdentityRevision) { setupDiscovering = false; if (!setupDisposed) render(); }
  }
}
// Setup may have committed before service startup failed. Reconcile without writing again.
async function readSetupSnapshot(revision: number, retry = false): Promise<void> {
  try {
    const result = await invoke<Snapshot>('get_snapshot');
    if (!setupDisposed && eventRevision === revision) {
      // A confirmed commit must not regress to setup, even if a read is stale.
      if (snapshot.setup_required || !result.setup_required) snapshot = result;
      if (retry) setupError = snapshot.setup_required ? '已确认尚未完成配置，表单已保留，可修改后重试。' : '';
      setupStateUnknown = false;
      localError = '';
    }
  } catch (error) {
    if (!setupDisposed && eventRevision === revision && snapshot.setup_required) {
      setupStateUnknown = true;
      setupError = '配置可能已保存，但状态读取失败。请点击“重新读取状态”确认，不要重复提交：' + String(error);
    }
  }
}
async function retrySetupSnapshot(): Promise<void> {
  if (!native || !connected || !setupActive() || setupSubmitting || setupListing || !setupStateUnknown) return;
  setupSubmitting = true;
  const revision = eventRevision;
  render();
  try { await readSetupSnapshot(revision, true); }
  finally { setupSubmitting = false; if (!setupDisposed) render(); }
}
async function completeSetup(): Promise<void> {
  if (!native || !connected || !setupActive() || setupSubmitting || element<HTMLButtonElement>('setup-submit').disabled) return;
  const validation = setupValidation();
  if (validation) { setupError = validation; render(); return; }
  const request = { distribution: setupDistribution().value, linux_user: setupInput('user').value.trim(), repository: setupInput('repository').value.trim(), node: setupInput('node').value.trim(), port: Number(setupInput('port').value) };
  setupSubmitting = true;
  setupError = '';
  const revision = eventRevision;
  render();
  try {
    const result = await invoke<Snapshot>('complete_setup', { request });
    if (!setupDisposed && (eventRevision === revision || snapshot.setup_required)) snapshot = result;
    if (result.setup_required) setupError = '配置尚未完成，请检查信息后重试。';
  } catch (error) {
    if (!setupDisposed) {
      setupError = '配置或启动未完成，已保留表单，可修改后重试：' + String(error);
      setupStateUnknown = snapshot.setup_required;
      render();
      await readSetupSnapshot(eventRevision);
    }
  } finally { setupSubmitting = false; if (!setupDisposed) render(); }
}
function render(): void {
  const busy = snapshot.busy || pending || repositoryPending || setupSubmitting;
  const disabled = !native || !connected || busy || updateLocksService();
  const passed = environmentPassed();
  const error = redact(settingsReturnError || settingsReadyError || localError || snapshot.last_error || '');
  if (settingsView) element<HTMLButtonElement>('settings-back').disabled = settingsReturnPending;
  if (settingsView) renderSettings(disabled, passed, error);
  else { renderStartup(disabled, passed, busy, error); renderSetup(); }
  if (buttons.check) buttons.check.disabled = disabled || snapshot.setup_required;
  if (buttons.open) buttons.open.disabled = disabled || snapshot.setup_required || !passed;
  if (buttons.logs) buttons.logs.disabled = disabled;
  renderUpdate();
  renderNotifications();
  renderPower();
  renderPetSettings();
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
  element<HTMLButtonElement>('open-settings').disabled = settingsRequestPending || setupSubmitting;
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
  notificationsWhenFocused.checked = state.notify_when_focused;
  notificationsWhenFocused.disabled = notificationsEnabled.disabled;
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

async function performNotification(command: 'get_notification_snapshot' | 'set_notifications_enabled' | 'test_notification', enabled?: boolean, notifyWhenFocused?: boolean): Promise<void> {
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
    const result = await invoke<NotificationSnapshot>(command, command === 'set_notifications_enabled' ? { enabled, ...(notifyWhenFocused === undefined ? {} : { notifyWhenFocused }) } : undefined);
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

function renderPower(): void {
  if (!settingsView) return;
  const state = powerSnapshot;
  const labels = { disabled: '未启用', connecting: '连接中', idle: '等待任务', active: '保护中', error: '电源管理异常' };
  powerEnabled.checked = state.enabled;
  // Never write the optimistic default back before a real snapshot/event and listener are ready.
  powerEnabled.disabled = !native || !powerLoaded || !unlistenPower || powerPending || powerDisposed;
  powerRefreshButton.disabled = !native || powerPending || powerDisposed;
  const active = element('power-active');
  active.dataset.active = powerLoaded ? String(state.active) : 'unknown';
  active.textContent = !native ? '浏览器预览 · 未提供实际休眠保护' : !powerLoaded ? '当前保护状态未知' : state.active ? '当前正在防止系统自动休眠' : '当前未在防止系统自动休眠';
  const message = element('power-message');
  message.dataset.error = String(Boolean(powerError) || state.phase === 'error');
  message.dataset.phase = state.phase;
  message.textContent = !native ? '浏览器预览不连接电源管理服务，也不会更改本机电源设置。' : redact(powerError || labels[state.phase] + ' · ' + state.message);
}

async function subscribePower(): Promise<boolean> {
  if (powerDisposed) return false;
  if (unlistenPower) return true;
  const stop = await listen<PowerSnapshot>('launcher-power-state', event => {
    if (powerDisposed) return;
    powerRevision += 1;
    powerSnapshot = event.payload;
    powerLoaded = true;
    powerError = '';
    renderPower();
  });
  if (powerDisposed) { stop(); return false; }
  unlistenPower = stop;
  return true;
}

async function performPower(command: 'get_power_snapshot' | 'set_power_enabled', enabled?: boolean): Promise<void> {
  if (!settingsView || !native || powerDisposed || powerPending || (command === 'set_power_enabled' && powerEnabled.disabled)) {
    renderPower();
    return;
  }
  powerPending = true;
  powerError = '';
  renderPower();
  // Capture before registration: even an event received inside listen() wins over this reply.
  const revision = powerRevision;
  try {
    if (!await subscribePower() || powerDisposed) return;
    const result = await invoke<PowerSnapshot>(command, command === 'set_power_enabled' ? { enabled } : undefined);
    if (!powerDisposed && powerRevision === revision) {
      powerSnapshot = result;
      powerLoaded = true;
    }
  } catch (error) {
    if (!powerDisposed && (!unlistenPower || powerRevision === revision)) {
      powerError = (!unlistenPower ? '无法监听电源状态，请重试检测：' : command === 'get_power_snapshot' ? '无法读取电源设置，请重试检测：' : '电源设置保存失败，可重试：') + String(error);
    }
  } finally {
    powerPending = false;
    if (!powerDisposed) renderPower();
  }
}

function renderPetSettings(): void {
  if (!settingsView) return;
  petVisible.checked = petSnapshot?.visible ?? false;
  petStartupVisible.checked = petSnapshot?.startup_visible ?? false;
  petRoamingEnabled.checked = petSnapshot?.roaming_enabled ?? false;
  petBubbleNotifications.checked = petSnapshot?.bubble_notifications ?? false;
  // Window/config controls are independent of DSH service readiness and task activity.
  const disabled = !native || !petSnapshot || !unlistenPet || petPending || petDisposed;
  petVisible.disabled = petStartupVisible.disabled = petRoamingEnabled.disabled = petBubbleNotifications.disabled = disabled;
  petRefreshButton.disabled = !native || petPending || petDisposed;
  petRefreshButton.textContent = petPending ? '读取或保存中…' : '重新读取';
  const message = element('pet-message');
  message.dataset.error = String(Boolean(petError));
  message.textContent = !native ? '浏览器预览不读取或更改桌面宠物设置。' : redact(petError || petSnapshot?.message || '正在读取桌面宠物设置。');
}

function isPetSettingsSnapshot(state: unknown): state is PetSettingsSnapshot {
  if (!state || typeof state !== 'object') return false;
  const value = state as Record<string, unknown>;
  return ['visible', 'startup_visible', 'roaming_enabled', 'bubble_notifications'].every(key => typeof value[key] === 'boolean')
    && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0
    && typeof value.message === 'string';
}

function acceptPetSettings(state: unknown): boolean {
  // Native revisions order both events and replies, including events during listen registration.
  if (petDisposed || !isPetSettingsSnapshot(state) || (petSnapshot && state.revision <= petSnapshot.revision)) return false;
  petSnapshot = state;
  return true;
}

async function subscribePetSettings(): Promise<boolean> {
  if (petDisposed) return false;
  if (unlistenPet) return true;
  const stop = await listen<PetSettingsSnapshot>('pet-settings-state', event => {
    if (!acceptPetSettings(event.payload)) return;
    petError = '';
    renderPetSettings();
  });
  if (petDisposed) { stop(); return false; }
  unlistenPet = stop;
  return true;
}

async function performPetSettings(command: 'get_pet_settings' | 'set_pet_settings' | 'set_pet_visibility', args?: { patch: PetSettingsPatch } | { visible: boolean }): Promise<void> {
  if (!settingsView || !native || petDisposed) return;
  if (petPending || (command !== 'get_pet_settings' && petVisible.disabled)) {
    renderPetSettings();
    return;
  }
  petPending = true;
  petError = '';
  renderPetSettings(); // Restore actual values instead of optimistically committing a checkbox.
  const revision = petSnapshot?.revision;
  try {
    if (!await subscribePetSettings() || petDisposed) return;
    const result = await invoke<unknown>(command, args);
    if (!isPetSettingsSnapshot(result)) throw new Error('桌面宠物设置格式无效。');
    acceptPetSettings(result);
  } catch (error) {
    if (petDisposed) return;
    if (command !== 'get_pet_settings' || petSnapshot?.revision === revision) {
      petError = (command === 'get_pet_settings' ? '无法读取桌面宠物设置，可重新读取：' : '桌面宠物操作未完成，可重新读取或重试：') + String(error);
    }
    // A failed write may have reached native code. Reconcile without guessing its outcome.
    if (command !== 'get_pet_settings' && unlistenPet) {
      try { acceptPetSettings(await invoke<PetSettingsSnapshot>('get_pet_settings')); }
      catch { /* Keep the last confirmed state and the explicit retry affordance. */ }
    }
  } finally {
    petPending = false;
    if (!petDisposed) renderPetSettings();
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
  const selected = settingsSections.find(item => item === (section === 'speech' ? 'pet' : section));
  if (!selected) return;
  settingsSection = selected;
  const index = settingsSections.indexOf(selected);
  element('settings-title').textContent = ['环境与目录', '系统通知', '电源管理', '桌面宠物', '软件更新', '诊断日志'][index] || '';
  element('settings-description').textContent = ['指定已有的 DSH 项目，查看本地运行配置。', '管理后台任务的系统提醒。', '管理任务期间的系统自动休眠保护。', '管理桌面宠物的显示、随机漫游与本地语音。', '检查并安装 Windows 启动器的新版本。', '查看本次启动和服务操作的脱敏记录。'][index] || '';
  for (const item of settingsSections) {
    element('settings-' + item).hidden = item !== selected;
    element('nav-' + item).dataset.active = String(item === selected);
    element('nav-' + item).setAttribute('aria-current', item === selected ? 'page' : 'false');
  }
  speechSettings?.setVisible(selected === 'pet' && !document.hidden && settingsPageRevealed);
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
async function readySettingsPage(initialization: Promise<void>[]): Promise<void> {
  if (!native || !settingsView) return;
  try {
    // The parent reveals this view only after every settings listener has been registered.
    await Promise.all(initialization);
    if (settingsDisposed) return;
    const revision = settingsSectionRevision;
    const section = await invoke<string>('settings_page_ready');
    if (!settingsDisposed) {
      settingsPageRevealed = true;
      selectSettings(settingsSectionRevision === revision ? section : settingsSection);
    }
  } catch {
    if (!settingsDisposed) {
      settingsReadyError = '设置页面准备失败，请重试打开设置。';
      render();
    }
  }
}
async function returnFromSettings(): Promise<void> {
  if (!settingsView || settingsDisposed || settingsReturnPending) return;
  // Preview has no retained native view: use a fixed local startup route, never history or URL input.
  if (!native) { window.location.search = ''; return; }
  settingsReturnPending = true;
  settingsReturnError = '';
  render();
  try {
    // Rust alone chooses which retained parent view to reveal; no URL or window label crosses IPC.
    await invoke<void>('return_from_settings');
  } catch {
    if (!settingsDisposed) settingsReturnError = '返回未完成，请重试。';
  } finally {
    settingsReturnPending = false;
    if (!settingsDisposed) render();
  }
}
async function perform(action: Action): Promise<void> {
  const button = buttons[action];
  if (!native || !button || button.disabled || pending || repositoryPending || setupSubmitting) return;
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
  return { setup_required: preview === 'setup', state: failed ? 'error' : ready ? 'ready' : settingsView ? 'stopped' : 'unknown', phase: failed ? '等待处理环境问题' : ready ? '已就绪' : '检测运行环境', message: '', busy: preview !== 'setup' && !settingsView && !failed && !ready, managed: ready, origin:'http://127.0.0.1:3080', last_error:failed ? '运行环境尚未准备好。' : null, logs:['[预览] 此处仅展示脱敏启动记录，未操作实际服务。'], environment:{checks,repository:'/home/user/deepseek-harness'}, environment_checking:!settingsView && !failed && !ready, config_path:'%APPDATA%/io.local.dsh-wsl-desktop/config.json' };
}
async function initialize(): Promise<void> {
  if (!native) {
    connected = true;
    snapshot = previewSnapshot();
    if (setupActive()) {
      const option = document.createElement('option');
      option.value = 'Ubuntu'; option.textContent = 'Ubuntu';
      setupDistribution().replaceChildren(option); setupDistribution().value = 'Ubuntu';
      setupInput('user').value = 'user';
      setupInput('repository').value = '/home/user/deepseek-harness';
      setupInput('node').value = '/home/user/.nvm/versions/node/v24.0.0/bin/node';
      element('setup-distribution-status').textContent = '预览示例 · 不检测实际发行版。';
      element('setup-identity-status').textContent = '预览示例 · 用户 user，主目录 /home/user。';
    }
    element(settingsView ? 'settings-preview' : 'preview-note').textContent = '浏览器预览 · 不会操作本地服务';
    element(settingsView ? 'settings-preview' : 'preview-note').hidden = false;
    render(); return;
  }
  try {
    // Subscribe first so startup transitions cannot be lost during the first query.
    unlisten = await listen<Snapshot>('launcher-state', event => {
      eventRevision += 1;
      snapshot = event.payload;
      setupStateUnknown = false;
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
    unlistenShowSettings = await listen<string>('launcher-show-settings', event => {
      settingsSectionRevision += 1;
      selectSettings(event.payload, true);
    });
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
  element('settings-back').addEventListener('click', () => { void returnFromSettings(); });
  repositoryInput.addEventListener('input', () => { repositoryDirty = true; render(); });
  saveRepositoryButton.addEventListener('click', () => { void saveRepository(); });
  notificationsEnabled.addEventListener('change', () => { void performNotification('set_notifications_enabled', notificationsEnabled.checked); });
  notificationsWhenFocused.addEventListener('change', () => {
    if (notificationsWhenFocused.disabled) { renderNotifications(); return; }
    void performNotification('set_notifications_enabled', notificationSnapshot.enabled, notificationsWhenFocused.checked);
  });
  powerEnabled.addEventListener('change', () => { void performPower('set_power_enabled', powerEnabled.checked); });
  powerRefreshButton.addEventListener('click', () => { void performPower('get_power_snapshot'); });
  petVisible.addEventListener('change', () => { void performPetSettings('set_pet_visibility', { visible: petVisible.checked }); });
  petStartupVisible.addEventListener('change', () => { void performPetSettings('set_pet_settings', { patch: { startup_visible: petStartupVisible.checked } }); });
  petRoamingEnabled.addEventListener('change', () => { void performPetSettings('set_pet_settings', { patch: { roaming_enabled: petRoamingEnabled.checked } }); });
  petBubbleNotifications.addEventListener('change', () => { void performPetSettings('set_pet_settings', { patch: { bubble_notifications: petBubbleNotifications.checked } }); });
  petRefreshButton.addEventListener('click', () => { void performPetSettings('get_pet_settings'); });
  testNotificationButton.addEventListener('click', () => { void performNotification('test_notification'); });
  checkUpdateButton.addEventListener('click', () => { void performUpdate('check_update'); });
  installUpdateButton.addEventListener('click', () => { void performUpdate('install_update'); });
  for (const section of settingsSections) element('nav-' + section).addEventListener('click', () => selectSettings(section));
} else {
  element('open-settings').addEventListener('click', () => { if (!setupSubmitting) void openSettings(); });
  setupInput('port').value = '3080';
  element('setup-detect-distributions').addEventListener('click', () => {
    if (setupStateUnknown) void retrySetupSnapshot(); else void detectSetupDistributions();
  });
  setupDistribution().addEventListener('change', changeSetupDistribution);
  element('setup-detect-identity').addEventListener('click', () => {
    if (!element<HTMLButtonElement>('setup-detect-identity').disabled) void detectSetupIdentity();
  });
  setupInput('user').addEventListener('input', () => {
    if (setupSubmitting) return;
    setupIdentityRevision += 1;
    setupDiscovering = false;
    setupNodeRevision += 1;
    setupInput('node').value = '';
    element('setup-identity-status').textContent = '用户已修改，可重新发现 Node.js 或手动填写。';
    setupError = '';
    render();
  });
  setupInput('user').addEventListener('change', () => { if (!setupSubmitting) void detectSetupIdentity(); });
  for (const name of ['repository', 'node', 'port']) setupInput(name).addEventListener('input', () => {
    if (setupSubmitting) return;
    if (name === 'node') setupNodeRevision += 1;
    setupError = '';
    render();
  });
  element('setup-form').addEventListener('submit', event => { event.preventDefault(); void completeSetup(); });
}
for (const action of actions) buttons[action]?.addEventListener('click', () => { void perform(action); });
window.addEventListener('beforeunload', () => {
  setupDisposed = true; setupIdentityRevision += 1;
  settingsDisposed = true;
  speechSettings?.dispose();
  notificationsDisposed = true; unlistenNotifications?.(); unlistenNotifications = undefined;
  powerDisposed = true; unlistenPower?.(); unlistenPower = undefined;
  petDisposed = true; unlistenPet?.(); unlistenPet = undefined;
  unlisten?.(); unlistenShowLogs?.(); unlistenShowSettings?.(); unlistenUpdates?.(); unlistenShowUpdates?.();
}, { once: true });
document.addEventListener('visibilitychange', () => speechSettings?.setVisible(settingsSection === 'pet' && !document.hidden && settingsPageRevealed));
window.addEventListener('pagehide', () => speechSettings?.dispose(), { once: true });
render();
const initialization = initialize();
const updatesInitialization = initializeUpdates();
if (settingsView) {
  const notificationsInitialization = performNotification('get_notification_snapshot');
  const powerInitialization = performPower('get_power_snapshot');
  const petInitialization = performPetSettings('get_pet_settings');
  void readySettingsPage([initialization, updatesInitialization, notificationsInitialization, powerInitialization, petInitialization]);
}
