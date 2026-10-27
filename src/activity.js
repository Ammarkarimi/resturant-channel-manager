// "Who changed what" log shown on the dashboard.

function logActivity(db, user, action, propertyId = null) {
  db.prepare('INSERT INTO activity (property_id, user_id, user_name, action, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(propertyId, user?.id ?? null, user?.name ?? 'System', action, new Date().toISOString());
}

function listActivity(db, propertyId, limit = 50) {
  return db.prepare(`SELECT id, user_name, action, created_at FROM activity
                     WHERE property_id = ? OR property_id IS NULL ORDER BY id DESC LIMIT ?`).all(propertyId, limit);
}

module.exports = { logActivity, listActivity };
