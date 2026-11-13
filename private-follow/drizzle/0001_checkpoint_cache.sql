CREATE TABLE checkpoint_cache (source TEXT PRIMARY KEY, payload TEXT, attempted_at INTEGER NOT NULL DEFAULT 0, fetched_at INTEGER);
