const endedStates = new Set(['error', 'exited']);
// busy/starting no longer block the composer: the backend queues mid-turn input and adapters
// queue until ready, so typing ahead is safe. Only parked sessions must resume first.
const blockedStates = new Set(['dormant']);

export function normalizeSessionPath(cwd) {
  const raw = String(cwd || '').trim().replace(/\\/g, '/');
  if (!raw) return '~';
  if (raw === '/') return '/';
  return raw.replace(/\/+$/g, '') || '/';
}

export function sessionPathParts(cwd) {
  const path = normalizeSessionPath(cwd);
  if (path === '~' || path === '/') return { path, parent: '', project: path };

  const absolute = path.startsWith('/');
  const parts = path.split('/').filter(Boolean);
  const project = parts[parts.length - 1] || path;
  const parentParts = parts.slice(0, -1);
  const parent = parentParts.length ? (absolute ? '/' : '') + parentParts.join('/') : '';
  return { path, parent, project };
}

export function sessionHostLabel(host) {
  return !host || host === 'local' ? 'local' : String(host);
}

export function sessionStatusView(status) {
  if (status === 'starting') return { label: 'starting', detail: 'opening stream', tone: 'busy' };
  if (status === 'busy') return { label: 'running', detail: 'turn in progress', tone: 'busy' };
  if (status === 'idle') return { label: 'ready', detail: 'waiting for input', tone: 'idle' };
  if (status === 'dormant') return { label: 'parked', detail: 'resume to continue', tone: 'dormant' };
  if (status === 'error') return { label: 'error', detail: 'needs attention', tone: 'error' };
  if (status === 'exited') return { label: 'ended', detail: 'process closed', tone: 'error' };
  return { label: 'connecting', detail: 'opening stream', tone: 'idle' };
}

export function canSubmitMessage({ status = '', ended = false } = {}) {
  return !ended && !endedStates.has(status) && !blockedStates.has(status);
}

export function composerSubmitState({ status = '', ended = false, draft = '', attachments = [] } = {}) {
  if (!canSubmitMessage({ status, ended })) {
    return { canSend: false, reason: 'blocked', hint: '' };
  }

  const items = Array.isArray(attachments) ? attachments : [];
  const pendingUploads = items.filter((item) => !item.done && !item.error).length;
  if (pendingUploads) {
    return { canSend: false, reason: 'uploading', hint: 'Wait for uploads to finish.' };
  }

  const hasText = String(draft || '').trim().length > 0;
  const readyUploads = items.filter((item) => item.done && !item.error).length;
  if (hasText || readyUploads) {
    if (status === 'busy' || status === 'starting') return { canSend: true, reason: 'queue', hint: 'Sends when this turn ends.' };
    return { canSend: true, reason: 'ready', hint: '' };
  }

  const failedUploads = items.filter((item) => item.error).length;
  if (failedUploads) {
    return { canSend: false, reason: 'failed-only', hint: 'Remove failed uploads or type a message.' };
  }

  return { canSend: false, reason: 'empty', hint: '' };
}

export function sessionResumeAction(session = {}) {
  if (session.status === 'dormant') {
    return { label: 'Resume', title: 'Resume session and reconnect the stream' };
  }
  return null;
}

export function sessionEndAction(session = {}) {
  if (session.status === 'dormant') return null;
  if (endedStates.has(session.status)) {
    return { kind: 'remove', label: 'Remove', title: 'Remove session', icon: 'trash', danger: true };
  }
  return { kind: 'kill', label: 'End', title: 'End session', icon: 'close', danger: false };
}

const AGENT_LABELS = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
export function agentLabel(agent) {
  return AGENT_LABELS[agent] || AGENT_LABELS.claude;
}

export function composerPlaceholder({ status = '', ended = false, project = '', agent = 'claude' } = {}) {
  if (ended || endedStates.has(status)) return 'Session ended.';
  if (status === 'busy') return agentLabel(agent) + ' is working...';
  if (status === 'starting') return 'Opening ' + (project || 'session') + '...';
  if (status === 'dormant') return 'Session is parked.';
  return 'Message ' + (project || 'the agent') + '...';
}
