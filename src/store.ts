import { HttpError } from './http';

export type Role = 'owner' | 'writer' | 'reader';
export type Kind = 'human' | 'llm' | 'agent' | 'app' | 'bridge';

export class Store {
  constructor(private readonly db: D1Database, readonly participant: string) {}

  async create(title: string) {
    const id = crypto.randomUUID();
    await this.db.batch([
      this.db.prepare('INSERT INTO conversations(id,title) VALUES (?,?)').bind(id, title),
      this.db.prepare("INSERT INTO memberships VALUES (?,?,'owner')").bind(id, this.participant),
    ]);
    return { id, title };
  }

  async list(after = '') {
    const rows = await this.db.prepare(`
      SELECT c.id,c.title,c.created_at,m.role FROM memberships m
      JOIN conversations c ON c.id=m.conversation_id
      WHERE m.participant_id=? AND c.id>? ORDER BY c.id LIMIT 51
    `).bind(this.participant, after).all<{ id: string; title: string; role: Role }>();
    return { conversations: rows.results.slice(0, 50), next: rows.results[50] ? rows.results[49].id : null };
  }

  async history(conversation: string, after: number) {
    // The left join returns one empty row for an authorized conversation with no new messages.
    const { results } = await this.db.prepare(`
      SELECT x.seq,x.id,x.participant_id,x.body,x.source,x.created_at,p.display_name,x.email_from_claim,x.email_reply_to_claims
      FROM memberships m LEFT JOIN messages x ON x.conversation_id=m.conversation_id AND x.seq>?
      LEFT JOIN participants p ON p.id=x.participant_id
      WHERE m.conversation_id=? AND m.participant_id=? ORDER BY x.seq LIMIT 21
    `).bind(after, conversation, this.participant).all<{ seq: number | null; email_from_claim: string | null; email_reply_to_claims: string | null }>();
    if (!results.length) throw new HttpError(404, 'Conversation unavailable');
    const messages = results.filter(row => row.seq !== null).slice(0, 20)
      .map(({ email_from_claim, email_reply_to_claims, ...row }) => ({
        ...row,
        email_sender_claims: email_from_claim ? {
          from: email_from_claim,
          reply_to: JSON.parse(email_reply_to_claims ?? '[]') as string[],
          verified: false,
        } : null,
      }));
    return { messages, next: messages.at(-1)?.seq ?? after, more: results.length > 20 };
  }

  async post(conversation: string, body: string) {
    const id = crypto.randomUUID();
    const row = await this.db.prepare(`
      INSERT INTO messages(id,conversation_id,participant_id,body)
      SELECT ?,conversation_id,participant_id,? FROM memberships
      WHERE conversation_id=? AND participant_id=? AND role IN ('owner','writer')
      RETURNING seq,id,conversation_id
    `).bind(id, body, conversation, this.participant).first();
    if (!row) throw new HttpError(403, 'Write access required');
    return row;
  }

  async membership(conversation: string, participant: string, role: Exclude<Role, 'owner'> | null) {
    const owner = "EXISTS (SELECT 1 FROM memberships WHERE conversation_id=? AND participant_id=? AND role='owner')";
    const result = role
      ? await this.db.prepare(`
          INSERT INTO memberships(conversation_id,participant_id,role)
          SELECT ?,id,? FROM participants WHERE id=? AND ${owner}
          ON CONFLICT(conversation_id,participant_id) DO UPDATE SET role=excluded.role
          WHERE memberships.role<>'owner'
        `).bind(conversation, role, participant, conversation, this.participant).run()
      : await this.db.prepare(`
          DELETE FROM memberships WHERE conversation_id=? AND participant_id=? AND role<>'owner' AND ${owner}
        `).bind(conversation, participant, conversation, this.participant).run();
    if (!result.meta.changes) throw new HttpError(403, 'Membership change unavailable');
  }

  async acknowledge(conversation: string, seq: number) {
    const result = await this.db.prepare(`
      INSERT INTO cursors(conversation_id,participant_id,last_seq)
      SELECT conversation_id,participant_id,? FROM memberships WHERE conversation_id=? AND participant_id=?
      AND (?=0 OR EXISTS (SELECT 1 FROM messages WHERE conversation_id=? AND seq=?))
      ON CONFLICT(conversation_id,participant_id) DO UPDATE SET last_seq=MAX(last_seq,excluded.last_seq)
    `).bind(seq, conversation, this.participant, seq, conversation, seq).run();
    if (!result.meta.changes) throw new HttpError(404, 'Conversation or message unavailable');
  }
}
