import test from 'node:test';
import assert from 'node:assert/strict';
import { rpcMethod, responseCategory } from '../src/mcp-diagnostics.ts';

test('MCP diagnostics use fixed method labels only', () => {
  assert.equal(rpcMethod('{"method":"tools/list","params":{"secret":"fixture"}}'), 'tools/list');
  assert.equal(rpcMethod('{"method":"secret-fixture"}'), 'other');
  assert.equal(rpcMethod('{"method":42}'), 'other');
  assert.equal(rpcMethod('[{"method":"tools/list"}]'), 'batch');
  assert.equal(rpcMethod('broken'), 'invalid_json');
});

test('HTTP and JSON-RPC diagnostic categories distinguish discovery failures', async () => {
  const fixtures = [
    [403, { error: 'Origin denied' }, 'tools/list', 'origin_denied'],
    [406, {}, 'tools/list', 'accept_mismatch'],
    [401, { error: 'Invalid or expired access token' }, 'tools/list', 'invalid_credential'],
    [403, { error: 'Missing ocp:access scope' }, 'tools/list', 'insufficient_scope'],
    [403, { error: 'OAuth participant and client are not enrolled' }, 'tools/list', 'participant_not_enrolled'],
    [400, { error: { message: 'Bad Request: Unsupported protocol version: fixture-secret' } }, 'tools/list', 'unsupported_protocol'],
    [200, { error: { code: -32601, message: 'fixture-secret' } }, 'server/discover', 'rpc_method_not_supported'],
    [400, { error: 'fixture-secret' }, 'tools/list', 'request_rejected'],
    [200, { result: { tools: [] } }, 'tools/list', 'ok'],
    [404, {}, null, 'not_found'],
  ];
  for (const [status, body, method, expected] of fixtures) {
    const response = Response.json(body, { status });
    assert.equal(await responseCategory(response, method), expected);
    assert.deepEqual(await response.json(), body);
  }
  const denied = Response.json({ result: { _meta: { 'mcp/www_authenticate': ['fixture-secret'] } } });
  assert.equal(await responseCategory(denied, 'tools/call', true), 'authentication_required');
});
