// Turn a raw model id into a human label, e.g. "claude-opus-4-8[1m]" -> "Opus 4.8 · 1M".
export function prettyModel(id) {
  if (!id) return '';
  const ctx = /\[1m\]/i.test(id) ? ' · 1M' : '';
  const m = id.match(/(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i);
  if (m) return m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + '.' + m[3] + ctx;
  return id;
}
