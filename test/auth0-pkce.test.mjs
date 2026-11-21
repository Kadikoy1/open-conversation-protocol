import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { callbackCode, validateStagingToken } from '../scripts/ocp-auth0-pkce.mjs';

const issuer = 'https://dev-c5r8hkva3vnw4dm6.us.auth0.com/';
const audience = 'https://staging.openconversationprotocol.org/mcp';
const clientId = 'native-test-client';

test('loopback callback requires a single matching state before accepting a code', () => {
  const params = new URLSearchParams({ iss: issuer, code: 'synthetic-code' });
  assert.equal(callbackCode(params, 'test-state'), null);
  params.set('state', 'bad--state');
  assert.equal(callbackCode(params, 'test-state'), null);
  params.set('state', 'test-state');
  assert.equal(callbackCode(params, 'test-state'), 'synthetic-code');
  params.append('state', 'test-state');
  assert.equal(callbackCode(params, 'test-state'), null);
  params.set('state', 'test-state');
  params.set('iss', 'https://wrong.example/');
  assert.throws(() => callbackCode(params, 'test-state'), /authorization failed/);
});

test('runner reports only verified claims and rejects invalid tokens', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const keys = createLocalJWKSet({ keys: [await exportJWK(publicKey)] });
  const sign = ({ aud = audience, scope = 'ocp:access', signingKey = privateKey } = {}) =>
    new SignJWT({ client_id: clientId, scope })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt' })
      .setIssuer(issuer).setAudience(aud).setSubject('auth0|fixture')
      .setIssuedAt().setExpirationTime('5m').setJti('fixture').sign(signingKey);
  const token = await sign();
  const result = await validateStagingToken(token, keys, clientId);
  assert.deepEqual(Object.keys(result).sort(), [
    'audience', 'clientId', 'expiresAt', 'issuer', 'lifetimeSeconds', 'scopeChecked', 'subject',
  ]);
  assert.equal(result.clientId, clientId);
  assert.equal(result.audience, audience);
  assert.equal(result.scopeChecked, 'ocp:access');

  await assert.rejects(validateStagingToken('opaque-token', keys, clientId), /signed JWT/);
  await assert.rejects(validateStagingToken(token, keys, 'other-client'), /signed client_id/);
  await assert.rejects(validateStagingToken(await sign({ scope: 'openid' }), keys, clientId), /ocp:access/);
  const wrong = await generateKeyPair('RS256');
  for (const invalid of [
    await sign({ aud: [audience, issuer + 'userinfo'] }),
    await sign({ signingKey: wrong.privateKey }),
  ]) {
    await assert.rejects(validateStagingToken(invalid, keys, clientId), error =>
      error.message.includes('OCP verifier rejected') && !error.message.includes(invalid));
  }
});
