import { jwtVerify, type JWTVerifyGetKey } from 'jose';

export async function verifyAccessToken(
  token: string,
  key: JWTVerifyGetKey,
  issuer: string,
  resource: string,
) {
  const { payload } = await jwtVerify(token, key, {
    issuer, audience: resource, algorithms: ['RS256', 'ES256'], requiredClaims: ['exp', 'sub'],
  });
  if (!payload.sub || payload.sub.length > 320) throw new Error('Invalid subject');
  return {
    subject: payload.sub,
    inScope: typeof payload.scope === 'string' && payload.scope.split(/\s+/).includes('ocp:access'),
  };
}
