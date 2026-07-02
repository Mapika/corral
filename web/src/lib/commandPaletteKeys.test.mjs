import assert from 'node:assert/strict';
import { commandPaletteKeyAction } from './commandPaletteKeys.mjs';

function handlesGlobalPaletteKeys() {
  assert.deepEqual(commandPaletteKeyAction({ key: 'Escape', active: 2, resultCount: 5 }), {
    type: 'close',
    active: 2,
  });
  assert.deepEqual(commandPaletteKeyAction({ key: 'ArrowDown', active: 1, resultCount: 3 }), {
    type: 'active',
    active: 2,
  });
  assert.deepEqual(commandPaletteKeyAction({ key: 'ArrowDown', active: 2, resultCount: 3 }), {
    type: 'active',
    active: 2,
  });
  assert.deepEqual(commandPaletteKeyAction({ key: 'ArrowUp', active: 0, resultCount: 3 }), {
    type: 'active',
    active: 0,
  });
  assert.deepEqual(commandPaletteKeyAction({ key: 'Enter', active: 1, resultCount: 3 }), {
    type: 'pick',
    active: 1,
  });
}

function ignoresTextEntryAndEmptyPicks() {
  assert.deepEqual(commandPaletteKeyAction({ key: 'c', active: 0, resultCount: 3 }), {
    type: 'none',
    active: 0,
  });
  assert.deepEqual(commandPaletteKeyAction({ key: 'Enter', active: 0, resultCount: 0 }), {
    type: 'none',
    active: 0,
  });
  assert.deepEqual(commandPaletteKeyAction({ key: 'ArrowDown', active: 0, resultCount: 0 }), {
    type: 'active',
    active: 0,
  });
}

handlesGlobalPaletteKeys();
ignoresTextEntryAndEmptyPicks();

console.log('commandPaletteKeys tests ok');
