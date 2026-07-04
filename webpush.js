// Web Push without a relay: the browser-paired phone subscribes through the service worker and
// the backend pushes straight to the browser vendor's push endpoint. Message encryption is
// RFC 8291 (aes128gcm) and sender identity is RFC 8292 (VAPID), both on node:crypto — the
// encrypt path is selftested against RFC 8291 Appendix A. State (VAPID keypair + subscriptions)
// lives in <data-dir>/webpush.json; keys are minted on first use.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Same fallback rule as chat.js/push.js: an existing pre-rename ~/.codapp keeps being used.
const DATA_DIR = fs.existsSync(path.join(os.homedir(), '.codapp')) && !fs.existsSync(path.join(os.homedir(), '.corral'))
  ? path.join(os.homedir(), '.codapp')
  : path.join(os.homedir(), '.corral');
const CONF = path.join(DATA_DIR, 'webpush.json');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');

function load() {
  try { return JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch (e) { return {}; }
}
let state = load();

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = CONF + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, CONF);
  } catch (e) {}
}

// --- VAPID keypair (P-256, stored as JWK) ---
function keys() {
  if (!state.vapid || !state.vapid.d) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    state.vapid = privateKey.export({ format: 'jwk' });   // includes x/y (public) + d (private)
    save();
  }
  return state.vapid;
}

// The applicationServerKey the page hands to pushManager.subscribe: 65-byte uncompressed point.
function publicKey() {
  const k = keys();
  return b64u(Buffer.concat([Buffer.from([4]), fromB64u(k.x), fromB64u(k.y)]));
}

// --- RFC 8291 payload encryption (pure given the inputs — selftested) ---
// `testing` injects the app-server private key + salt to reproduce the RFC's Appendix A message.
function encrypt(payload, { p256dh, auth } = {}, testing = {}) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('bad p256dh');
  if (authSecret.length !== 16) throw new Error('bad auth');
  const ecdh = crypto.createECDH('prime256v1');
  if (testing.asPrivate) ecdh.setPrivateKey(fromB64u(testing.asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();                    // uncompressed, 65 bytes
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = testing.salt ? fromB64u(testing.salt) : crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const record = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);   // 0x02 = last record
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);                         // salt(16) | rs(4) | idlen(1)
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, ct]);
}

// --- RFC 8292 VAPID auth header (pure given the keypair — selftested) ---
function vapidAuth(endpoint, jwk = keys(), nowSec = Math.floor(Date.now() / 1000)) {
  const enc = (obj) => b64u(Buffer.from(JSON.stringify(obj)));
  const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({
    aud: new URL(endpoint).origin,
    exp: nowSec + 12 * 3600,
    sub: 'https://github.com/Mapika/corral',
  });
  const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  const pub = b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]));
  return 'vapid t=' + unsigned + '.' + b64u(sig) + ', k=' + pub;
}

// --- subscriptions ---
function subs() { return Array.isArray(state.subscriptions) ? state.subscriptions : []; }

function subscribe({ endpoint, p256dh, auth } = {}) {
  const ep = String(endpoint || '');
  if (!/^https:\/\//.test(ep)) throw new Error('endpoint must be https');
  const pub = fromB64u(p256dh), sec = fromB64u(auth);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('bad p256dh key');
  if (sec.length !== 16) throw new Error('bad auth secret');
  state.subscriptions = [...subs().filter((s) => s.endpoint !== ep), { endpoint: ep, p256dh, auth, addedAt: Date.now() }];
  save();
  return status();
}

function unsubscribe(endpoint) {
  const ep = String(endpoint || '');
  state.subscriptions = subs().filter((s) => s.endpoint !== ep);
  save();
  return status();
}

function status() {
  return { publicKey: publicKey(), count: subs().length };
}

// --- delivery ---
async function sendTo(sub, payload, urgency) {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: urgency === 'high' ? 'high' : 'normal',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: vapidAuth(sub.endpoint),
    },
    body: encrypt(payload, sub),
  });
  if (res.status === 404 || res.status === 410) return 'gone';   // subscription expired/revoked
  if (!res.ok) throw new Error('push endpoint ' + res.status);
  return 'ok';
}

// Fan out one notification to every subscribed phone; expired subscriptions are pruned.
async function notify({ title, body, priority, sessionId, reviewId } = {}) {
  const targets = subs();
  if (!targets.length) return;
  const payload = Buffer.from(JSON.stringify({ title: title || 'corral', body: body || '', session: sessionId || null, ...(reviewId ? { review: reviewId } : {}) }));
  const results = await Promise.allSettled(targets.map((s) => sendTo(s, payload, priority)));
  const gone = new Set(targets.filter((s, i) => results[i].status === 'fulfilled' && results[i].value === 'gone').map((s) => s.endpoint));
  if (gone.size) { state.subscriptions = subs().filter((s) => !gone.has(s.endpoint)); save(); }
  for (const r of results) if (r.status === 'rejected') console.error('webpush failed:', r.reason && r.reason.message);
}

module.exports = { publicKey, subscribe, unsubscribe, status, notify, encrypt, vapidAuth };
