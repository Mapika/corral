import assert from 'node:assert/strict';
import { openExternalUrl } from './externalOpen.mjs';

function opensWithNoopener() {
  const calls = [];
  const result = openExternalUrl('  http://127.0.0.1:5173  ', {
    openImpl: (...args) => {
      calls.push(args);
      return {};
    },
  });

  assert.deepEqual(result, { ok: true, url: 'http://127.0.0.1:5173' });
  assert.deepEqual(calls, [['http://127.0.0.1:5173', '_blank', 'noopener,noreferrer']]);
}

function reportsBlockedOrUnavailableOpen() {
  assert.deepEqual(openExternalUrl('http://127.0.0.1:3000', { openImpl: () => null }), {
    ok: false,
    error: 'popup blocked',
  });
  assert.deepEqual(openExternalUrl('http://127.0.0.1:3000', { openImpl: null }), {
    ok: false,
    error: 'window.open unavailable',
  });
  assert.deepEqual(openExternalUrl('', { openImpl: () => ({}) }), {
    ok: false,
    error: 'missing url',
  });
  assert.deepEqual(openExternalUrl('javascript:alert(1)', { openImpl: () => ({}) }), {
    ok: false,
    error: 'unsupported url scheme',
  });
  assert.deepEqual(openExternalUrl('file:///C:/Users/mark/secrets.txt', { openImpl: () => ({}) }), {
    ok: false,
    error: 'unsupported url scheme',
  });
}

opensWithNoopener();
reportsBlockedOrUnavailableOpen();

console.log('externalOpen tests ok');
