// `phone` CLI — the agent's bridge to the phone itself (Corral pocket runtime only). The shim
// in rt/bin execs `node phone.js "$@"`; this talks one JSON line each way over the app's unix
// socket (same-uid filesystem access IS the auth — no token ever enters agent env), and the
// Kotlin side (PocketBridge.phone) does the actual Android work.
//
// Usage:
//   phone notify <title> [body]     post a notification (always works)
//   phone battery                   -> {"ok":true,"percent":87,"charging":false}
//   phone open <url>                open in the default app (needs the app on screen)
//   phone share <text>              share sheet with the text (needs the app on screen)
//   phone clip get | clip set <t>   clipboard (get is foreground-restricted on Android 10+)
const net = require('net');

const sock = process.env.CORRAL_PHONE_SOCK;
const [verb, ...rest] = process.argv.slice(2);

const CALLS = {
  notify: () => ({ verb: 'notify', a: rest[0] || '', b: rest.slice(1).join(' ') }),
  battery: () => ({ verb: 'battery' }),
  open: () => ({ verb: 'open', a: rest[0] || '' }),
  share: () => ({ verb: 'share', a: rest.join(' ') }),
  clip: () => (rest[0] === 'set'
    ? { verb: 'clip-set', a: rest.slice(1).join(' ') }
    : { verb: 'clip-get' }),
};

if (!sock) { console.error('phone: not inside the Corral pocket runtime (CORRAL_PHONE_SOCK unset)'); process.exit(2); }
if (!CALLS[verb]) {
  console.error('phone: unknown verb. Usage: phone notify|battery|open|share|clip ...');
  process.exit(2);
}

const c = net.connect(sock);
let buf = '';
c.on('connect', () => c.write(JSON.stringify({ a: '', b: '', ...CALLS[verb]() }) + '\n'));
c.on('data', (d) => { buf += d; });
c.on('error', (e) => { console.error('phone: bridge unreachable — ' + e.message); process.exit(1); });
c.on('close', () => {
  const line = buf.trim();
  console.log(line || '{"ok":false,"error":"empty reply"}');
  let ok = false;
  try { ok = !!JSON.parse(line).ok; } catch (e) {}
  process.exit(ok ? 0 : 1);
});
