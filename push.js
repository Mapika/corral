// Phone push via an ntfy-compatible relay (https://ntfy.sh — open protocol, self-hostable, native
// iOS/Android apps). The relay endpoint is pluggable: point `server` at ntfy.sh, your own ntfy, or
// any service speaking the same "POST /<topic> with Title/Priority/Tags headers" contract.
// Config lives in <data-dir>/push.json; CORRAL_NTFY_SERVER / CORRAL_NTFY_TOPIC env vars override
// (setting the topic via env implies enabled — handy for headless runs).
const fs = require('fs');
const os = require('os');
const path = require('path');

// Same fallback rule as chat.js: an existing pre-rename ~/.codapp keeps being used.
const DATA_DIR = fs.existsSync(path.join(os.homedir(), '.codapp')) && !fs.existsSync(path.join(os.homedir(), '.corral'))
  ? path.join(os.homedir(), '.codapp')
  : path.join(os.homedir(), '.corral');
const CONF = path.join(DATA_DIR, 'push.json');

const DEFAULTS = Object.freeze({
  enabled: false,
  server: 'https://ntfy.sh',
  topic: '',
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
  return { enabled, server, topic, events: { ...conf.events } };
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

// --- delivery ---
async function send({ title, body, tags, priority }, cfg = get()) {
  if (!cfg.topic) throw new Error('no topic configured');
  const res = await fetch(cfg.server + '/' + encodeURIComponent(cfg.topic), {
    method: 'POST',
    body: body || '',
    // ntfy headers are latin-1; strip anything outside to stay safe with unicode project names
    headers: {
      Title: String(title || 'corral').replace(/[^\x20-\x7e]/g, '?'),
      Tags: tags || '', Priority: priority || 'default',
    },
  });
  if (!res.ok) throw new Error('relay ' + res.status);
}

// Session hook: fire-and-forget with a per-session+kind cooldown so a burst (e.g. several
// permission requests in one turn) lands as one buzz, not five.
const lastSent = new Map();
const COOLDOWN_MS = 15000;
function notifySession(kind, s, extra = {}) {
  const cfg = get();
  const evKey = kind.startsWith('fail') ? 'fail' : kind;
  if (!cfg.enabled || !cfg.topic || cfg.events[evKey] === false) return;
  const key = (s && s.id) + ':' + evKey;
  const now = Date.now();
  if (now - (lastSent.get(key) || 0) < COOLDOWN_MS) return;
  lastSent.set(key, now);
  send(messageFor(kind, s, extra), cfg).catch((e) => console.error('push failed:', e.message));
}

module.exports = { get, set, send, messageFor, notifySession };
