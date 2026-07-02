<script>
  // Session history: debounced full-text search across past agent transcripts (local claude
  // sessions for now). A hit whose sessionId is still on the roster opens that session;
  // anything else offers a fresh chat in the hit's folder.
  import { searchHistory } from './lib/api.js';
  import { apiErrorMessage } from './lib/apiRequest.mjs';

  let { sessions = [], onOpenSession, onNewChat } = $props();
  let q = $state('');
  let hits = $state([]);
  let searching = $state(false);
  let error = $state('');
  let searched = $state('');
  let inputEl;
  let timer;

  const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
  const when = (t) => (t ? new Date(t).toLocaleDateString() : '');
  const rosterFor = (hit) => sessions.find((s) => s.sessionId === hit.sessionId) || null;

  async function run(query) {
    searching = true; error = '';
    try {
      const r = await searchHistory(query);
      hits = r.hits || [];
      searched = query;
    } catch (e) { error = apiErrorMessage(e, 'Search failed.'); }
    searching = false;
  }
  $effect(() => {
    const query = q.trim();
    clearTimeout(timer);
    if (query.length < 2) { hits = []; searched = ''; error = ''; return; }
    timer = setTimeout(() => run(query), 300);
    return () => clearTimeout(timer);
  });
  $effect(() => { inputEl?.focus(); });
</script>

<div class="history">
  <div class="col">
    <input bind:this={inputEl} bind:value={q} class="q" spellcheck="false" autocomplete="off"
           placeholder="Search past sessions" aria-label="Search session history" />
    {#if error}
      <div class="state" role="alert">{error}</div>
    {:else if searching && hits.length === 0}
      <div class="state">searching...</div>
    {:else if searched && hits.length === 0}
      <div class="state">No matches.</div>
    {:else if !q.trim()}
      <div class="state">Full-text search across everything your agents have said and done on this computer.</div>
    {/if}
    <div class="hits">
      {#each hits as h (h.sessionId)}
        {@const roster = rosterFor(h)}
        <article class="hit">
          <div class="hmain">
            <div class="ttl">
              <b>{base(h.cwd) || h.sessionId.slice(0, 8)}</b>
              <span class="cwd" title={h.cwd}>{h.cwd || ''}</span>
              <span class="date">{when(h.mtime)}</span>
            </div>
            {#each h.matches as m}
              <div class="snippet"><span class="role">{m.role}</span>{m.snippet}</div>
            {/each}
          </div>
          {#if roster}
            <button class="act" onclick={() => onOpenSession?.(roster)}>Open</button>
          {:else if h.cwd}
            <button class="act" onclick={() => onNewChat?.('local', h.cwd)}>New chat here</button>
          {/if}
        </article>
      {/each}
    </div>
  </div>
</div>

<style>
  .history { position: absolute; inset: 0; overflow: auto; background: var(--bg); padding: var(--s5); }
  .col { max-width: 860px; margin: 0 auto; }
  .q { width: 100%; background: none; border: 0; border-bottom: 1px solid var(--seam); color: var(--text); padding: 10px 0 14px; outline: 0; font: var(--w-light) 26px var(--sans); transition: border-color .12s; }
  .q:focus { border-bottom-color: var(--text-faint); }
  .q::placeholder { color: var(--text-faint); }
  .state { padding: var(--s4) 0; color: var(--text-dim); font-size: 13px; }
  .hits { display: grid; }
  .hit { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: var(--s3); padding: var(--s3) 0; border-bottom: 1px solid var(--seam); }
  .hmain { min-width: 0; display: grid; gap: 7px; }
  .ttl { display: flex; align-items: baseline; gap: 11px; min-width: 0; }
  .ttl b { color: var(--text); font-size: 15px; font-weight: var(--w-reg); white-space: nowrap; }
  .ttl .cwd { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); font: 11px var(--mono); }
  .ttl .date { margin-left: auto; flex: none; color: var(--text-faint); font: 11px var(--mono); }
  .snippet { color: var(--text-dim); font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
  .snippet .role { margin-right: 9px; color: var(--text-faint); font-size: 9px; letter-spacing: .14em; text-transform: uppercase; }
  .act { align-self: center; background: none; border: 0; padding: 8px 0; color: var(--text-dim); font-size: 10px; letter-spacing: .14em; text-transform: uppercase; white-space: nowrap; cursor: pointer; transition: color .12s; }
  .act:hover { color: var(--text); text-decoration: underline; text-underline-offset: 4px; }
  .q:focus-visible, .act:focus-visible { outline: 0; box-shadow: inset 0 0 0 1px var(--text-dim); }
</style>
