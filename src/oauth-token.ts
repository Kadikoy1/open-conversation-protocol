import { errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const accessScope = 'ocp:access';
export const clientIdLimit = 512;

class TokenValidationError extends Error {
  constructor(readonly category: string) {
    super('Invalid access token claims');
  }
}

export function tokenFailureCategory(error: unknown) {
  if (error instanceof TokenValidationError) return error.category;
  if (error instanceof errors.JWTExpired) return 'jwt_expired';
  if (error instanceof errors.JWTClaimValidationFailed) {
    switch (error.claim) {
      case 'iss': return 'jwt_issuer';
      case 'aud': return 'jwt_audience';
      case 'client_id': return 'jwt_client_id';
      case 'sub': return 'jwt_subject';
      case 'iat':
      case 'exp':
      case 'nbf': return 'jwt_lifetime';
      default: return 'jwt_required_claim';
    }
  }
  if (error instanceof errors.JOSEAlgNotAllowed) return 'jwt_algorithm';
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'jwt_signature';
  if (error instanceof errors.JWKSNoMatchingKey) return 'jwt_signing_key';
  if (error instanceof errors.JWKSTimeout || error instanceof TypeError) return 'jwks_unavailable';
  return 'invalid_credential';
}

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
  if (!['at+jwt', 'application/at+jwt'].includes(protectedHeader.typ?.toLowerCase() ?? '')) {
    throw new TokenValidationError('jwt_type');
  }
  if (audience.length !== 1 || audience[0] !== resource) throw new TokenValidationError('jwt_audience');
  if (!payload.sub || payload.sub.length > 320) throw new TokenValidationError('jwt_subject');
  if (typeof payload.client_id !== 'string' || !payload.client_id || payload.client_id.length > clientIdLimit) {
    throw new TokenValidationError('jwt_client_id');
  }
  if (typeof payload.jti !== 'string' || !payload.jti) throw new TokenValidationError('jwt_required_claim');
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number' ||
      payload.exp <= payload.iat || payload.exp - payload.iat > 3600) {
    throw new TokenValidationError('jwt_lifetime');
  }
  return {
    subject: payload.sub,
    clientId: payload.client_id,
    inScope: typeof payload.scope === 'string' && payload.scope.split(' ').includes(accessScope),
  };
}
