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

  /** A browser-like client: keeps its session cookie and sends the CSRF header. */
  function client() {
    let cookie = '';
    return async function api(method, path, body, headers = {}) {
      const res = await fetch(base + path, {
        method,
        headers: {
          'content-type': 'application/json', [CSRF_HEADER]: CSRF_VALUE, ...(cookie ? { cookie } : {}), ...headers,
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
  }

  const api = client();
  if (setup) {
    const r = await api('POST', '/api/setup', { hotel_name: 'Test Hotel', currency: 'INR', ...OWNER, demo });
    if (r.status !== 201) throw new Error(`setup failed: ${JSON.stringify(r.body)}`);
  }

  return {
    db, engine, channex, base, api, client,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startApp, OWNER };
