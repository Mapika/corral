export function withTrailingSlash(path) {
  return (path || '/').replace(/[\\/]?$/, '/');
}

export function parsePathInput(path) {
  const text = String(path || '');
  if (text === '/') return { dir: '/', frag: '' };
  const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return index < 0 ? { dir: '', frag: text } : { dir: text.slice(0, index + 1), frag: text.slice(index + 1) };
}

export function stripTrailingSlash(path) {
  const text = String(path || '');
  return text.length > 1 ? text.replace(/[\\/]$/, '') : text;
}

export function joinPath(dir, name) {
  return String(dir || '') + String(name || '');
}

export function dirPickerListState({ loading = false, loadError = '', listing = [], matches = [] } = {}) {
  const listingCount = Array.isArray(listing) ? listing.length : 0;
  const matchCount = Array.isArray(matches) ? matches.length : 0;
  const showRetry = !!String(loadError || '').trim();

  return {
    isInitialLoading: !!loading && listingCount === 0 && !showRetry,
    showRefreshing: !!loading && listingCount > 0,
    showRetry,
    showEmpty: !loading && !showRetry && matchCount === 0,
    emptyText: listingCount
      ? 'No folder matches - Tab does nothing here.'
      : 'No sub-folders - start in this folder, or type a path.',
  };
}

export function launchTargetFromManual(manual, listing = []) {
  const { dir, frag } = parsePathInput(manual);
  const exact = frag && listing.find((item) => item?.type === 'd' && item.name?.toLowerCase() === frag.toLowerCase());
  if (exact) return stripTrailingSlash(joinPath(dir, exact.name)) || '/';
  const typed = stripTrailingSlash(manual);
  if (typed) return typed;
  return stripTrailingSlash(dir) || '/';
}
