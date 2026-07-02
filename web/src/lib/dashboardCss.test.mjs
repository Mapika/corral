import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dashboard = readFileSync(new URL('../Dashboard.svelte', import.meta.url), 'utf8');
const sessions = readFileSync(new URL('../Sessions.svelte', import.meta.url), 'utf8');

function disablesAnimatedDotsForReducedMotion() {
  const dashRule = dashboard.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(dashRule, /\.dot\.busy/);
  assert.match(dashRule, /\.dot\.live/);
  const sessRule = sessions.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(sessRule, /\.dot\.busy/);
}

disablesAnimatedDotsForReducedMotion();

console.log('dashboardCss tests ok');
