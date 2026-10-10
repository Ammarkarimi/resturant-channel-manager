const express = require('express');
const { transaction, seedDemo } = require('../db');
const {
  COOKIE, verifyPassword, hashPassword, createSession, sessionUser, endSession, endOtherSessions, readCookie,
  cookieOptions, createUser, validatePassword, LoginLimiter,
} = require('../auth');
const { getProperty, saveProperty, validateProperty } = require('../hotel');
const { logActivity } = require('../activity');
const { badRequest, HttpError } = require('../errors');

const needsSetup = (db) => db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;

function startSession(db, req, res, userId) {
  const { token, maxAge } = createSession(db, userId);
  res.cookie(COOKIE, token, cookieOptions(req, maxAge));
}

/** Routes that work without being logged in: first-run setup and login. */
function publicAuthRoutes({ db }) {
  const r = express.Router();
  const limiter = new LoginLimiter();

  // Tells the dashboard which screen to show: setup, login or the app.
  r.get('/session', (req, res) => {
    const user = sessionUser(db, readCookie(req));
    res.json({ needs_setup: needsSetup(db), user, property: user ? getProperty(db) : null });
  });

  // First run only: name the hotel and create the owner's account.
  r.post('/setup', (req, res) => {
    const body = req.body || {};
    const property = validateProperty({ name: body.hotel_name, currency: body.currency });
    const user = transaction(db, () => {
      if (!needsSetup(db)) throw new HttpError(409, 'This app is already set up. Log in instead.');
      saveProperty(db, property);
      const created = createUser(db, body);
      if (body.demo) seedDemo(db);
      logActivity(db, created, `Set up ${property.name}${body.demo ? ' with demo rooms and OTAs' : ''}`);
      return created;
    });
    startSession(db, req, res, user.id);
    res.status(201).json({ user, property: getProperty(db) });
  });

  r.post('/auth/login', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const keys = [`ip:${req.ip}`, `email:${email}`];
    if (limiter.blocked(keys)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!row || !verifyPassword(password, row.password_hash)) {
      limiter.fail(keys);
      throw new HttpError(401, 'Wrong email or password');
    }
    limiter.reset(keys);
    startSession(db, req, res, row.id);
    res.json({ user: { id: row.id, email: row.email, name: row.name }, property: getProperty(db) });
  });

  r.post('/auth/logout', (req, res) => {
    endSession(db, readCookie(req));
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  return r;
}

/** Account management, for logged-in users. */
function accountRoutes({ db }) {
  const r = express.Router();

  r.post('/auth/password', (req, res) => {
    const { current_password: current, new_password: next } = req.body || {};
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(current || ''), row.password_hash)) throw badRequest('Current password is wrong');
    validatePassword(next);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    endOtherSessions(db, req.user.id, readCookie(req));
    logActivity(db, req.user, 'Changed their password');
    res.json({ ok: true });
  });

  r.get('/users', (req, res) => {
    res.json(db.prepare('SELECT id, name, email, created_at FROM users ORDER BY id').all());
  });

  r.post('/users', (req, res) => {
    const user = createUser(db, req.body || {});
    logActivity(db, req.user, `Added user ${user.name} (${user.email})`);
    res.status(201).json(user);
  });

  r.delete('/users/:id', (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw badRequest("You can't remove yourself");
    const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(id);
    if (!user) throw new HttpError(404, 'User not found');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    logActivity(db, req.user, `Removed user ${user.name} (${user.email})`);
    res.json({ ok: true });
  });

  return r;
}

/** Rejects API calls without a valid session and sets req.user. */
function requireUser({ db }) {
  return (req, res, next) => {
    const user = sessionUser(db, readCookie(req));
    if (!user) return res.status(401).json({ error: 'Please log in' });
    req.user = user;
    return next();
  };
}

module.exports = { publicAuthRoutes, accountRoutes, requireUser };
