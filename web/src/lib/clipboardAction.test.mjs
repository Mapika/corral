import assert from 'node:assert/strict';
import { writeClipboardText } from './clipboardAction.mjs';

async function writesText() {
  const writes = [];
  const result = await writeClipboardText('daily brief', {
    legacyCopy: () => false,
    writeText: async (text) => writes.push(text),
    timeoutMs: 20,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(writes, ['daily brief']);
}

async function reportsWriteFailure() {
  const result = await writeClipboardText('daily brief', {
    legacyCopy: () => false,
    writeText: async () => { throw new Error('denied'); },
    timeoutMs: 20,
  });
  assert.deepEqual(result, { ok: false, error: 'denied' });
}

async function reportsWriteTimeout() {
  const result = await writeClipboardText('daily brief', {
    legacyCopy: () => false,
    writeText: () => new Promise(() => {}),
    timeoutMs: 1,
  });
  assert.deepEqual(result, { ok: false, error: 'clipboard timed out' });
}

async function usesLegacyCopyBeforeAsyncWriter() {
  let asyncCalls = 0;
  const legacyWrites = [];
  const result = await writeClipboardText('daily brief', {
    legacyCopy: (text) => {
      legacyWrites.push(text);
      return true;
    },
    writeText: async () => {
      asyncCalls += 1;
    },
    timeoutMs: 20,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(legacyWrites, ['daily brief']);
  assert.equal(asyncCalls, 0);
}

async function canSkipAsyncFallback() {
  let asyncCalls = 0;
  const result = await writeClipboardText('daily brief', {
    legacyCopy: () => false,
    fallbackToAsync: false,
    writeText: async () => {
      asyncCalls += 1;
    },
    timeoutMs: 20,
  });
  assert.deepEqual(result, { ok: false, error: 'copy failed' });
  assert.equal(asyncCalls, 0);
}

await writesText();
await reportsWriteFailure();
await reportsWriteTimeout();
await usesLegacyCopyBeforeAsyncWriter();
await canSkipAsyncFallback();

console.log('clipboardAction tests ok');
