-- OAuth grants now require operator review of the issuing client as well as the subject.
CREATE TABLE oauth_enrollments (
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  PRIMARY KEY (issuer, client_id, subject)
);
CREATE INDEX oauth_enrollments_participant ON oauth_enrollments(participant_id);

ALTER TABLE messages ADD COLUMN email_from_claim TEXT;
ALTER TABLE messages ADD COLUMN email_reply_to_claims TEXT;
