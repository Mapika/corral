// Pure pieces of the phone's Web Push enrolment: decoding the VAPID key for
// pushManager.subscribe and flattening a PushSubscription for the backend's query-string API.

export function applicationServerKeyBytes(b64u) {
  const s = String(b64u || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

// PushSubscription.toJSON() -> { endpoint, p256dh, auth } or null when malformed.
export function subscriptionParams(json) {
  const endpoint = String(json?.endpoint || '');
  const p256dh = String(json?.keys?.p256dh || '');
  const auth = String(json?.keys?.auth || '');
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) return null;
  return { endpoint, p256dh, auth };
}
