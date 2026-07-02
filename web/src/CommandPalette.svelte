<script>
  import { commandPaletteKeyAction } from './lib/commandPaletteKeys.mjs';
  import { filterCommandItems } from './lib/commandItems.mjs';

  let { items = [], onclose, onselect } = $props();

  let query = $state('');
  let active = $state(0);
  let inputEl;

  let results = $derived(filterCommandItems(items, query, 12));

  $effect(() => {
    query;
    items;
    active = 0;
  });

  $effect(() => {
    inputEl?.focus();
  });

  function pick(it) {
    if (!it) return;
    onselect?.(it);
  }

  function key(e) {
    const action = commandPaletteKeyAction({ key: e.key, active, resultCount: results.length });
    e.stopPropagation();
    if (action.type === 'none') return;
    e.preventDefault();
    active = action.active;
    if (action.type === 'close') { onclose?.(); return; }
    if (action.type === 'pick') pick(results[action.active]);
  }

  const kindLabel = (k) => ({
    view: 'view',
    'new-chat': 'new',
    files: 'files',
    tunnels: 'tunnel',
    'recent-project': 'recent',
    'operator-brief': 'brief',
    'operator-filter': 'queue',
    'operator-refresh': 'sync',
    'tmux-chat': 'tmux',
    'tmux-files': 'tmux',
    'session-inspect': 'inspect',
    'session-remove': 'remove',
    session: 'session',
    'session-files': 'files',
    'session-changes': 'changes',
    'session-tunnels': 'tunnel',
    tunnel: 'live',
  }[k] || k);
</script>

<div class="veil" role="presentation" onclick={() => onclose?.()}>
  <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={key}>
    <input
      bind:this={inputEl}
      bind:value={query}
      spellcheck="false"
      autocomplete="off"
      placeholder="Jump to a session, host, file browser, or tunnel"
      aria-label="Search commands"
    />

    <div class="results" role="listbox" aria-label="Command results">
      {#if results.length === 0}
        <div class="empty">
          <b>No command found.</b>
          <span>Try a host name, project folder, "files", "chat", or "tunnel".</span>
        </div>
      {:else}
        {#each results as it, i (it.id)}
          <button
            class="row"
            class:on={i === active}
            role="option"
            aria-selected={i === active}
            onmouseenter={() => (active = i)}
            onkeydown={key}
            onclick={() => pick(it)}
          >
            <span class="kind">{kindLabel(it.kind)}</span>
            <span class="main">
              <span class="title">{it.title}</span>
              <span class="sub">{it.subtitle}</span>
            </span>
          </button>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .veil { position: fixed; inset: 0; z-index: 80; display: grid; place-items: start center; padding: 12vh 24px 24px; background: rgba(0,0,0,.62); }
  .palette { width: min(720px, 100%); background: var(--surface); box-shadow: 0 24px 70px rgba(0,0,0,.62); }
  input { width: 100%; height: 64px; background: var(--bg); color: var(--text); border: 0; padding: 0 var(--s4); font: var(--w-light) 24px/1 var(--sans); outline: 0; }
  input::placeholder { color: var(--text-faint); }
  .results { max-height: min(54vh, 520px); overflow: auto; padding: var(--s1); }
  .row { width: 100%; min-height: 52px; display: grid; grid-template-columns: 70px minmax(0, 1fr); align-items: center; gap: var(--s3); background: none; border: 0; border-left: 2px solid transparent; color: var(--text); text-align: left; cursor: pointer; font: inherit; padding: 0 var(--s2); }
  .row:hover, .row.on { background: var(--surface-2); border-left-color: var(--text); }
  .kind { color: var(--text-faint); font: 10px var(--mono); letter-spacing: .12em; text-transform: uppercase; }
  .main { min-width: 0; display: grid; gap: 2px; }
  .title, .sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title { color: var(--text); font-size: 14px; }
  .sub { color: var(--text-dim); font: 11.5px var(--mono); }
  .empty { display: grid; gap: 5px; padding: var(--s4); color: var(--text-dim); font-size: 13px; }
  .empty b { color: var(--text); font-weight: var(--w-med); }

  @media (max-width: 700px) {
    .veil { padding: var(--s3); place-items: start center; }
    input { height: 56px; font-size: 19px; padding: 0 var(--s3); }
    .row { grid-template-columns: 58px minmax(0, 1fr); }
  }
</style>
