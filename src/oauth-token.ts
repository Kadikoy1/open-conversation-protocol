import { jwtVerify, type JWTVerifyGetKey } from 'jose';

export const accessScope = 'ocp:access';
export const clientIdLimit = 512;

export async function verifyAccessToken(
  token: string,
  key: JWTVerifyGetKey,
  issuer: string,
  resource: string,
) {
  const { payload, protectedHeader } = await jwtVerify(token, key, {
    issuer, audience: resource, algorithms: ['RS256', 'ES256'],
    requiredClaims: ['exp', 'iat', 'sub', 'client_id', 'jti'],
    maxTokenAge: '1h',
    clockTolerance: 5,
  });
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!['at+jwt', 'application/at+jwt'].includes(protectedHeader.typ?.toLowerCase() ?? '') ||
      audience.length !== 1 || audience[0] !== resource ||
      !payload.sub || payload.sub.length > 320 || typeof payload.jti !== 'string' || !payload.jti ||
      typeof payload.client_id !== 'string' || !payload.client_id || payload.client_id.length > clientIdLimit ||
      typeof payload.iat !== 'number' || typeof payload.exp !== 'number' ||
      payload.exp <= payload.iat || payload.exp - payload.iat > 3600) {
    throw new Error('Invalid access token claims');
  }
  return {
    subject: payload.sub,
    clientId: payload.client_id,
    inScope: typeof payload.scope === 'string' && payload.scope.split(' ').includes(accessScope),
  };
}
