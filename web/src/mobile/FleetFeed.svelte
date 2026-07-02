<script>
  // Live fleet as a vertical feed — every running agent streaming in its own black frame.
  // Tap opens the chat; press-and-hold opens quick actions (whoa there / end) without leaving
  // the feed. Reuses the desktop FleetTile (self-contained read-only tail over the chat socket).
  import FleetTile from '../FleetTile.svelte';
  import { interruptSession, killSession } from '../lib/api.js';
  import { isLiveSession } from '../lib/operatorStatus.mjs';
  import { sessionHostLabel, sessionPathParts } from '../lib/sessionView.mjs';
  import Sheet from './Sheet.svelte';

  let { data, onOpenSession, onLaunch } = $props();
  let live = $derived(data.d.sessions.filter((s) => isLiveSession(s)));

  let actions = $state(null);        // session under the long-press action sheet
  let pressTimer = null;
  let longFired = false;

  function down(s) {
    longFired = false;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      longFired = true;
      actions = s;
      try { navigator.vibrate?.(12); } catch (e) {}
    }, 480);
  }
  const cancelPress = () => clearTimeout(pressTimer);
  function openTile(s) {
    if (longFired) { longFired = false; return; }   // the hold consumed this tap
    onOpenSession?.(s);
  }
  async function whoa(s) {
    actions = null;
    try { await interruptSession(s.id); await data.poll(); } catch (e) {}
  }
  async function end(s) {
    actions = null;
    try { await killSession(s.id); await data.poll(); } catch (e) {}
  }
</script>

<div class="feed">
  {#if live.length === 0}
    <div class="empty">
      <b>Nothing running.</b>
      <span>The fleet view streams every live agent, all hosts at once.</span>
      <button class="ranch" onclick={() => onLaunch?.()}>Ranch an agent</button>
    </div>
  {:else}
    {#each live as s (s.id)}
      <div class="cell" role="presentation"
           onpointerdown={() => down(s)} onpointerup={cancelPress} onpointercancel={cancelPress}
           onpointerleave={cancelPress} oncontextmenu={(e) => e.preventDefault()}>
        <FleetTile session={s} onOpen={() => openTile(s)} />
      </div>
    {/each}
  {/if}
</div>

{#if actions}
  <Sheet onclose={() => (actions = null)} label="Session actions">
    <div class="menu">
      <div class="who">
        <b>{actions.label || sessionPathParts(actions.cwd).project}</b>
        <span>{sessionHostLabel(actions.host)}</span>
      </div>
      <button onclick={() => { const s = actions; actions = null; onOpenSession?.(s); }}>Open</button>
      {#if actions.status === 'busy' || actions.status === 'starting'}
        <button onclick={() => whoa(actions)}>Whoa there — stop this turn</button>
      {/if}
      <button class="danger" onclick={() => end(actions)}>End session</button>
    </div>
  </Sheet>
{/if}

<style>
  .feed { display: flex; flex-direction: column; gap: var(--s2); padding: var(--s2) 0 var(--s4); }
  .cell { height: 46dvh; min-height: 300px; display: grid; touch-action: pan-y; }
  .empty { min-height: 56dvh; display: flex; flex-direction: column; justify-content: center; gap: 12px; padding: 0 var(--s4); }
  .empty b { font-size: clamp(34px, 9vw, 46px); line-height: 1.02; font-weight: var(--w-light); color: var(--text); }
  .empty span { color: var(--text-dim); font-size: 13px; max-width: 300px; }
  .ranch { align-self: flex-start; margin-top: 14px; background: var(--paper); color: var(--ink); border: 0; border-radius: var(--pill); padding: 12px 22px; font: var(--w-med) 13px var(--sans); cursor: pointer; }

  .menu { display: flex; flex-direction: column; }
  .who { display: flex; align-items: baseline; gap: 10px; padding: 4px 4px 14px; border-bottom: 1px solid var(--seam); }
  .who b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: 15px; font-weight: var(--w-med); }
  .who span { margin-left: auto; flex: none; color: var(--text-faint); font: 10.5px var(--mono); }
  .menu button { min-height: 54px; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--seam); color: var(--text); font: var(--w-reg) 15px var(--sans); cursor: pointer; padding: 0 4px; }
  .menu button:last-child { border-bottom: 0; }
  .menu .danger { color: var(--alert); }
</style>
