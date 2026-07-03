// Hardware-back integration + ephemeral toasts for the mobile console.
//
// Overlays don't live in the URL (no router) — each open overlay registers a close handler here,
// so Android's back gesture (and a browser's back button) peels the top overlay instead of
// leaving the app. The whole stack shares ONE sentinel history entry: per-overlay entries broke
// on sheet-to-sheet transitions (close+open in the same tick queued a back() around a pushState,
// and the strays eventually walked history right out of the app). The sentinel is pushed when
// the first overlay opens, re-pushed after a back gesture that still leaves overlays open, and
// consumed only when the LAST overlay closes through its own UI.
const stack = [];
let armed = false;   // the sentinel entry currently exists
let swallow = 0;     // popstates we caused ourselves (last-overlay UI closes) — not back gestures

// Register an open overlay. Returns the deregister function — call it when the overlay closes
// through its own UI (back arrow, backdrop tap); a Svelte $effect cleanup is the natural home.
export function pushOverlay(close) {
  if (typeof history === 'undefined') return () => {};
  const entry = { close };
  stack.push(entry);
  if (!armed) {
    try { history.pushState({ overlay: true }, ''); armed = true; } catch (e) {}
  }
  return () => {
    const i = stack.indexOf(entry);
    if (i < 0) return; // the back gesture already consumed it
    stack.splice(i, 1);
    // Deferred: in a sheet-to-sheet transition (close + open in one tick) the replacement overlay
    // registers before this runs, the stack never reads empty, and history stays untouched.
    // Calling back() synchronously here raced the replacement's pushState — Chromium resolves
    // back() against the position at CALL time, so the pair walked one entry too far back and the
    // next close stepped out of the app entirely.
    queueMicrotask(() => {
      if (stack.length === 0 && armed) {
        armed = false;
        swallow += 1;
        try { history.back(); } catch (e) { swallow -= 1; }
      }
    });
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    if (swallow > 0) { swallow -= 1; return; }
    armed = false;                 // the gesture consumed the sentinel
    const entry = stack.pop();
    if (entry) entry.close();
    if (stack.length > 0) {
      try { history.pushState({ overlay: true }, ''); armed = true; } catch (e) {}
    }
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
