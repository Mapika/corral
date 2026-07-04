// Pure pieces of the desktop self-update flow (0.8.2): the phase machine the titlebar pill
// renders. The Tauri side (check / downloadAndInstall / relaunch) lives in App.svelte behind
// the inTauri gate; this reducer just keeps the pill honest through the download.
export function updateReduce(st, ev) {
  const s = { phase: st?.phase || 'idle', version: st?.version || '', got: st?.got || 0, total: st?.total || 0, error: st?.error || '' };
  switch (ev?.type) {
    case 'found': return { ...s, phase: 'available', version: String(ev.version || ''), error: '' };
    case 'begin': return { ...s, phase: 'downloading', got: 0, total: ev.total || 0, error: '' };
    case 'chunk': return s.phase === 'downloading' ? { ...s, got: s.got + (ev.size || 0) } : s;
    case 'downloaded': return { ...s, phase: 'restarting' };
    // a failed download falls back to "update available" so the pill stays tappable
    case 'error': return { ...s, phase: s.version ? 'available' : 'idle', error: String(ev.message || 'update failed') };
    default: return s;
  }
}

export function updateLabel(st) {
  if (!st) return '';
  if (st.phase === 'available') return 'update to ' + st.version;
  if (st.phase === 'downloading') {
    if (!st.total) return 'updating…';
    return 'updating ' + Math.min(99, Math.round((st.got / st.total) * 100)) + '%';
  }
  if (st.phase === 'restarting') return 'restarting…';
  return '';
}
