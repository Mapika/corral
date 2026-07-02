import assert from 'node:assert/strict';
import { chatHandoffs, isRemoteSession } from './sessionHandoffs.mjs';

function classifiesRemoteSessions() {
  assert.equal(isRemoteSession({ host: 'gb300' }), true);
  assert.equal(isRemoteSession({ host: 'local' }), false);
  assert.equal(isRemoteSession({}), false);
}

function returnsContextualHandoffs() {
  assert.deepEqual(chatHandoffs({ host: 'local', cwd: 'C:/work/app' }).map((a) => a.kind), ['files', 'terminal']);
  assert.deepEqual(chatHandoffs({ host: 'gb300', cwd: '/mnt/work/app' }).map((a) => a.kind), ['files', 'terminal', 'tunnels']);
}

classifiesRemoteSessions();
returnsContextualHandoffs();

console.log('sessionHandoffs tests ok');
