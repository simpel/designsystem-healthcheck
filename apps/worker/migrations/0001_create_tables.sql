CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  figma_user_id TEXT NOT NULL UNIQUE,
  figma_user_name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  collections_count INTEGER NOT NULL DEFAULT 0,
  variables_count INTEGER NOT NULL DEFAULT 0,
  violations_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  violations_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_audits_user_id ON audits(user_id);
CREATE INDEX idx_users_token ON users(token);
