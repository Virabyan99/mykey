-- The probe's state (Run 2.6). Heartbeat and evaluation fields are separate
-- rows, so a heartbeat arriving during an evaluation is never overwritten.
CREATE TABLE heartbeat (host TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE host_state (host TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  condition TEXT NOT NULL,
  kind TEXT NOT NULL,
  since INTEGER NOT NULL,
  at INTEGER NOT NULL,
  delivered INTEGER NOT NULL
);
CREATE INDEX alert_log_host ON alert_log (host, id);
