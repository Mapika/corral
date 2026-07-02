// Stage the Node sidecar Tauri bundles (externalBin: binaries/node): copy the Node binary
// running this script into src-tauri/binaries/node-<target-triple>[.exe]. Run it with the same
// Node version you want to ship — on CI that's whatever actions/setup-node installed.
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TRIPLES = {
  'win32-x64': 'x86_64-pc-windows-msvc.exe',
  'win32-arm64': 'aarch64-pc-windows-msvc.exe',
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
};

const key = `${process.platform}-${process.arch}`;
const triple = TRIPLES[key];
if (!triple) {
  console.error(`no target triple mapping for ${key}`);
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'src-tauri', 'binaries');
mkdirSync(dir, { recursive: true });
const dest = join(dir, `node-${triple}`);
copyFileSync(process.execPath, dest);
if (process.platform !== 'win32') chmodSync(dest, 0o755);
console.log(`sidecar staged: ${dest} (node ${process.version})`);
