import assert from 'node:assert/strict';
import { apiErrorMessage, requestJson, requestText } from './apiRequest.mjs';

async function retriesTransientFailures() {
  let calls = 0;
  const result = await requestJson('/api/example', {
    retryDelay: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
}

async function throwsAfterRetriesWithoutFallback() {
  let calls = 0;
  await assert.rejects(
    () => requestJson('/api/missing', {
      retries: 1,
      retryDelay: 0,
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 503, json: async () => ({}) };
      },
    }),
    /\/api\/missing failed: 503/,
  );
  assert.equal(calls, 2);
}

async function returnsExplicitFallbackAfterRetries() {
  const result = await requestJson('/api/list', {
    retries: 0,
    retryDelay: 0,
    fallback: [],
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });

  assert.deepEqual(result, []);
}

async function surfacesClientErrorBodyWithoutRetrying() {
  let calls = 0;
  await assert.rejects(
    () => requestJson('/api/ls?server=local&path=Z%3A%2Fmissing', {
      retryDelay: 0,
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 400, json: async () => ({ error: 'path does not exist' }) };
      },
    }),
    /\/api\/ls\?server=local&path=Z%3A%2Fmissing failed: path does not exist/,
  );

  assert.equal(calls, 1);
}

async function rejectsFailedTextResponses() {
  let calls = 0;
  await assert.rejects(
    () => requestText('/api/file?server=local&path=C%3A%2Fmissing.txt', {
      retries: 1,
      retryDelay: 0,
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 400, json: async () => ({ error: 'file not found' }) };
      },
    }),
    /\/api\/file\?server=local&path=C%3A%2Fmissing\.txt failed: file not found/,
  );

  assert.equal(calls, 1);
}

async function readsSuccessfulTextResponsesWithHeaders() {
  let seen = null;
  const result = await requestText('/api/file?server=local&path=C%3A%2Freadme.md', {
    fetchImpl: async (path, opts) => {
      seen = { path, opts };
      return { ok: true, status: 200, text: async () => 'hello' };
    },
    getHeaders: () => ({ Authorization: 'Bearer token-123' }),
  });

  assert.equal(result, 'hello');
  assert.deepEqual(seen, {
    path: '/api/file?server=local&path=C%3A%2Freadme.md',
    opts: { headers: { Authorization: 'Bearer token-123' } },
  });
}

async function doesNotRetrySuccessfulResponseWithBadBody() {
  let calls = 0;
  await assert.rejects(
    () => requestJson('/api/example', {
      retries: 2,
      retryDelay: 0,
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, status: 200, json: async () => { throw new Error('Unexpected token < in JSON'); } };
      },
    }),
    /Unexpected token < in JSON/,
  );
  assert.equal(calls, 1);
}

async function doesNotRetrySuccessfulTextResponseWithBadBody() {
  let calls = 0;
  await assert.rejects(
    () => requestText('/api/file', {
      retries: 2,
      retryDelay: 0,
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, status: 200, text: async () => { throw new Error('stream aborted'); } };
      },
    }),
    /stream aborted/,
  );
  assert.equal(calls, 1);
}

function formatsUserFacingApiErrors() {
  assert.equal(
    apiErrorMessage(new Error('/api/ls?server=local&path=x failed: Path does not exist.'), 'Could not load.'),
    'Path does not exist.',
  );
  assert.equal(apiErrorMessage(new Error('network down'), 'Could not load.'), 'network down');
  assert.equal(apiErrorMessage(null, 'Could not load.'), 'Could not load.');
}

await retriesTransientFailures();
await throwsAfterRetriesWithoutFallback();
await returnsExplicitFallbackAfterRetries();
await surfacesClientErrorBodyWithoutRetrying();
await rejectsFailedTextResponses();
await readsSuccessfulTextResponsesWithHeaders();
await doesNotRetrySuccessfulResponseWithBadBody();
await doesNotRetrySuccessfulTextResponseWithBadBody();
formatsUserFacingApiErrors();

console.log('apiRequest tests ok');
