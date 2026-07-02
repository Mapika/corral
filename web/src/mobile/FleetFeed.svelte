<script>
  // Live fleet as a vertical feed — every running agent streaming in its own black frame.
  // Reuses the desktop FleetTile (self-contained read-only tail over the chat socket).
  import FleetTile from '../FleetTile.svelte';
  import { isLiveSession } from '../lib/operatorStatus.mjs';

  let { data, onOpenSession, onLaunch } = $props();
  let live = $derived(data.d.sessions.filter((s) => isLiveSession(s)));
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
      <div class="cell"><FleetTile session={s} onOpen={() => onOpenSession?.(s)} /></div>
    {/each}
  {/if}
</div>

<style>
  .feed { display: flex; flex-direction: column; gap: var(--s2); padding: var(--s2) 0 var(--s4); }
  .cell { height: 46dvh; min-height: 300px; display: grid; }
  .empty { min-height: 56dvh; display: flex; flex-direction: column; justify-content: center; gap: 12px; padding: 0 var(--s4); }
  .empty b { font-size: clamp(34px, 9vw, 46px); line-height: 1.02; font-weight: var(--w-light); color: var(--text); }
  .empty span { color: var(--text-dim); font-size: 13px; max-width: 300px; }
  .ranch { align-self: flex-start; margin-top: 14px; background: var(--paper); color: var(--ink); border: 0; border-radius: var(--pill); padding: 12px 22px; font: var(--w-med) 13px var(--sans); cursor: pointer; }
</style>
