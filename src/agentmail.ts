import { Webhook } from 'standardwebhooks';
import { z } from 'zod';
import { Env } from './auth';
import { body, external, HttpError, parseJson, rawBody } from './http';

const envelope = z.object({ event_type: z.string() });
const received = z.object({
  message: z.object({
    inbox_id: external,
    thread_id: external,
    message_id: external,
    from: z.string().min(1),
    labels: z.array(z.string()).default([]),
    headers: z.record(z.string(), z.string()).optional(),
    extracted_text: z.string().nullish(),
    text: z.string().nullish(),
  }),
});

function address(from: string) {
  return (from.match(/<([^<>]+)>\s*$/)?.[1] ?? from).trim().toLowerCase();
}

export async function ingest(request: Request, env: Env) {
  if (!env.AGENTMAIL_WEBHOOK_SECRET) throw new HttpError(503, 'Bridge disabled');
  const raw = await rawBody(request, 1024 * 1024);
  try {
    const verifier = new Webhook(env.AGENTMAIL_WEBHOOK_SECRET);
    verifier.verify(raw, {
      'webhook-id': request.headers.get('svix-id') ?? '',
      'webhook-timestamp': request.headers.get('svix-timestamp') ?? '',
      'webhook-signature': request.headers.get('svix-signature') ?? '',
    }, { jsonParse: false });
  } catch {
    throw new HttpError(401, 'Invalid webhook signature or timestamp');
  }
  const event = parseJson(raw);
  if (envelope.parse(event).event_type !== 'message.received') return;
  const { message } = received.parse(event);
  const headers = Object.fromEntries(Object.entries(message.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  if (address(message.from) === address(message.inbox_id) ||
      message.labels.some(label => ['sent', 'spam', 'blocked', 'unauthenticated'].includes(label.toLowerCase())) ||
      headers['x-ocp-loop'] !== undefined ||
      (headers['auto-submitted'] && headers['auto-submitted'].trim().toLowerCase() !== 'no')) return;

  const text = message.extracted_text?.trim() || message.text?.trim();
  if (!text) return;
  const content = body.parse(text.slice(0, 24000));
  // AgentMail's message ID, scoped to its inbox, is stable across webhook registrations.
  const delivery = JSON.stringify([message.inbox_id, message.message_id]);
  await env.DB.prepare(`
    INSERT INTO messages(id,conversation_id,participant_id,body,source,external_id)
    SELECT ?,l.conversation_id,l.participant_id,?,'agentmail',? FROM agentmail_links l
    JOIN memberships m ON m.conversation_id=l.conversation_id AND m.participant_id=l.participant_id
    WHERE l.inbox_id=? AND l.thread_id=? AND m.role='writer'
    ON CONFLICT(source,external_id) DO NOTHING
  `).bind(crypto.randomUUID(), content, delivery, message.inbox_id, message.thread_id).run();
}
