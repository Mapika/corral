<script>
  // The app's single top bar: brand (→ home), view context, running indicator — and, inside the
  // Tauri shell (decorations:false), the drag region + window controls. In a plain browser the
  // same bar renders without the window buttons. There is deliberately no second header below.
  import Icon from './Icon.svelte';

  let { crumb = null, running = 0, back = null, onHome, onBack, onRunning, onPush, onPhone, update = '', updateError = '', onUpdate } = $props();

  const inTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
  let appWin = null;
  let maximized = $state(false);

  async function win() {
    if (!appWin) { const { getCurrentWindow } = await import('@tauri-apps/api/window'); appWin = getCurrentWindow(); }
    return appWin;
  }
  async function sync() { try { maximized = await (await win()).isMaximized(); } catch (e) {} }
  const minimize = async () => { try { await (await win()).minimize(); } catch (e) {} };
  const toggleMax = async () => { try { await (await win()).toggleMaximize(); await sync(); } catch (e) {} };
  const close = async () => { try { await (await win()).close(); } catch (e) {} };

  $effect(() => {
    if (!inTauri) return;
    let un;
    (async () => { const w = await win(); await sync(); un = await w.onResized(sync); })();
    return () => un && un();
  });
</script>

<div class="titlebar" data-tauri-drag-region>
  <button class="brand" onclick={() => onHome?.()} title="Dashboard">corral</button>
  {#if back}
    <button class="backbtn" onclick={() => onBack?.()} title="Back to {back.label}">&lsaquo; {back.label}</button>
  {/if}
  {#if crumb}
    <span class="crumb" data-tauri-drag-region>{crumb.name}<span class="chost">{crumb.host}</span></span>
  {/if}
  <span class="sp" data-tauri-drag-region></span>
  {#if update}
    <button class="upd" onclick={() => onUpdate?.()} title={updateError ? 'Last try failed: ' + updateError + ' — click to retry' : 'Download and restart into the new version'}>{update}</button>
  {/if}
  {#if running}
    <button class="run" onclick={() => onRunning?.()} title="Show running sessions"><span class="livedot"></span>{running} running</button>
  {/if}
  {#if onPhone}
    <button class="bell" onclick={() => onPhone?.()} title="Ranch from your phone" aria-label="Phone pairing"><Icon name="phone" size={13} /></button>
  {/if}
  {#if onPush}
    <button class="bell" onclick={() => onPush?.()} title="Push notifications" aria-label="Push notifications"><Icon name="bell" size={13} /></button>
  {/if}
  {#if inTauri}
    <div class="wbtns">
      <button class="wbtn" onclick={minimize} title="Minimize" aria-label="Minimize"><Icon name="minimize" size={15} /></button>
      <button class="wbtn" onclick={toggleMax} title={maximized ? 'Restore' : 'Maximize'} aria-label="Maximize / restore"><Icon name={maximized ? 'restore' : 'maximize'} size={13} /></button>
      <button class="wbtn close" onclick={close} title="Close" aria-label="Close"><Icon name="close" size={15} /></button>
    </div>
  {/if}
</div>

<style>
  /* drag region is the whole bar except the buttons; double-click maximises (Tauri handles both) */
  .titlebar { flex: none; height: 34px; display: flex; align-items: center; gap: var(--s3); background: var(--bg); border-bottom: 1px solid var(--seam); user-select: none; -webkit-user-select: none; }
  .brand { flex: none; background: none; border: 0; cursor: pointer; padding: 0 0 0 var(--s3); font: var(--w-reg) 11px var(--sans); letter-spacing: .14em; text-transform: uppercase; color: var(--text-dim); transition: color .12s; }
  .brand:hover { color: var(--text); }
  .backbtn { flex: none; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--chip); border: 0; border-radius: var(--pill); color: var(--text-dim); padding: 3px 11px; cursor: pointer; font: var(--w-reg) 11px var(--sans); transition: color .12s, background .12s; }
  .backbtn:hover { color: var(--text); background: var(--chip-hi); }
  .crumb { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--text); }
  .crumb .chost { margin-left: 9px; font: 10px var(--mono); color: var(--text-faint); }
  .sp { flex: 1; align-self: stretch; min-width: var(--s2); }
  .upd { flex: none; height: 100%; background: none; border: 0; padding: 0 var(--s2); cursor: pointer; font-size: 9.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--mercury-flow); }
  .upd:hover { color: var(--text); }
  .run { flex: none; display: inline-flex; align-items: center; gap: 7px; height: 100%; background: none; border: 0; padding: 0 var(--s2); cursor: pointer; font-size: 9.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--text); }
  .run:hover { color: var(--text-dim); }
  .livedot { width: 6px; height: 6px; border-radius: 50%; background: var(--mercury-flow); animation: breathe 2.4s ease-in-out infinite; }
  @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
  .bell { flex: none; display: grid; place-items: center; height: 100%; padding: 0 var(--s2); background: none; border: 0; color: var(--text-faint); cursor: pointer; transition: color .12s; }
  .bell:hover { color: var(--text); }
  .wbtns { display: flex; height: 100%; }
  .wbtn { width: 46px; height: 100%; display: grid; place-items: center; background: none; border: 0; color: var(--text-dim); cursor: pointer; transition: background .12s, color .12s; }
  .wbtn:hover { background: var(--surface-2); color: var(--text); }
  .wbtn.close:hover { background: #b3261e; color: #fff; }
  .brand:focus-visible, .run:focus-visible, .wbtn:focus-visible, .bell:focus-visible { outline: 0; box-shadow: inset 0 0 0 1px var(--text-dim); }
  @media (prefers-reduced-motion: reduce) { .livedot { animation: none; } }
</style>
