# Hotel Channel Manager

Change your room rates and availability **once**, and the change goes out to
every OTA your hotel is listed on: Booking.com, Agoda, MakeMyTrip, Expedia and
so on. You no longer log in to each extranet one by one.

When a guest books on one OTA, the rooms come off sale on **all** the others
automatically, so you don't get overbooked.

## What it does

The feature set follows established channel managers used by Indian hotels,
such as AxisRooms: rate plans, restrictions, multi-property groups, roles,
occupancy pricing, parity and channel reports.

**Dashboard**
- Tonight's occupancy, arrivals, departures, the next 7 days, and revenue,
  ADR and RevPAR for the month against last year.
- A 14-day occupancy chart, channel mix, the latest bookings, and one line
  per property for groups.

**Calendar: rates, availability and restrictions**
- **Rate plans under each room type:** Room only (EP), With breakfast (CP),
  Half board (MAP), Full board (AP). Each plan has prices for 1, 2 and 3
  adults plus extra adult and extra child.
- **Derived plans:** e.g. "With breakfast = Room only + ₹600", or
  "Non-refundable = Room only −10%". Change the parent and every derived
  plan follows, even across room types.
- **One-click bulk update:** pick room types and plans, a date range and
  weekdays, then set rooms available, prices, stop sell, closed to arrival
  (CTA), closed to departure (CTD), and minimum/maximum stay. Press
  **Update all channels**.
- **Close on chosen channels only:** e.g. stop selling Suites on Agoda this
  weekend while other channels keep selling.
- **Occupancy-based pricing:** rules like "+20% when a room type is 50%
  booked". Prices move on their own as bookings come in.
- **Calendar grid:** rooms left per room type and the price per plan for
  each night, with badges for restrictions, channel closures and
  occupancy pricing. Click any night to edit it.

**Bookings**
- OTA bookings arrive by themselves through Channex: new, modified and
  cancelled. Each one updates the calendar and every other channel.
- **Direct bookings** (phone, walk-in): priced from the rate plan by guest
  count, with warnings for restrictions such as minimum stay. Refused if
  the rooms aren't free.
- Overbooking alerts, lists (upcoming, arrivals, in house, departures,
  needs attention, past, cancelled), search by guest, phone or reference,
  and a **printable booking voucher**.

**Channels**
- Connect real OTAs through Channex, mapping your rooms and rate plans to
  Channex's.
- Per-channel price markup, reliable queued delivery with retries, and
  four demo OTAs for trying everything.

**Reports** (all downloadable as CSV)
- Summary (occupancy, revenue, ADR, RevPAR against last year), occupancy
  by night, channel performance (revenue, room nights, share,
  cancellations), booking pace against last year, and **rate parity**
  (each OTA's price against your direct price, flagging an OTA that is
  cheaper than you or hasn't received an update).

**Group and team**
- **Several properties** in one login, with a property switcher and a
  group overview.
- **Roles:** Admin, Revenue manager, Front desk, Viewer. Access can be
  limited to some properties.
- **Two-factor login** with an authenticator app, and a change history
  showing who changed what.

**Phone:** the dashboard is responsive and can be installed on Android and
iPhone home screens as an app (Add to Home Screen).

## Run it

Requires Node.js 22.13 or newer (it uses the built-in SQLite). There is no database to install.

```bash
npm install
npm start          # http://localhost:3000
npm test
```

On first start the app asks for your hotel name, currency and an owner
account. Tick **Add demo rooms, rate plans and OTAs** to try it with sample
data, or leave it unticked and add your own room types and rate plans in
**Settings**.

Upgrading from an earlier version: the database is converted on first start.
Your hotel becomes the first property, each room's rate becomes a "Room
only" rate plan, existing users become admins, and every channel gets a
fresh full sync.

Data is stored in `data/channel-manager.db`. Settings go in a `.env` file
(see `.env.example`).

**Things to try with the demo data:**
1. Set a new rate for next weekend and press **Update all channels**. On
   **Channels**, open **View on Agoda** and check the new price (with
   markup) is there.
2. On **Bookings**, open *Demo: simulate a booking*. Book 2 Suites on
   Agoda, then 1 more on Expedia for the same night. The overbooking alert
   appears.
3. Tick **Simulate API outage** on Expedia and make a change. Expedia shows
   *Retrying* while the other channels update. Untick it and Expedia
   catches up.
4. In **Settings**, add a pricing rule (+20% at 50% occupancy), then book
   one Suite. The Suite's price for that night goes up on every channel.
5. Open **Reports → Rate parity** and give one channel a negative markup to
   see a parity warning.

## How it's built

```
src/
  server.js          starts the app (reads .env settings)
  app.js             security headers, login gate, property context, routes
  routes/            the HTTP API, one file per area
  schema.js          the database layout (version 3)
  migrations/        upgrades from older versions (v1 -> v2 -> v3)
  permissions.js     roles and which properties a user can reach
  auth.js, totp.js   passwords (scrypt), sessions, lockout, two-factor codes
  hotel.js           properties, room types, rate plans, pricing rules
  pricing.js         a night's price: own/derived price, occupancy pricing, markup
  inventory.js       the calendar, bulk updates, channel-only closures
  bookings.js        OTA and direct bookings, quotes, overbooking detection
  reports.js         dashboard, KPIs, channel performance, pace, parity, CSV
  queue.js, sync.js  which nights need pushing, and the worker that pushes them
  channels/          one adapter per kind of connection (Channex, demo OTA)
  providers/channex/ Channex API client, connect/mapping, booking revisions
public/              dashboard (plain HTML/CSS/JS, no build step), voucher, app manifest
scripts/             password reset, icon generator
test/                end-to-end tests, plus a fake Channex API
```

The queue stores *which* cells changed, not their values. The worker reads the
latest values when it sends. Ten quick edits to the same night are sent as one
update, and a channel can never end up with stale values left over from an
earlier, slower push.

### API

Everything under `/api` needs a logged-in session cookie, except
`/api/health`, `/api/session`, `/api/setup`, `/api/auth/login*` and the
Channex webhook. Requests that change something must send the header
`X-Requested-With: channel-manager`. Requests about one property send
`X-Property-Id` (or `?property=`); without it, the user's first property is
used.

| Area | Endpoints |
|---|---|
| Session & login | `GET /api/session` · `POST /api/setup` · `POST /api/auth/login` → `{two_factor_required, challenge}` or a session · `POST /api/auth/login/verify {challenge, code}` · `POST /api/auth/logout` |
| Own account | `POST /api/auth/password` · `POST /api/auth/2fa/setup` · `/2fa/enable {code}` · `/2fa/disable {password}` |
| Users (admin) | `GET, POST /api/users` · `PATCH /api/users/:id {role, all_properties, property_ids}` · `POST /api/users/:id/reset-2fa` · `DELETE /api/users/:id` |
| Properties | `GET, POST /api/properties` · `GET, PATCH /api/property` (current) · `GET /api/group/overview` |
| Rooms & plans | `GET, POST /api/room-types` · `PATCH, DELETE /api/room-types/:id` · `POST /api/rate-plans` · `PATCH, DELETE /api/rate-plans/:id` |
| Pricing rules | `GET, POST /api/yield-rules` · `PATCH, DELETE /api/yield-rules/:id` |
| Calendar | `GET /api/inventory?start&days` · `POST /api/inventory/bulk` · `POST /api/inventory/channel-blocks` · `GET /api/activity` · `GET /api/alerts` |
| Bookings | `GET /api/bookings?view&q` · `GET /api/bookings/:id` · `POST /api/bookings/quote` · `POST /api/bookings` · `POST /api/bookings/:id/cancel` · `/handled` |
| Channels | `GET /api/channels` · `PATCH /api/channels/:code` · `GET /api/channels/:code/listings` · `GET /api/sync/log` · `POST /api/sync/retry` |
| Channex | `GET /api/providers/channex` · `/properties` · `/properties/:id/rooms` · `POST /connect {property_id, rooms, rate_plans}` · `/disconnect` · `/pull` · `/webhook` |
| Reports | `GET /api/reports/dashboard` · `/summary` · `/occupancy` · `/channels` · `/pace` (all `?from&to`) · `/parity?start&days&rate_plan_id` · `/export.csv?type=bookings\|occupancy\|channels&from&to` |
| Health | `GET /api/health` |

Bulk update body: `{room_type_ids, rate_plan_ids?, start_date, end_date, weekdays?, set}`
where `set` may hold `available`, `stop_sell` (whole room), `rate` /
`rate_double`, `rate_single`, `rate_triple`, `extra_adult`, `extra_child`,
`reset_rates`, `plan_stop_sell`, `cta`, `ctd`, `min_stay`, and `max_stay`
(0 = none).

## Going live with real OTAs, through Channex

Booking.com, Agoda, MakeMyTrip and the others only give API access to
approved partners. Rather than getting approved by each one, this app connects
to **[Channex](https://channex.io)**, a connectivity provider that is already
approved with them. You switch OTAs on inside Channex, and this app talks only
to Channex:

```
 this app ──rates & availability──▶ Channex ──▶ Booking.com, Agoda, MakeMyTrip, Expedia, …
          ◀────────bookings──────────         ◀──
```

### Setting it up

1. **Get a Channex account.** The sandbox at `staging.channex.io` is free.
   Create your property there, with its room types and rate plans. Use
   *per room* rate plans with *manual* pricing, because the app sends one
   price per night.
2. **Create an API key** in Channex (profile → *API Access*).
3. **Configure the app:** copy `.env.example` to `.env` and set
   `CHANNEX_API_KEY` (and `CHANNEX_ENV=production` when you go live).
   Restart with `npm start`.
4. **Connect in the dashboard:** under **Channels → Connect real OTAs
   through Channex**, pick your Channex property. Then choose the Channex
   room type for each of your room types, and the Channex rate plan for
   each of your rate plans. Press **Connect**. With several properties,
   connect each one to its own Channex property.
5. **Switch on OTAs inside Channex** (Channels → add Booking.com, Agoda,
   MakeMyTrip, …). Channex's
   [mapping guides](https://docs.channex.io/channel-mapping-guides) walk
   through each OTA.

You can try all of this without a Channex account. `node test/fake-channex.js`
starts a stand-in API on port 4010. Then start the app with
`CHANNEX_API_KEY=test-key CHANNEX_BASE_URL=http://127.0.0.1:4010/api/v1 npm start`.

### What happens after you connect

- **Full sync once:** connecting sends the next 500 days for every mapped
  room in two API calls (one for availability, one for rates and
  restrictions), as Channex asks.
- **Afterwards, only changes are sent:** consecutive nights with identical
  values are merged into one date range. Edits are batched and spaced at
  least 7 seconds apart, which keeps well under Channex's limit of 10
  calls per minute per endpoint. On a rate-limit or server error, pushes
  pause for a minute and retry. Values Channex rejects show up as errors on
  the Channex card instead of being silently dropped.
- **Bookings:** every new, modified or cancelled booking from any OTA is
  fetched from Channex's booking feed, applied to the calendar, and
  acknowledged. New availability then goes back out to every OTA. Each
  revision is applied exactly once, even if Channex sends it again. A
  booking for a room you haven't mapped is kept and marked
  **Needs attention**.
- **How fast bookings arrive:** the app checks every 60 seconds
  (`CHANNEX_POLL_SECONDS`). For near-instant updates, add a webhook in
  Channex for `booking` events pointing at
  `https://<your-server>/api/providers/channex/webhook`, with a custom
  header `X-Channex-Webhook-Secret` set to the value of
  `CHANNEX_WEBHOOK_SECRET`. The webhook only tells the app to check now.
  Bookings are always fetched from Channex with your API key, so a forged
  call can't inject one.
- **Demo channels:** connecting switches off the four demo OTAs. They are
  stand-ins that aren't needed once real OTAs are connected through Channex.

### Things to know about Channex

- Channex sells to **software companies (PMS / channel-manager builders)**,
  not directly to individual hotels, and Channex charges per property.
  Contact them about pricing and their partner agreement before you plan
  around it.
- Before using production, Channex runs **PMS certification tests**. They
  check batching, full sync, booking acknowledgement and similar behaviour.
  This integration was built to their published rules, but it has only
  been tested against a stand-in API, not the real staging server. Run
  through their tests on staging first.
- The markup % on the Channex card applies to everything sent to Channex.
  To charge different prices on different OTAs (e.g. +15% on Booking.com
  only), that needs to be set up on the Channex side. Ask Channex how they
  recommend doing it for your OTAs.

### Other ways to connect

Another provider, or a direct partnership with one OTA, plugs in the same
way. Write an adapter in `src/channels/` (extend `ChannelAdapter` and
implement `pushUpdates`), register it in `src/channels/index.js`, and feed
its bookings to `applyReservation` in `src/bookings.js`.

## Putting it online

### With Docker

```bash
docker build -t channel-manager .
docker run -d --name channel-manager -p 3000:3000 \
  -v channel-manager-data:/data --env-file .env channel-manager
```

The database is stored in the `/data` volume. Back it up by copying
`/data/channel-manager.db` while the app is stopped, or with
`sqlite3 channel-manager.db ".backup backup.db"` while it runs.

### Without Docker

Any server with Node.js 22.13+: `npm ci --omit=dev && npm start`. Keep it
running with systemd, pm2 or similar.

### HTTPS (required)

Never expose the app over plain HTTP: passwords and session cookies would
travel unencrypted. Put it behind a reverse proxy that handles HTTPS
(Caddy, nginx, or your hosting platform's built-in HTTPS), and set
`TRUST_PROXY=1` so the app knows requests arrived over HTTPS and marks its
cookies Secure. With Caddy, the whole config is:

```
hotel.example.com {
    reverse_proxy localhost:3000
}
```

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `DB_FILE` | `data/channel-manager.db` | Where the database is stored |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy |
| `CHANNEX_API_KEY` | – | Your Channex API key; leave empty to run without Channex |
| `CHANNEX_ENV` | `staging` | `staging` or `production` |
| `CHANNEX_WEBHOOK_SECRET` | – | Shared secret for the Channex webhook (optional) |
| `CHANNEX_POLL_SECONDS` | `60` | How often to check Channex for bookings |

## Security

- Passwords are hashed with scrypt. Sessions are random tokens, and only
  their hashes are stored. Cookies are HttpOnly, SameSite=Strict, and
  Secure behind HTTPS.
- Optional two-factor login (TOTP, RFC 6238). Admins can reset it for a
  user who lost their phone.
- After 10 wrong passwords for an email or from an IP address, logins are
  blocked for 15 minutes. Two-factor codes allow 5 tries per sign-in.
- Roles are enforced on the server, and users only reach the properties
  they were given.
- Requests that change data need a custom header, which blocks cross-site
  request forgery. A strict Content-Security-Policy and anti-framing
  headers are set. Guest text in CSV exports is protected against
  spreadsheet formula injection.
- Changing your password or turning on two-factor logs out your other
  devices. Removing a user logs them out everywhere.

## Not built yet

- **GDS and metasearch** (Amadeus, Sabre, Google Hotel Ads): these need
  their own commercial agreements. Channex offers some of these as
  separate connections.
- **Competitor rate shopping and AI pricing:** these need a market-data
  feed. Occupancy-based rules are included instead.
- **A booking engine** for your own website, and a **PMS** (front desk,
  folios, housekeeping).
- **Native iOS/Android apps:** the dashboard installs as an app from the
  browser instead.
- **Email/WhatsApp alerts** and **password reset by email:** for now,
  alerts show in the dashboard. Whoever runs the server resets a password
  with `npm run reset-password -- you@example.com 'new password'` (with
  Docker: `docker exec channel-manager node scripts/reset-password.js
  you@example.com 'new password'`).
- **Other languages:** English only.
