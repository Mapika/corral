export function openExternalUrl(url, { openImpl = globalThis.open } = {}) {
  const text = String(url || '').trim();
  if (!text) return { ok: false, error: 'missing url' };
  let parsed;
  try {
    parsed = new URL(text);
  } catch (e) {
    return { ok: false, error: 'invalid url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'unsupported url scheme' };
  }
  if (typeof openImpl !== 'function') return { ok: false, error: 'window.open unavailable' };
  try {
    const opened = openImpl(text, '_blank', 'noopener,noreferrer');
    if (opened === null) return { ok: false, error: 'popup blocked' };
    return { ok: true, url: text };
  } catch (e) {
    return { ok: false, error: e?.message || 'open failed' };
  }
}
