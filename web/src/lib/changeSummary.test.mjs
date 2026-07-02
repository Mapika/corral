import assert from 'node:assert/strict';
import {
  buildChangeCopyText,
  buildChangeReviewPrompt,
  changeSummaryLabel,
  changedFilesFromDiff,
  copyChangeSummaryText,
} from './changeSummary.mjs';

const diff = `diff --git a/server.js b/server.js
index 111..222 100644
--- a/server.js
+++ b/server.js
@@ -1 +1 @@
-old
+new
diff --git a/web/src/App.svelte b/web/src/App.svelte
index 333..444 100644
--- a/web/src/App.svelte
+++ b/web/src/App.svelte
@@ -1 +1 @@
-old
+new`;

function countsChangedFiles() {
  assert.deepEqual(changedFilesFromDiff(diff), ['server.js', 'web/src/App.svelte']);
  assert.deepEqual(changedFilesFromDiff(''), []);
}

function labelsReviewStates() {
  assert.equal(changeSummaryLabel({ loading: true }), 'checking');
  assert.equal(changeSummaryLabel({ isRepo: false }), 'not a git repo');
  assert.equal(changeSummaryLabel({ isRepo: true, diff: '', untracked: [] }), 'clean');
  assert.equal(changeSummaryLabel({ isRepo: true, diff, untracked: ['notes.md'] }), '2 changed / 1 untracked');
}

function buildsCopyText() {
  assert.equal(buildChangeCopyText({ isRepo: true, diff: '', untracked: [] }), '');
  assert.equal(
    buildChangeCopyText({ isRepo: true, diff: 'diff body', untracked: ['notes.md', 'tmp/log.txt'] }),
    'Untracked files:\nnotes.md\ntmp/log.txt\n\nDiff:\ndiff body',
  );
}

function buildsReviewPrompt() {
  assert.equal(buildChangeReviewPrompt({ isRepo: false }, '/repo'), '');
  assert.equal(buildChangeReviewPrompt({ isRepo: true, diff: '', untracked: [] }, '/repo'), '');
  assert.equal(
    buildChangeReviewPrompt({ isRepo: true, diff, untracked: ['notes.md'] }, '/repo'),
    'Please review the current working tree in /repo.\n\nFocus on correctness bugs, regressions, security issues, and missing tests.\n\nChanged files:\n- server.js\n- web/src/App.svelte\n\nUntracked files:\n- notes.md',
  );
}

async function copiesChangeSummaryWithClipboardFallback() {
  const calls = [];
  const toasts = [];
  const result = await copyChangeSummaryText('Diff:\n+new', {
    writeClipboard: async (text, opts) => {
      calls.push({ text, opts });
      return { ok: true };
    },
    toast: (msg, kind, ms) => toasts.push({ msg, kind, ms }),
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{ text: 'Diff:\n+new', opts: undefined }]);
  assert.deepEqual(toasts, [{ msg: 'Changes copied', kind: 'ok', ms: 2200 }]);
}

async function reportsChangeSummaryCopyFailures() {
  const toasts = [];
  const result = await copyChangeSummaryText('Diff:\n+new', {
    writeClipboard: async () => ({ ok: false, error: 'denied' }),
    toast: (msg, kind) => toasts.push({ msg, kind }),
  });

  assert.deepEqual(result, { ok: false, error: 'denied' });
  assert.deepEqual(toasts, [{ msg: 'Copy failed: denied', kind: 'error' }]);
}

countsChangedFiles();
labelsReviewStates();
buildsCopyText();
buildsReviewPrompt();
await copiesChangeSummaryWithClipboardFallback();
await reportsChangeSummaryCopyFailures();

console.log('changeSummary tests ok');
