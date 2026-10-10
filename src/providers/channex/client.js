// Thin client for the Channex API v1 (https://docs.channex.io).

const BASE_URLS = {
  staging: 'https://staging.channex.io/api/v1',
  production: 'https://app.channex.io/api/v1',
};

// Channex asks integrations to pause about a minute after a 429 or a server error.
const BACKOFF_MS = 60_000;
const PAGE_LIMIT = 100;

class ChannexError extends Error {
  constructor(message, { status, retryAfterMs } = {}) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function describeErrors(body) {
  const errors = body?.errors;
  if (!errors) return '';
  if (errors.details) return `${errors.title || ''}: ${JSON.stringify(errors.details)}`;
  return errors.title || JSON.stringify(errors);
}

class ChannexClient {
  constructor({
    apiKey, baseUrl = BASE_URLS.staging, fetchImpl = globalThis.fetch, timeoutMs = 30_000, minIntervalMs = 7000,
  }) {
    if (!apiKey) throw new Error('Channex API key is required');
    // Gap between ARI pushes. Channex allows 10 availability and 10
    // restriction calls per minute per property; every 7s stays under that.
    this.minIntervalMs = minIntervalMs;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  get environment() {
    return this.baseUrl === BASE_URLS.production ? 'production' : this.baseUrl === BASE_URLS.staging ? 'staging' : 'custom';
  }

  async request(method, path, body) {
    let res;
    try {
      res = await this.fetch(this.baseUrl + path, {
        method,
        headers: { 'user-api-key': this.apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ChannexError(`Could not reach Channex: ${err.message}`, { retryAfterMs: BACKOFF_MS });
    }
    const data = await res.json().catch(() => null);
    if (res.ok) return data;

    if (res.status === 401) throw new ChannexError('Channex rejected the API key (401)', { status: 401 });
    if (res.status === 429) {
      throw new ChannexError('Channex rate limit reached; pausing for a minute', { status: 429, retryAfterMs: BACKOFF_MS });
    }
    if (res.status >= 500) {
      throw new ChannexError(`Channex server error (${res.status})`, { status: res.status, retryAfterMs: BACKOFF_MS });
    }
    throw new ChannexError(`Channex returned ${res.status}${describeErrors(data) ? `: ${describeErrors(data)}` : ''}`, { status: res.status });
  }

  async listAll(path) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const sep = path.includes('?') ? '&' : '?';
      const body = await this.request('GET', `${path}${sep}pagination[page]=${page}&pagination[limit]=${PAGE_LIMIT}`);
      items.push(...(body?.data || []));
      const total = body?.meta?.total ?? items.length;
      if (items.length >= total || !body?.data?.length) return items;
    }
  }

  async listProperties() {
    const body = await this.request('GET', '/properties/options');
    return (body?.data || []).map((p) => ({
      id: p.id, title: p.attributes.title, currency: p.attributes.currency, min_stay_type: p.attributes.min_stay_type,
    }));
  }

  async listRoomTypes(propertyId) {
    const rows = await this.listAll(`/room_types?filter[property_id]=${encodeURIComponent(propertyId)}`);
    return rows.map((r) => ({ id: r.id, title: r.attributes.title, count_of_rooms: r.attributes.count_of_rooms }));
  }

  async listRatePlans(propertyId) {
    const rows = await this.listAll(`/rate_plans?filter[property_id]=${encodeURIComponent(propertyId)}`);
    return rows.map((r) => ({
      id: r.id,
      title: r.attributes.title,
      room_type_id: r.relationships?.room_type?.data?.id ?? null,
      sell_mode: r.attributes.sell_mode,
      rate_mode: r.attributes.rate_mode,
      currency: r.attributes.currency,
    }));
  }

  /** POST /availability or /restrictions. Channex answers 200 even when it rejects some values, listing them in meta.warnings. */
  async pushAri(kind, values) {
    if (values.length === 0) return;
    const body = await this.request('POST', `/${kind}`, { values });
    const warnings = body?.meta?.warnings || [];
    if (warnings.length) {
      const first = warnings[0];
      throw new ChannexError(
        `Channex rejected ${warnings.length} ${kind} value(s), e.g. ${first.date || first.date_from || ''} ${JSON.stringify(first.warning)}`,
        { status: 200 }
      );
    }
  }

  /** Unacknowledged booking revisions, oldest first. */
  async bookingFeed(propertyId) {
    const body = await this.request(
      'GET',
      `/booking_revisions/feed?filter[property_id]=${encodeURIComponent(propertyId)}&order[inserted_at]=asc`
    );
    return body?.data || [];
  }

  async ackRevision(revisionId) {
    await this.request('POST', `/booking_revisions/${encodeURIComponent(revisionId)}/ack`);
  }
}

/** Build a client from environment variables, or null when Channex isn't configured. */
function clientFromEnv(env = process.env) {
  if (!env.CHANNEX_API_KEY) return null;
  const environment = (env.CHANNEX_ENV || 'staging').toLowerCase();
  const baseUrl = env.CHANNEX_BASE_URL || BASE_URLS[environment];
  if (!baseUrl) throw new Error(`CHANNEX_ENV must be "staging" or "production", got "${env.CHANNEX_ENV}"`);
  return new ChannexClient({ apiKey: env.CHANNEX_API_KEY, baseUrl });
}

module.exports = { ChannexClient, ChannexError, clientFromEnv, BASE_URLS };
