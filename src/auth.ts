import { createRemoteJWKSet } from 'jose';
import { HttpError } from './http.ts';
import { verifyAccessToken } from './oauth-token.ts';

export type Env = Pick<Cloudflare.Env, 'DB' | 'REQUEST_LIMIT' | 'PARTICIPANT_LIMIT'> & {
  OCP_ADMIN_TOKEN?: string;
  OCP_PUBLIC_ORIGIN?: string;
  OCP_MCP_DIAGNOSTICS?: string;
  OAUTH_ISSUER?: string;
  OAUTH_JWKS_URL?: string;
  AGENTMAIL_WEBHOOK_SECRET?: string;
};

const encoder = new TextEncoder();
const sha256 = (value: string) => crypto.subtle.digest('SHA-256', encoder.encode(value));

async function digest(value: string) {
  return Array.from(new Uint8Array(await sha256(value)), byte => byte.toString(16).padStart(2, '0')).join('');
}

const adminToken = /^[a-f0-9]{64}$/;
function bearer(request: Request) {
  return request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9._~+/-]+=*)$/i)?.[1];
}

export async function requireAdmin(request: Request, env: Env) {
  const secret = env.OCP_ADMIN_TOKEN;
  const token = bearer(request);
  if (!secret || !adminToken.test(secret) || !token || !adminToken.test(token)) {
    throw new HttpError(401, 'Administrator credential required');
  }
  const [provided, expected] = await Promise.all([sha256(token), sha256(secret)]);
  if (!crypto.subtle.timingSafeEqual(provided, expected)) {
    throw new HttpError(401, 'Administrator credential required');
  }
}

export async function issue(db: D1Database, participant: string, hours: number) {
  const token = 'ocp_' + Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  const expires_at = Math.floor(Date.now() / 1000) + hours * 3600;
  await db.prepare('INSERT INTO credentials VALUES (?,?,?)').bind(await digest(token), participant, expires_at).run();
  return { token, expires_at };
}

function httpsUrl(value: string | undefined) {
  if (!value) return null;
  const url = URL.parse(value);
  return url?.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search ? url : null;
}

export function oauth(env: Env) {
  const origin = httpsUrl(env.OCP_PUBLIC_ORIGIN);
  const issuer = httpsUrl(env.OAUTH_ISSUER);
  const jwks = httpsUrl(env.OAUTH_JWKS_URL);
  if (!origin || !issuer || !jwks || origin.origin !== env.OCP_PUBLIC_ORIGIN ||
      !env.OAUTH_ISSUER || env.OAUTH_ISSUER.trim() !== env.OAUTH_ISSUER) return null;
  return {
    issuer: env.OAUTH_ISSUER,
    jwks,
    resource: origin.origin + '/mcp',
    discovery: origin.origin + '/.well-known/oauth-protected-resource/mcp',
  };
}

export async function authenticate(request: Request, env: Env, mcp = false) {
  const token = bearer(request);
  if (!token || token.length > 8192) throw new HttpError(401, 'Participant credential required');
  if (/^ocp_[a-f0-9]{64}$/.test(token)) {
    const participant = await env.DB.prepare(
      'SELECT participant_id FROM credentials WHERE digest=? AND expires_at>?'
    ).bind(await digest(token), Math.floor(Date.now() / 1000)).first<string>('participant_id');
    if (participant) return participant;
    throw new HttpError(401, 'Invalid or expired credential');
  }
  const config = mcp ? oauth(env) : null;
  if (!config) throw new HttpError(401, 'Invalid credential');

  let claims;
  try {
    claims = await verifyAccessToken(token, createRemoteJWKSet(config.jwks, { timeoutDuration: 3000 }), config.issuer, config.resource);
  } catch {
    throw new HttpError(401, 'Invalid or expired access token');
  }
  if (!claims.inScope) throw new HttpError(403, 'Missing ocp:access scope');

  const participant = await env.DB.prepare(`
    SELECT e.participant_id FROM oauth_enrollments e JOIN participants p ON p.id=e.participant_id
    WHERE e.issuer=? AND e.client_id=? AND e.subject=? AND p.kind<>'bridge'
  `).bind(config.issuer, claims.clientId, claims.subject).first<string>('participant_id');
  if (!participant) throw new HttpError(403, 'OAuth participant and client are not enrolled');
  return participant;
}
