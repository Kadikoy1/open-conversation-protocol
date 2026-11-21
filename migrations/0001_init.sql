CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS participants (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('human','llm','agent','app','bridge')));
CREATE TABLE IF NOT EXISTS memberships (conversation_id TEXT NOT NULL REFERENCES conversations(id), participant_id TEXT NOT NULL REFERENCES participants(id), role TEXT NOT NULL CHECK(role IN ('owner','writer','reader')), PRIMARY KEY(conversation_id,participant_id));
CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL REFERENCES conversations(id), participant_id TEXT NOT NULL REFERENCES participants(id), body TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'ocp', external_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(source,external_id));
CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq ON messages(conversation_id,seq);
CREATE TABLE IF NOT EXISTS cursors (conversation_id TEXT NOT NULL, participant_id TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(conversation_id,participant_id));
CREATE TABLE IF NOT EXISTS bridge_links (external_thread_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id));
