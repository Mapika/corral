// Hardware-back integration + ephemeral toasts for the mobile console.
//
// Overlays don't live in the URL (no router) — each open overlay registers a close handler here
// and pushes one history entry, so Android's back gesture (and a browser's back button) peels
// the top overlay instead of leaving the app. A UI-driven close consumes its history entry with
// history.back(), keeping the stack and the history in step either way.
const stack = [];
let swallow = 0; // popstates we caused ourselves (UI closes) — not back gestures

// Register an open overlay. Returns the deregister function — call it when the overlay closes
// through its own UI (back arrow, backdrop tap); a Svelte $effect cleanup is the natural home.
export function pushOverlay(close) {
  if (typeof history === 'undefined') return () => {};
  const entry = { close };
  stack.push(entry);
  try { history.pushState({ overlay: stack.length }, ''); } catch (e) {}
  return () => {
    const i = stack.indexOf(entry);
    if (i < 0) return; // the back gesture already consumed it
    stack.splice(i, 1);
    swallow += 1;
    try { history.back(); } catch (e) { swallow -= 1; }
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    if (swallow > 0) { swallow -= 1; return; }
    const entry = stack.pop();
    if (entry) entry.close();
  });
}

// One toast at a time, self-clearing — for actions whose failure was previously swallowed
// (end/rename/stop from a sheet has no other place to speak).
export const toast = $state({ msg: '' });
let toastTimer = null;
export function showToast(msg) {
  toast.msg = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.msg = ''), 3500);
}
