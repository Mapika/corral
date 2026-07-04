// wake.js — wake-on-LAN (0.8). Any live ranch can rouse a sleeping one: the console remembers
// each ranch's MACs (self-reported via /api/hosts telemetry) and asks a live backend on the
// same LAN to broadcast the magic packet. Packet construction is pure and selftested; the
// send is a single UDP datagram to the local broadcast address, port 9.
const dgram = require('dgram');

// 6 × 0xFF then the MAC sixteen times — 102 bytes. `:` and `-` separators both accepted
// (Windows reports dashes); anything else refuses loudly rather than waking the wrong thing.
function buildMagicPacket(mac) {
  const m = String(mac || '').trim();
  if (!/^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}$/.test(m)) throw new Error('bad mac: ' + mac);
  const bytes = Buffer.from(m.split(/[:-]/).map(h => parseInt(h, 16)));
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
}

function send({ mac, address = '255.255.255.255', port = 9 } = {}) {
  return new Promise((resolve, reject) => {
    let pkt;
    try { pkt = buildMagicPacket(mac); } catch (e) { return reject(e); }
    const sock = dgram.createSocket('udp4');
    const done = err => { try { sock.close(); } catch (e) {} err ? reject(err) : resolve(true); };
    sock.once('error', done);
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch (e) {}
      sock.send(pkt, 0, pkt.length, port, address, err => done(err));
    });
  });
}

module.exports = { buildMagicPacket, send };
