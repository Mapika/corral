import assert from 'node:assert/strict';
import {
  agentLabel,
  canSubmitMessage,
  composerPlaceholder,
  composerSubmitState,
  sessionEndAction,
  sessionResumeAction,
  sessionHostLabel,
  sessionPathParts,
  sessionStatusView,
} from './sessionView.mjs';

function formatsSessionIdentity() {
  assert.deepEqual(sessionPathParts('C:\\D_Drive\\projects\\codapp'), {
    path: 'C:/D_Drive/projects/codapp',
    parent: 'C:/D_Drive/projects',
    project: 'codapp',
  });
  assert.deepEqual(sessionPathParts('/home/mark/work/api/'), {
    path: '/home/mark/work/api',
    parent: '/home/mark/work',
    project: 'api',
  });
  assert.equal(sessionPathParts('').project, '~');
  assert.equal(sessionHostLabel('local'), 'local');
  assert.equal(sessionHostLabel('gb300'), 'gb300');
}

function mapsLifecycleState() {
  assert.deepEqual(sessionStatusView('starting'), {
    label: 'starting',
    detail: 'opening stream',
    tone: 'busy',
  });
  assert.deepEqual(sessionStatusView('busy'), {
    label: 'running',
    detail: 'turn in progress',
    tone: 'busy',
  });
  assert.deepEqual(sessionStatusView('idle'), {
    label: 'ready',
    detail: 'waiting for input',
    tone: 'idle',
  });
  assert.deepEqual(sessionStatusView('dormant'), {
    label: 'parked',
    detail: 'resume to continue',
    tone: 'dormant',
  });
  assert.deepEqual(sessionStatusView('exited'), {
    label: 'ended',
    detail: 'process closed',
    tone: 'error',
  });
}

function queuesDuringBusyTurns() {
  assert.equal(canSubmitMessage({ status: 'busy', ended: false }), true);       // queued by the backend
  assert.equal(canSubmitMessage({ status: 'starting', ended: false }), true);   // adapters queue until ready
  assert.equal(canSubmitMessage({ status: 'dormant', ended: false }), false);   // resume first
  assert.equal(canSubmitMessage({ status: 'idle', ended: false }), true);
  assert.equal(canSubmitMessage({ status: 'idle', ended: true }), false);
}

function blocksSubmitWhileUploadsArePending() {
  assert.deepEqual(composerSubmitState({
    status: 'idle',
    draft: 'please read this',
    attachments: [{ name: 'trace.log', done: false, error: false }],
  }), {
    canSend: false,
    reason: 'uploading',
    hint: 'Wait for uploads to finish.',
  });
  assert.deepEqual(composerSubmitState({
    status: 'idle',
    draft: '',
    attachments: [{ name: 'trace.log', done: true, error: false }],
  }), {
    canSend: true,
    reason: 'ready',
    hint: '',
  });
  assert.deepEqual(composerSubmitState({
    status: 'idle',
    draft: '',
    attachments: [{ name: 'trace.log', done: false, error: true }],
  }), {
    canSend: false,
    reason: 'failed-only',
    hint: 'Remove failed uploads or type a message.',
  });
  assert.deepEqual(composerSubmitState({
    status: 'busy',
    draft: 'wait',
    attachments: [],
  }), {
    canSend: true,
    reason: 'queue',
    hint: 'Sends when this turn ends.',
  });
  assert.deepEqual(composerSubmitState({
    status: 'idle',
    draft: 'hello',
    attachments: null,
  }), {
    canSend: true,
    reason: 'ready',
    hint: '',
  });
}

function givesFocusedPlaceholders() {
  assert.equal(composerPlaceholder({ status: 'busy', project: 'codapp' }), 'Claude is working...');
  assert.equal(composerPlaceholder({ status: 'busy', project: 'codapp', agent: 'codex' }), 'Codex is working...');
  assert.equal(composerPlaceholder({ status: 'busy', project: 'codapp', agent: 'opencode' }), 'OpenCode is working...');
  assert.equal(agentLabel('codex'), 'Codex');
  assert.equal(agentLabel(undefined), 'Claude');
  assert.equal(agentLabel('unknown-agent'), 'Claude');
  assert.equal(composerPlaceholder({ status: 'starting', project: 'codapp' }), 'Opening codapp...');
  assert.equal(composerPlaceholder({ status: 'dormant', project: 'codapp' }), 'Session is parked.');
  assert.equal(composerPlaceholder({ status: 'idle', project: 'codapp' }), 'Message codapp...');
  assert.equal(composerPlaceholder({ status: 'idle', ended: true, project: 'codapp' }), 'Session ended.');
}

function offersExplicitResumeForParkedSessions() {
  assert.deepEqual(sessionResumeAction({ status: 'dormant' }), {
    label: 'Resume',
    title: 'Resume session and reconnect the stream',
  });
  assert.equal(sessionResumeAction({ status: 'exited', sessionId: 'abc' }), null);
  assert.equal(sessionResumeAction({ status: 'busy' }), null);
}

function showsOnlyUsefulEndActions() {
  assert.deepEqual(sessionEndAction({ status: 'idle' }), {
    kind: 'kill',
    label: 'End',
    title: 'End session',
    icon: 'close',
    danger: false,
  });
  assert.deepEqual(sessionEndAction({ status: 'exited' }), {
    kind: 'remove',
    label: 'Remove',
    title: 'Remove session',
    icon: 'trash',
    danger: true,
  });
  assert.equal(sessionEndAction({ status: 'dormant' }), null);
}

formatsSessionIdentity();
mapsLifecycleState();
queuesDuringBusyTurns();
blocksSubmitWhileUploadsArePending();
givesFocusedPlaceholders();
offersExplicitResumeForParkedSessions();
showsOnlyUsefulEndActions();

console.log('sessionView tests ok');
