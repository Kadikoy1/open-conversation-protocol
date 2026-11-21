import { createRemoteJWKSet } from 'jose';
import { HttpError } from './http';
import { verifyAccessToken } from './oauth-token';

export interface Env {
  DB: D1Database;
  OCP_ADMIN_TOKEN?: string;
  OCP_PUBLIC_ORIGIN?: string;
  OAUTH_ISSUER?: string;
  OAUTH_JWKS_URL?: string;
  AGENTMAIL_WEBHOOK_SECRET?: string;
}

export async function digest(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function bearer(request: Request) {
  return request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9._~+/-]+=*)$/i)?.[1];
}

export async function requireAdmin(request: Request, env: Env) {
  const secret = env.OCP_ADMIN_TOKEN;
  const token = bearer(request);
  if (!secret || secret.length < 32 || !token || token.length > 512) {
    throw new HttpError(401, 'Administrator credential required');
  }
  const [provided, expected] = await Promise.all([digest(token), digest(secret)]);
  const bytes = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', bytes.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', key, bytes.encode(expected));
  if (!await crypto.subtle.verify('HMAC', key, signature, bytes.encode(provided))) {
    throw new HttpError(401, 'Administrator credential required');
  }
}

export async function issue(db: D1Database, participant: string, hours: number) {
  const token = 'ocp_' + Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  const expires_at = Math.floor(Date.now() / 1000) + hours * 3600;
  await db.prepare('INSERT INTO credentials VALUES (?,?,?)').bind(await digest(token), participant, expires_at).run();
  return { token, expires_at };
}

export function oauth(env: Env) {
  if (!env.OCP_PUBLIC_ORIGIN || !env.OAUTH_ISSUER || !env.OAUTH_JWKS_URL) return null;
  const origin = new URL(env.OCP_PUBLIC_ORIGIN);
  const issuer = new URL(env.OAUTH_ISSUER);
  const jwks = new URL(env.OAUTH_JWKS_URL);
  if (origin.protocol !== 'https:' || origin.origin !== env.OCP_PUBLIC_ORIGIN ||
      issuer.protocol !== 'https:' || jwks.protocol !== 'https:' ||
      [issuer, jwks].some(url => url.username || url.password || url.hash)) return null;
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

  let subject: string;
  try {
    const claims = await verifyAccessToken(token, createRemoteJWKSet(config.jwks), config.issuer, config.resource);
    if (!claims.inScope) throw new HttpError(403, 'Missing ocp:access scope');
    subject = claims.subject;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, 'Invalid or expired access token');
  }
  const participant = await env.DB.prepare(
    'SELECT participant_id FROM oauth_identities WHERE issuer=? AND subject=?'
  ).bind(config.issuer, subject).first<string>('participant_id');
  if (!participant) throw new HttpError(403, 'OAuth participant is not enrolled');
  return participant;
}
