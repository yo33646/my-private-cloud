CREATE TABLE IF NOT EXISTS private_cloud_state (
  device_id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
