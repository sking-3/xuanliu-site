CREATE TABLE follow_settings (owner_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
CREATE TABLE connections (owner_id TEXT NOT NULL, exchange TEXT NOT NULL, vault TEXT NOT NULL, summary_json TEXT NOT NULL, checked_at INTEGER NOT NULL, stopped_reason TEXT, PRIMARY KEY (owner_id, exchange));
CREATE TABLE source_stops (source TEXT PRIMARY KEY, reason TEXT NOT NULL, stopped_at INTEGER NOT NULL);
