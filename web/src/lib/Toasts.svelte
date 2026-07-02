<script>
  import { toasts, toast } from './toast.svelte.js';
  const dismiss = (id) => { const i = toasts.findIndex((t) => t.id === id); if (i >= 0) toasts.splice(i, 1); };
</script>

<div class="toasts">
  {#each toasts as t (t.id)}
    <button class="toast" class:err={t.kind === 'error'} onclick={() => dismiss(t.id)} title="Dismiss">{t.msg}</button>
  {/each}
</div>

<style>
  .toasts { position: fixed; bottom: var(--s4); right: var(--s4); z-index: 100; display: flex; flex-direction: column; gap: 9px; pointer-events: none; }
  /* borderless raised surface (shadow does the lift); the left rule carries state — alert = error */
  .toast { pointer-events: auto; max-width: 380px; text-align: left; background: var(--surface-2); color: var(--text); border: 0; border-left: 2px solid var(--text-dim); padding: 11px 15px; font: var(--w-reg) 13px/1.45 var(--sans); cursor: pointer; box-shadow: 0 14px 40px rgba(0,0,0,.5); animation: tin .18s ease both; }
  .toast.err { border-left-color: var(--alert); }
  .toast:hover { border-left-color: var(--text); }
  @keyframes tin { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
</style>
