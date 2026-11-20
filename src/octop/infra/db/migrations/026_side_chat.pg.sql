-- Side chats retain their identity after persistence.
ALTER TABLE threads ADD COLUMN side_chat INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN source_thread_id TEXT;
ALTER TABLE threads ADD COLUMN copied_messages INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN expires_at BIGINT;
ALTER TABLE threads ADD COLUMN gc_claimed_at BIGINT;
CREATE INDEX idx_threads_side_chat_expiry ON threads(expires_at) WHERE expires_at IS NOT NULL;
UPDATE _schema_version SET version = 26;
