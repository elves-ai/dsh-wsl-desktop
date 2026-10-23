export type AssistantMessage = { id: string; role: 'user' | 'assistant' | 'system'; text: string; status?: string; request_id?: string };
export type AssistantSnapshot = {
  enabled: boolean; phase: string; message: string; workspace_id: string | null;
  session_id: string | null; workspace_path: string | null;
  sessions: { id: string; title: string }[]; messages: AssistantMessage[];
  running: boolean; waiting: boolean; connected: boolean; revision: number;
};
export type AssistantDelta = Partial<AssistantSnapshot> & { kind: 'delta'; revision: number; session_id: string | null };
export function initialSnapshot(): AssistantSnapshot {
  return { enabled: false, phase: 'loading', message: '正在连接桌面助手…', workspace_id: null,
    session_id: null, workspace_path: null, sessions: [], messages: [], running: false,
    waiting: false, connected: false, revision: -1 };
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nullableString = (v: unknown) => v === null || typeof v === 'string';
function validMessages(v: unknown): v is AssistantMessage[] {
  return Array.isArray(v) && v.every(m => record(m) && typeof m.id === 'string' &&
    ['user', 'assistant', 'system'].includes(String(m.role)) && typeof m.text === 'string' &&
    (m.status === undefined || typeof m.status === 'string') &&
    (m.request_id === undefined || typeof m.request_id === 'string'));
}
function validSessions(v: unknown): v is AssistantSnapshot['sessions'] {
  return Array.isArray(v) && v.every(s => record(s) && typeof s.id === 'string' && typeof s.title === 'string');
}
function dedupe<T extends { id: string }>(items: T[]): T[] {
  const result = new Map<string, T>();
  for (const item of items) result.set(item.id, { ...item });
  return [...result.values()];
}
/** Snapshot is authoritative; deltas use cumulative text, never append tokens twice. */
export function mergeSnapshot(current: AssistantSnapshot, incoming: unknown): AssistantSnapshot {
  if (!record(incoming) || !Number.isSafeInteger(incoming.revision) ||
      (incoming.revision as number) <= current.revision) return current;
  const delta = incoming.kind === 'delta';
  const bools = ['enabled', 'running', 'waiting', 'connected'];
  const strings = ['phase', 'message'];
  const nullable = ['workspace_id', 'session_id', 'workspace_path'];
  for (const key of bools) if ((!delta || key in incoming) && typeof incoming[key] !== 'boolean') return current;
  for (const key of strings) if ((!delta || key in incoming) && typeof incoming[key] !== 'string') return current;
  for (const key of nullable) if ((!delta || key in incoming) && !nullableString(incoming[key])) return current;
  if (!('session_id' in incoming)) return current;
  if ((!delta || 'messages' in incoming) && !validMessages(incoming.messages)) return current;
  if ((!delta || 'sessions' in incoming) && !validSessions(incoming.sessions)) return current;
  // Do not apply a partial event from a different conversation; wait for its full snapshot.
  if (delta && incoming.session_id !== current.session_id) return current;
  const next = { ...current };
  for (const key of [...bools, ...strings, ...nullable, 'revision']) {
    if (key in incoming) Object.assign(next, { [key]: incoming[key] });
  }
  next.messages = incoming.messages ? dedupe(delta ? [...current.messages, ...incoming.messages as AssistantMessage[]] : incoming.messages as AssistantMessage[]) : current.messages;
  next.sessions = incoming.sessions ? dedupe(incoming.sessions as AssistantSnapshot['sessions']) : current.sessions;
  return next;
}
export function canSend(state: AssistantSnapshot, text: string, pending = false): boolean {
  return state.enabled && state.connected && !!state.session_id && !state.running && !state.waiting &&
    !['sending', 'cancelling'].includes(state.phase) && !pending && !!text.trim();
}
export function statusLabel(state: AssistantSnapshot): string {
  if (state.phase === 'loading') return '连接中';
  if (!state.enabled) return '待启用';
  if (!state.connected) return '连接已断开';
  if (state.phase === 'sending') return '消息发送中';
  if (state.phase === 'cancelling') return '正在停止';
  if (state.waiting) return '等待你的确认';
  if (state.running) return '正在思考';
  if (['error', 'failed'].includes(state.phase)) return '需要重试';
  return '随时聊聊';
}
export function movedBeyondThreshold(x: number, y: number, startX: number, startY: number): boolean {
  return Math.hypot(x - startX, y - startY) >= 6;
}
