import assert from 'node:assert/strict';
import { normalizeFilePathInput, parentPath } from './filePathInput.mjs';

function normalizesTypedPaths() {
  assert.equal(normalizeFilePathInput('', '/work'), '/work');
  assert.equal(normalizeFilePathInput('  /mnt/data/app/  '), '/mnt/data/app');
  assert.equal(normalizeFilePathInput('C:\\Users\\mark\\app\\'), 'C:/Users/mark/app');
  assert.equal(normalizeFilePathInput('D:'), 'D:/');
  assert.equal(normalizeFilePathInput('C:/'), 'C:/');
  assert.equal(normalizeFilePathInput('C:\\'), 'C:/');
  assert.equal(normalizeFilePathInput('/'), '/');
  assert.equal(normalizeFilePathInput('~'), '~');
}

function findsParents() {
  assert.equal(parentPath('/mnt/data/app'), '/mnt/data');
  assert.equal(parentPath('/mnt'), '/');
  assert.equal(parentPath('/'), '/');
  assert.equal(parentPath('C:/Users/mark/app'), 'C:/Users/mark');
  assert.equal(parentPath('C:/Users'), 'C:/');
  assert.equal(parentPath('C:/'), 'C:/');
  assert.equal(parentPath('~/projects/app'), '~/projects');
  assert.equal(parentPath('~'), '~');
}

normalizesTypedPaths();
findsParents();

console.log('filePathInput tests ok');
