<script>
  // The fleet view: every live agent across every host as a grid of streaming tiles.
  import FleetTile from './FleetTile.svelte';
  import Icon from './lib/Icon.svelte';

  let { sessions = [], onInspectChat, onNewChat } = $props();

  const LIVE = new Set(['busy', 'starting', 'idle']);
  const rank = (s) => (s.status === 'busy' ? 0 : s.status === 'starting' ? 1 : 2);
  let active = $derived([...sessions.filter((s) => LIVE.has(s.status))]
    .sort((a, b) => rank(a) - rank(b) || (b.updatedAt || 0) - (a.updatedAt || 0)));
  let hostCount = $derived(new Set(active.map((s) => s.host || 'local')).size);
</script>

<section class="fleet">
  <div class="wrap">
    <div class="head">
      <span class="sectionlabel">Fleet</span>
      {#if active.length}
        <span class="count">{active.length} live {active.length === 1 ? 'agent' : 'agents'} · {hostCount} {hostCount === 1 ? 'host' : 'hosts'}</span>
      {/if}
    </div>
    {#if active.length}
      <div class="grid">
        {#each active as s (s.id)}
          <FleetTile session={s} onOpen={() => onInspectChat?.(s)} />
        {/each}
      </div>
    {:else}
      <div class="empty">
        <b>The corral is quiet.</b>
        <small>Live agents appear here the moment they start working.</small>
        <button class="mini" onclick={() => onNewChat?.('local')}><Icon name="plus" size={13} /> new chat</button>
      </div>
    {/if}
  </div>
</section>

<style>
  .fleet { position: absolute; inset: 0; overflow: auto; overflow-x: hidden; background: var(--bg); padding: var(--s5); }
  .wrap { max-width: 1240px; margin: 0 auto; }
  .head { min-height: 40px; display: flex; align-items: center; gap: var(--s3); padding: 0 2px 10px; }
  .sectionlabel { color: var(--text-faint); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; }
  .count { color: var(--text-faint); font: 11px var(--mono); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 2px; }
  .empty { display: grid; justify-items: start; gap: 10px; padding: var(--s5) 2px; }
  .empty b { color: var(--text); font: var(--w-light) 26px/1.1 var(--sans); }
  .empty small { color: var(--text-faint); font: 12px/1.5 var(--mono); }
  .mini { display: inline-flex; align-items: center; gap: 7px; margin-top: 6px; background: var(--chip); border: 0; color: var(--text-dim); border-radius: var(--pill); padding: 8px 15px; cursor: pointer; font: var(--w-reg) 12px var(--sans); transition: color .12s, background .12s; }
  .mini:hover { color: var(--text); background: var(--chip-hi); }
  @media (max-width: 760px) {
    .fleet { padding: var(--s3); }
    .grid { grid-template-columns: minmax(0, 1fr); }
  }
</style>
