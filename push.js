// Phone push via an ntfy-compatible relay (https://ntfy.sh — open protocol, self-hostable, native
// iOS/Android apps). The relay endpoint is pluggable: point `server` at ntfy.sh, your own ntfy, or
// any service speaking the same "POST /<topic> with Title/Priority/Tags headers" contract.
// Config lives in <data-dir>/push.json; CORRAL_NTFY_SERVER / CORRAL_NTFY_TOPIC env vars override
// (setting the topic via env implies enabled — handy for headless runs).
const fs = require('fs');
const os = require('os');
const path = require('path');
const remote = require('./remote');
const webpush = require('./webpush');

// Same fallback rule as chat.js: an existing pre-rename ~/.codapp keeps being used.
const DATA_DIR = fs.existsSync(path.join(os.homedir(), '.codapp')) && !fs.existsSync(path.join(os.homedir(), '.corral'))
  ? path.join(os.homedir(), '.codapp')
  : path.join(os.homedir(), '.corral');
const CONF = path.join(DATA_DIR, 'push.json');

const DEFAULTS = Object.freeze({
  enabled: false,
  server: 'https://ntfy.sh',
  topic: '',
  // One-tap Allow/Deny buttons on permission notifications. Opt-in: the action URLs must embed
  // the phone-pairing token, so anyone who can read the ntfy topic could answer prompts.
  actions: false,
  // Click opens the installed Corral app (corral:// scheme) instead of the browser console.
  // Opt-in: without the APK a corral:// link is a dead tap.
  appClick: false,
  events: Object.freeze({ input: true, done: true, fail: true }),
});

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONF, 'utf8'));
    return { ...DEFAULTS, ...parsed, events: { ...DEFAULTS.events, ...(parsed.events || {}) } };
  } catch (e) {
    return { ...DEFAULTS, events: { ...DEFAULTS.events } };
  }
}
let conf = load();

// Effective config: env overrides file (env topic implies enabled).
function get() {
  const server = process.env.CORRAL_NTFY_SERVER || conf.server;
  const topic = process.env.CORRAL_NTFY_TOPIC || conf.topic;
  const enabled = process.env.CORRAL_NTFY_TOPIC ? true : conf.enabled;
  return { enabled, server, topic, actions: !!conf.actions, appClick: !!conf.appClick, events: { ...conf.events } };
}

const SAFE_TOPIC = /^[A-Za-z0-9_-]{1,64}$/;
function set(next = {}) {
  const merged = { ...conf, events: { ...conf.events } };
  if (next.enabled != null) merged.enabled = !!next.enabled;
  if (next.server != null) {
    const server = String(next.server).trim().replace(/\/+$/, '') || DEFAULTS.server;
    if (!/^https?:\/\//.test(server)) throw new Error('server must be an http(s) URL');
    merged.server = server;
  }
  if (next.topic != null) {
    const topic = String(next.topic).trim();
    if (topic && !SAFE_TOPIC.test(topic)) throw new Error('topic: letters, digits, - and _ only (max 64)');
    merged.topic = topic;
  }
  if (next.actions != null) merged.actions = !!next.actions;
  if (next.appClick != null) merged.appClick = !!next.appClick;
  for (const k of Object.keys(DEFAULTS.events)) if (next[k] != null) merged.events[k] = !!next[k];
  conf = merged;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = CONF + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(conf, null, 2));
    fs.renameSync(tmp, CONF);
  } catch (e) {}
  return get();
}

// --- message construction (pure — selftested) ---
const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
const basename = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '~';
const where = (s = {}) => basename(s.cwd) + (s.host && s.host !== 'local' ? ' / ' + s.host : '');
const agentName = (s = {}) => AGENT_NAMES[s.agent] || AGENT_NAMES.claude;

function messageFor(kind, s = {}, extra = {}) {
  if (kind === 'input') {
    return {
      title: agentName(s) + ' needs you',
      body: where(s) + ' - waiting for permission' + (extra.tool ? ': ' + extra.tool : ''),
      tags: 'raised_hand', priority: 'high',
    };
  }
  if (kind === 'done') {
    return {
      title: agentName(s) + ' is ready',
      body: where(s) + ' finished its turn' + (extra.costUsd != null ? ' ($' + Number(extra.costUsd).toFixed(2) + ' total)' : ''),
      tags: 'white_check_mark', priority: 'default',
    };
  }
  return {
    title: 'Session ' + (kind === 'fail-error' ? 'error' : 'ended'),
    body: where(s) + (extra.detail ? ' - ' + String(extra.detail).slice(0, 160) : ''),
    tags: 'rotating_light', priority: 'high',
  };
}

// Notification extras when phone pairing is on (pure -> selftested): Click opens the mobile
// console on the session; permission asks optionally carry one-tap Allow/Deny http actions that
// POST straight back to the LAN listener. Both are dropped when remote access is off — a click
// URL nobody can reach is worse than none.
function notificationExtras({ kind, sessionId, requestId, base, token, actionsEnabled, appClick } = {}) {
  if (!base || !sessionId) return {};
  const out = {
    click: appClick
      ? 'corral://session/' + encodeURIComponent(sessionId)          // opens the installed APK
      : base + '/#session=' + encodeURIComponent(sessionId),
  };
  if (kind === 'input' && actionsEnabled && token && requestId) {
    const act = (d) => base + '/api/chat/permission?id=' + encodeURIComponent(sessionId) + '&requestId=' + encodeURIComponent(requestId) + '&decision=' + d;
    out.actions = [
      'http, Allow, ' + act('allow') + ', method=POST, clear=true, headers.x-corral-token=' + token,
      'http, Deny, ' + act('deny') + ', method=POST, clear=true, headers.x-corral-token=' + token,
    ].join('; ');
  }
  return out;
}

// The pairing base the phone can actually reach — first LAN address + remote port, or '' when
// remote access is disabled. Scheme follows the listener's TLS config.
function remoteBase() {
  const rc = remote.get();
  if (!rc.enabled || !rc.token) return { base: '', token: '' };
  const addr = remote.lanAddresses()[0];
  return addr ? { base: (rc.tls ? 'https' : 'http') + '://' + addr + ':' + rc.port, token: rc.token } : { base: '', token: '' };
}

// --- delivery ---
async function send({ title, body, tags, priority, click, actions }, cfg = get()) {
  if (!cfg.topic) throw new Error('no topic configured');
  // ntfy headers are latin-1; strip anything outside to stay safe with unicode project names
  const headers = {
    Title: String(title || 'corral').replace(/[^\x20-\x7e]/g, '?'),
    Tags: tags || '', Priority: priority || 'default',
  };
  if (click) headers.Click = click;
  if (actions) headers.Actions = actions;
  const res = await fetch(cfg.server + '/' + encodeURIComponent(cfg.topic), {
    method: 'POST',
    body: body || '',
    headers,
  });
  if (!res.ok) throw new Error('relay ' + res.status);
}

// Session hook: fire-and-forget with a per-session+kind cooldown so a burst (e.g. several
// permission requests in one turn) lands as one buzz, not five. Two transports share the event
// toggles and the cooldown: the ntfy relay (when enabled) and Web Push straight to any phone
// that subscribed through the service worker (see webpush.js — no relay involved).
const lastSent = new Map();
const COOLDOWN_MS = 15000;
function notifySession(kind, s, extra = {}) {
  const cfg = get();
  const evKey = kind.startsWith('fail') ? 'fail' : kind;
  if (cfg.events[evKey] === false) return;
  const key = (s && s.id) + ':' + evKey;
  const now = Date.now();
  if (now - (lastSent.get(key) || 0) < COOLDOWN_MS) return;
  lastSent.set(key, now);
  const msg = messageFor(kind, s, extra);
  if (cfg.enabled && cfg.topic) {
    const { base, token } = remoteBase();
    const extras = notificationExtras({ kind, sessionId: s && s.id, requestId: extra.requestId, base, token, actionsEnabled: cfg.actions, appClick: cfg.appClick });
    send({ ...msg, ...extras }, cfg).catch((e) => console.error('push failed:', e.message));
  }
  webpush.notify({ title: msg.title, body: msg.body, priority: msg.priority, sessionId: s && s.id }).catch((e) => console.error('webpush failed:', e.message));
}

module.exports = { get, set, send, messageFor, notificationExtras, notifySession };
