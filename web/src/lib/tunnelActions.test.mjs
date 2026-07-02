import assert from 'node:assert/strict';
import { copyTunnelUrl, tunnelLocalUrl } from './tunnelActions.mjs';

function formatsLocalTunnelUrls() {
  assert.equal(tunnelLocalUrl({ localPort: 5173 }), 'http://127.0.0.1:5173');
  assert.equal(tunnelLocalUrl({}), '');
}

async function copiesTunnelUrlsWithFallback() {
  const calls = [];
  const toasts = [];
  const result = await copyTunnelUrl({ localPort: 5173 }, {
    writeClipboard: async (text, opts) => {
      calls.push({ text, opts });
      return { ok: true };
    },
    toast: (msg, kind, ms) => toasts.push({ msg, kind, ms }),
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{ text: 'http://127.0.0.1:5173', opts: undefined }]);
  assert.deepEqual(toasts, [{ msg: 'Tunnel URL copied', kind: 'ok', ms: 1800 }]);
}

async function reportsTunnelCopyFailures() {
  const toasts = [];
  const result = await copyTunnelUrl({ localPort: 3000 }, {
    writeClipboard: async () => ({ ok: false, error: 'denied' }),
    toast: (msg, kind) => toasts.push({ msg, kind }),
  });

  assert.deepEqual(result, { ok: false, error: 'denied' });
  assert.deepEqual(toasts, [{ msg: 'Copy failed: denied', kind: 'error' }]);
}

formatsLocalTunnelUrls();
await copiesTunnelUrlsWithFallback();
await reportsTunnelCopyFailures();

console.log('tunnelActions tests ok');
