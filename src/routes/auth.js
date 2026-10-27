const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const { transaction, seedDemo, createProperty } = require('../db');
const {
  COOKIE, verifyPassword, hashPassword, createSession, sessionUser, endSession, endOtherSessions, readCookie,
  cookieOptions, createUser, validatePassword, validateAccess, setUserProperties, publicUser, sha256, LoginLimiter,
} = require('../auth');
const { validateProperty } = require('../hotel');
const { generateSecret, verifyTotp, otpauthUrl } = require('../totp');
const { accessibleProperties, requirePermission, ROLE_LABELS } = require('../permissions');
const { logActivity } = require('../activity');
const { badRequest, HttpError } = require('../errors');

const CHALLENGE_MINUTES = 5;
const MAX_CODE_ATTEMPTS = 5;

const needsSetup = (db) => db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;

function startSession(db, req, res, userId) {
  const { token, maxAge } = createSession(db, userId);
  res.cookie(COOKIE, token, cookieOptions(req, maxAge));
}

function loginResponse(db, userId) {
  const user = publicUser(db, userId);
  return { user, properties: accessibleProperties(db, user) };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

/** Routes that work without being logged in: first-run setup and login. */
function publicAuthRoutes({ db }) {
  const r = express.Router();
  const limiter = new LoginLimiter();

  // Tells the dashboard which screen to show: setup, login or the app.
  r.get('/session', (req, res) => {
    const user = sessionUser(db, readCookie(req));
    res.json({
      needs_setup: needsSetup(db),
      user: user ? publicUser(db, user.id) : null,
      properties: user ? accessibleProperties(db, user) : [],
      roles: ROLE_LABELS,
    });
  });

  // First run only: name the hotel and create the owner's account.
  r.post('/setup', (req, res) => {
    const body = req.body || {};
    const property = validateProperty({ name: body.hotel_name, currency: body.currency, city: body.city, country: body.country });
    const user = transaction(db, () => {
      if (!needsSetup(db)) throw new HttpError(409, 'This app is already set up. Log in instead.');
      // A database upgraded from the single-hotel version already has its hotel.
      const first = db.prepare('SELECT id FROM properties ORDER BY id LIMIT 1').get();
      let propertyId;
      if (first) {
        propertyId = first.id;
        db.prepare('UPDATE properties SET name = ?, currency = ?, city = ?, country = ? WHERE id = ?')
          .run(property.name, property.currency, property.city, property.country, propertyId);
      } else {
        propertyId = createProperty(db, property);
      }
      const created = createUser(db, { ...body, role: 'admin', all_properties: true });
      if (body.demo) seedDemo(db, propertyId);
      logActivity(db, created, `Set up ${property.name}${body.demo ? ' with demo rooms, rate plans and OTAs' : ''}`, propertyId);
      return created;
    });
    startSession(db, req, res, user.id);
    res.status(201).json(loginResponse(db, user.id));
  });

  // Step 1: password. With two-factor on, this returns a challenge instead of a session.
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
    if (row.totp_enabled) {
      const challenge = crypto.randomBytes(24).toString('base64url');
      db.prepare('DELETE FROM login_challenges WHERE expires_at < ?').run(new Date().toISOString());
      db.prepare('INSERT INTO login_challenges (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(sha256(challenge), row.id, new Date(Date.now() + CHALLENGE_MINUTES * 60_000).toISOString());
      return res.json({ two_factor_required: true, challenge });
    }
    startSession(db, req, res, row.id);
    return res.json(loginResponse(db, row.id));
  });

  // Step 2: the code from the authenticator app.
  r.post('/auth/login/verify', (req, res) => {
    const hash = sha256(String(req.body?.challenge || ''));
    const ch = db.prepare('SELECT * FROM login_challenges WHERE token_hash = ? AND expires_at > ?').get(hash, new Date().toISOString());
    if (!ch || ch.attempts >= MAX_CODE_ATTEMPTS) {
      throw new HttpError(401, 'This sign-in has expired. Enter your password again.');
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ch.user_id);
    if (!verifyTotp(user.totp_secret, req.body?.code)) {
      db.prepare('UPDATE login_challenges SET attempts = attempts + 1 WHERE token_hash = ?').run(hash);
      throw new HttpError(401, 'That code is not right. Check the time on your phone and try again.');
    }
    db.prepare('DELETE FROM login_challenges WHERE token_hash = ?').run(hash);
    startSession(db, req, res, user.id);
    res.json(loginResponse(db, user.id));
  });

  r.post('/auth/logout', (req, res) => {
    endSession(db, readCookie(req));
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  return r;
}

/** The logged-in user's own account: password and two-factor login. */
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

  // Start setting up two-factor login: a new secret, shown as a QR code.
  r.post('/auth/2fa/setup', wrap(async (req, res) => {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (row.totp_enabled) throw badRequest('Two-factor login is already on');
    const secret = generateSecret();
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, row.id);
    const url = otpauthUrl(secret, row.email);
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1 });
    res.json({ secret, otpauth_url: url, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` });
  }));

  r.post('/auth/2fa/enable', (req, res) => {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!row.totp_secret) throw badRequest('Start the setup first');
    if (!verifyTotp(row.totp_secret, req.body?.code)) throw badRequest("That code doesn't match. Check the time on your phone and try again.");
    db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(row.id);
    endOtherSessions(db, row.id, readCookie(req));
    logActivity(db, req.user, 'Turned on two-factor login');
    res.json(publicUser(db, row.id));
  });

  r.post('/auth/2fa/disable', (req, res) => {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(req.body?.password || ''), row.password_hash)) throw badRequest('Password is wrong');
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(row.id);
    logActivity(db, req.user, 'Turned off two-factor login');
    res.json(publicUser(db, row.id));
  });

  return r;
}

/** User management, admins only. */
function userRoutes({ db }) {
  const r = express.Router();
  const admin = requirePermission('users');
  const adminCount = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;

  r.get('/users', admin, (req, res) => {
    res.json(db.prepare('SELECT id FROM users ORDER BY id').all().map((u) => publicUser(db, u.id)));
  });

  r.post('/users', admin, (req, res) => {
    const user = createUser(db, req.body || {});
    logActivity(db, req.user, `Added user ${user.name} (${user.email}) as ${user.role}`);
    res.status(201).json(user);
  });

  r.patch('/users/:id', admin, (req, res) => {
    const id = Number(req.params.id);
    const before = publicUser(db, id);
    if (!before) throw new HttpError(404, 'User not found');
    const access = validateAccess(db, req.body || {}, { partial: true });
    if (before.role === 'admin' && access.role && access.role !== 'admin' && adminCount() === 1) {
      throw badRequest('There must always be at least one admin');
    }
    transaction(db, () => {
      if (access.role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(access.role, id);
      if (access.all_properties !== undefined) {
        db.prepare('UPDATE users SET all_properties = ? WHERE id = ?').run(access.all_properties, id);
        setUserProperties(db, id, access.property_ids);
      }
    });
    const after = publicUser(db, id);
    logActivity(db, req.user, `Changed access for ${after.name}: ${after.role}, ${after.all_properties ? 'all properties' : `${after.property_ids.length} property(ies)`}`);
    res.json(after);
  });

  // For a user who lost their phone.
  r.post('/users/:id/reset-2fa', admin, (req, res) => {
    const user = publicUser(db, Number(req.params.id));
    if (!user) throw new HttpError(404, 'User not found');
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    logActivity(db, req.user, `Turned off two-factor login for ${user.name}`);
    res.json(publicUser(db, user.id));
  });

  r.delete('/users/:id', admin, (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw badRequest("You can't remove yourself");
    const user = publicUser(db, id);
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

module.exports = { publicAuthRoutes, accountRoutes, userRoutes, requireUser };
