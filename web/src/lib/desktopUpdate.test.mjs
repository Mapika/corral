import assert from 'node:assert/strict';
import { updateLabel, updateReduce } from './desktopUpdate.mjs';

// happy path: found -> begin -> chunks -> downloaded, labels track every phase
{
  let st = updateReduce(null, { type: 'found', version: '0.8.3' });
  assert.equal(st.phase, 'available');
  assert.equal(updateLabel(st), 'update to 0.8.3');
  st = updateReduce(st, { type: 'begin', total: 200 });
  st = updateReduce(st, { type: 'chunk', size: 50 });
  assert.equal(updateLabel(st), 'updating 25%');
  st = updateReduce(st, { type: 'chunk', size: 150 });
  assert.equal(updateLabel(st), 'updating 99%');            // never claims 100 before Finished
  st = updateReduce(st, { type: 'downloaded' });
  assert.equal(updateLabel(st), 'restarting…');
}

// unknown size stays honest; chunks outside a download are ignored
assert.equal(updateLabel(updateReduce(updateReduce(null, { type: 'found', version: '1' }), { type: 'begin', total: 0 })), 'updating…');
{
  const st = updateReduce(updateReduce(null, { type: 'found', version: '1' }), { type: 'chunk', size: 10 });
  assert.equal(st.got, 0);
}

// a failed download falls back to the tappable "update to X" with the error kept
{
  let st = updateReduce(null, { type: 'found', version: '0.9.0' });
  st = updateReduce(st, { type: 'begin', total: 10 });
  st = updateReduce(st, { type: 'error', message: 'network gone' });
  assert.equal(st.phase, 'available');
  assert.equal(st.error, 'network gone');
  assert.equal(updateLabel(st), 'update to 0.9.0');
}

// nothing found -> no pill
assert.equal(updateLabel(null), '');
assert.equal(updateLabel(updateReduce(null, null)), '');
assert.equal(updateLabel(updateReduce(null, { type: 'error', message: 'check failed' })), '');

console.log('desktopUpdate tests ok');
