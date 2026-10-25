import type { AssistantSnapshot } from '../assistant-model';

export interface ConversationCue {
  key: string;
  kind: 'thinking' | 'reply' | 'waiting' | 'error' | 'greeting';
  text: string;
  busy: boolean;
}

/** Only public answer text from the current turn, never reasoning or a previous turn's answer. */
export function conversationCue(state: AssistantSnapshot): ConversationCue {
  const scope = [state.workspace_id, state.session_id].join(':');
  const cue = (key: string, kind: ConversationCue['kind'], text: string, busy = false): ConversationCue =>
    ({ key: scope + ':' + key, kind, text, busy });
  if (state.phase === 'loading') return cue('loading', 'thinking', state.message || '正在连接桌面助手…', true);
  if (!state.enabled || state.phase === 'workspace_missing') return cue('setup', 'greeting', state.phase === 'error' && state.message ? '初始化未完成：' + state.message : '宠物目录尚未初始化或已丢失，请到「设置 → 桌面宠物」初始化后再聊天。');
  if (!state.connected) return cue('offline', 'error', state.message || '暂时连不上，草稿会为你保留。');
  if (['error', 'failed'].includes(state.phase)) return cue('error:' + state.message, 'error', state.message || '刚才没有完成，可以重试连接。');
  if (state.phase === 'cancelling') return cue('stopping', 'thinking', '正在停下来…', true);
  if (state.waiting) return cue('waiting', 'waiting', '有件事需要你确认，请查看确认气泡，或在 DSH 中处理。', true);
  let lastUser = -1;
  for (let i = state.messages.length - 1; i >= 0; i--) { if (state.messages[i].role === 'user') { lastUser = i; break; } }
  const answer = [...state.messages.slice(lastUser + 1)].reverse().find(message => message.role === 'assistant' && message.text.trim());
  if (state.phase === 'sending') return cue('sending', 'thinking', '听到啦，正在发送…', true);
  if (answer) return cue('answer:' + answer.id, 'reply', answer.text, state.running);
  if (state.running) return cue('thinking:' + (state.messages[lastUser]?.id ?? ''), 'thinking', '让我想想…', true);
  return cue('hello', 'greeting', '我在呢，想跟我说点什么？');
}

export interface CompletedReply { key: string; text: string }

/** Consume accepted snapshots, not renders. Reconnect/history baselines never become speech. */
export class CompletedReplyTracker {
  private scope = '';
  private hydrated = false;
  private handled = new Set<string>();

  observe(state: AssistantSnapshot): CompletedReply | null {
    const scope = [state.workspace_id, state.session_id].join(':');
    if (scope !== this.scope) { this.scope = scope; this.hydrated = false; this.handled.clear(); }
    if (!state.enabled || !state.connected || !state.session_id || ['loading', 'connecting'].includes(state.phase)) {
      this.hydrated = false;
      return null;
    }
    const ids = state.messages.filter(message => message.role === 'assistant').map(message => message.id);
    if (!this.hydrated) { this.hydrated = true; this.handled = new Set(ids); return null; }
    if (state.running || state.waiting || ['sending', 'cancelling'].includes(state.phase)) return null;
    let lastUser = -1;
    for (let i = state.messages.length - 1; i >= 0; i--) { if (state.messages[i].role === 'user') { lastUser = i; break; } }
    const answer = [...state.messages.slice(lastUser + 1)].reverse().find(message => message.role === 'assistant' && message.text.trim());
    const fresh = answer && !this.handled.has(answer.id);
    // Mark even skipped/failed/off-mode answers as consumed; toggling never replays them.
    const successful = ['ready', 'completed', 'success'].includes(state.phase);
    const settled = successful ? state.messages.filter(message => message.role === 'assistant' && !['streaming', 'running'].includes(message.status ?? '')).map(message => message.id) : ids;
    this.handled = new Set([...this.handled, ...settled]);
    if (!fresh || !successful ||
        (answer.status !== undefined && answer.status !== 'completed')) return null;
    return { key: scope + ':answer:' + answer.id, text: answer.text };
  }
}

/** Give short answers time to read; long answers stay until explicitly dismissed. */
export function speechReadingTime(text: string): number | null {
  const length = Array.from(text).length;
  return length > 180 ? null : Math.max(8000, Math.min(24000, length * 180));
}
