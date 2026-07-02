import assert from 'node:assert/strict';
import { parseTunnelForm, tunnelListState, tunnelStatusView } from './tunnelStatus.mjs';

function labelsHttpServiceHealth() {
  assert.deepEqual(tunnelStatusView({ status: 'up', http: true, serviceStatus: 'reachable', serviceStatusCode: 404 }), {
    label: 'reachable',
    tone: 'ok',
    detail: 'HTTP service answered 404',
    canCopy: true,
    canOpen: true,
  });
  assert.deepEqual(tunnelStatusView({ status: 'up', http: true, serviceStatus: 'service-down', serviceError: 'ECONNREFUSED' }), {
    label: 'service down',
    tone: 'warn',
    detail: 'ECONNREFUSED',
    canCopy: true,
    canOpen: false,
  });
  assert.deepEqual(tunnelStatusView({ status: 'up', http: true, serviceStatus: 'probing' }), {
    label: 'checking',
    tone: 'starting',
    detail: 'checking HTTP service',
    canCopy: true,
    canOpen: false,
  });
}

function keepsSshTunnelStateSeparate() {
  assert.equal(tunnelStatusView({ status: 'up', http: false }).label, 'tunnel up');
  assert.equal(tunnelStatusView({ status: 'starting' }).label, 'starting');
  assert.equal(tunnelStatusView({ status: 'error', error: 'ssh failed' }).detail, 'ssh failed');
}

function separatesErrorAndEmptyStates() {
  assert.deepEqual(tunnelListState({ tunnels: [], loadErr: 'offline' }), {
    showError: true,
    showEmpty: false,
  });
  assert.deepEqual(tunnelListState({ tunnels: [{ id: 't1' }], loadErr: 'offline' }), {
    showError: true,
    showEmpty: false,
  });
  assert.deepEqual(tunnelListState({ tunnels: [], loadErr: '' }), {
    showError: false,
    showEmpty: true,
  });
}

function validatesTunnelPortsStrictly() {
  assert.deepEqual(parseTunnelForm({ remotePort: '8080', localPort: '' }), {
    ok: true,
    remoteHost: '127.0.0.1',
    remotePort: 8080,
    localPort: undefined,
  });
  assert.deepEqual(parseTunnelForm({ remotePort: '8080', localPort: '5173' }), {
    ok: true,
    remoteHost: '127.0.0.1',
    remotePort: 8080,
    localPort: 5173,
  });
  assert.deepEqual(parseTunnelForm({ remotePort: '8080abc', localPort: '' }), {
    ok: false,
    error: 'Enter a remote port from 1 to 65535.',
  });
  assert.deepEqual(parseTunnelForm({ remotePort: '8.5', localPort: '' }), {
    ok: false,
    error: 'Enter a remote port from 1 to 65535.',
  });
  assert.deepEqual(parseTunnelForm({ remotePort: '8080', localPort: '0' }), {
    ok: false,
    error: 'Local port must be from 1 to 65535, or left as auto.',
  });
}

function validatesRemoteHostsBeforeForwarding() {
  assert.deepEqual(parseTunnelForm({ remoteHost: '  app.internal_1  ', remotePort: '8080', localPort: '' }), {
    ok: true,
    remoteHost: 'app.internal_1',
    remotePort: 8080,
    localPort: undefined,
  });
  assert.deepEqual(parseTunnelForm({ remoteHost: '', remotePort: '8080', localPort: '' }), {
    ok: false,
    error: 'Enter a remote host.',
  });
  assert.deepEqual(parseTunnelForm({ remoteHost: 'http://localhost', remotePort: '8080', localPort: '' }), {
    ok: false,
    error: 'Remote host must use letters, numbers, dots, underscores, or hyphens.',
  });
  assert.deepEqual(parseTunnelForm({ remoteHost: 'bad host', remotePort: '8080', localPort: '' }), {
    ok: false,
    error: 'Remote host must use letters, numbers, dots, underscores, or hyphens.',
  });
}

labelsHttpServiceHealth();
keepsSshTunnelStateSeparate();
separatesErrorAndEmptyStates();
validatesTunnelPortsStrictly();
validatesRemoteHostsBeforeForwarding();

console.log('tunnelStatus tests ok');
