const crypto = require('node:crypto');
const { badRequest } = require('./errors');

const COOKIE = 'cm_session';
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [algo, N, r, p, salt, hash] = String(stored).split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, now.toISOString(), expires.toISOString());
  return { token, maxAge: SESSION_DAYS * 86_400_000 };
}

function sessionUser(db, token) {
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(sha256(token), new Date().toISOString()) || null;
}

function endSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

/** Log a user out everywhere except the given session (after a password change). */
function endOtherSessions(db, userId, keepToken) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha256(keepToken || ''));
}

function readCookie(req, name = COOKIE) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function cookieOptions(req, maxAge) {
  return { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/', maxAge };
}

function validateNewUser({ name, email, password }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 80) throw badRequest('Enter a name');
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) throw badRequest('Enter a valid email address');
  validatePassword(password);
  return { name: name.trim(), email: email.trim().toLowerCase(), password };
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw badRequest(`Password must be at least ${MIN_PASSWORD} characters`);
  }
  if (password.length > 200) throw badRequest('Password is too long');
}

function createUser(db, input) {
  const { name, email, password } = validateNewUser(input);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw badRequest('A user with that email already exists');
  const id = db.prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(email, name, hashPassword(password), new Date().toISOString()).lastInsertRowid;
  return db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?').get(id);
}

/** Slows down password guessing: too many failures for an email or IP locks it for a while. */
class LoginLimiter {
  constructor({ max = 10, windowMs = 15 * 60_000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.failures = new Map();
  }

  blocked(keys) {
    const now = Date.now();
    return keys.some((k) => {
      const f = this.failures.get(k);
      return f && now - f.first < this.windowMs && f.count >= this.max;
    });
  }

  fail(keys) {
    const now = Date.now();
    for (const k of keys) {
      const f = this.failures.get(k);
      if (!f || now - f.first >= this.windowMs) this.failures.set(k, { first: now, count: 1 });
      else f.count += 1;
    }
  }

  reset(keys) {
    for (const k of keys) this.failures.delete(k);
  }
}

module.exports = {
  COOKIE, hashPassword, verifyPassword, createSession, sessionUser, endSession, endOtherSessions, readCookie, cookieOptions,
  createUser, validatePassword, LoginLimiter,
};
