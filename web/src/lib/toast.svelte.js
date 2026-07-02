// Tiny global toast store. Mutating this $state array from anywhere updates the one <Toasts/> in App.
// Replaces alert(), which is blocked/ugly in Tauri's WebView2 and breaks the dark theme.
export const toasts = $state([]);
let seq = 0;
export function toast(msg, kind = 'error', ms = 5000) {
  const id = ++seq;
  toasts.push({ id, msg, kind });
  setTimeout(() => { const i = toasts.findIndex((t) => t.id === id); if (i >= 0) toasts.splice(i, 1); }, ms);
}
