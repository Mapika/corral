// Demo backend for recording OSS media. Enabled only with CORRAL_DEMO=1.
// It serves deterministic sessions/files/tunnels and streams fake agent events over the
// same WebSocket shapes the real adapters use.
const path = require('path');

const startedAt = Date.now();
const eventClients = new Set();
let extraTunnelId = 0;
let demoTunnels = [
  {
    id: 'tun-preview',
    host: 'staging',
    localPort: 5180,
    remoteHost: '127.0.0.1',
    remotePort: 8080,
    status: 'up',
    error: null,
    http: true,
    serviceStatus: 'reachable',
    serviceError: null,
    serviceStatusCode: 200,
    lastProbeAt: startedAt - 15_000,
  },
];

function now() {
  return Date.now();
}

// Answering the demo permission (from the herd card or the chat) really clears it, so the
// decision loop can be exercised end-to-end; it revives after a minute for the next take.
let permResolvedAt = 0;

function sessions() {
  const t = now();
  const permOpen = t - permResolvedAt > 60_000;
  return [
    {
      id: 'sess-corral',
      agent: 'claude',
      host: 'local',
      cwd: 'E:/Projects/terminal-rancher',
      model: 'claude-sonnet-4-5',
      status: 'busy',
      sessionId: 'claude_demo_corral',
      createdAt: t - 18 * 60_000,
      updatedAt: t - 25_000,
      label: 'corral release',
      tokIn: 18200,
      tokOut: 4200,
      costUsd: 0.38,
      ...(permOpen ? { pendingPerm: { count: 1, id: 'perm-readme', tool: 'Edit', summary: 'README.md' } } : {}),   // mirrors the chat stream's ask
    },
    {
      id: 'sess-feed',
      agent: 'codex',
      host: 'gpu-box',
      cwd: '/srv/market-feed',
      model: 'gpt-5-codex',
      status: 'busy',
      sessionId: 'thr_demo_feed',
      createdAt: t - 42 * 60_000,
      updatedAt: t - 70_000,
      label: 'market feed',
      tokIn: 9400,
      tokOut: 3100,
      costUsd: null,
    },
    {
      id: 'sess-admin',
      agent: 'opencode',
      host: 'staging',
      cwd: '/var/www/admin',
      model: 'qwen3-coder',
      status: 'idle',
      sessionId: 'ses_demo_admin',
      createdAt: t - 75 * 60_000,
      updatedAt: t - 6 * 60_000,
      label: 'admin health',
      tokIn: 6100,
      tokOut: 1700,
      costUsd: 0.04,
    },
    {
      id: 'sess-bundle',
      agent: 'claude',
      host: 'build-node',
      cwd: '/home/mark/corral',
      model: 'claude-sonnet-4-5',
      status: 'error',
      sessionId: 'claude_demo_bundle',
      createdAt: t - 2 * 60 * 60_000,
      updatedAt: t - 22 * 60_000,
      label: 'linux bundle',
      note: 'missing webkit package',
      tokIn: 7200,
      tokOut: 900,
      costUsd: 0.11,
    },
  ];
}

const hostStatuses = () => [
  {
    name: 'gpu-box',
    ok: true,
    checkedAt: now() - 10_000,
    tmux: [
      { name: 'feed-tail', windows: 2, attached: false, group: '', path: '/srv/market-feed' },
    ],
    cc: [{ sessionId: 'remote-claude-1', status: 'idle', cwd: '/srv/market-feed' }],
  },
  {
    name: 'staging',
    ok: true,
    checkedAt: now() - 8_000,
    tmux: [
      { name: 'web', windows: 1, attached: true, group: '', path: '/var/www/admin' },
    ],
    cc: [],
  },
  {
    name: 'build-node',
    ok: false,
    checkedAt: now() - 12_000,
    error: 'Connection timed out',
  },
];

const listings = new Map([
  ['local\0E:/Projects/terminal-rancher', [
    { type: 'd', size: 0, name: 'agents' },
    { type: 'd', size: 0, name: 'web' },
    { type: 'd', size: 0, name: 'src-tauri' },
    { type: 'f', size: 3875, name: 'README.md' },
    { type: 'f', size: 80432, name: 'server.js' },
    { type: 'f', size: 921, name: 'package.json' },
    { type: 'f', size: 3974, name: 'SECURITY.md' },
  ]],
  ['gpu-box\0/srv/market-feed', [
    { type: 'd', size: 0, name: 'src' },
    { type: 'd', size: 0, name: 'scripts' },
    { type: 'd', size: 0, name: 'tests' },
    { type: 'f', size: 1184, name: 'package.json' },
    { type: 'f', size: 2740, name: 'README.md' },
    { type: 'f', size: 612, name: '.env.example' },
  ]],
  ['gpu-box\0/srv/market-feed/src', [
    { type: 'f', size: 4822, name: 'replay.ts' },
    { type: 'f', size: 3160, name: 'queue.ts' },
    { type: 'f', size: 2284, name: 'server.ts' },
  ]],
  ['staging\0/var/www/admin', [
    { type: 'd', size: 0, name: 'app' },
    { type: 'd', size: 0, name: 'public' },
    { type: 'f', size: 942, name: 'healthz.ts' },
    { type: 'f', size: 1814, name: 'README.md' },
  ]],
]);

const fileTexts = new Map([
  ['local\0E:/Projects/terminal-rancher/README.md', [
    '# corral',
    '',
    'Ranch your AI coding agents.',
    '',
    '- Fleet view across every host',
    '- File browser, git diffs, terminals, and SSH tunnels',
    '- Phone push when a session needs a decision',
  ].join('\n')],
  ['gpu-box\0/srv/market-feed/README.md', [
    '# market-feed',
    '',
    'Remote service that replays exchange ticks into the local simulator.',
    '',
    'Run `npm run dev` on the host, then forward port 8080 through Corral.',
  ].join('\n')],
  ['gpu-box\0/srv/market-feed/src/replay.ts', [
    'export async function replay(queue, tick) {',
    '  if (queue.depth() > 5000) await queue.drainUntil(2500);',
    '  return queue.push(tick);',
    '}',
  ].join('\n')],
  ['gpu-box\0/srv/market-feed/package.json', '{\n  "scripts": { "dev": "tsx src/server.ts", "test": "vitest" }\n}\n'],
  ['staging\0/var/www/admin/healthz.ts', 'export const healthz = () => ({ ok: true, uptime: process.uptime() });\n'],
]);

const demoDiff = [
  'diff --git a/README.md b/README.md',
  'index 4a3c1de..8f122a3 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -19,7 +19,7 @@',
  '-Grab the installer for your OS from Releases - macOS, Windows, Linux.',
  '+Grab the installer for your OS from Releases - macOS Apple silicon, Windows, Linux.',
  '',
  'diff --git a/server.js b/server.js',
  'index 0daf907..dad8f28 100644',
  '--- a/server.js',
  '+++ b/server.js',
  '@@ -132,6 +132,10 @@',
  '+function insideDir(root, target) {',
  '+  const rel = path.relative(root, target);',
  '+  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));',
  '+}',
].join('\n');

function json(res, value, status = 200) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}

function text(res, value, type = 'text/plain; charset=utf-8') {
  res.setHeader('content-type', type);
  res.end(value);
}

// The overnight ranch, demo-sized: one diff waiting at the review gate, one job still queued.
// Keep/bounce really resolve (and revive after a minute) so the loop can be recorded end-to-end.
let demoReviewedAt = 0;
let demoQueue = () => {
  const t = now();
  const reviewed = t - demoReviewedAt < 60_000;
  return {
    hold: null,
    jobs: [
      {
        id: 'job-readme', dir: 'E:/Projects/terminal-rancher', prompt: 'Tighten the README install section and fix stale release wording.',
        label: 'Tighten the README install section', agent: 'claude', model: null, perm: 'auto',
        status: reviewed ? 'kept' : 'landed', sessionId: 'sess-corral', branch: 'corral/terminal-rancher-demo',
        worktreeDir: 'E:/Projects/terminal-rancher-corral-demo', repoRoot: 'E:/Projects/terminal-rancher',
        diffstat: { files: 2, add: 14, del: 6, untracked: 1 }, error: null,
        createdAt: t - 9 * 3600_000, startedAt: t - 8 * 3600_000, finishedAt: t - 7 * 3600_000, reviewedAt: reviewed ? demoReviewedAt : null,
      },
      {
        id: 'job-flaky', dir: 'E:/Projects/terminal-rancher', prompt: 'Hunt down the flaky reconnect test and make it deterministic.',
        label: 'Hunt down the flaky reconnect test', agent: 'claude', model: null, perm: 'auto',
        status: 'queued', sessionId: null, branch: null, worktreeDir: null, repoRoot: null, diffstat: null, error: null,
        createdAt: t - 2 * 3600_000, startedAt: null, finishedAt: null, reviewedAt: null,
      },
    ],
  };
};

function snapshotFrames() {
  return [
    { type: 'sessions', sessions: sessions() },
    { type: 'tunnels', tunnels: demoTunnels },
    { type: 'queue', queue: demoQueue() },
  ];
}

function broadcast(frame) {
  const msg = JSON.stringify(frame);
  for (const ws of eventClients) if (ws.readyState === 1) ws.send(msg);
}

function addTunnel(url) {
  const remotePort = Number(url.searchParams.get('remotePort') || 8080);
  const localPort = Number(url.searchParams.get('localPort') || 5200 + extraTunnelId);
  const host = url.searchParams.get('server') || 'staging';
  const tunnel = {
    id: 'tun-demo-' + (++extraTunnelId),
    host,
    localPort,
    remoteHost: url.searchParams.get('remoteHost') || '127.0.0.1',
    remotePort,
    status: 'starting',
    error: null,
    http: url.searchParams.get('http') !== '0',
    serviceStatus: 'probing',
    serviceError: null,
    serviceStatusCode: null,
    lastProbeAt: null,
  };
  demoTunnels = [tunnel, ...demoTunnels];
  broadcast({ type: 'tunnels', tunnels: demoTunnels });
  setTimeout(() => {
    tunnel.status = 'up';
    tunnel.serviceStatus = 'reachable';
    tunnel.serviceStatusCode = 200;
    tunnel.lastProbeAt = now();
    broadcast({ type: 'tunnels', tunnels: demoTunnels });
  }, 900).unref?.();
  return tunnel;
}

async function handleApi(req, res, url) {
  if (!url.pathname.startsWith('/api/')) return false;
  if (url.pathname === '/api/hosts') return json(res, { local: 'E:/Projects/terminal-rancher', hosts: ['gpu-box', 'staging', 'build-node'], hostname: 'demo-ranch',
    telemetry: { cpus: 16, load1: 0.4, memFree: 21_000_000_000, memTotal: 32_000_000_000, uptime: 86_400, onBattery: false, busy: 2, platform: 'linux', macs: ['aa:bb:cc:dd:ee:ff'] } }), true;
  // Both demo ranches report a checkout of the same remote, so the two-ranch pass sees one
  // project with two places (the placement chip's whole reason to exist).
  if (url.pathname === '/api/projects') return json(res, { checkouts: [
    { dir: 'E:/Projects/terminal-rancher', root: 'E:/Projects/terminal-rancher', remote: 'github.com/mapika/corral', name: 'corral', lastSeen: now() - 3600_000 },
    { dir: '/srv/market-feed', root: '/srv/market-feed', remote: 'github.com/mapika/market-feed', name: 'market-feed', lastSeen: now() - 7200_000 },
  ] }), true;
  if (url.pathname === '/api/wake' && req.method === 'POST') return json(res, { ok: true }), true;
  if (url.pathname === '/api/servers') return json(res, hostStatuses()), true;
  if (url.pathname === '/api/chat/list') return json(res, sessions()), true;
  if (url.pathname === '/api/chat/launch' && req.method === 'POST') return json(res, { ok: true, id: 'sess-corral' }), true;
  if (url.pathname === '/api/chat/resume' && req.method === 'POST') return json(res, { ok: true, id: url.searchParams.get('id') || 'sess-corral' }), true;
  if (url.pathname === '/api/chat/kill' && req.method === 'POST') return json(res, { ok: true }), true;
  if (url.pathname === '/api/chat/interrupt' && req.method === 'POST') return json(res, { ok: true }), true;
  if (url.pathname === '/api/chat/remove' && req.method === 'POST') return json(res, { ok: true }), true;
  if (url.pathname === '/api/chat/label' && req.method === 'POST') return json(res, { ok: true }), true;
  if (url.pathname === '/api/chat/permission' && req.method === 'POST') {
    permResolvedAt = now();
    broadcast({ type: 'sessions', sessions: sessions() });
    return json(res, { ok: true }), true;
  }
  if (url.pathname === '/api/queue/list') return json(res, demoQueue()), true;
  if (url.pathname === '/api/queue/add' && req.method === 'POST') return json(res, { ok: true, id: 'job-flaky' }), true;
  if ((url.pathname === '/api/queue/keep' || url.pathname === '/api/queue/bounce') && req.method === 'POST') {
    demoReviewedAt = now();
    broadcast({ type: 'queue', queue: demoQueue() });
    return json(res, { ok: true }), true;
  }
  if (url.pathname.startsWith('/api/queue/') && req.method === 'POST') return json(res, { ok: true }), true;
  if (url.pathname === '/api/remote') return json(res, { ok: true, enabled: true, port: 7879, running: true, error: '', addresses: ['192.168.1.20'], token: 'demo0token0demo0token0demo0token0demo0token0demo0token0demo0abcd' }), true;
  if (url.pathname === '/api/history/search') return json(res, { hits: [] }), true;
  if (url.pathname === '/api/push') return json(res, { enabled: false, server: 'https://ntfy.sh', topic: '', events: { input: true, done: true, fail: true } }), true;
  if (url.pathname === '/api/push/test' && req.method === 'POST') return json(res, { ok: true }), true;
  // Web Push stubs — demo must never mint real VAPID keys in the user's data dir.
  if (url.pathname === '/api/webpush') return json(res, { publicKey: 'BDemoDemoDemo', count: 0 }), true;
  if (url.pathname.startsWith('/api/webpush/') && req.method === 'POST') return json(res, { ok: true, publicKey: 'BDemoDemoDemo', count: 1 }), true;
  if (url.pathname === '/api/tunnels') {
    if (req.method === 'GET') return json(res, demoTunnels), true;
    if (req.method === 'POST') {
      const tunnel = addTunnel(url);
      return json(res, { ok: true, id: tunnel.id, localPort: tunnel.localPort }), true;
    }
    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      demoTunnels = demoTunnels.filter((t) => t.id !== id);
      broadcast({ type: 'tunnels', tunnels: demoTunnels });
      return json(res, { ok: true }), true;
    }
  }
  if (url.pathname === '/api/ls') {
    const key = (url.searchParams.get('server') || 'local') + '\0' + (url.searchParams.get('path') || '');
    return json(res, listings.get(key) || []), true;
  }
  if (url.pathname === '/api/file') {
    const key = (url.searchParams.get('server') || 'local') + '\0' + (url.searchParams.get('path') || '');
    return text(res, fileTexts.get(key) || 'Demo file content\n'), true;
  }
  if (url.pathname === '/api/download-dir') return text(res, 'demo archive\n', 'application/gzip'), true;
  if (url.pathname === '/api/upload' && req.method === 'PUT') {
    req.resume();
    return json(res, { ok: true }), true;
  }
  if (url.pathname === '/api/fileop' && req.method === 'POST') return json(res, { ok: true }), true;
  if (url.pathname === '/api/git/diff') return json(res, { isRepo: true, diff: demoDiff, untracked: ['docs/media/corral-fleet-chat.webm'] }), true;
  return false;
}

const chunks = (text) => String(text).match(/.{1,42}(\s|$)/g) || [String(text)];
const streamText = (text, index) => [
  { type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'text' } } },
  ...chunks(text).map((part) => ({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } } })),
  { type: 'stream_event', event: { type: 'content_block_stop', index } },
];
const toolUse = (id, name, input, result, index) => [
  { type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } },
  { type: 'stream_event', event: { type: 'content_block_stop', index } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: false }] } },
];
const result = (input, output, cost) => ({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: input, output_tokens: output }, total_cost_usd: cost });

function chatEvents(id) {
  const s = sessions().find((item) => item.id === id) || sessions()[0];
  const init = { type: 'system', subtype: 'init', session_id: s.sessionId, model: s.model, cwd: s.cwd, agent: s.agent, tools: [] };
  if (id === 'sess-feed') return [
    init,
    { type: '_user', text: 'The replay service stutters after a few minutes. Find the bottleneck and patch it.' },
    { type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant', content: [] } } },
    ...toolUse('tool-feed-1', 'Bash', { command: 'rg "queue|drain|backpressure" src tests' }, 'src/replay.ts\nsrc/queue.ts\ntests/replay.test.ts\n', 0),
    ...streamText('The queue is allowed to grow without a drain checkpoint during replay bursts. I am adding a bounded drain before enqueue and a regression test around the 5k item case.', 1),
    result(9400, 3100, null),
  ];
  if (id === 'sess-admin') return [
    init,
    { type: '_user', text: 'Add a cheap health endpoint and surface it in the admin header.' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done. Added `GET /healthz`, a small header badge, and a smoke test that fails if the service does not answer 200.' }] } },
    result(6100, 1700, 0.04),
  ];
  if (id === 'sess-bundle') return [
    init,
    { type: '_user', text: 'Build the Linux release bundle.' },
    { type: '_error', message: 'tauri build failed: libwebkit2gtk-4.1-dev is missing on build-node' },
    { type: '_exit', code: 1 },
  ];
  return [
    init,
    { type: '_user', text: 'Check the public launch pass. Fix anything small that would make the repo look sloppy.' },
    { type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant', content: [] } } },
    ...toolUse('tool-corral-1', 'Bash', { command: 'npm test && npm run build' }, 'selftest ok\n24 frontend unit files ok\nvite build completed\n', 0),
    ...streamText('Tests are green. I found one real mismatch: the README promises Intel Mac builds but the release workflow only ships Apple silicon. I also found a static file boundary check that should use path.relative().', 1),
    { type: '_permission_request', id: 'perm-readme', tool: 'Edit', input: { file_path: 'README.md', description: 'match release wording to the actual macOS artifact' } },
  ];
}

function handleEvents(ws) {
  eventClients.add(ws);
  for (const frame of snapshotFrames()) ws.send(JSON.stringify(frame));
  ws.on('message', () => {});
  ws.on('close', () => eventClients.delete(ws));
}

function handleChat(ws, req) {
  const id = new URL(req.url, 'http://x').searchParams.get('id') || 'sess-corral';
  const timers = [];
  const send = (ev, delay) => {
    const timer = setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify(ev)); }, delay);
    timer.unref?.();
    timers.push(timer);
  };
  let delay = 150;
  for (const ev of chatEvents(id)) {
    send(ev, delay);
    delay += ev.type === 'stream_event' ? 130 : 260;
  }
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'permission') {
      ws.send(JSON.stringify({ type: '_permission_resolved', id: String(msg.requestId || ''), decision: msg.decision || 'allow' }));
      ws.send(JSON.stringify(result(18200, 4200, 0.38)));
    } else if (msg.type === 'input') {
      ws.send(JSON.stringify({ type: '_user', text: String(msg.text || '') }));
      ws.send(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Queued. I will run it after the current turn finishes.' }] } }));
    }
  });
  ws.on('close', () => timers.forEach(clearTimeout));
}

module.exports = { handleApi, handleEvents, handleChat };
