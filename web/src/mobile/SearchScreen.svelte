<script>
  // "Which session talked about X?" — debounced full-text search across past transcripts,
  // couch-sized, fanned out to every paired ranch at once. A hit still on the roster opens that
  // session; anything else offers a fresh ranch in the hit's folder (on the hit's server).
  import { apiErrorMessage } from '../lib/apiRequest.mjs';
  import Icon from '../lib/Icon.svelte';

  let { data, onclose, onOpenSession, onRanchAt } = $props();
  let multi = $derived(data.d.ranches.length > 1);

  let q = $state('');
  let hits = $state([]);
  let searching = $state(false);
  let error = $state('');
  let searched = $state('');
  let inputEl = $state(null);
  let timer;

  const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
  const when = (t) => (t ? new Date(t).toLocaleDateString() : '');
  const rosterFor = (hit) => data.d.sessions.find((s) => s.sessionId === hit.sessionId && (!hit.ranch || s.ranch === hit.ranch)) || null;

  async function run(query) {
    searching = true; error = '';
    const ranches = [...data.d.ranches];
    const results = await Promise.allSettled(ranches.map((r) => data.clientFor(r.id).searchHistory(query)));
    const merged = [];
    let anyOk = false, firstErr = null;
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        anyOk = true;
        for (const h of res.value.hits || []) merged.push({ ...h, ranch: ranches[i].id, ranchName: ranches[i].name });
      } else if (!firstErr) firstErr = res.reason;
    });
    // Partial results beat an error page: only fail the search when EVERY ranch failed.
    if (!anyOk && firstErr) { error = apiErrorMessage(firstErr, 'Search failed.'); }
    else { hits = merged.sort((a, b) => (b.mtime || 0) - (a.mtime || 0)); searched = query; }
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

<div class="search">
  <header>
    <button class="back" onclick={() => onclose?.()} aria-label="Close search"><Icon name="chevron-left" size={22} /></button>
    <input bind:this={inputEl} bind:value={q} placeholder="Search past sessions"
           autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Search session history" />
  </header>

  <div class="body">
    {#if error}
      <p class="state" role="alert">{error}</p>
      <button class="retry" onclick={() => run(q.trim())}>Try again</button>
    {:else if searching && hits.length === 0}
      <p class="state">searching…</p>
    {:else if searched && hits.length === 0}
      <p class="state">No matches.</p>
    {:else if !q.trim()}
      <p class="state">Full-text search across everything your agents have said and done{multi ? ', on every ranch at once' : ' on the ranch computer'}.</p>
    {/if}

    {#each hits as h ((h.ranch || '') + ':' + h.sessionId)}
      {@const roster = rosterFor(h)}
      <button class="hit" onclick={() => (roster ? onOpenSession?.(roster) : h.cwd && onRanchAt?.(h.cwd, h.ranch))}>
        <span class="ttl">
          <b>{base(h.cwd) || h.sessionId.slice(0, 8)}</b>
          <span class="date">{multi && h.ranchName ? h.ranchName + ' · ' : ''}{when(h.mtime)}</span>
        </span>
        {#each h.matches.slice(0, 2) as m}
          <span class="snippet"><span class="role">{m.role}</span>{m.snippet}</span>
        {/each}
        <span class="act">{roster ? 'Open session' : h.cwd ? 'Ranch here' : ''}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .search { position: fixed; inset: 0; z-index: 35; display: flex; flex-direction: column; background: var(--bg); }
  header { flex: none; display: flex; align-items: center; gap: 4px; min-height: 54px; padding-top: env(safe-area-inset-top, 0px); border-bottom: 1px solid var(--seam); }
  .back { flex: none; width: 46px; height: 46px; background: none; border: 0; color: var(--text-dim); cursor: pointer; display: grid; place-items: center; }
  .retry { align-self: flex-start; background: var(--chip); color: var(--text); border: 0; border-radius: var(--pill); min-height: 42px; padding: 0 20px; font: var(--w-reg) 13px var(--sans); cursor: pointer; }
  input { flex: 1; min-width: 0; background: none; border: 0; outline: 0; color: var(--text); font: var(--w-light) 19px var(--sans); padding: 8px 14px 8px 0; }
  input::placeholder { color: var(--text-faint); }

  .body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 var(--s4) var(--s5); }
  .state { padding: var(--s4) 0; color: var(--text-dim); font-size: 13px; }
  .hit { display: flex; flex-direction: column; gap: 7px; width: 100%; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--seam); padding: var(--s3) 2px; color: inherit; font: inherit; cursor: pointer; }
  .hit:active { background: var(--chip); }
  .ttl { display: flex; align-items: baseline; gap: 10px; }
  .ttl b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: 15px; font-weight: var(--w-med); }
  .ttl .date { margin-left: auto; flex: none; color: var(--text-faint); font: 10.5px var(--mono); }
  .snippet { color: var(--text-dim); font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .snippet .role { margin-right: 8px; color: var(--text-faint); font-size: 9px; letter-spacing: .14em; text-transform: uppercase; }
  .act { color: var(--text-faint); font-size: 10px; letter-spacing: .14em; text-transform: uppercase; }
</style>
