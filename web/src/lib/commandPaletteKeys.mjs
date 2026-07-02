function clampActive(active, resultCount) {
  const max = Math.max(0, Number(resultCount || 0) - 1);
  const current = Number.isInteger(active) ? active : 0;
  return Math.min(Math.max(current, 0), max);
}

export function commandPaletteKeyAction({ key = '', active = 0, resultCount = 0 } = {}) {
  const current = clampActive(active, resultCount);
  if (key === 'Escape') return { type: 'close', active: current };
  if (key === 'ArrowDown') return { type: 'active', active: clampActive(current + 1, resultCount) };
  if (key === 'ArrowUp') return { type: 'active', active: clampActive(current - 1, resultCount) };
  if (key === 'Enter' && resultCount > 0) return { type: 'pick', active: current };
  return { type: 'none', active: current };
}
