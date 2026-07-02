import assert from 'node:assert/strict';
import { requestMutation } from './apiRequest.mjs';

async function rejectsFailedSessionStops() {
  let calls = 0;
  await assert.rejects(
    () => requestMutation('/api/chat/kill?id=s%201', {
      method: 'POST',
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 503, json: async () => ({}) };
      },
    }),
    /\/api\/chat\/kill\?id=s%201 failed: 503/,
  );

  assert.equal(calls, 1);
}

async function rejectsFailedTunnelDeletes() {
  let seenMethod = '';
  await assert.rejects(
    () => requestMutation('/api/tunnels?id=t%2F1', {
      method: 'DELETE',
      fetchImpl: async (path, opts) => {
        seenMethod = opts.method;
        return { ok: false, status: 500, json: async () => ({}) };
      },
    }),
    /\/api\/tunnels\?id=t%2F1 failed: 500/,
  );

  assert.equal(seenMethod, 'DELETE');
}

await rejectsFailedSessionStops();
await rejectsFailedTunnelDeletes();

console.log('apiMutations tests ok');
