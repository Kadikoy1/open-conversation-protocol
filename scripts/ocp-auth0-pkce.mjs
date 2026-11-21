import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader } from 'jose';
import { accessScope, verifyAccessToken } from '../src/oauth-token.ts';

const issuer = 'https://dev-c5r8hkva3vnw4dm6.us.auth0.com/';
const resource = 'https://staging.openconversationprotocol.org/mcp';
const host = '127.0.0.1';
const port = 8765;
const path = '/callback';
const callback = 'http://' + host + ':' + port + path;

export function callbackCode(params, state) {
  const states = params.getAll('state');
  const provided = Buffer.from(states[0] ?? '');
  const expected = Buffer.from(state);
  if (states.length !== 1 || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }
  const issuers = params.getAll('iss');
  const codes = params.getAll('code');
  if (issuers.length !== 1 || issuers[0] !== issuer || codes.length !== 1 || !codes[0] || params.has('error')) {
    throw new Error('Auth0 authorization failed. Check the application settings and tenant logs.');
  }
  return codes[0];
}

async function authorizationCode(url, state) {
  return new Promise((resolve, reject) => {
    let timer;
    const server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Connection', 'close');
      if (req.method !== 'GET' || req.headers.host !== host + ':' + port ||
          !req.url || req.url.split('?')[0] !== path) {
        res.writeHead(404).end('Unknown local path.');
        return;
      }
      let code;
      try {
        code = callbackCode(new URL(req.url, callback).searchParams, state);
      } catch (error) {
        finish();
        res.writeHead(400).end('Auth0 authorization did not complete. Check the terminal.');
        reject(error);
        return;
      }
      if (code === null) {
        res.writeHead(400).end('Invalid OAuth state.');
        return;
      }
      finish();
      res.end('Callback received. Check the terminal for the validation result, then close this tab.');
      resolve(code);
    });

    function finish() {
      clearTimeout(timer);
      server.close();
    }

    server.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Cannot listen on ' + host + ':' + port + '. Free that port and retry.'));
    });
    server.listen(port, host, () => {
      timer = setTimeout(() => {
        finish();
        reject(new Error('No valid callback within five minutes.'));
      }, 300_000);
      console.error('Open this Auth0 authorization URL in a browser on this computer:');
      console.error(url.href);
    });
  });
}

export async function validateStagingToken(token, key, clientId) {
  if (token.split('.').length !== 3) {
    throw new Error('Auth0 did not return a signed JWT. Check the API identifier, resource compatibility and token profile.');
  }
  let claims;
  try {
    claims = await verifyAccessToken(token, key, issuer, resource);
  } catch {
    throw new Error('The OCP verifier rejected this token. Check the API audience, RFC 9068 profile, token lifetime and signing keys.');
  }
  if (!claims.inScope || claims.clientId !== clientId) {
    throw new Error('The verified token lacks ocp:access or its signed client_id differs from the selected app.');
  }
  if (decodeProtectedHeader(token).alg !== 'RS256') throw new Error('Expected Auth0 RS256 for this test.');
  const { exp, iat } = decodeJwt(token);
  return {
    issuer, audience: resource, scopeChecked: accessScope,
    clientId: claims.clientId, subject: claims.subject,
    expiresAt: new Date(exp * 1000).toISOString(), lifetimeSeconds: exp - iat,
  };
}

async function main([clientId, mode = 'resource', ...extra]) {
  if (!clientId || !/^[A-Za-z0-9_-]{1,512}$/.test(clientId) || !['resource', 'audience'].includes(mode) || extra.length) {
    throw new Error('Usage: node scripts/ocp-auth0-pkce.mjs <Native application Client ID> [resource|audience]');
  }

  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL('authorize', issuer);
  authorize.search = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: callback, scope: accessScope,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', state, [mode]: resource,
  });
  const code = await authorizationCode(authorize, state);
  const body = new URLSearchParams({
    grant_type: 'authorization_code', client_id: clientId, redirect_uri: callback,
    code, code_verifier: verifier,
  });
  if (mode === 'resource') body.set('resource', resource);

  const response = await fetch(new URL('oauth/token', issuer), {
    method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new Error('Could not reach the Auth0 token endpoint.'); });
  const data = await response.json().catch(() => null);
  if (!response.ok || typeof data?.access_token !== 'string') {
    throw new Error('No access token issued (HTTP ' + response.status + '). Check Auth0 logs.');
  }

  const key = createRemoteJWKSet(new URL('.well-known/jwks.json', issuer), { timeoutDuration: 3000 });
  const claims = await validateStagingToken(data.access_token, key, clientId);
  console.log(JSON.stringify({ result: 'PASS', mode, ...claims }, null, 2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
