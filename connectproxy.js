// CONNECT proxy for on-device agent binaries whose libc can't resolve DNS (the claude musl build
// on Android: no /etc/resolv.conf, so it tries 127.0.0.1:53 and dies). The agent is pointed at
// this proxy via HTTPS_PROXY; Node dials the upstream itself, resolving through the platform
// resolver (bionic on Android), and just pipes bytes. Loopback-bound and deliberately narrow:
// TLS-port-only, no private/loopback targets — other apps on the phone can reach 127.0.0.1, and
// this must not become their open relay into the LAN or the backend itself.
const http = require('http');
const net = require('net');
const { isPrivateIp } = require('./remote');

// Validate a CONNECT request target ("host:port"). Returns { host, port } or null (pure).
// Only 443 passes — agents only need TLS APIs — and IP-literal loopback/private/link-local hosts
// are rejected. Hostname targets are allowed (that's the point: we resolve what musl can't);
// a hostname maliciously resolving to a private address is out of scope for a loopback-only
// proxy on a single-user device.
function parseConnectTarget(target) {
  const m = /^([A-Za-z0-9._-]+):(\d{1,5})$/.exec(String(target || ''));
  if (!m) return null;                              // bracketed IPv6 literals fail here too
  const [host, port] = [m[1].toLowerCase(), +m[2]];
  if (port !== 443) return null;
  if (host === 'localhost' || /^127\./.test(host) || /^169\.254\./.test(host) || host === '0.0.0.0') return null;
  if (isPrivateIp(host)) return null;
  return { host, port };
}

// Start the proxy. Plain requests get a 502 (CONNECT is the only supported verb); tunnels pipe
// both ways and tear down together on either side erroring.
function startConnectProxy({ port, bind = '127.0.0.1' } = {}) {
  const srv = http.createServer((req, res) => { res.writeHead(502); res.end(); });
  srv.on('connect', (req, sock, head) => {
    const t = parseConnectTarget(req.url);
    if (!t) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const up = net.connect(t.port, t.host, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  // A listen failure here silently killed all agent DNS (an http.Server 'error' with no handler
  // throws into the backend's uncaughtException keep-alive). The caller probes for a free port,
  // so a conflict is a rare race — retry the same port a few times, then say plainly it's down.
  let attempts = 0;
  srv.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempts < 5) {
      attempts += 1;
      console.error(`[proxy] port ${port} busy — retrying (${attempts}/5)`);
      setTimeout(() => srv.listen(port, bind), 1000);
    } else {
      console.error(`[proxy] listen failed: ${e.message} — agent DNS is DOWN`);
    }
  });
  srv.listen(port, bind, () => console.log(`connect proxy on http://${bind}:${port} (443-only)`));
  return srv;
}

module.exports = { parseConnectTarget, startConnectProxy };
