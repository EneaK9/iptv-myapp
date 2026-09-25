// Restarts the viewer if it exits. Launch this detached (new session) so a shell exit cannot kill it.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT ?? '8789';
const log = createWriteStream(join(root, 'data/serve.log'), { flags: 'a' });
const stamp = () => new Date().toISOString();

function start() {
  const child = spawn(process.execPath, ['scripts/serve.mjs'], {
    cwd: root,
    env: { ...process.env, PORT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  log.write(`[${stamp()}] serve pid ${child.pid} port ${PORT}\n`);
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.on('exit', (code, signal) => {
    log.write(`[${stamp()}] serve exited code=${code} signal=${signal}, restarting in 1s\n`);
    setTimeout(start, 1000);
  });
}
start();
