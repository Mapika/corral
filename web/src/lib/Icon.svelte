<script>
  // Minimal stroke-icon set (Lucide-derived geometry, MIT). One <path> per icon — multiple
  // M-subpaths live in a single `d`, so every glyph shares one consistent 1.5px stroke and
  // centres perfectly inside a flex/grid button. currentColor => the button controls the hue.
  let { name, size = 16, stroke = 1.5 } = $props();
  const P = {
    plus: 'M5 12h14 M12 5v14',
    folder: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
    file: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z M14 2v5h5',
    swap: 'M8 3 4 7l4 4 M4 7h16 M16 21l4-4-4-4 M20 17H4',
    up: 'M12 19V5 M5 12l7-7 7 7',
    download: 'M4 20h16 M12 4v12 M8 12l4 4 4-4',
    upload: 'M4 4h16 M12 20V8 M8 12l4-4 4 4',
    copy: 'M9 9h11v11H9z M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
    chevron: 'M9 6l6 6-6 6',
    filter: 'M22 3H2l8 9.5V19l4 2v-8.5Z',
    pencil: 'M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z',
    trash: 'M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
    minimize: 'M5 12h14',
    maximize: 'M5 5h14v14H5z',
    restore: 'M8 8V6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-2 M5 9h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z',
    close: 'M6 6l12 12 M18 6l-12 12',
    terminal: 'M4 17l6-6-6-6 M12 19h8',
    bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.94 1.94 0 0 0 3.4 0',
    phone: 'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z M11 18h2',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z M21 21l-4.35-4.35',
  };
</script>

<svg class="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
     stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={P[name]} />
</svg>

<style>.icon { display: block; flex: none; }</style>
