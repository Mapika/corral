function defaultLegacyCopy(text) {
  const doc = globalThis.document;
  if (!doc?.body || typeof doc.execCommand !== 'function') return false;
  const field = doc.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.left = '-9999px';
  field.style.top = '0';
  doc.body.appendChild(field);
  field.focus();
  field.select();
  try {
    return doc.execCommand('copy');
  } catch (e) {
    return false;
  } finally {
    field.remove();
  }
}

export async function writeClipboardText(text, { fallbackToAsync = true, legacyCopy = defaultLegacyCopy, writeText, timeoutMs = 1500 } = {}) {
  const value = String(text ?? '');
  if (legacyCopy?.(value)) return { ok: true };
  if (!fallbackToAsync) return { ok: false, error: 'copy failed' };

  const writer = writeText || globalThis.navigator?.clipboard?.writeText?.bind(globalThis.navigator.clipboard);
  if (!writer) return { ok: false, error: 'clipboard unavailable' };

  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('clipboard timed out')), timeoutMs);
    });
    const write = Promise.resolve().then(() => writer(value));
    await Promise.race([write, timeout]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || 'copy failed' };
  } finally {
    clearTimeout(timer);
  }
}
