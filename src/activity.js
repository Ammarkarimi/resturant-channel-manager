// "Who changed what" log shown on the dashboard.

function logActivity(db, user, action) {
  db.prepare('INSERT INTO activity (user_id, user_name, action, created_at) VALUES (?, ?, ?, ?)')
    .run(user?.id ?? null, user?.name ?? 'System', action, new Date().toISOString());
}

function listActivity(db, limit = 50) {
  return db.prepare('SELECT id, user_name, action, created_at FROM activity ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = { logActivity, listActivity };
