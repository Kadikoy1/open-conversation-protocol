import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const issuer = 'https://dev-c5r8hkva3vnw4dm6.us.auth0.com/';
const endpoint = 'https://staging.openconversationprotocol.org/api/admin/participants/oauth';
const [clientId, subject, ...extra] = process.argv.slice(2);

async function main() {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(clientId ?? '') ||
      !subject || subject.length > 320 || /[\x00-\x20\x7f]/.test(subject) || extra.length) {
    throw new Error('Usage: node scripts/ocp-enrol-staging.mjs <public Client ID> <verified subject>');
  }
  let admin;
  try {
    ({ OCP_ADMIN_TOKEN: admin } = parseEnv(await readFile('.env.staging', 'utf8')));
  } catch {
    throw new Error('Cannot read .env.staging. Run from the repository root.');
  }
  if (!/^[a-f0-9]{64}$/.test(admin ?? '')) throw new Error('Expected OCP_ADMIN_TOKEN in .env.staging.');

  const headers = { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json', Accept: 'application/json' };
  const { CF_ACCESS_CLIENT_ID: accessId, CF_ACCESS_CLIENT_SECRET: accessSecret, OCP_CF_ACCESS_JWT: accessJwt } = process.env;
  if (accessJwt && !accessId && !accessSecret && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(accessJwt)) {
    headers.Cookie = 'CF_Authorization=' + accessJwt;
  } else if (!accessJwt && accessId && accessSecret && /^[!-~]+$/.test(accessId) && /^[!-~]+$/.test(accessSecret)) {
    headers['CF-Access-Client-Id'] = accessId;
    headers['CF-Access-Client-Secret'] = accessSecret;
  } else {
    throw new Error('Supply either an Access session JWT or both Cloudflare Access service credential variables.');
  }

  const response = await fetch(endpoint, {
    method: 'POST', headers, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ display_name: 'OCP Auth0 Test Participant', kind: 'app',
      issuer, client_id: clientId, subject }),
  }).catch(() => { throw new Error('Staging request failed. Retrying with the same identity is safe.'); });
  if (response.status >= 300 && response.status < 400) {
    throw new Error('Staging redirected the request. Check the Cloudflare Access session or service policy.');
  }
  if ([401, 403].includes(response.status)) {
    throw new Error('Access denied (HTTP ' + response.status + '). Check Cloudflare Access and the staging administrator credential.');
  }
  if (response.status === 404) throw new Error('The enrolment endpoint is unavailable. Check the approved staging version.');
  if (response.status === 409) throw new Error('Enrolment conflict. Check the configured issuer and existing participant mapping.');
  const status = response.status === 201 ? 'created' : response.status === 200 ? 'already_enrolled' : null;
  const data = status ? await response.json().catch(() => null) : null;
  if (!status || data?.status !== status || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(data?.id ?? '')) {
    throw new Error('Unexpected enrolment response (HTTP ' + response.status + ').');
  }
  console.log(JSON.stringify({ participantId: data.id, status }));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
