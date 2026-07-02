import { writeClipboardText } from './clipboardAction.mjs';

export function changedFilesFromDiff(diff = '') {
  const seen = new Set();
  const files = [];
  for (const match of String(diff || '').matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const file = match[2].trim();
    if (file && !seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  }
  return files;
}

export function changeSummaryLabel(changes = {}) {
  if (changes.loading) return 'checking';
  if (changes.isRepo === false) return 'not a git repo';
  const changed = changedFilesFromDiff(changes.diff).length;
  const untracked = Array.isArray(changes.untracked) ? changes.untracked.length : 0;
  if (!changed && !untracked) return 'clean';
  const parts = [];
  if (changed) parts.push(changed + ' changed');
  if (untracked) parts.push(untracked + ' untracked');
  return parts.join(' / ');
}

export function buildChangeCopyText(changes = {}) {
  if (!changes.isRepo) return '';
  const parts = [];
  const untracked = Array.isArray(changes.untracked) ? changes.untracked : [];
  if (untracked.length) parts.push('Untracked files:\n' + untracked.join('\n'));
  if (changes.diff) parts.push('Diff:\n' + changes.diff);
  return parts.join('\n\n');
}

export function buildChangeReviewPrompt(changes = {}, cwd = '') {
  if (!changes.isRepo) return '';
  const changed = changedFilesFromDiff(changes.diff);
  const untracked = Array.isArray(changes.untracked) ? changes.untracked : [];
  if (!changed.length && !untracked.length) return '';

  const where = cwd ? ' in ' + cwd : '';
  const parts = [
    'Please review the current working tree' + where + '.',
    '',
    'Focus on correctness bugs, regressions, security issues, and missing tests.',
  ];
  if (changed.length) parts.push('', 'Changed files:', ...changed.map((file) => '- ' + file));
  if (untracked.length) parts.push('', 'Untracked files:', ...untracked.map((file) => '- ' + file));
  return parts.join('\n');
}

export async function copyChangeSummaryText(text, { writeClipboard = writeClipboardText, toast } = {}) {
  const result = await writeClipboard(text);
  if (result.ok) toast?.('Changes copied', 'ok', 2200);
  else toast?.('Copy failed: ' + (result.error || 'unknown'), 'error');
  return result;
}
