import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/ocp-enrol-staging.mjs', import.meta.url));
const admin = 'a'.repeat(64);
const secret = 'synthetic-access-secret';
const participantId = '934ebac8-012c-4e72-a384-965d875089dc';

function run(t, config, response, credentials = { CF_ACCESS_CLIENT_ID: 'fixture-id', CF_ACCESS_CLIENT_SECRET: secret }) {
  const cwd = mkdtempSync(join(tmpdir(), 'ocp-enrol-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, '.env.staging'), config);
  const shim = `
    globalThis.fetch = async (url, init) => {
      if (url !== 'https://staging.openconversationprotocol.org/api/admin/participants/oauth' ||
          init.redirect !== 'manual' || init.method !== 'POST' ||
          JSON.parse(init.body).client_id !== 'fixture-client' ||
          init.headers.Authorization !== 'Bearer ' + 'a'.repeat(64) ||
          init.headers['CF-Access-Client-Secret'] !== 'synthetic-access-secret' ||
          init.headers['CF-Access-Client-Id'] !== 'fixture-id') {
        throw new Error('Unexpected request');
      }
      return Response.json(${JSON.stringify(response.body)}, { status: ${response.status} });
    };
  `;
  return spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(shim),
    script, 'fixture-client', 'auth0|fixture'], {
    cwd, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, OCP_CF_ACCESS_JWT: '', ...credentials },
  });
}

test('enrolment utility uses the local admin and Access credentials but prints only the result', t => {
  const child = run(t, 'OCP_ADMIN_TOKEN="' + admin + '"\n', {
    status: 200, body: { id: participantId, status: 'already_enrolled', injected: secret },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), { participantId, status: 'already_enrolled' });
});

test('enrolment utility rejects invalid credentials and sanitizes Access errors', t => {
  const invalid = run(t, 'OCP_ADMIN_TOKEN=invalid\n', { status: 200, body: {} });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Expected OCP_ADMIN_TOKEN/);
  assert.equal(invalid.stdout, '');

  for (const status of [302, 403]) {
    const child = run(t, 'OCP_ADMIN_TOKEN=' + admin + '\n', { status, body: { detail: secret } });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /redirected|Access denied/);
    assert.equal(child.stderr.includes(secret), false);
    assert.equal(child.stderr.includes(admin), false);
    assert.equal(child.stdout, '');
  }
});
