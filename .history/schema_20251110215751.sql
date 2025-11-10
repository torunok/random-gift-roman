CREATE TABLE IF NOT EXISTS gifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  imageUrl TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  stock INTEGER NOT NULL DEFAULT 1,      -- 🔸 додаємо кількість
  createdAt DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ipHash TEXT NOT NULL,
  name TEXT,
  telegram TEXT,
  giftId INTEGER,
  createdAt DATETIME NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(giftId) REFERENCES gifts(id)
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ipHash TEXT,
  action TEXT,
  createdAt DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assignments_ip ON assignments(ipHash);
CREATE INDEX IF NOT EXISTS idx_assignments_gift ON assignments(giftId);
