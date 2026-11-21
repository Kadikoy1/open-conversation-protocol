CREATE TABLE credentials (
  digest TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX credentials_participant ON credentials(participant_id);
CREATE TABLE oauth_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX memberships_by_participant ON memberships(participant_id, conversation_id);

-- Legacy links lack a verified inbox and bridge participant. Keep them for reference.
CREATE TABLE agentmail_links (
  inbox_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  PRIMARY KEY (inbox_id, thread_id)
);
