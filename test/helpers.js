// Starts the app on a random port and logs in through the real setup flow.
const { openDb } = require('../src/db');
const { createApp, CSRF_HEADER, CSRF_VALUE } = require('../src/app');

const OWNER = { name: 'Owner', email: 'owner@example.com', password: 'correct horse' };

async function startApp(options = {}, { setup = true, demo = true } = {}) {
  const db = options.db || openDb(':memory:');
  const { app, engine, channex } = createApp(db, options);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  /**
   * A browser-like client: keeps its session cookie, sends the CSRF header,
   * and the property it is working on (api.property = id).
   */
  function client() {
    let cookie = '';
    const api = async function call(method, path, body, headers = {}) {
      const res = await fetch(base + path, {
        method,
        headers: {
          'content-type': 'application/json',
          [CSRF_HEADER]: CSRF_VALUE,
          ...(cookie ? { cookie } : {}),
          ...(api.property ? { 'x-property-id': String(api.property) } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, body: json, headers: res.headers };
    };
    api.property = null;
    api.login = async (email, password) => {
      const r = await api('POST', '/api/auth/login', { email, password });
      if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
      return r;
    };
    return api;
  }

  const api = client();
  if (setup) {
    const r = await api('POST', '/api/setup', { hotel_name: 'Test Hotel', currency: 'INR', ...OWNER, demo });
    if (r.status !== 201) throw new Error(`setup failed: ${JSON.stringify(r.body)}`);
    api.property = r.body.properties[0].id;
  }

  /** Run sync passes until nothing is pending (rate-limited channels may need a few). */
  async function sync({ waitMs = 0 } = {}) {
    await engine.kick();
    for (let i = 0; i < 40; i += 1) {
      const pending = db.prepare("SELECT COUNT(*) AS n FROM sync_queue WHERE status = 'pending' AND next_attempt_at <= ?")
        .get(new Date().toISOString()).n;
      if (pending === 0) return;
      if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
      await engine.runOnce();
    }
    throw new Error('sync did not finish');
  }

  return {
    db, engine, channex, base, api, client, sync,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startApp, OWNER };
