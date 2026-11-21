import test from 'node:test';
import assert from 'node:assert/strict';
import { body, rawBody, HttpError, seq } from '../src/http.ts';

test('rejects blank or oversized text and unsafe sequences', () => {
  assert.equal(body.safeParse('  ').success, false);
  assert.equal(body.safeParse('x'.repeat(24001)).success, false);
  assert.equal(body.parse('  preserve whitespace '), '  preserve whitespace ');
  assert.equal(seq.safeParse(2 ** 53).success, false);
});

test('bounds streamed bytes and rejects malformed UTF-8', async () => {
  const request = bytes => new Request('http://localhost', { method: 'POST', body: bytes });
  await assert.rejects(rawBody(request('éé'), 3), error => error instanceof HttpError && error.status === 413);
  await assert.rejects(rawBody(request(Uint8Array.of(255))), error => error instanceof HttpError && error.status === 400);
  assert.equal(await rawBody(request('éé'), 4), 'éé');
});
