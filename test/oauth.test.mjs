import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { verifyAccessToken } from '../src/oauth-token.ts';

test('OAuth validates signature, expiry, issuer, resource audience, and scope', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const key = createLocalJWKSet({ keys: [await exportJWK(publicKey)] });
  const issuer = 'https://issuer.example';
  const resource = 'https://ocp.example/mcp';
  const sign = (options = {}) => new SignJWT({ scope: options.scope ?? 'ocp:access' })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? resource)
    .setSubject('participant-1')
    .setExpirationTime(options.exp ?? '5m')
    .sign(options.key ?? privateKey);
  const verify = token => verifyAccessToken(token, key, issuer, resource);

  assert.deepEqual(await verify(await sign()), { subject: 'participant-1', inScope: true });
  assert.equal((await verify(await sign({ scope: 'ocp:access-other' }))).inScope, false);
  await assert.rejects(verify(await sign({ audience: 'https://another.example/mcp' })));
  await assert.rejects(verify(await sign({ issuer: 'https://another-issuer.example' })));
  await assert.rejects(verify(await sign({ exp: 1 })));
  await assert.rejects(verify(await sign({ key: (await generateKeyPair('ES256')).privateKey })));
});
