import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { authenticate, Env, issue, oauth, requireAdmin } from './auth';
import { ingest } from './agentmail';
import { body, external, HttpError, id, json, seq, title } from './http';
import { mcp } from './mcp';
import { Store } from './store';

const app = new Hono<{ Bindings: Env; Variables: { participant: string } }>();
const expiry = z.number().int().min(1).max(720).default(168);
const role = z.enum(['reader', 'writer']);
const kind = z.enum(['human', 'llm', 'agent', 'app', 'bridge']);

app.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
});

app.onError((error, c) => {
  if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
  if (error instanceof z.ZodError) {
    return c.json({ error: 'Invalid input', fields: error.issues.map(issue => issue.path.join('.')) }, 400);
  }
  console.error('OCP request failed', c.req.method);
  return c.json({ error: 'Service error' }, 500);
});

app.post('/api/bridge/agentmail', async c => {
  await ingest(c.req.raw, c.env);
  return c.body(null, 204);
});

app.use('/api/admin/*', async (c, next) => {
  await requireAdmin(c.req.raw, c.env);
  await next();
});
app.post('/api/admin/participants', async c => {
  const data = await json(c.req.raw, z.object({ display_name: title, kind }).strict());
  const participant = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO participants(id,display_name,kind) VALUES (?,?,?)')
    .bind(participant, data.display_name, data.kind).run();
  return c.json({ id: participant }, 201);
});
app.post('/api/admin/participants/:participant/credentials', async c => {
  const participant = id.parse(c.req.param('participant'));
  const { hours } = await json(c.req.raw, z.object({ hours: expiry }).strict());
  const exists = await c.env.DB.prepare("SELECT 1 FROM participants WHERE id=? AND kind<>'bridge'").bind(participant).first();
  if (!exists) throw new HttpError(404, 'Participant unavailable');
  return c.json(await issue(c.env.DB, participant, hours), 201);
});
app.delete('/api/admin/participants/:participant/credentials', async c => {
  await c.env.DB.prepare('DELETE FROM credentials WHERE participant_id=?')
    .bind(id.parse(c.req.param('participant'))).run();
  return c.body(null, 204);
});
app.put('/api/admin/participants/:participant/oauth', async c => {
  const config = oauth(c.env);
  if (!config) throw new HttpError(503, 'OAuth is disabled');
  const participant = id.parse(c.req.param('participant'));
  const { subject } = await json(c.req.raw, z.object({ subject: external }).strict());
  const result = await c.env.DB.prepare(`
    INSERT INTO oauth_identities(issuer,subject,participant_id)
    SELECT ?,?,id FROM participants WHERE id=? AND kind<>'bridge'
    ON CONFLICT(issuer,subject) DO NOTHING
  `).bind(config.issuer, subject, participant).run();
  if (!result.meta.changes) throw new HttpError(409, 'Participant unavailable or identity already enrolled');
  return c.body(null, 204);
});
app.delete('/api/admin/participants/:participant/oauth', async c => {
  await c.env.DB.prepare('DELETE FROM oauth_identities WHERE participant_id=?')
    .bind(id.parse(c.req.param('participant'))).run();
  return c.body(null, 204);
});

app.use('/api/conversations', async (c, next) => {
  c.set('participant', await authenticate(c.req.raw, c.env));
  await next();
});
app.use('/api/conversations/*', async (c, next) => {
  if (!c.get('participant')) c.set('participant', await authenticate(c.req.raw, c.env));
  await next();
});
app.get('/api/conversations', async c => {
  const after = id.optional().parse(c.req.query('after'));
  return c.json(await new Store(c.env.DB, c.get('participant')).list(after));
});
app.post('/api/conversations', async c => {
  const data = await json(c.req.raw, z.object({ title }).strict());
  return c.json(await new Store(c.env.DB, c.get('participant')).create(data.title), 201);
});
app.get('/api/conversations/:id/messages', async c => {
  const after = z.string().regex(/^\d+$/).transform(Number).pipe(seq).parse(c.req.query('after') ?? '0');
  return c.json(await new Store(c.env.DB, c.get('participant')).history(id.parse(c.req.param('id')), after));
});
app.post('/api/conversations/:id/messages', async c => {
  const data = await json(c.req.raw, z.object({ body }).strict());
  return c.json(await new Store(c.env.DB, c.get('participant')).post(id.parse(c.req.param('id')), data.body), 201);
});
app.put('/api/conversations/:id/members/:participant', async c => {
  const data = await json(c.req.raw, z.object({ role }).strict());
  await new Store(c.env.DB, c.get('participant')).membership(id.parse(c.req.param('id')), id.parse(c.req.param('participant')), data.role);
  return c.body(null, 204);
});
app.delete('/api/conversations/:id/members/:participant', async c => {
  await new Store(c.env.DB, c.get('participant')).membership(id.parse(c.req.param('id')), id.parse(c.req.param('participant')), null);
  return c.body(null, 204);
});
app.post('/api/conversations/:id/cursor', async c => {
  const data = await json(c.req.raw, z.object({ last_seq: seq }).strict());
  await new Store(c.env.DB, c.get('participant')).acknowledge(id.parse(c.req.param('id')), data.last_seq);
  return c.body(null, 204);
});
app.post('/api/conversations/:id/agentmail', async c => {
  const data = await json(c.req.raw, z.object({ inbox_id: external, thread_id: external, participant_id: id }).strict());
  const conversation = id.parse(c.req.param('id'));
  const result = await c.env.DB.prepare(`
    INSERT INTO agentmail_links(inbox_id,thread_id,conversation_id,participant_id)
    SELECT ?,?,m.conversation_id,m.participant_id FROM memberships m
    JOIN participants p ON p.id=m.participant_id
    WHERE m.conversation_id=? AND m.participant_id=? AND m.role='writer' AND p.kind='bridge'
    AND EXISTS (SELECT 1 FROM memberships WHERE conversation_id=m.conversation_id AND participant_id=? AND role='owner')
    ON CONFLICT(inbox_id,thread_id) DO NOTHING
  `).bind(data.inbox_id, data.thread_id, conversation, data.participant_id, c.get('participant')).run();
  if (!result.meta.changes) throw new HttpError(409, 'Link unavailable');
  return c.body(null, 204);
});

function resourceMetadata(c: Context<{ Bindings: Env }>) {
  const config = oauth(c.env);
  if (!config) return c.notFound();
  return c.json({ resource: config.resource, authorization_servers: [config.issuer],
    scopes_supported: ['ocp:access'], bearer_methods_supported: ['header'] });
}
app.get('/.well-known/oauth-protected-resource/mcp', resourceMetadata);
app.get('/.well-known/oauth-protected-resource', resourceMetadata);
app.all('/mcp', async c => {
  const config = oauth(c.env);
  const origin = c.req.header('Origin');
  if (origin && origin !== (c.env.OCP_PUBLIC_ORIGIN ?? new URL(c.req.url).origin)) {
    throw new HttpError(403, 'Origin denied');
  }
  let participant: string;
  try {
    participant = await authenticate(c.req.raw, c.env, true);
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.message === 'Missing ocp:access scope')) {
      const attributes = ['realm="ocp"'];
      if (config) attributes.push(`resource_metadata="${config.discovery}"`, 'scope="ocp:access"');
      if (error.status === 403) attributes.push('error="insufficient_scope"');
      else if (c.req.header('Authorization')) attributes.push('error="invalid_token"');
      c.header('WWW-Authenticate', 'Bearer ' + attributes.join(', '));
    }
    throw error;
  }
  if (c.req.method !== 'POST') return c.body(null, 405, { Allow: 'POST' });
  return mcp(c.req.raw, new Store(c.env.DB, participant), !!config);
});

export default app;
