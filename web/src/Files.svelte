<script>
  import { untrack } from 'svelte';
  import { lsDir, fileUrl, dirDownloadUrl, fileText, uploadFile, mkdir, renameItem, deleteItem } from './lib/api.js';
  import { renderMarkdown, highlightCode } from './lib/markdown.js';
  import { apiErrorMessage } from './lib/apiRequest.mjs';
  import { runUploadBatch } from './lib/fileUploads.mjs';
  import { chatLaunchTarget, copyFilePathText, filePreviewError, runFileOperation } from './lib/fileActions.mjs';
  import { normalizeFilePathInput, parentPath } from './lib/filePathInput.mjs';
  import { toast } from './lib/toast.svelte.js';
  import Icon from './lib/Icon.svelte';

  let { host, path: startPath, onNewChat } = $props();

  // Stale-while-revalidate listing cache (module-lifetime): a revisited folder renders its last
  // known contents instantly while the fresh listing loads behind it — combined with the server's
  // pooled ssh channel this makes remote browsing feel local.
  const listingCache = cacheRef();
  function cacheRef() {
    const g = globalThis;
    return (g.__corralLs = g.__corralLs || new Map());
  }
  const cacheKey = (h, p) => h + '\0' + p;
  function cachePut(key, list) {
    listingCache.delete(key);
    listingCache.set(key, list);
    if (listingCache.size > 60) listingCache.delete(listingCache.keys().next().value);
  }

  // svelte-ignore state_referenced_locally
  let cwd = $state(startPath || '~');   // initial path only; re-browsed via $effect on startPath
  let items = $state([]);
  let loading = $state(false);
  let sel = $state(null);            // selected file name
  let preview = $state(null);        // { kind, html|url|name }
  let dragOver = $state(false);
  let error = $state('');
  let lastLoaded = $state('');
  let uploads = $state([]);          // { name, pct, error, message }
  let creating = $state(false);      // new-folder input row visible
  let newName = $state('');
  let renaming = $state(null);       // name of the item being renamed inline
  let renameTo = $state('');
  let pendingDel = $state(null);     // name awaiting delete confirmation
  let pathDraft = $state('~');
  let filter = $state('');           // case-insensitive name filter for the current folder
  let lastExternalPathKey = '';

  let visible = $derived(filter.trim()
    ? items.filter((it) => it.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : items);

  const IMG = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
  const TEXTY = ['txt', 'md', 'markdown', 'json', 'jsonl', 'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs', 'py', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml', 'sh', 'bash', 'html', 'css', 'xml', 'ini', 'cfg', 'conf', 'c', 'h', 'cpp', 'hpp', 'cc', 'rs', 'go', 'java', 'rb', 'sql', 'env', 'gitignore', 'dockerfile', 'diff', 'patch'];
  const ext = (n) => (n.split('.').pop() || '').toLowerCase();
  const fmtSize = (b) => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
  const join = (a, b) => a.replace(/[\\/]$/, '') + '/' + b;

  async function browse(p, opts = {}) {
    const nextPath = normalizeFilePathInput(p, cwd || '~');
    cwd = nextPath;
    pathDraft = nextPath;
    if (!opts.keepSelection) { sel = null; preview = null; filter = ''; }
    const key = cacheKey(host, nextPath);
    const cached = listingCache.get(key);
    if (cached) { items = cached; lastLoaded = nextPath; }   // instant paint; fresh load continues
    loading = true; error = '';
    try {
      const r = await lsDir(host, nextPath);
      if (cwd !== nextPath) return;                          // user already navigated elsewhere
      r.sort((a, b) => (a.type === 'd' ? 0 : 1) - (b.type === 'd' ? 0 : 1) || a.name.localeCompare(b.name));
      items = r; lastLoaded = nextPath;
      cachePut(key, r);
    } catch (e) { if (cwd === nextPath) error = apiErrorMessage(e, 'Could not load this folder.'); }
    if (cwd === nextPath) loading = false;
  }
  function up() { browse(parentPath(cwd)); }
  function jumpPath() { browse(pathDraft || cwd); }
  function resetPathDraft() { pathDraft = cwd; }
  async function copyPath() {
    await copyFilePathText(cwd, { toast });
  }
  function startChatHere() {
    const target = chatLaunchTarget({ host, cwd });
    onNewChat?.(target.host, target.path);
  }

  async function open(it) {
    if (it.type === 'd') { browse(join(cwd, it.name)); return; }
    const full = join(cwd, it.name), e = ext(it.name);
    sel = it.name;
    if (IMG.includes(e)) { preview = { kind: 'img', url: fileUrl(host, full) }; return; }
    if (e === 'pdf') { preview = { kind: 'pdf', url: fileUrl(host, full) }; return; }
    if (TEXTY.includes(e) || it.size < 512 * 1024) {
      preview = { kind: 'loading' };
      try {
        let t = await fileText(host, full);
        if (t.length > 400000) t = t.slice(0, 400000) + '\n\n… (truncated)';
        preview = (e === 'md' || e === 'markdown')
          ? { kind: 'md', html: renderMarkdown(t) }
          : { kind: 'code', html: highlightCode(t, e) };
      } catch (x) { preview = filePreviewError(it.name, x, fileUrl(host, full, { dl: true })); }
      return;
    }
    preview = { kind: 'binary', name: it.name, url: fileUrl(host, full, { dl: true }) };
  }

  async function doUpload(files) {
    const result = await runUploadBatch(files, {
      host,
      cwd,
      records: uploads,
      uploadFile,
      toast,
      onRecords: (next) => (uploads = next),
    });
    if (result.changed) browse(cwd, { keepSelection: true });
  }
  function onDrop(e) { e.preventDefault(); dragOver = false; if (e.dataTransfer?.files?.length) doUpload([...e.dataTransfer.files]); }

  async function doMkdir() {
    const n = newName.trim();
    if (!n) { creating = false; newName = ''; return; }
    await runFileOperation({
      label: 'New folder',
      run: () => mkdir(host, cwd, n),
      cleanup: () => { creating = false; newName = ''; },
      refresh: () => browse(cwd),
      toast,
    });
  }
  function startRename(name) { renaming = name; renameTo = name; pendingDel = null; }
  async function doRename() {
    const old = renaming;
    if (old == null) return;        // Enter already handled it; ignore the unmount blur
    renaming = null;
    const n = renameTo.trim();
    if (!n || n === old) { renameTo = ''; return; }
    await runFileOperation({
      label: 'Rename',
      run: () => renameItem(host, join(cwd, old), n),
      cleanup: () => { renameTo = ''; },
      refresh: () => browse(cwd),
      toast,
    });
  }
  async function doDelete(name) {
    pendingDel = null;
    await runFileOperation({
      label: 'Delete',
      run: () => deleteItem(host, join(cwd, name)),
      refresh: () => {
        if (sel === name) { sel = null; preview = null; }
        return browse(cwd);
      },
      toast,
    });
  }
  function pickUpload() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true;
    inp.onchange = () => doUpload([...inp.files]);
    inp.click();
  }

  $effect(() => {
    const nextStart = startPath || '~';
    const nextKey = host + '\0' + nextStart;
    if (nextKey === lastExternalPathKey) return;
    lastExternalPathKey = nextKey;
    untrack(() => browse(nextStart));
  });
</script>

<div class="files" role="region" aria-label="File browser — drop files to upload"
     ondragover={(e) => { e.preventDefault(); dragOver = true; }}
     ondragleave={() => (dragOver = false)}
     ondrop={onDrop}
     class:drag={dragOver}>
  <header class="fhead">
    <button class="up" onclick={up} title="Up one level"><Icon name="up" size={16} /></button>
    <form class="pathbox" onsubmit={(e) => { e.preventDefault(); jumpPath(); }}>
      <input bind:value={pathDraft} spellcheck="false" autocomplete="off" aria-label="Current path" title={cwd}
             onkeydown={(e) => { if (e.key === 'Escape') resetPathDraft(); }} />
    </form>
    <button class="btn icononly" onclick={copyPath} title="Copy current path" aria-label="Copy current path"><Icon name="copy" size={14} /></button>
    {#if onNewChat}<button class="btn" onclick={startChatHere} title="Start chat in this folder"><Icon name="plus" size={14} /> chat</button>{/if}
    <button class="btn" onclick={() => browse(cwd, { keepSelection: true })} title="Refresh this folder"><Icon name="swap" size={14} /> refresh</button>
    <button class="btn" onclick={() => { creating = true; newName = ''; }} title="New folder here"><Icon name="plus" size={14} /> folder</button>
    <a class="btn" href={dirDownloadUrl(host, cwd)} title="Download this folder as .tar.gz"><Icon name="download" size={14} /> folder</a>
    <button class="btn" onclick={pickUpload}><Icon name="upload" size={14} /> upload</button>
  </header>

  <div class="body" class:has-preview={!!preview}>
    <div class="list">
      <input class="filterbox" bind:value={filter} spellcheck="false" autocomplete="off"
             placeholder="filter" aria-label="Filter files by name"
             onkeydown={(e) => { if (e.key === 'Escape') (filter = ''); }} />
      {#if loading && items.length === 0}
        <div class="empty">loading…</div>
      {:else}
        {#if loading}<div class="loadingbar">refreshing folder...</div>{/if}
        {#if error}
          <div class="loaderr" role="alert">
            <b>Could not load folder.</b>
            <span>{error}</span>
            {#if lastLoaded}<span class="stale">Showing last loaded contents from {lastLoaded}.</span>{/if}
            <button onclick={() => browse(cwd, { keepSelection: true })}>Retry</button>
          </div>
        {/if}
        {#if creating}
          <div class="row creating">
            <span class="ic dir"><Icon name="folder" size={15} /></span>
            <!-- svelte-ignore a11y_autofocus -->
            <input class="rin" bind:value={newName} autofocus placeholder="New folder name"
                   onkeydown={(e) => { if (e.key === 'Enter') doMkdir(); else if (e.key === 'Escape') { creating = false; newName = ''; } }}
                   onblur={doMkdir} />
          </div>
        {/if}
        {#each visible as it (it.name)}
          <div class="row" class:active={sel === it.name}>
            {#if renaming === it.name}
              <span class="ic" class:dir={it.type === 'd'}><Icon name={it.type === 'd' ? 'folder' : 'file'} size={15} /></span>
              <!-- svelte-ignore a11y_autofocus -->
              <input class="rin" bind:value={renameTo} autofocus
                     onkeydown={(e) => { if (e.key === 'Enter') doRename(); else if (e.key === 'Escape') renaming = null; }}
                     onblur={doRename} />
            {:else if pendingDel === it.name}
              <span class="ic"><Icon name={it.type === 'd' ? 'folder' : 'file'} size={15} /></span>
              <span class="nm del">Delete {it.name}?</span>
              <button class="confirm danger" onclick={() => doDelete(it.name)} title="Confirm delete">Delete</button>
              <button class="confirm" onclick={() => (pendingDel = null)} title="Cancel">Cancel</button>
            {:else}
              <button class="open" onclick={() => open(it)}>
                <span class="ic" class:dir={it.type === 'd'}><Icon name={it.type === 'd' ? 'folder' : 'file'} size={15} /></span>
                <span class="nm">{it.name}</span>
                <span class="sz">{it.type === 'd' ? '' : fmtSize(it.size)}</span>
              </button>
              <button class="act" onclick={() => startRename(it.name)} title="Rename"><Icon name="pencil" size={13} /></button>
              <button class="act" onclick={() => { pendingDel = it.name; renaming = null; }} title="Delete"><Icon name="trash" size={13} /></button>
              {#if it.type !== 'd'}
                <a class="dl" href={fileUrl(host, join(cwd, it.name), { dl: true })} title="Download"><Icon name="download" size={14} /></a>
              {/if}
            {/if}
          </div>
        {/each}
        {#if items.length === 0 && !creating && !error}<div class="empty">This folder is empty.</div>
        {:else if visible.length === 0 && items.length > 0}<div class="empty">No matches.</div>{/if}
      {/if}
      {#each uploads as u}
        <div class="uprow" class:err={u.error} title={u.message || ''}>
          <Icon name={u.error ? 'close' : 'upload'} size={13} />
          <span class="nm">{u.name}</span>
          <span class="pct">{u.error ? 'failed' : u.pct + '%'}</span>
          {#if u.error}<button class="uclr" onclick={() => (uploads = uploads.filter((x) => x !== u))} aria-label="Dismiss failed upload"><Icon name="close" size={11} /></button>{/if}
        </div>
      {/each}
    </div>

    <div class="prev">
      {#if !preview}
        <div class="ph">Select a file — or drag files here to upload.</div>
      {:else if preview.kind === 'loading'}
        <div class="ph">loading…</div>
      {:else if preview.kind === 'img'}
        <img src={preview.url} alt={sel} />
      {:else if preview.kind === 'pdf'}
        <iframe src={preview.url} title={sel}></iframe>
      {:else if preview.kind === 'md'}
        <div class="prose">{@html preview.html}</div>
      {:else if preview.kind === 'code'}
        <pre class="code"><code>{@html preview.html}</code></pre>
      {:else if preview.kind === 'error'}
        <div class="ph error" role="alert">
          <b>Could not preview {preview.name}.</b>
          <span>{preview.message}</span>
          {#if preview.url}<a href={preview.url}>Download file</a>{/if}
        </div>
      {:else if preview.kind === 'binary'}
        <div class="ph">Binary file — <a href={preview.url}>download {preview.name}</a></div>
      {/if}
    </div>
  </div>

  {#if dragOver}<div class="dropmask">Drop to upload to {cwd}</div>{/if}
</div>

<style>
  .files { position: absolute; inset: 0; display: flex; flex-direction: column; min-height: 0; background: var(--bg); }
  .fhead { flex: none; display: flex; align-items: center; gap: 10px; height: 56px; padding: 0 var(--s4); }
  .up { display: grid; place-items: center; background: var(--chip); border: 0; color: var(--text-dim); width: 30px; height: 30px; cursor: pointer; transition: color .12s, background .12s; }
  .up:hover { color: var(--text); background: var(--chip-hi); }
  .pathbox { flex: 1; min-width: 120px; }
  .pathbox input { width: 100%; height: 30px; background: var(--chip); border: 0; color: var(--text); padding: 0 11px; outline: 0; font: 12px var(--mono); transition: background .12s; }
  .pathbox input:focus { background: var(--chip-hi); }
  .btn { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; background: var(--chip); border: 0; color: var(--text-dim); border-radius: var(--pill); padding: 7px 15px; cursor: pointer; text-decoration: none; transition: color .12s, background .12s; }
  .btn.icononly { width: 30px; height: 30px; justify-content: center; padding: 0; border-radius: 0; }
  .btn:hover { background: var(--chip-hi); color: var(--text); }
  .up:focus-visible, .btn:focus-visible, .pathbox input:focus-visible, .open:focus-visible, .act:focus-visible, .dl:focus-visible, .confirm:focus-visible, .loaderr button:focus-visible, .uclr:focus-visible { outline: 0; box-shadow: inset 0 0 0 1px var(--text-dim); }

  .body { flex: 1; min-height: 0; display: grid; grid-template-columns: 328px 1fr; }
  .list { background: var(--surface); overflow: auto; padding: var(--s2) var(--s1); }
  .filterbox { width: calc(100% - 8px); margin: 0 4px 6px; height: 28px; background: var(--chip); border: 0; color: var(--text); padding: 0 10px; outline: 0; font: 11.5px var(--mono); transition: background .12s; }
  .filterbox:focus { background: var(--chip-hi); }
  .filterbox::placeholder { color: var(--text-faint); }
  .row { display: flex; align-items: center; border-left: 2px solid transparent; }
  .row:hover { background: var(--surface-2); }
  .row.active { background: var(--surface-2); border-left-color: var(--text); }
  .open { flex: 1; display: flex; align-items: center; gap: 11px; min-width: 0; height: 38px; padding: 0 11px; background: none; border: 0; color: var(--text); cursor: pointer; text-align: left; font: inherit; }
  .open .ic { display: grid; place-items: center; flex: none; color: var(--text-faint); }
  .open .ic.dir { color: var(--text); }
  .open .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; }
  .open .sz { color: var(--text-dim); font-size: 11px; font-family: var(--mono); }
  .dl { display: grid; place-items: center; color: var(--text-faint); text-decoration: none; padding: 6px 12px; transition: color .12s; }
  .dl:hover { color: var(--text); }
  /* per-row rename/delete triggers — revealed on row hover so the list stays calm at rest */
  .act { display: grid; place-items: center; background: none; border: 0; color: var(--text-faint); cursor: pointer; padding: 6px 7px; font: inherit; opacity: 0; transition: color .12s, opacity .12s; }
  .row:hover .act, .row:focus-within .act { opacity: 1; }
  .act:hover { color: var(--text); }
  /* inline rename / new-folder field */
  .rin { flex: 1; min-width: 0; margin: 0 11px 0 0; background: var(--chip-hi); border: 0; color: var(--text); padding: 0 10px; height: 30px; font: 13.5px var(--sans); outline: 0; box-shadow: inset 0 0 0 1px var(--text-faint); }
  .row.creating { padding-left: 11px; gap: 11px; height: 38px; }
  .row.creating .ic { color: var(--text); }
  /* delete confirmation */
  .nm.del { flex: 1; padding: 0 11px; color: var(--text); font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .confirm { background: var(--chip); border: 0; color: var(--text-dim); border-radius: var(--pill); padding: 5px 13px; margin-right: 7px; cursor: pointer; font: var(--w-reg) 11.5px var(--sans); transition: color .12s, background .12s; }
  .confirm:hover { color: var(--text); background: var(--chip-hi); }
  .confirm.danger:hover { background: var(--paper); color: var(--ink); }
  .empty { color: var(--text-dim); font-size: 12px; padding: 14px; }
  .loadingbar { color: var(--text-faint); font-size: 11px; font-family: var(--mono); padding: 8px 14px; }
  .loaderr { display: grid; gap: 7px; margin: 6px 6px 10px; padding: 12px; background: var(--surface-2); color: var(--text-dim); font-size: 12px; }
  .loaderr b { color: var(--text); font-weight: var(--w-med); }
  .loaderr span { overflow-wrap: anywhere; }
  .loaderr .stale { color: var(--text-faint); font-family: var(--mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .loaderr button { justify-self: start; background: var(--chip); border: 0; color: var(--text-dim); border-radius: var(--pill); padding: 6px 13px; cursor: pointer; font: var(--w-reg) 11.5px var(--sans); }
  .loaderr button:hover { color: var(--text); background: var(--chip-hi); }
  .uprow { display: flex; align-items: center; gap: 9px; padding: 8px 11px; color: var(--text-dim); font-size: 12px; }
  .uprow.err { color: var(--text); border-left: 2px solid var(--text); background: var(--surface-2); }
  .uprow .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .uprow .pct { font-family: var(--mono); color: var(--text); }
  .uclr { display: grid; place-items: center; width: 22px; height: 22px; border: 0; background: var(--chip); color: var(--text-dim); cursor: pointer; }
  .uclr:hover { color: var(--text); background: var(--chip-hi); }

  .prev { overflow: auto; background: var(--bg); position: relative; }
  .prev img { max-width: 100%; display: block; margin: auto; }
  .prev iframe { width: 100%; height: 100%; border: 0; background: #fff; }
  .prev .ph { color: var(--text-dim); padding: var(--s6); text-align: center; }
  .prev .ph a { color: var(--text); text-decoration: underline; text-underline-offset: 3px; }
  .prev .ph.error { min-height: 100%; display: grid; align-content: center; justify-items: center; gap: 10px; }
  .prev .ph.error b { color: var(--text); font-weight: var(--w-med); }
  .prev .ph.error span { max-width: 560px; overflow-wrap: anywhere; }
  .prev .prose { padding: var(--s5) var(--s6); max-width: 760px; }
  /* code preview — a pure-black immersive frame filling the pane */
  .prev .code { margin: 0; min-height: 100%; padding: var(--s4) var(--s5); background: var(--frame); font: 12.5px/1.6 var(--mono); color: #e2e2e2; white-space: pre; overflow: auto; }

  .files.drag { outline: 1.5px dashed var(--text-dim); outline-offset: -8px; }
  .dropmask { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(10,10,11,.82); color: var(--text); font-size: 22px; font-weight: var(--w-light); pointer-events: none; }

  @media (max-width: 900px) {
    .fhead { gap: 7px; padding: 0 var(--s3); }
    .pathbox { min-width: 0; }
    .btn { padding: 6px 10px; }
    .btn.icononly { padding: 0; }
    .body { grid-template-columns: 1fr; }
    .body:not(.has-preview) .prev { display: none; }
    .body.has-preview .list { max-height: 42vh; }
  }
</style>
