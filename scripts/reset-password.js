// Set a user's password from the command line, for when nobody can log in.
//   npm run reset-password -- owner@example.com 'new password'
const path = require('node:path');
const { openDb } = require('../src/db');
const { hashPassword, validatePassword } = require('../src/auth');

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error("Usage: npm run reset-password -- <email> '<new password>'");
  process.exit(1);
}
try {
  validatePassword(password);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const db = openDb(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'channel-manager.db'));
const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase());
if (!user) {
  console.error(`No user with email ${email}`);
  process.exit(1);
}
db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
console.log(`Password for ${email} has been reset. They have been logged out everywhere.`);
