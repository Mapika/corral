import assert from 'node:assert/strict';
import { dirPickerListState, launchTargetFromManual, parsePathInput, stripTrailingSlash, withTrailingSlash } from './dirPickerPath.mjs';

function parsesPathInput() {
  assert.deepEqual(parsePathInput('/home/mark/app'), { dir: '/home/mark/', frag: 'app' });
  assert.deepEqual(parsePathInput('C:/D_Drive/projects/codapp'), { dir: 'C:/D_Drive/projects/', frag: 'codapp' });
  assert.deepEqual(parsePathInput('/'), { dir: '/', frag: '' });
}

function normalizesTrailingSlash() {
  assert.equal(withTrailingSlash('/home/mark/app'), '/home/mark/app/');
  assert.equal(stripTrailingSlash('/home/mark/app/'), '/home/mark/app');
  assert.equal(stripTrailingSlash('/'), '/');
}

function resolvesLaunchTargetFromTypedPath() {
  assert.equal(
    launchTargetFromManual('/home/mark/projects/codapp', []),
    '/home/mark/projects/codapp',
  );
  assert.equal(
    launchTargetFromManual('/home/mark/projects/codapp', [{ name: 'codapp', type: 'd' }]),
    '/home/mark/projects/codapp',
  );
  assert.equal(
    launchTargetFromManual('/home/mark/projects/', []),
    '/home/mark/projects',
  );
}

function exposesDirectoryLoadFailures() {
  const state = dirPickerListState({
    loading: false,
    loadError: 'Access denied',
    listing: [{ name: 'codapp', type: 'd' }],
    matches: [{ name: 'codapp', type: 'd' }],
  });

  assert.equal(state.showRetry, true);
  assert.equal(state.showEmpty, false);
  assert.equal(state.isInitialLoading, false);
}

parsesPathInput();
normalizesTrailingSlash();
resolvesLaunchTargetFromTypedPath();
exposesDirectoryLoadFailures();

console.log('dirPickerPath tests ok');
