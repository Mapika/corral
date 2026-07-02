import assert from 'node:assert/strict';
import { buildPairUrl, isLoopbackPage, isStandaloneShell, normalizeBase, parsePairInput, wsUrl } from './serverBase.mjs';

// normalizeBase: canonical origins out of whatever gets pasted
assert.equal(normalizeBase('http://192.168.0.24:7879'), 'http://192.168.0.24:7879');
assert.equal(normalizeBase('192.168.0.24:7879'), 'http://192.168.0.24:7879');           // scheme assumed
assert.equal(normalizeBase('  HTTPS://Corral.Tail1234.ts.net  '), 'https://corral.tail1234.ts.net');
assert.equal(normalizeBase('http://192.168.0.24:7879/#tk=abc'), 'http://192.168.0.24:7879');  // fragment dropped
assert.equal(normalizeBase('http://10.0.0.2:7879/some/path?x=1'), 'http://10.0.0.2:7879');    // path/query dropped
assert.equal(normalizeBase(''), '');
assert.equal(normalizeBase('ftp://x'), '');
assert.equal(normalizeBase('myhost:7879'), 'http://myhost:7879');   // hostname:port is not a scheme
assert.equal(normalizeBase('http://'), '');

// parsePairInput: the QR payload round-trips; base-only input yields no token
{
  const url = buildPairUrl('192.168.0.24', 7879, 'abcdef0123456789abcdef0123456789');
  assert.equal(url, 'http://192.168.0.24:7879/#tk=abcdef0123456789abcdef0123456789');
  const p = parsePairInput(url);
  assert.equal(p.base, 'http://192.168.0.24:7879');
  assert.equal(p.token, 'abcdef0123456789abcdef0123456789');
}
assert.deepEqual(parsePairInput('10.1.2.3:7879'), { base: 'http://10.1.2.3:7879', token: '' });
assert.equal(parsePairInput('http://x/#tk=short').token, '');                    // too short to be a token
assert.equal(buildPairUrl('', 7879, 'aabbccddeeff0011'), '');
assert.equal(buildPairUrl('10.0.0.1', 7879, ''), '');

// wsUrl: base wins; otherwise the page's own origin
assert.equal(wsUrl('http://192.168.0.24:7879', '/events'), 'ws://192.168.0.24:7879/events');
assert.equal(wsUrl('https://corral.example', '/chat?id=1'), 'wss://corral.example/chat?id=1');
assert.equal(wsUrl('', '/ws', { protocol: 'http:', host: '127.0.0.1:7878' }), 'ws://127.0.0.1:7878/ws');
assert.equal(wsUrl('', '/ws', { protocol: 'https:', host: 'x.example' }), 'wss://x.example/ws');

// shell detection
assert.equal(isStandaloneShell({ protocol: 'tauri:', hostname: 'localhost' }), true);
assert.equal(isStandaloneShell({ protocol: 'http:', hostname: 'tauri.localhost' }), true);
assert.equal(isStandaloneShell({ protocol: 'http:', hostname: '127.0.0.1' }), false);
assert.equal(isStandaloneShell({ protocol: 'http:', hostname: '192.168.0.24' }), false);
assert.equal(isLoopbackPage({ hostname: 'localhost' }), true);
assert.equal(isLoopbackPage({ hostname: '127.0.0.1' }), true);
assert.equal(isLoopbackPage({ hostname: '192.168.0.24' }), false);

console.log('serverBase tests ok');
