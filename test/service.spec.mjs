import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Webhook } from 'standardwebhooks';

const admin = 'e'.repeat(64);
const auth = token => ({ Authorization: 'Bearer ' + token });
const requestFor = (request, token) => (path, method = 'GET', data) =>
  request.fetch(path, { method, data, headers: auth(token) });
const conversations = '/api/conversations';

async function participant(request, kind = 'human') {
  const call = requestFor(request, admin);
  const response = await call('/api/admin/participants', 'POST', { display_name: 'Test ' + kind, kind });
  expect(response.status()).toBe(201);
  const { id } = await response.json();
  if (kind === 'bridge') return { id };
  const credential = await call('/api/admin/participants/' + id + '/credentials', 'POST', {});
  expect(credential.status()).toBe(201);
  const { token } = await credential.json();
  return { id, token, call: requestFor(request, token) };
}

async function room(owner, title = 'Test room') {
  const response = await owner.call(conversations, 'POST', { title });
  expect(response.status()).toBe(201);
  const { id } = await response.json();
  return { id, path: conversations + '/' + id };
}

test('credentials enforce membership, role changes and revocation', async ({ request }) => {
  const owner = await participant(request);
  const other = await participant(request);
  const { path } = await room(owner);
  expect((await request.get(conversations)).status()).toBe(401);
  expect((await requestFor(request, admin)(conversations)).status()).toBe(401);
  expect((await other.call(path + '/messages?participant_id=' + owner.id)).status()).toBe(404);
  expect((await other.call(path + '/messages', 'POST', { body: 'fake', participant_id: owner.id })).status()).toBe(400);
  const member = path + '/members/' + other.id;
  expect((await other.call(member, 'PUT', { role: 'writer' })).status()).toBe(403);
  expect((await owner.call(member, 'PUT', { role: 'reader' })).status()).toBe(204);
  expect((await other.call(path + '/messages')).status()).toBe(200);
  expect((await other.call(path + '/messages', 'POST', { body: 'blocked' })).status()).toBe(403);
  expect((await owner.call(member, 'PUT', { role: 'writer' })).status()).toBe(204);
  const sent = await other.call(path + '/messages', 'POST', { body: 'persisted' });
  expect(sent.status()).toBe(201);
  const { seq } = await sent.json();
  expect((await owner.call(path + '/cursor', 'POST', { last_seq: seq + 100 })).status()).toBe(404);
  expect((await owner.call(path + '/cursor', 'POST', { last_seq: seq })).status()).toBe(204);
  const history = await (await owner.call(path + '/messages')).json();
  expect(history.messages[0]).toMatchObject({ participant_id: other.id, body: 'persisted', seq });
  expect((await (await owner.call(path + '/messages?after=' + seq)).json()).messages).toEqual([]);
  expect((await owner.call(member, 'DELETE')).status()).toBe(204);
  expect((await other.call(path + '/messages')).status()).toBe(404);
  await requestFor(request, admin)('/api/admin/participants/' + other.id + '/credentials', 'DELETE');
  expect((await other.call(conversations)).status()).toBe(401);
});

test('MCP discovery, origin checks and real SDK tool round trip', async ({ request, baseURL }) => {
  const owner = await participant(request, 'llm');
  const unauthenticated = await request.get('/mcp');
  expect(unauthenticated.status()).toBe(401);
  expect(unauthenticated.headers()['www-authenticate']).toContain('oauth-protected-resource/mcp');
  expect(await (await request.get('/.well-known/oauth-protected-resource/mcp')).json()).toMatchObject({
    resource: 'https://ocp.example.com/mcp', authorization_servers: ['https://issuer.example.com'],
  });
  const anonymous = new Client({ name: 'discovery', version: '1.0.0' });
  try {
    await anonymous.connect(new StreamableHTTPClientTransport(new URL('/mcp', baseURL)));
    expect((await anonymous.listTools()).tools.every(tool =>
      tool._meta.securitySchemes[0].scopes.includes('ocp:access'))).toBe(true);
    for (const [name, args] of [
      ['list_conversations', {}],
      ['create_conversation', { title: 'Must not be written' }],
    ]) {
      const result = await anonymous.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(result._meta['mcp/www_authenticate'][0]).toContain('resource_metadata=');
    }
    expect((await (await owner.call(conversations)).json()).conversations).toEqual([]);
  } finally {
    await anonymous.close();
  }
  expect((await request.get('/mcp', { headers: { ...auth(owner.token), Origin: 'https://elsewhere.example' } })).status()).toBe(403);
  const client = new Client({ name: 'ocp-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseURL), { requestInit: { headers: auth(owner.token) } });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(['create_conversation', 'list_conversations', 'post_message', 'read_messages']);
    const invoke = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBeFalsy();
      return JSON.parse(result.content[0].text);
    };
    const { id } = await invoke('create_conversation', { title: 'MCP room' });
    await invoke('post_message', { conversation_id: id, body: 'MCP hello' });
    expect((await invoke('read_messages', { conversation_id: id })).messages[0].body).toBe('MCP hello');
    expect((await invoke('list_conversations', {})).conversations[0].id).toBe(id);
  } finally {
    await client.close();
  }
});

test('signed mail is linked, deduplicated and never reflected', async ({ request }) => {
  const owner = await participant(request);
  const bridge = await participant(request, 'bridge');
  const { path } = await room(owner);
  const member = path + '/members/' + bridge.id;
  const message = { inbox_id: 'inbox@example.test', thread_id: 'thread-1', message_id: 'message-1',
    from: 'Sender <sender@example.test>', reply_to: ['reply@example.test'], text: 'Synthetic mail' };
  expect((await owner.call(member, 'PUT', { role: 'writer' })).status()).toBe(204);
  expect((await owner.call(path + '/agentmail', 'POST', { inbox_id: message.inbox_id,
    thread_id: message.thread_id, participant_id: bridge.id })).status()).toBe(204);
  const signer = new Webhook(Buffer.alloc(32, 7).toString('base64'));
  const deliver = (changes = {}, options = {}) => {
    const raw = JSON.stringify({ event_type: options.type ?? 'message.received', message: { ...message, ...changes } });
    const id = crypto.randomUUID();
    const now = new Date(Date.now() - (options.age ?? 0));
    return request.post('/api/bridge/agentmail', { data: raw, headers: {
      'svix-id': id, 'svix-timestamp': String(Math.floor(now.getTime() / 1000)),
      'svix-signature': options.bad ? 'v1,invalid' : signer.sign(id, now, raw),
    } });
  };
  expect((await deliver({}, { bad: true })).status()).toBe(401);
  expect((await deliver({}, { age: 600000 })).status()).toBe(401);
  const responses = await Promise.all([deliver(), deliver()]);
  expect(responses.map(response => response.status())).toEqual([204, 204]);
  expect((await deliver({ message_id: '2', from: 'Inbox <INBOX@example.test>' })).status()).toBe(204);
  expect((await deliver({ message_id: '3', headers: { 'X-OCP-Loop': '1' } })).status()).toBe(204);
  expect((await deliver({ message_id: '4', thread_id: 'unmapped' })).status()).toBe(204);
  expect((await deliver({ message_id: '5' }, { type: 'message.sent' })).status()).toBe(204);
  expect((await owner.call(member, 'DELETE')).status()).toBe(204);
  expect((await deliver({ message_id: '6' })).status()).toBe(204);
  const { messages } = await (await owner.call(path + '/messages')).json();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    body: 'Synthetic mail', source: 'agentmail', participant_id: bridge.id, display_name: 'Test bridge',
    email_sender_claims: { from: message.from, reply_to: message.reply_to, verified: false },
  });
});

test('human can connect, post literal HTML and reconnect to persisted history', async ({ page, request }) => {
  const owner = await participant(request);
  await page.goto('/');
  await page.getByLabel('Participant token').fill(owner.token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Conversation title').fill('Browser room');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('<img src=x onerror=alert(1)>');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByText('<img src=x onerror=alert(1)>')).toBeVisible();
  await expect(page.locator('img')).toHaveCount(0);
  await page.reload();
  await page.getByLabel('Participant token').fill(owner.token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Conversation', { exact: true }).selectOption({ label: 'Browser room' });
  await expect(page.getByText('<img src=x onerror=alert(1)>')).toBeVisible();
});

test('administration requires the exact configured secret and enrolls each client separately', async ({ request }) => {
  const path = '/api/admin/participants';
  for (const header of [undefined, 'Basic ' + admin, 'Bearer ' + 'f'.repeat(64)]) {
    const response = await request.post(path, {
      data: { display_name: 'Denied', kind: 'human' }, headers: header ? { Authorization: header } : {},
    });
    expect(response.status()).toBe(401);
  }
  const member = await participant(request);
  const another = await participant(request);
  expect((await member.call(path, 'POST', { display_name: 'Denied', kind: 'human' })).status()).toBe(401);
  const enroll = (who, data) => requestFor(request, admin)(path + '/' + who.id + '/oauth', 'PUT', data);
  expect((await enroll(member, { subject: 'same-user' })).status()).toBe(400);
  const first = { subject: 'same-user', client_id: 'chat-client' };
  expect((await enroll(member, first)).status()).toBe(204);
  expect((await enroll(another, first)).status()).toBe(409);
  expect((await enroll(another, { ...first, client_id: 'different-client' })).status()).toBe(204);
  expect((await requestFor(request, admin)(path + '/' + member.id + '/oauth', 'DELETE')).status()).toBe(204);
  expect((await enroll(another, first)).status()).toBe(204);
});

test('ownership, role changes and message writes remain consistent under concurrency', async ({ request }) => {
  const owner = await participant(request);
  const writer = await participant(request);
  const rooms = await Promise.all(Array.from({ length: 4 }, () => room(owner, 'Equal title')));
  expect(new Set(rooms.map(room => room.id)).size).toBe(4);
  const { conversations: owned } = await (await owner.call(conversations)).json();
  expect(owned.map(room => room.role)).toEqual(['owner', 'owner', 'owner', 'owner']);

  const { path } = rooms[0];
  const ownerMember = path + '/members/' + owner.id;
  const member = path + '/members/' + writer.id;
  const attempts = await Promise.all([
    owner.call(ownerMember, 'PUT', { role: 'reader' }),
    owner.call(ownerMember, 'DELETE'),
    ...Array.from({ length: 4 }, () => owner.call(member, 'PUT', { role: 'writer' })),
  ]);
  expect(attempts.map(response => response.status())).toEqual([403, 403, 204, 204, 204, 204]);

  const post = index => writer.call(path + '/messages', 'POST', { body: 'Concurrent ' + index });
  const before = await Promise.all(Array.from({ length: 5 }, (_, index) => post(index + 100)));
  expect(before.every(response => response.status() === 201)).toBe(true);
  const [demote, ...posts] = await Promise.all([
    owner.call(member, 'PUT', { role: 'reader' }),
    ...Array.from({ length: 12 }, (_, index) => post(index)),
  ]);
  expect(demote.status()).toBe(204);
  const accepted = await Promise.all(before.map(response => response.json()));
  for (const response of posts) {
    expect([201, 403]).toContain(response.status());
    if (response.status() === 201) accepted.push(await response.json());
  }
  expect((await post(12)).status()).toBe(403);
  const { messages } = await (await owner.call(path + '/messages')).json();
  expect(messages.map(message => message.seq)).toEqual(accepted.map(message => message.seq).sort((a, b) => a - b));
  expect(new Set(messages.map(message => message.id)).size).toBe(accepted.length);
  expect(messages.every(message => message.participant_id === writer.id)).toBe(true);
  expect((await owner.call(path + '/messages', 'POST', { body: 'Owner still writes' })).status()).toBe(201);
});

test('sustained requests from a participant receive 429 with retry information', async ({ request }) => {
  const member = await participant(request);
  let limited;
  for (let count = 0; count < 135; count++) {
    const response = await member.call(conversations);
    if (response.status() === 429) {
      limited = response;
      break;
    }
    expect(response.status()).toBe(200);
  }
  expect(limited?.headers()['retry-after']).toBe('60');
});
