import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { verifyAccessToken } from '../src/oauth-token.ts';
import { authenticate, oauth } from '../src/auth.ts';

const issuer = 'https://issuer.example';
const origin = 'https://ocp.example';
const resource = origin + '/mcp';
const { privateKey, publicKey } = await generateKeyPair('ES256');
const jwks = { keys: [await exportJWK(publicKey)] };
const key = createLocalJWKSet(jwks);
const config = {
  OCP_PUBLIC_ORIGIN: origin, OAUTH_ISSUER: issuer, OAUTH_JWKS_URL: issuer + '/jwks',
};
const sign = (options = {}) => {
  const claims = { scope: options.scope ?? 'ocp:access' };
  if (!options.omitClient) claims.client_id = options.clientId ?? 'connector';
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', typ: options.type ?? 'at+jwt' })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? resource)
    .setSubject(options.subject ?? 'participant-1')
    .setJti(crypto.randomUUID())
    .setIssuedAt(options.iat ?? Math.floor(Date.now() / 1000))
    .setExpirationTime(options.exp ?? '5m')
    .sign(options.key ?? privateKey);
};

test('OAuth verifies signature, type, lifetime, issuer, exclusive resource audience and client claim', async () => {
  const verify = token => verifyAccessToken(token, key, issuer, resource);
  assert.deepEqual(await verify(await sign()), { subject: 'participant-1', clientId: 'connector', inScope: true });
  assert.equal((await verify(await sign({ scope: 'ocp:access-other' }))).inScope, false);
  for (const options of [
    { audience: 'https://another.example/mcp' }, { audience: [resource, 'https://another.example/mcp'] },
    { issuer: 'https://another-issuer.example' }, { exp: 1 }, { exp: '2h' },
    { iat: Math.floor(Date.now() / 1000) + 100 }, { type: 'JWT' }, { omitClient: true },
    { clientId: ['connector'] }, { key: (await generateKeyPair('ES256')).privateKey },
  ]) {
    await assert.rejects(verify(await sign(options)));
  }
});

test('OAuth grants access only for the exact issuer, client and subject enrollment', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), config.OAUTH_JWKS_URL);
    return Response.json(jwks);
  });
  let enrolled = true;
  const DB = {
    prepare: () => ({
      bind: (...keys) => ({
        first: async () => enrolled && keys.join('|') === issuer + '|connector|participant-1' ? 'principal' : null,
      }),
    }),
  };
  const using = token => new Request(resource, { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(await authenticate(using(await sign()), { ...config, DB }, true), 'principal');
  for (const options of [{ clientId: 'another-client' }, { subject: 'other' }, { scope: 'other' }]) {
    await assert.rejects(authenticate(using(await sign(options)), { ...config, DB }, true), { status: 403 });
  }
  enrolled = false;
  await assert.rejects(authenticate(using(await sign()), { ...config, DB }, true), { status: 403 });
  await assert.rejects(authenticate(using(await sign()), { ...config, DB }), { status: 401 });
});

test('OAuth discovery disables incomplete or unsafe URL configurations', () => {
  assert.equal(oauth(config).resource, resource);
  for (const delta of [
    { OCP_PUBLIC_ORIGIN: origin + '/' }, { OCP_PUBLIC_ORIGIN: 'not a url' }, { OAUTH_ISSUER: 'http://issuer.example' },
    { OAUTH_JWKS_URL: 'https://user@issuer.example/jwks' }, { OAUTH_JWKS_URL: undefined },
  ]) assert.equal(oauth({ ...config, ...delta }), null);
});
