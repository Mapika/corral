import assert from 'node:assert/strict';
import { chatLaunchTarget, copyFilePathText, filePreviewError, runFileOperation } from './fileActions.mjs';

function targetsCurrentFolderForChatLaunch() {
  assert.deepEqual(
    chatLaunchTarget({ host: 'gb300', cwd: '/mnt/data/mark/projects/molecular-interp' }),
    { host: 'gb300', path: '/mnt/data/mark/projects/molecular-interp' },
  );
}

function fallsBackToHomeForBlankFolder() {
  assert.deepEqual(
    chatLaunchTarget({ host: '', cwd: '' }),
    { host: 'local', path: '~' },
  );
}

async function cleansUpThrownFileOperation() {
  const toasts = [];
  let cleaned = 0;
  let refreshed = 0;
  const result = await runFileOperation({
    label: 'Rename',
    run: async () => { throw new Error('/api/fileop?op=rename failed: not found'); },
    cleanup: () => { cleaned += 1; },
    refresh: () => { refreshed += 1; },
    toast: (msg) => toasts.push(msg),
  });

  assert.deepEqual(result, { ok: false, error: 'not found' });
  assert.equal(cleaned, 1);
  assert.equal(refreshed, 0);
  assert.deepEqual(toasts, ['Rename failed: not found']);
}

async function copiesFilePathsWithClipboardFallback() {
  const calls = [];
  const toasts = [];
  const result = await copyFilePathText('C:/work/codapp', {
    writeClipboard: async (text, opts) => {
      calls.push({ text, opts });
      return { ok: true };
    },
    toast: (msg, kind, ms) => toasts.push({ msg, kind, ms }),
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{ text: 'C:/work/codapp', opts: undefined }]);
  assert.deepEqual(toasts, [{ msg: 'Path copied', kind: 'ok', ms: 1800 }]);
}

async function reportsFilePathCopyFailures() {
  const toasts = [];
  const result = await copyFilePathText('/work/codapp', {
    writeClipboard: async () => ({ ok: false, error: 'denied' }),
    toast: (msg, kind) => toasts.push({ msg, kind }),
  });

  assert.deepEqual(result, { ok: false, error: 'denied' });
  assert.deepEqual(toasts, [{ msg: 'Copy failed: denied', kind: 'error' }]);
}

function buildsFilePreviewErrors() {
  assert.deepEqual(
    filePreviewError('README.md', new Error('/api/file?server=local failed: access denied'), '/api/file?dl=1'),
    {
      kind: 'error',
      name: 'README.md',
      message: 'access denied',
      url: '/api/file?dl=1',
    },
  );
  assert.deepEqual(
    filePreviewError('', null, ''),
    {
      kind: 'error',
      name: 'file',
      message: 'Could not preview this file.',
      url: '',
    },
  );
}

targetsCurrentFolderForChatLaunch();
fallsBackToHomeForBlankFolder();
await cleansUpThrownFileOperation();
await copiesFilePathsWithClipboardFallback();
await reportsFilePathCopyFailures();
buildsFilePreviewErrors();

console.log('fileActions tests ok');
