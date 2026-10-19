// Runs the API and the web dev server together. A plain `a & b` in package.json
// runs them one after the other on Windows (cmd.exe), so the web app never starts.
import { spawn } from 'node:child_process';

const children = ['dev:server', 'dev:web'].map((script) =>
  spawn(`npm run ${script}`, { stdio: 'inherit', shell: true }),
);

let stopping = false;
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    // On Windows, killing the shell leaves tsx/vite running; take the whole tree down.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  process.exitCode = code;
}

for (const child of children) child.on('exit', (code) => stopAll(code ?? 0));
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
