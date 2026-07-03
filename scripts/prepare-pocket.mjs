// Stage the on-device (pocket) backend payload: the pure-JS backend the Android app extracts to
// filesDir and runs on the bundled Node. Packs src-tauri/pocket/payload.tar.gz + payload.sha
// (sha256, computed here so the app never hashes at runtime — it just compares strings to decide
// whether to re-extract). Run after fetch-pocket-runtime.sh so runtime-map.txt rides along; when
// the runtime isn't fetched (slim/local builds) an empty map is packed and the Rust build embeds
// a payload that pocket_available() will never expose.
//
// Deliberately NOT packed: dist/ (the phone webview uses the Tauri-bundled frontend), node-pty
// (optional native module — the /ws terminal is desktop-only), demo.js.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pocket = join(root, 'src-tauri', 'pocket');
const stage = join(pocket, 'stage');

const FILES = ['server.js', 'chat.js', 'connectproxy.js', 'phone.js', 'remote.js', 'push.js', 'webpush.js', 'tunnels.js', 'package.json'];
const DIRS = ['agents', join('node_modules', 'ws')];

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of FILES) cpSync(join(root, f), join(stage, f));
for (const d of DIRS) cpSync(join(root, d), join(stage, d), { recursive: true });

const map = join(pocket, 'runtime', 'runtime-map.txt');
writeFileSync(join(stage, 'runtime-map.txt'), existsSync(map) ? readFileSync(map) : '');

// Relative paths + cwd: GNU tar parses "E:\…" as a remote-host spec on Windows.
const out = join(pocket, 'payload.tar.gz');
execFileSync('tar', ['-czf', 'payload.tar.gz', '-C', 'stage', '.'], { cwd: pocket });
rmSync(stage, { recursive: true, force: true });

const sha = crypto.createHash('sha256').update(readFileSync(out)).digest('hex');
writeFileSync(join(pocket, 'payload.sha'), sha);
console.log(`pocket payload staged: ${out} (sha256 ${sha.slice(0, 12)}…)`);
