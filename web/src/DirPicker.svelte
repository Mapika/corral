<script>
  // VS Code-style directory picker. The path bar is the source of truth: type a path and the list
  // live-filters; Tab completes to the match (or the common prefix of several). Reuses lsDir — the
  // directory part of whatever you've typed is listed, the trailing fragment filters it.
  import { lsDir } from './lib/api.js';
  import { apiErrorMessage } from './lib/apiRequest.mjs';
  import { dirPickerListState, joinPath, launchTargetFromManual, parsePathInput, stripTrailingSlash, withTrailingSlash } from './lib/dirPickerPath.mjs';
  import { AGENTS, MODELS, PERMS } from './lib/launchOptions.mjs';
  import Icon from './lib/Icon.svelte';

  let { host, start = '/', recentRoots = [], launchError = '', onpick, oncancel } = $props();
  let agent = $state('claude');
  let model = $state(null);
  let perm = $state('auto');
  let worktree = $state(false);          // local git repos only: launch in a fresh worktree
  let models = $derived(MODELS[agent] || MODELS.claude);
  const setAgent = (v) => { agent = v; model = null; };
  const pick = (dir) => onpick?.({ dir, model, perm, agent, worktree: worktree && isLocal });

  // svelte-ignore state_referenced_locally
  let manual = $state(withTrailingSlash(start));   // initial value; the bar drives navigation thereafter
  let listing = $state([]);        // sub-directories of the current dir part
  let loadedDir = $state(null);    // which dir `listing` belongs to
  let loading = $state(false);
  let loadError = $state('');
  let loadErrorDir = $state('');
  let inputEl;
  let timer;

  const isLocal = $derived(host === 'local');
  const base = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p || '~';
  let pathParts = $derived.by(() => parsePathInput(manual));
  let visibleListing = $derived(pathParts.dir === loadedDir ? listing : []);

  async function loadDir(dir) {
    loading = true;
    loadError = '';
    loadErrorDir = '';
    try {
      const r = await lsDir(host, dir);
      listing = r.filter((x) => x.type === 'd').sort((a, b) => a.name.localeCompare(b.name));
      loadedDir = dir;
    } catch (e) {
      loadError = apiErrorMessage(e, 'Could not load folder.');
      loadErrorDir = dir;
    }
    loading = false;
  }

  // live: whenever the typed directory changes, (debounced) load it. Typing the fragment doesn't reload.
  $effect(() => {
    const { dir } = parsePathInput(manual);
    if (dir === loadedDir) return;
    clearTimeout(timer);
    const d = dir;
    timer = setTimeout(() => {
      if (d) loadDir(d);
      else { listing = []; loadedDir = ''; loadError = ''; loadErrorDir = ''; }
    }, 120);
    return () => clearTimeout(timer);
  });

  $effect(() => { inputEl?.focus(); inputEl?.select?.(); });

  let matches = $derived.by(() => {
    const f = pathParts.frag.toLowerCase();
    return f ? visibleListing.filter((x) => x.name.toLowerCase().startsWith(f)) : visibleListing;
  });
  // the directory the session will actually start in (an exact-typed folder, else the browsed dir)
  let target = $derived.by(() => {
    return launchTargetFromManual(manual, visibleListing);
  });
  let listState = $derived(dirPickerListState({ loading, loadError, listing: visibleListing, matches }));
  let crumbs = $derived.by(() => {
    const { dir } = pathParts;
    const parts = dir.split(/[\\/]/); const out = []; let acc = '';
    parts.forEach((seg, i) => {
      if (i === 0 && seg === '') { out.push({ label: '/', path: '/' }); return; }
      if (!seg) return;
      acc = acc ? acc + '/' + seg : seg;
      out.push({ label: seg, path: acc });
    });
    return out;
  });

  const descend = (name) => { manual = withTrailingSlash(joinPath(parsePathInput(manual).dir, name)); inputEl?.focus(); };
  function up() {
    const noslash = parsePathInput(manual).dir.replace(/[\\/]$/, '');
    manual = withTrailingSlash(noslash.replace(/[\\/][^\\/]*$/, '') || '/');
  }
  function commonPrefix(arr) {
    let p = arr[0];
    for (const s of arr) { let i = 0; while (i < p.length && i < s.length && p[i].toLowerCase() === s[i].toLowerCase()) i++; p = p.slice(0, i); }
    return p;
  }
  function tab() {
    const { dir, frag } = parsePathInput(manual);
    const names = matches.map((m) => m.name);
    if (!names.length) return;
    if (names.length === 1) { descend(names[0]); return; }   // unambiguous => go in
    const cp = commonPrefix(names);
    if (cp.length > frag.length) manual = dir + cp;          // extend to the shared prefix
  }
  function enter() {
    const { dir, frag } = pathParts;
    const exact = frag && visibleListing.find((x) => x.name.toLowerCase() === frag.toLowerCase());
    if (exact) descend(exact.name);                          // typed a real folder => open it
    else if (matches.length === 1) descend(matches[0].name);
  }
  function onKey(e) {
    if (e.key === 'Escape') return oncancel?.();
    if (e.key === 'Tab') { e.preventDefault(); tab(); }
    else if (e.key === 'Enter') { e.preventDefault(); enter(); }
  }
  function onDialogKey(e) {
    e.stopPropagation();
    if (e.key === 'Escape') oncancel?.();
  }
</script>

<div class="backdrop" onclick={() => oncancel?.()} role="presentation">
  <div class="picker"
       role="dialog" aria-modal="true" aria-label="Choose a directory" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={onDialogKey}>
    <header class="phead">
      <span class="ptitle">New session</span>
      <span class="phost">{isLocal ? 'this computer' : host}</span>
    </header>

    {#if recentRoots.length}
      <section class="recents" aria-label="Recent launch roots">
        <div class="rhead">
          <span>Recent roots</span>
          <span>{recentRoots.length}</span>
        </div>
        <div class="rlist">
          {#each recentRoots as r (`${r.host}:${r.dir}`)}
            <button class="rroot" onclick={() => (manual = withTrailingSlash(r.dir))} ondblclick={() => pick(r.dir)} title={r.dir}>
              <Icon name="folder" size={14} />
              <span class="rmain">{base(r.dir)}</span>
              <span class="rpath">{r.dir}</span>
              <span class="rsrc">{r.source}</span>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    <div class="pathbar">
      <button class="up" onclick={up} title="Up one level"><Icon name="up" size={16} /></button>
      <input bind:this={inputEl} bind:value={manual} onkeydown={onKey}
             spellcheck="false" autocapitalize="off" autocomplete="off"
             placeholder={isLocal ? 'C:/path/to/project' : '/home/you/project'} />
      <span class="hintkey">Tab to complete</span>
    </div>

    <nav class="crumbs">
      {#each crumbs as c, i}
        {#if i > 0}<span class="sep">/</span>{/if}
        <button class="crumb" onclick={() => (manual = withTrailingSlash(c.path))}>{c.label}</button>
      {/each}
    </nav>

    <div class="list">
      {#if listState.isInitialLoading}
        <div class="empty">loading...</div>
      {:else}
        {#if listState.showRetry}
          <div class="loaderr" role="alert">
            <b>Could not browse this folder.</b>
            <span>{loadError}</span>
            <button onclick={() => loadDir(loadErrorDir || pathParts.dir)}>Retry</button>
          </div>
        {/if}
        {#if listState.showRefreshing}
          <div class="refreshing">refreshing...</div>
        {/if}
        {#if listState.showEmpty}
          <div class="empty">{listState.emptyText}</div>
        {:else if matches.length}
          {#each matches as it (it.name)}
            <button class="drow" onclick={() => descend(it.name)} ondblclick={() => pick(stripTrailingSlash(joinPath(pathParts.dir, it.name)))}>
              <span class="ic"><Icon name="folder" size={15} /></span>
              <span class="nm">{it.name}</span>
              <span class="chev"><Icon name="chevron" size={14} /></span>
            </button>
          {/each}
        {/if}
      {/if}
    </div>

    {#if launchError}
      <div class="launcherr" role="alert">
        <b>Could not start session.</b>
        <span>{launchError}</span>
      </div>
    {/if}

    <div class="opts">
      <div class="optrow">
        <span class="olabel">Agent</span>
        <div class="seg">
          {#each AGENTS as a}
            <button class="segb" class:on={agent === a.v}
                    disabled={a.v === 'opencode' && !isLocal}
                    title={a.v === 'opencode' && !isLocal ? 'OpenCode runs on this computer only for now' : undefined}
                    onclick={() => setAgent(a.v)}>{a.l}</button>
          {/each}
        </div>
      </div>
      <div class="optrow">
        <span class="olabel">Model</span>
        <div class="seg">
          {#each models as m}<button class="segb" class:on={model === m.v} onclick={() => (model = m.v)}>{m.l}</button>{/each}
        </div>
      </div>
      <div class="optrow">
        <span class="olabel">Permissions</span>
        <div class="seg">
          {#each PERMS as p}<button class="segb" class:on={perm === p.v} onclick={() => (perm = p.v)}>{p.l}</button>{/each}
        </div>
      </div>
      {#if isLocal}
        <div class="optrow">
          <span class="olabel">Isolation</span>
          <div class="seg">
            <button class="segb" class:on={!worktree} onclick={() => (worktree = false)}>In place</button>
            <button class="segb" class:on={worktree} onclick={() => (worktree = true)} title="git worktree add next to the repo — the session works on its own branch">New worktree</button>
          </div>
        </div>
      {/if}
    </div>

    <footer class="pfoot">
      <span class="here" title={target}>{target}</span>
      <span class="sp"></span>
      <button class="ghost" onclick={() => oncancel?.()}>Cancel</button>
      <button class="primary" onclick={() => pick(target)}>Start session here</button>
    </footer>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,.55); display: grid; place-items: center; padding: clamp(12px, 4vw, 40px); overflow: auto; animation: fade .14s ease; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  /* solid modal — raised surface, hairline border, soft drop shadow; no glass refraction */
  .picker { width: min(560px, calc(100vw - 24px)); max-height: min(76vh, calc(100vh - 24px)); display: flex; flex-direction: column; background: var(--surface); box-shadow: 0 18px 50px rgba(0,0,0,.5); }

  .phead { flex: none; display: flex; align-items: baseline; gap: 11px; padding: var(--s4) var(--s4) var(--s3); }
  .ptitle { font-size: 19px; font-weight: var(--w-light); color: var(--text); }
  .phost { font-family: var(--mono); font-size: 12px; color: var(--text-dim); }

  .recents { flex: none; border-bottom: 1px solid var(--seam); padding: var(--s2) var(--s2); }
  .rhead { display: flex; align-items: center; justify-content: space-between; padding: 0 var(--s2) 7px; color: var(--text-faint); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; }
  .rlist { display: grid; gap: 2px; }
  .rroot { display: grid; grid-template-columns: 16px minmax(76px, .55fr) minmax(0, 1fr) auto; align-items: center; gap: 9px; width: 100%; height: 34px; padding: 0 10px; background: none; border: 0; border-left: 2px solid transparent; color: var(--text-dim); cursor: pointer; text-align: left; font: inherit; }
  .rroot:hover { background: var(--surface-2); border-left-color: var(--text); color: var(--text); }
  .rmain, .rpath, .rsrc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rmain { color: var(--text); font-size: 13px; }
  .rpath { color: var(--text-faint); font-family: var(--mono); font-size: 11px; }
  .rsrc { color: var(--text-faint); font-size: 9.5px; letter-spacing: .12em; text-transform: uppercase; }

  .pathbar { flex: none; display: flex; align-items: center; gap: 9px; padding: var(--s3) var(--s4) var(--s2); }
  .up { flex: none; display: grid; place-items: center; width: 36px; height: 36px; background: var(--chip); border: 0; color: var(--text-dim); cursor: pointer; transition: color .12s, background .12s; }
  .up:hover { color: var(--text); background: var(--chip-hi); }
  .pathbar input { flex: 1; min-width: 0; background: var(--chip); border: 0; color: var(--text); padding: 0 12px; height: 36px; font: 13px/1 var(--mono); transition: background .12s; }
  .pathbar input:focus { outline: 0; background: var(--chip-hi); }
  .hintkey { flex: none; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--text-faint); }

  .crumbs { flex: none; display: flex; align-items: center; gap: 3px; padding: 0 var(--s4) var(--s2); overflow: hidden; white-space: nowrap; }
  .crumb { background: none; border: 0; color: var(--text-dim); cursor: pointer; font: var(--w-reg) 13px var(--sans); padding: 2px 3px; transition: color .12s; }
  .crumb:hover { color: var(--text); text-decoration: underline; text-underline-offset: 3px; }
  .crumb:last-child { color: var(--text); }
  .crumbs .sep { color: var(--text-faint); }

  .list { flex: 1; min-height: 120px; overflow: auto; padding: 4px var(--s2); border-top: 1px solid var(--seam); border-bottom: 1px solid var(--seam); }
  .empty { color: var(--text-dim); font-size: 13px; padding: var(--s4); line-height: 1.5; }
  .loaderr { display: grid; gap: 7px; margin: 7px 8px 9px; padding: 11px 12px; background: var(--bg); color: var(--text-dim); font-size: 12.5px; line-height: 1.4; }
  .loaderr b { color: var(--text); font-weight: var(--w-med); }
  .loaderr button { justify-self: start; background: var(--chip); border: 0; color: var(--text-dim); border-radius: var(--pill); padding: 6px 13px; cursor: pointer; font: var(--w-reg) 11.5px var(--sans); }
  .loaderr button:hover { color: var(--text); background: var(--chip-hi); }
  .launcherr { flex: none; display: grid; gap: 5px; margin: var(--s3) var(--s4) 0; padding: 10px 12px; background: var(--bg); color: var(--text-dim); font-size: 12.5px; line-height: 1.4; }
  .launcherr b { color: var(--text); font-weight: var(--w-med); }
  .refreshing { padding: 8px 12px; color: var(--text-faint); font: 11px var(--mono); }
  .drow { display: flex; align-items: center; gap: 11px; width: 100%; height: 38px; padding: 0 11px; background: none; border: 0; border-left: 2px solid transparent; color: var(--text); cursor: pointer; text-align: left; font: inherit; transition: background .12s; }
  .drow:hover { background: var(--surface-2); border-left-color: var(--text); }
  .drow .ic { display: grid; place-items: center; flex: none; color: var(--text); }
  .drow .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; }
  .drow .chev { display: grid; place-items: center; color: var(--text-faint); opacity: 0; transition: opacity .12s; }
  .drow:hover .chev { opacity: 1; }

  /* launch options — two hairline segmented rows; the chosen cell fills, the rest stay ghost */
  .opts { flex: none; display: flex; flex-direction: column; gap: 9px; padding: var(--s3) var(--s4) 0; }
  .optrow { display: flex; align-items: center; gap: var(--s3); }
  .olabel { flex: none; width: 78px; font-size: 10px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-faint); }
  .seg { display: flex; gap: 4px; }
  .segb { background: var(--chip); border: 0; color: var(--text-dim); cursor: pointer; font: var(--w-reg) 12px var(--sans); padding: 7px 14px; transition: background .12s, color .12s; }
  .segb:hover { color: var(--text); background: var(--chip-hi); }
  .segb.on { background: var(--paper); color: var(--ink); }
  .segb:disabled { cursor: not-allowed; opacity: .38; }

  .pfoot { flex: none; display: flex; align-items: center; gap: 11px; padding: var(--s3) var(--s4); }
  .here { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 11.5px; color: var(--text-dim); }
  .sp { flex: 1; }
  .ghost { background: var(--chip); border: 0; color: var(--text-dim); border-radius: var(--pill); padding: 9px 17px; cursor: pointer; font: var(--w-reg) 13px var(--sans); transition: color .12s, background .12s; }
  .ghost:hover { color: var(--text); background: var(--chip-hi); }
  .primary { background: var(--paper); color: var(--ink); border: 0; border-radius: var(--pill); padding: 9px 18px; cursor: pointer; font: var(--w-med) 13px var(--sans); transition: transform .14s; white-space: nowrap; }
  .primary:hover { transform: translateY(-1px); }
  .up:focus-visible, .pathbar input:focus-visible, .rroot:focus-visible, .drow:focus-visible, .crumb:focus-visible, .segb:focus-visible, .ghost:focus-visible, .primary:focus-visible, .loaderr button:focus-visible { outline: 0; box-shadow: inset 0 0 0 1px var(--text-dim); }

  @media (max-width: 520px) {
    .hintkey { display: none; }
    .phead, .pathbar, .crumbs, .opts, .pfoot { padding-left: var(--s3); padding-right: var(--s3); }
    .optrow { flex-direction: column; align-items: stretch; gap: 7px; }
    .olabel { width: auto; }
    .seg { min-width: 0; }
    .segb { flex: 1 1 0; padding-left: 9px; padding-right: 9px; }
    .pfoot { flex-wrap: wrap; }
    .here { flex: 1 0 100%; }
    .sp { display: none; }
    .ghost { margin-left: auto; }
  }
</style>
