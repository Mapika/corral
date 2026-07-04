import assert from 'node:assert/strict';
import { compareVersions, releaseUpdate, sessionFromDeepLink, deepLinkTarget } from './appUpdate.mjs';

// compareVersions: dotted numerics, v-prefix tolerated, missing parts are zero
assert.equal(compareVersions('0.4.0', '0.3.0'), 1);
assert.equal(compareVersions('0.3.0', '0.4.0'), -1);
assert.equal(compareVersions('v0.4.0', '0.4.0'), 0);
assert.equal(compareVersions('0.4', '0.4.0'), 0);
assert.equal(compareVersions('0.10.0', '0.9.9'), 1);     // numeric, not lexicographic
assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
assert.equal(compareVersions('', '0.1.0'), -1);

// releaseUpdate: maps releases/latest against the running version
{
  const u = releaseUpdate({ tag_name: 'v0.5.0', html_url: 'https://github.com/Mapika/corral/releases/tag/v0.5.0' }, '0.4.0');
  assert.deepEqual(u, { latest: '0.5.0', url: 'https://github.com/Mapika/corral/releases/tag/v0.5.0', newer: true });
}
assert.equal(releaseUpdate({ tag_name: 'v0.4.0' }, '0.4.0').newer, false);
assert.equal(releaseUpdate({ tag_name: 'v0.4.0' }, '0.4.0').url, 'https://github.com/Mapika/corral/releases/latest');  // html_url fallback
assert.deepEqual(releaseUpdate({}, '0.4.0'), { error: 'no release found' });
assert.deepEqual(releaseUpdate(null, '0.4.0'), { error: 'no release found' });

// sessionFromDeepLink: the ntfy Click target -> session id
assert.equal(sessionFromDeepLink('corral://session/abc-123'), 'abc-123');
assert.equal(sessionFromDeepLink('corral://session/ses%201'), 'ses 1');           // round-trips push.js encoding
assert.equal(sessionFromDeepLink('CORRAL://session/x'), 'x');                     // scheme is case-insensitive
assert.equal(sessionFromDeepLink('corral://session/abc?from=push'), 'abc');       // query tolerated
assert.equal(sessionFromDeepLink('corral://other/abc'), null);
assert.equal(sessionFromDeepLink('https://example.com/#session=abc'), null);
assert.equal(sessionFromDeepLink(''), null);
assert.equal(sessionFromDeepLink(null), null);

// deepLinkTarget: session AND review (queue landing) targets
assert.deepEqual(deepLinkTarget('corral://review/j-9'), { kind: 'review', id: 'j-9' });
assert.deepEqual(deepLinkTarget('corral://session/abc'), { kind: 'session', id: 'abc' });
assert.equal(deepLinkTarget('corral://other/abc'), null);
assert.equal(deepLinkTarget(''), null);

console.log('appUpdate tests ok');
