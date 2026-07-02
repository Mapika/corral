import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url)); // project root (where this config lives)

// While the backend is still booting, answer proxy errors with a quiet 503 (the client retries)
// instead of dumping a scary connect-ETIMEDOUT stack trace into the dev console.
const quiet = (proxy) => {
  proxy.on('error', (err, req, res) => {
    if (res && typeof res.writeHead === 'function' && !res.headersSent) {
      try { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('backend starting'); } catch (e) {}
    }
  });
};

// Dev convenience: start the Node backend alongside Vite, so a single `npm run dev` runs everything.
// (Build mode skips this — `apply: 'serve'`.)
function backend() {
  let child = null;
  const stop = () => { if (child) { try { child.kill(); } catch (e) {} child = null; } };
  return {
    name: 'corral-backend',
    apply: 'serve',
    configureServer() {
      child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'inherit' });
      child.on('exit', (code) => { if (code) console.log(`[backend] exited with code ${code}`); });
      process.once('exit', stop);
      process.once('SIGINT', () => { stop(); process.exit(); });
      process.once('SIGTERM', () => { stop(); process.exit(); });
    },
  };
}

export default defineConfig({
  root: 'web',
  plugins: [svelte(), backend()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7878', configure: quiet },
      '/chat': { target: 'ws://127.0.0.1:7878', ws: true, configure: quiet },
      '/events': { target: 'ws://127.0.0.1:7878', ws: true, configure: quiet },
      '/ws': { target: 'ws://127.0.0.1:7878', ws: true, configure: quiet },
    },
  },
});
