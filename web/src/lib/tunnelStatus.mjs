function firstLine(text, fallback) {
  const line = String(text || '').trim().split(/\r?\n/)[0];
  return (line || fallback).slice(0, 100);
}

function parsePortValue(value) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function parseRemoteHostValue(value) {
  const text = String(value ?? '127.0.0.1').trim();
  if (!text) return { ok: false, error: 'Enter a remote host.' };
  if (!/^[A-Za-z0-9._-]+$/.test(text)) {
    return { ok: false, error: 'Remote host must use letters, numbers, dots, underscores, or hyphens.' };
  }
  return { ok: true, remoteHost: text };
}

export function parseTunnelForm({ remoteHost, remotePort = '', localPort = '' } = {}) {
  const parsedHost = parseRemoteHostValue(remoteHost);
  if (!parsedHost.ok) return parsedHost;

  const parsedRemote = parsePortValue(remotePort);
  if (!parsedRemote) return { ok: false, error: 'Enter a remote port from 1 to 65535.' };

  const localText = String(localPort || '').trim();
  if (!localText) return { ok: true, remoteHost: parsedHost.remoteHost, remotePort: parsedRemote, localPort: undefined };

  const parsedLocal = parsePortValue(localText);
  if (!parsedLocal) return { ok: false, error: 'Local port must be from 1 to 65535, or left as auto.' };
  return { ok: true, remoteHost: parsedHost.remoteHost, remotePort: parsedRemote, localPort: parsedLocal };
}

export function tunnelStatusView(tunnel = {}) {
  if (tunnel.status === 'starting') {
    return { label: 'starting', tone: 'starting', detail: 'opening SSH tunnel', canCopy: false, canOpen: false };
  }
  if (tunnel.status === 'stopping') {
    return { label: 'stopping', tone: 'starting', detail: 'closing SSH tunnel', canCopy: false, canOpen: false };
  }
  if (tunnel.status === 'error') {
    return { label: 'error', tone: 'err', detail: firstLine(tunnel.error, 'SSH tunnel failed'), canCopy: false, canOpen: false };
  }

  if (tunnel.status === 'up' && tunnel.http) {
    if (tunnel.serviceStatus === 'reachable') {
      const suffix = tunnel.serviceStatusCode ? ' ' + tunnel.serviceStatusCode : '';
      return { label: 'reachable', tone: 'ok', detail: 'HTTP service answered' + suffix, canCopy: true, canOpen: true };
    }
    if (tunnel.serviceStatus === 'service-down') {
      return { label: 'service down', tone: 'warn', detail: firstLine(tunnel.serviceError, 'No HTTP response through tunnel'), canCopy: true, canOpen: false };
    }
    return { label: 'checking', tone: 'starting', detail: 'checking HTTP service', canCopy: true, canOpen: false };
  }

  if (tunnel.status === 'up') {
    return { label: 'tunnel up', tone: 'ok', detail: 'SSH tunnel is open', canCopy: false, canOpen: false };
  }

  return { label: tunnel.status || 'unknown', tone: 'err', detail: 'tunnel state unknown', canCopy: false, canOpen: false };
}

export function tunnelListState({ tunnels = [], loadErr = '' } = {}) {
  const showError = !!loadErr;
  return {
    showError,
    showEmpty: !showError && tunnels.length === 0,
  };
}
