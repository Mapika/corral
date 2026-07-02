const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableStatus(status) {
  if (!status) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

async function responseError(path, response) {
  let detail = '';
  try {
    const body = await response.json();
    if (typeof body === 'string') detail = body;
    else detail = body?.error || body?.message || body?.detail || '';
  } catch (e) {}

  const error = new Error(path + ' failed: ' + (String(detail || '').trim() || response.status));
  error.status = response.status;
  error.retryable = isRetryableStatus(response.status);
  return error;
}

export async function requestJson(path, {
  fetchImpl = globalThis.fetch,
  getHeaders = () => ({}),
  headers = {},
  retries = 2,
  retryDelay = 180,
  fallback,
  ...opts
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  let last;
  const hasFallback = Object.prototype.hasOwnProperty.call(arguments[1] || {}, 'fallback');

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response;
    try {
      const r = await fetchImpl(path, { ...opts, headers: { ...getHeaders(), ...headers } });
      if (!r.ok) throw await responseError(path, r);
      response = r;
    } catch (e) {
      last = e;
      if (attempt < retries && e?.retryable !== false) await sleep(retryDelay * (attempt + 1));
      else break;
      continue;
    }
    return response.json();
  }

  if (hasFallback) return fallback;
  throw last;
}

export async function requestText(path, {
  fetchImpl = globalThis.fetch,
  getHeaders = () => ({}),
  headers = {},
  retries = 2,
  retryDelay = 180,
  fallback,
  ...opts
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  let last;
  const hasFallback = Object.prototype.hasOwnProperty.call(arguments[1] || {}, 'fallback');

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response;
    try {
      const r = await fetchImpl(path, { ...opts, headers: { ...getHeaders(), ...headers } });
      if (!r.ok) throw await responseError(path, r);
      response = r;
    } catch (e) {
      last = e;
      if (attempt < retries && e?.retryable !== false) await sleep(retryDelay * (attempt + 1));
      else break;
      continue;
    }
    return response.text();
  }

  if (hasFallback) return fallback;
  throw last;
}

export async function requestMutation(path, opts = {}) {
  return requestJson(path, { ...opts, retries: 0 });
}

export function apiErrorMessage(error, fallback = 'Request failed.') {
  const text = String(error?.message || error || '').trim();
  if (!text) return fallback;
  const marker = ' failed: ';
  const index = text.indexOf(marker);
  return index >= 0 ? text.slice(index + marker.length).trim() || fallback : text;
}
