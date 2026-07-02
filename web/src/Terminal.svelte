<script>
  // Real terminal view: xterm.js on the /ws PTY bridge — a local shell on this machine, plain
  // interactive ssh on a remote, or an attach to a named tmux target. One socket per mount;
  // App.svelte keys the view on host+target+cwd so switching context remounts cleanly.
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { WebglAddon } from '@xterm/addon-webgl';
  import '@xterm/xterm/css/xterm.css';
  import { termSocket } from './lib/api.js';

  let { host = 'local', target = null, cwd = null } = $props();
  let el;
  let closed = $state(false);
  let waiting = $state(true);   // no PTY output yet — the ssh handshake takes a few seconds

  // Ink terminal palette: pure black frame, warm-white ink, silver cursor, restrained ANSI tones.
  const THEME = {
    background: '#000000', foreground: '#f3f2ef',
    cursor: '#cfd4dc', cursorAccent: '#000000',
    selectionBackground: 'rgba(243,242,239,.28)',
    black: '#1b1b1f', brightBlack: '#6f6d68',
    red: '#e06c5c', brightRed: '#ff5a36',
    green: '#9db978', brightGreen: '#b5d18e',
    yellow: '#d9b26a', brightYellow: '#ecca88',
    blue: '#7da7c9', brightBlue: '#9ec2e0',
    magenta: '#b58fc9', brightMagenta: '#cfaede',
    cyan: '#7fc0bc', brightCyan: '#9cdcd7',
    white: '#d9d8d4', brightWhite: '#f3f2ef',
  };

  $effect(() => {
    const term = new Terminal({
      fontFamily: '"Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      cursorBlink: true,
      scrollback: 8000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    // WebGL renderer: glyphs land in a pixel-snapped atlas — none of the fractional-width gaps
    // the DOM renderer produces. Falls back to the DOM renderer if WebGL is unavailable or lost.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (e) {}
    fit.fit();
    closed = false;

    waiting = true;
    const ws = termSocket({ host, target: target || '', cwd: cwd || '', cols: term.cols, rows: term.rows });
    ws.onmessage = (e) => { waiting = false; term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data)); };
    ws.onclose = () => {
      closed = true; waiting = false;
      try { term.write('\r\n\x1b[2m[session closed]\x1b[0m\r\n'); } catch (x) {}
    };
    const dataSub = term.onData((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: d })); });
    const ro = new ResizeObserver(() => {
      fit.fit();
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    });
    ro.observe(el);
    term.focus();
    return () => { ro.disconnect(); dataSub.dispose(); try { ws.close(); } catch (x) {} term.dispose(); };
  });
</script>

<div class="termview" class:closed>
  <div class="term" bind:this={el}></div>
  {#if waiting && !closed}
    <div class="conn" role="status"><span class="cdot"></span>connecting to {host === 'local' ? 'this computer' : host}{target ? ' · tmux ' + target : ''}</div>
  {/if}
</div>

<style>
  .termview { position: absolute; inset: 0; background: var(--frame); padding: var(--s3) var(--s3) var(--s2) var(--s4); }
  .conn { position: absolute; top: var(--s3); left: var(--s4); display: inline-flex; align-items: center; gap: 8px; color: var(--text-faint); font: 11px var(--mono); pointer-events: none; }
  .cdot { width: 6px; height: 6px; border-radius: 50%; background: var(--mercury-flow); animation: pulse 2.2s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
  @media (prefers-reduced-motion: reduce) { .cdot { animation: none; } }
  .termview.closed { opacity: .75; }
  .term { width: 100%; height: 100%; }
  .term :global(.xterm) { height: 100%; }
</style>
