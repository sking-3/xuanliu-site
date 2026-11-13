CREATE TABLE research_cache (cache_key TEXT PRIMARY KEY, result_json TEXT NOT NULL, received_at INTEGER NOT NULL);
CREATE TABLE research_budget (source TEXT PRIMARY KEY, next_at INTEGER NOT NULL);
CREATE TABLE research_results (owner_id TEXT PRIMARY KEY, result_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE research_result_parts (owner_id TEXT NOT NULL, part_index INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner_id,part_index));
