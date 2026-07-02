export function normalizeFilePathInput(value, fallback = '~') {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw) return fallback;
  if (raw === '/' || raw === '~') return raw;
  if (/^[A-Za-z]:\/*$/.test(raw)) return raw.slice(0, 2) + '/';
  return raw.replace(/\/+$/g, '') || '/';
}

export function parentPath(value) {
  const path = normalizeFilePathInput(value, '/');
  if (path === '/' || path === '~') return path;
  if (/^[A-Za-z]:\/?$/.test(path)) return path.endsWith('/') ? path : path + '/';
  const trimmed = path.replace(/\/+$/g, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return trimmed.startsWith('/') ? '/' : '~';
  const parent = trimmed.slice(0, idx);
  if (/^[A-Za-z]:$/.test(parent)) return parent + '/';
  return parent;
}
