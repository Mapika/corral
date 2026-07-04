// The default backend client — one server, module-level base/token. '' base = same origin (the
// desktop webview, vite dev, a phone browser opened on the pair URL); the Tauri shell injects a
// token via setToken(). The phone console builds additional per-ranch clients straight from
// createApiClient; everything here stays a plain named export so desktop call sites never care.
import { createApiClient } from './apiClient.mjs';

let TOKEN = '';
export function setToken(t) { TOKEN = t || ''; }
let BASE = '';
export function setServer(base) { BASE = base || ''; }
export function getServer() { return BASE; }

export const defaultClient = createApiClient({ getBase: () => BASE, getToken: () => TOKEN });

export const {
  listSessions, listHosts, listServerStatus, launchSession, searchHistory,
  setSessionLabel, killSession, interruptSession, removeSession, resumeSession, respondPermission,
  lsDir, fileUrl, dirDownloadUrl, fileText, mkdir, renameItem, deleteItem, gitDiff, uploadFile,
  listQueue, queueAdd, queueRemove, queueMove, queueHold, queueRelease, queueKeep, queueBounce,
  chatSocket, eventsSocket, termSocket,
  getRemoteConfig, setRemoteConfig,
  getPushConfig, setPushConfig, testPush,
  getWebPush, webPushSubscribe, webPushUnsubscribe, testWebPush,
  listTunnels, addTunnel, removeTunnel,
} = defaultClient;
