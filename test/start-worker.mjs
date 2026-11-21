import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = mkdtempSync(join(tmpdir(), 'ocp-test-'));
const shared = ['--persist-to', state];
const admin = 'test-admin-token-for-local-fixtures-only';
const webhook = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
const run = args => spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], { stdio: 'inherit' });
let child;
function wait(process) {
  return new Promise((resolve, reject) => {
    process.on('error', reject);
    process.on('exit', code => code === 0 ? resolve() : reject(new Error('Wrangler exited with ' + code)));
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child?.kill());
}
try {
  child = run(['d1', 'migrations', 'apply', 'DB', '--local', ...shared]);
  await wait(child);
  child = run(['dev', '--local', '--ip', '127.0.0.1', '--port', '8793', ...shared,
    '--var', 'OCP_ADMIN_TOKEN:' + admin, '--var', 'AGENTMAIL_WEBHOOK_SECRET:' + webhook,
    '--var', 'OCP_PUBLIC_ORIGIN:https://ocp.example.com', '--var', 'OAUTH_ISSUER:https://issuer.example.com',
    '--var', 'OAUTH_JWKS_URL:https://issuer.example.com/jwks']);
  await wait(child);
} finally {
  rmSync(state, { recursive: true, force: true });
}
