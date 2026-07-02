import assert from 'node:assert/strict';
import { runUploadBatch, uploadMessage } from './fileUploads.mjs';

async function keepsFailedUploadsVisible() {
  const files = [{ name: 'ok.txt' }, { name: 'bad.txt' }];
  const snapshots = [];
  const toasts = [];
  const result = await runUploadBatch(files, {
    host: 'local',
    cwd: '/work',
    records: [],
    onRecords: (next) => snapshots.push(next.map((r) => ({ ...r }))),
    toast: (msg) => toasts.push(msg),
    uploadFile: async (host, cwd, file, progress) => {
      progress(file.name === 'ok.txt' ? 1 : 0.4);
      return file.name === 'ok.txt' ? { ok: true } : { ok: false, error: 'disk full' };
    },
  });

  const last = snapshots.at(-1);
  assert.equal(result.changed, true);
  assert.equal(result.failed, 1);
  assert.deepEqual(last.map((r) => [r.name, r.pct, r.error, r.message]), [
    ['bad.txt', 40, true, 'disk full'],
  ]);
  assert.deepEqual(toasts, ['Upload failed: bad.txt']);
}

async function marksThrownUploadsAsFailed() {
  const snapshots = [];
  const result = await runUploadBatch([{ name: 'boom.txt' }], {
    records: [],
    onRecords: (next) => snapshots.push(next.map((r) => ({ ...r }))),
    toast: () => {},
    uploadFile: async () => { throw new Error('network down'); },
  });

  assert.equal(result.changed, false);
  assert.equal(result.failed, 1);
  assert.equal(snapshots.at(-1)[0].error, true);
  assert.equal(snapshots.at(-1)[0].message, 'network down');
}

function formatsUploadErrors() {
  assert.equal(uploadMessage({ error: 'disk full' }), 'disk full');
  assert.equal(uploadMessage(new Error('/api/upload failed: path denied')), 'path denied');
  assert.equal(uploadMessage(''), 'upload failed');
  assert.equal(uploadMessage({ ok: false }), 'upload failed');
  assert.equal(uploadMessage({ ok: false, error: { code: 13 } }), 'upload failed');
}

await keepsFailedUploadsVisible();
await marksThrownUploadsAsFailed();
formatsUploadErrors();

console.log('fileUploads tests ok');
