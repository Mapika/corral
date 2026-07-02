import { apiErrorMessage } from './apiRequest.mjs';
import { writeClipboardText } from './clipboardAction.mjs';

export function chatLaunchTarget({ host, cwd } = {}) {
  return {
    host: host || 'local',
    path: String(cwd || '').trim() || '~',
  };
}

export async function runFileOperation({ label = 'File action', run, cleanup, refresh, toast } = {}) {
  try {
    const result = await run?.();
    if (result && result.ok) {
      await refresh?.();
      return { ok: true };
    }

    const error = apiErrorMessage(result?.error || 'unknown', 'unknown');
    toast?.(`${label} failed: ${error}`);
    return { ok: false, error };
  } catch (e) {
    const error = apiErrorMessage(e, 'unknown');
    toast?.(`${label} failed: ${error}`);
    return { ok: false, error };
  } finally {
    cleanup?.();
  }
}

export async function copyFilePathText(path, { writeClipboard = writeClipboardText, toast } = {}) {
  const result = await writeClipboard(path);
  if (result.ok) toast?.('Path copied', 'ok', 1800);
  else toast?.('Copy failed: ' + (result.error || 'unknown'), 'error');
  return result;
}

export function filePreviewError(name, error, url = '') {
  return {
    kind: 'error',
    name: String(name || '').trim() || 'file',
    message: apiErrorMessage(error, 'Could not preview this file.'),
    url,
  };
}
