// Backend client factory. One corral server = one client; the desktop console uses a single
// default client (api.js), the phone console builds one per paired ranch. base/token come in as
// accessors so a client survives its server moving (pocket restarts re-mint both every time).
import { requestJson, requestMutation, requestText } from './apiRequest.mjs';
import { wsUrl } from './serverBase.mjs';

export function createApiClient({ getBase = () => '', getToken = () => '' } = {}) {
  const abs = (path) => (getBase() || '') + path;
  const token = () => getToken() || '';
  const headers = () => (token() ? { Authorization: 'Bearer ' + token() } : {});
  const json = (path, opts = {}) => requestJson(abs(path), { ...opts, getHeaders: headers });
  const mutate = (path, opts = {}) => requestMutation(abs(path), { ...opts, getHeaders: headers });

  async function listSessions() {
    return json('/api/chat/list');
  }

  async function listHosts() {
    return json('/api/hosts');
  }

  async function listServerStatus() {
    return json('/api/servers', { retries: 0 });
  }

  async function launchSession({ host = 'local', dir = '', model, perm, agent, worktree, prompt } = {}) {
    const q = new URLSearchParams({ host });
    if (dir) q.set('dir', dir);
    if (model) q.set('model', model);
    if (perm) q.set('perm', perm);
    if (agent) q.set('agent', agent);
    if (worktree) q.set('worktree', '1');
    if (prompt) q.set('prompt', prompt);
    return json('/api/chat/launch?' + q.toString(), { method: 'POST', retries: 0 });
  }

  async function searchHistory(q, limit = 20) {
    return json('/api/history/search?q=' + encodeURIComponent(q) + '&limit=' + limit, { retries: 0 });
  }

  async function setSessionLabel(id, label) {
    return mutate('/api/chat/label?id=' + encodeURIComponent(id) + '&label=' + encodeURIComponent(label || ''), { method: 'POST' });
  }

  async function killSession(id) {
    return mutate('/api/chat/kill?id=' + encodeURIComponent(id), { method: 'POST' });
  }

  async function interruptSession(id) {
    return mutate('/api/chat/interrupt?id=' + encodeURIComponent(id), { method: 'POST' });
  }

  async function removeSession(id) {
    return mutate('/api/chat/remove?id=' + encodeURIComponent(id), { method: 'POST' });
  }

  async function resumeSession(id) {
    return json('/api/chat/resume?id=' + encodeURIComponent(id), { method: 'POST', retries: 0 });
  }

  // One-tap answer to a roster-surfaced permission prompt (session.pendingPerm.id).
  async function respondPermission(id, requestId, decision) {
    const q = new URLSearchParams({ id, requestId, decision });
    return json('/api/chat/permission?' + q.toString(), { method: 'POST', retries: 0 });
  }

  // --- files ---
  async function lsDir(host, p) {
    return json('/api/ls?server=' + encodeURIComponent(host) + '&path=' + encodeURIComponent(p));
  }
  // <img>/<iframe>/<a> can't set an Authorization header, so GET file/download URLs carry the token
  // as a ?tk= param (loopback, single-user — acceptable). No-op in dev (no token).
  function fileUrl(host, p, opts = {}) {
    let u = abs('/api/file?server=' + encodeURIComponent(host) + '&path=' + encodeURIComponent(p));
    if (opts.dl) u += '&dl=1';
    if (token()) u += '&tk=' + encodeURIComponent(token());
    return u;
  }
  function dirDownloadUrl(host, p) {
    let u = abs('/api/download-dir?server=' + encodeURIComponent(host) + '&path=' + encodeURIComponent(p));
    if (token()) u += '&tk=' + encodeURIComponent(token());
    return u;
  }
  async function fileText(host, p) {
    return requestText(fileUrl(host, p), { getHeaders: headers, retries: 0 });
  }
  // mkdir / rename / delete. `p` is the parent dir for mkdir, the item path for rename/delete.
  async function fileop(host, op, p, name) {
    const q = new URLSearchParams({ server: host, op, path: p });
    if (name) q.set('name', name);
    return json('/api/fileop?' + q.toString(), { method: 'POST', retries: 0 });
  }
  const mkdir = (host, dir, name) => fileop(host, 'mkdir', dir, name);
  const renameItem = (host, p, name) => fileop(host, 'rename', p, name);
  const deleteItem = (host, p) => fileop(host, 'delete', p);

  // git diff of a session/dir — { isRepo, diff, untracked[] }
  async function gitDiff(host, p) {
    return json('/api/git/diff?server=' + encodeURIComponent(host) + '&path=' + encodeURIComponent(p), { fallback: { isRepo: false, diff: '', untracked: [] } });
  }

  function uploadFile(host, dir, file, onProgress, name) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', abs('/api/upload?server=' + encodeURIComponent(host) + '&path=' + encodeURIComponent(dir) + '&name=' + encodeURIComponent(name || file.name)));
      if (token()) xhr.setRequestHeader('Authorization', 'Bearer ' + token());
      xhr.upload.onprogress = (e) => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch (x) { resolve({ ok: xhr.status < 300 }); } };
      xhr.onerror = () => reject(new Error('upload failed'));
      xhr.send(file);
    });
  }

  const authed = (ws) => {
    if (token()) ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token: token() })));
    return ws;
  };

  function chatSocket(id) {
    return authed(new WebSocket(wsUrl(getBase(), '/chat?id=' + encodeURIComponent(id))));
  }

  // /events push socket: the server streams {type:'sessions'|'tunnels'} snapshots on change, so the
  // app can stand down its polling while connected. Same first-frame auth as chatSocket.
  function eventsSocket() {
    return authed(new WebSocket(wsUrl(getBase(), '/events')));
  }

  // /ws terminal bridge: local shell, plain ssh, or tmux attach. Raw PTY output arrives as text
  // frames; input goes as {type:'data'}, size changes as {type:'resize'}. Same first-frame auth.
  function termSocket({ host = 'local', target = '', cwd = '', cols = 80, rows = 24 } = {}) {
    const q = new URLSearchParams({ server: host, cols: String(cols), rows: String(rows) });
    if (target) q.set('target', target);
    if (cwd) q.set('cwd', cwd);
    return authed(new WebSocket(wsUrl(getBase(), '/ws?' + q.toString())));
  }

  // --- remote access (phone pairing) — loopback/desktop only; the server hides secrets otherwise ---
  async function getRemoteConfig() { return json('/api/remote'); }
  async function setRemoteConfig({ enabled, rotate, certPath, keyPath } = {}) {
    const q = new URLSearchParams();
    if (enabled != null) q.set('enabled', enabled ? '1' : '0');
    if (rotate) q.set('rotate', '1');
    if (certPath != null) q.set('certPath', certPath);
    if (keyPath != null) q.set('keyPath', keyPath);
    return json('/api/remote?' + q.toString(), { method: 'POST', retries: 0 });
  }

  // --- phone push (ntfy relay) ---
  async function getPushConfig() { return json('/api/push'); }
  async function setPushConfig({ enabled, actions, appClick, server, topic, input, done, fail } = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of [['enabled', enabled], ['actions', actions], ['appClick', appClick], ['input', input], ['done', done], ['fail', fail]]) if (v != null) q.set(k, v ? '1' : '0');
    if (server != null) q.set('server', server);
    if (topic != null) q.set('topic', topic);
    return json('/api/push?' + q.toString(), { method: 'POST', retries: 0 });
  }
  async function testPush() { return json('/api/push/test', { method: 'POST', retries: 0 }); }

  // --- Web Push (relay-free — the phone subscribes through the service worker) ---
  async function getWebPush() { return json('/api/webpush'); }
  async function webPushSubscribe({ endpoint, p256dh, auth } = {}) {
    return json('/api/webpush/subscribe?' + new URLSearchParams({ endpoint, p256dh, auth }), { method: 'POST', retries: 0 });
  }
  async function webPushUnsubscribe(endpoint) {
    return json('/api/webpush/unsubscribe?' + new URLSearchParams({ endpoint }), { method: 'POST', retries: 0 });
  }
  async function testWebPush() { return json('/api/webpush/test', { method: 'POST', retries: 0 }); }

  // --- tunnels ---
  async function listTunnels() { return json('/api/tunnels'); }
  async function addTunnel(host, opts) {
    const q = new URLSearchParams({ server: host, remotePort: String(opts.remotePort) });
    if (opts.localPort) q.set('localPort', String(opts.localPort));
    if (opts.remoteHost) q.set('remoteHost', opts.remoteHost);
    if (opts.http) q.set('http', '1');
    return json('/api/tunnels?' + q.toString(), { method: 'POST', retries: 0 });
  }
  async function removeTunnel(id) { return mutate('/api/tunnels?id=' + encodeURIComponent(id), { method: 'DELETE' }); }

  return {
    listSessions, listHosts, listServerStatus, launchSession, searchHistory,
    setSessionLabel, killSession, interruptSession, removeSession, resumeSession, respondPermission,
    lsDir, fileUrl, dirDownloadUrl, fileText, mkdir, renameItem, deleteItem, gitDiff, uploadFile,
    chatSocket, eventsSocket, termSocket,
    getRemoteConfig, setRemoteConfig,
    getPushConfig, setPushConfig, testPush,
    getWebPush, webPushSubscribe, webPushUnsubscribe, testWebPush,
    listTunnels, addTunnel, removeTunnel,
  };
}
