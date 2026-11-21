const knownMethods = ['initialize', 'notifications/initialized', 'server/discover', 'tools/list', 'tools/call', 'ping'];

export function rpcMethod(raw: string) {
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(value)) return 'batch';
    return knownMethods.includes(value?.method) ? value.method as string : 'other';
  } catch {
    return 'invalid_json';
  }
}

export async function responseCategory(response: Response, method?: string, anonymousToolCall = false) {
  const { status } = response;
  if (status === 429) return 'rate_limited';
  if (status === 406) return 'accept_mismatch';
  if (status === 405) return 'http_method_not_allowed';
  if (status === 413) return 'request_too_large';
  if (status >= 500) return 'worker_error';
  if (status === 404) return 'not_found';
  if ([400, 401, 403].includes(status) || (status === 200 && (method === 'server/discover' || anonymousToolCall))) {
    const data = await response.clone().json<{ error?: string | { code?: number; message?: string }; result?: { _meta?: Record<string, unknown> } }>().catch(() => null);
    if (anonymousToolCall && data?.result?._meta?.['mcp/www_authenticate']) return 'authentication_required';
    const error = data?.error;
    switch (error) {
      case 'Origin denied': return 'origin_denied';
      case 'Participant credential required': return 'credential_required';
      case 'Invalid or expired access token':
      case 'Invalid credential':
      case 'Invalid or expired credential': return 'invalid_credential';
      case 'Missing ocp:access scope': return 'insufficient_scope';
      case 'OAuth participant and client are not enrolled': return 'participant_not_enrolled';
    }
    if (typeof error === 'object' && error) {
      if (error.message?.startsWith('Bad Request: Unsupported protocol version:')) return 'unsupported_protocol';
      if (error.message?.startsWith('Invalid _meta envelope for protocol revision')) return 'invalid_protocol_envelope';
      if (error.code === -32601) return 'rpc_method_not_supported';
    }
    if (status >= 400) return 'request_rejected';
  }
  return status < 300 ? 'ok' : 'http_error';
}
