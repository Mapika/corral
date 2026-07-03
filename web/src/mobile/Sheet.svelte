<script>
  // Bottom sheet — the phone's one modal surface. Backdrop tap, the grip, or hardware back
  // closes it (every sheet registers on the shared back stack by existing).
  import { pushOverlay } from './nav.svelte.js';
  let { onclose, label = '', children } = $props();
  $effect(() => pushOverlay(() => onclose?.()));
</script>

<div class="backdrop" onclick={() => onclose?.()} aria-hidden="true"></div>
<div class="sheet" role="dialog" aria-modal="true" aria-label={label}>
  <button class="grip" onclick={() => onclose?.()} aria-label="Close"><span></span></button>
  {@render children?.()}
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .55); z-index: 40; animation: fade .16s ease both; }
  .sheet {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 41;
    background: var(--surface); max-height: 88dvh; overflow-y: auto; overscroll-behavior: contain;
    padding: 0 var(--s4) calc(var(--s4) + env(safe-area-inset-bottom, 0px));
    animation: rise .2s ease both;
  }
  .grip { position: sticky; top: 0; display: grid; place-items: center; width: 100%; padding: 10px 0 14px; background: var(--surface); border: 0; cursor: pointer; }
  .grip span { width: 38px; height: 4px; border-radius: var(--pill); background: var(--chip-hi); }
  @keyframes rise { from { transform: translateY(24px); opacity: 0; } to { transform: none; opacity: 1; } }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .sheet, .backdrop { animation: none; } }
</style>
