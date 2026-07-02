import { writeClipboardText } from './clipboardAction.mjs';

export function tunnelLocalUrl(tunnel = {}) {
  return tunnel.localPort ? 'http://127.0.0.1:' + tunnel.localPort : '';
}

export async function copyTunnelUrl(tunnel, { writeClipboard = writeClipboardText, toast } = {}) {
  const result = await writeClipboard(tunnelLocalUrl(tunnel));
  if (result.ok) toast?.('Tunnel URL copied', 'ok', 1800);
  else toast?.('Copy failed: ' + (result.error || 'unknown'), 'error');
  return result;
}
