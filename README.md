# Hotel Channel Manager

Change your room rates and availability **once**, and the change goes out to
every OTA your hotel is listed on: Booking.com, Agoda, MakeMyTrip, Expedia and
so on. You no longer log in to each extranet one by one.

When a guest books on one OTA, the rooms come off sale on **all** the others
automatically, so you don't get overbooked.

## What it does

**Calendar**
- **One-click update:** pick room types, a date range and optionally
  weekdays, then set the rate, rooms available, minimum stay or stop-sell.
  Press **Update all channels**.
- **Close out / reopen:** stop or restart sales for the selected rooms and
  dates on every OTA with one button.
- **Calendar grid:** two weeks per room type. Click any night to edit it.
  Closed, sold-out and overbooked nights show in red.
- **Recent changes:** who changed what, and when.

**Bookings**
- **OTA bookings arrive by themselves** (through Channex). New, changed and
  cancelled bookings update the calendar, and the new availability goes back
  out to every OTA.
- **Direct bookings** for phone, email and walk-in guests. The rooms come
  off every OTA straight away. They're refused if the rooms aren't free.
- **Overbooking alerts:** if an OTA confirms a guest for a night that was
  already full, a red banner stays up until someone marks it handled.
- **Lists:** upcoming stays, arrivals today, needs attention, past and
  cancelled, with search.

**Channels**
- **Connect real OTAs through Channex.** See below.
- **Reliable delivery:** changes are queued, batched and retried. If one
  channel is down, the others carry on. The header shows whether everything
  is in sync.
- **Per-channel price markup**, and four demo OTAs you can use to try
  everything before connecting real ones.

**Settings**
- Hotel name and currency, room types (add, edit, delete), user accounts
  and passwords.

## Run it

Requires Node.js 22.13 or newer (it uses the built-in SQLite). There is no database to install.

```bash
npm install
npm start          # http://localhost:3000
npm test
```

On first start the app asks for your hotel name, currency and an owner
account. Tick **Add demo rooms and OTAs** to try it with sample data, or
leave it unticked and add your own room types in **Settings**.

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

## How it's built

```
src/
  server.js          starts the app (reads .env settings)
  app.js             security headers, login gate, mounts the routes
  routes/            the HTTP API, one file per area
  auth.js            passwords (scrypt), sessions, login lockout
  hotel.js           hotel details and room types
  db.js              SQLite schema, upgrades from older versions, demo data
  inventory.js       the calendar (single source of truth) and bulk updates
  bookings.js        bookings from OTAs and direct; overbooking detection
  activity.js        "who changed what" log
  queue.js           marks changed nights as "needs pushing" per channel
  sync.js            background worker that pushes queued nights to each channel
  channels/          one adapter per kind of connection (Channex, demo OTA)
  providers/channex/ Channex API client, connect/mapping, booking revisions
public/              dashboard (plain HTML/CSS/JS, no build step)
test/                end-to-end tests, plus a fake Channex API
```

The queue stores *which* cells changed, not their values. The worker reads the
latest values when it sends. Ten quick edits to the same night are sent as one
update, and a channel can never end up with stale values left over from an
earlier, slower push.

### API

Everything under `/api` needs a logged-in session cookie, except
`/api/health`, `/api/session`, `/api/setup`, `/api/auth/login` and the
Channex webhook. Requests that change something must send the header
`X-Requested-With: channel-manager`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/session` | Setup needed? Who is logged in? |
| POST | `/api/setup` | First run only: `{hotel_name, currency, name, email, password, demo?}` |
| POST | `/api/auth/login` · `/api/auth/logout` · `/api/auth/password` | Log in / out, change password |
| GET, POST, DELETE | `/api/users` · `/api/users/:id` | Manage users |
| GET, PATCH | `/api/property` | Hotel name and currency |
| GET, POST, PATCH, DELETE | `/api/room-types` · `/api/room-types/:id` | Room types `{code, name, total_rooms, base_rate}` |
| GET | `/api/inventory?start=YYYY-MM-DD&days=14` | Calendar grid |
| POST | `/api/inventory/bulk` | `{room_type_ids, start_date, end_date, weekdays?, set: {rate?, available?, min_stay?, stop_sell?}}` |
| GET | `/api/bookings?view=upcoming\|arrivals\|attention\|past\|cancelled\|all&q=` | Bookings |
| POST | `/api/bookings` | Direct booking `{room_type_id, check_in, check_out, rooms, guest_name, total?, notes?}` |
| POST | `/api/bookings/:id/cancel` · `/api/bookings/:id/handled` | Cancel; mark an alert handled |
| GET | `/api/alerts` · `/api/activity` | Banner alerts; recent changes |
| GET, PATCH | `/api/channels` · `/api/channels/:code` | Channels and sync status; `{enabled?, rate_markup_pct?}` |
| GET | `/api/channels/:code/listings` | What a demo OTA shows vs. what it should show |
| GET, POST | `/api/sync/log` · `/api/sync/retry` | Sync history; retry failed pushes |
| GET | `/api/providers/channex` | Connection status |
| GET | `/api/providers/channex/properties` · `/properties/:id/rooms` | Channex properties, room types and rate plans |
| POST | `/api/providers/channex/connect` | `{property_id, mappings: [{room_type_id, channex_room_type_id, channex_rate_plan_id}]}` |
| POST | `/api/providers/channex/disconnect` · `/pull` | Disconnect; check for bookings now |
| POST | `/api/providers/channex/webhook` | Called by Channex (shared-secret header, no login) |
| GET | `/api/health` | For uptime checks |

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
4. **Connect in the dashboard:** under *Connect real OTAs through Channex*,
   pick your property, then choose the Channex room type and rate plan for
   each of your room types. Press **Connect**.
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
- After 10 wrong passwords for an email or from an IP address, logins are
  blocked for 15 minutes.
- Requests that change data need a custom header, which blocks cross-site
  request forgery. Strict Content-Security-Policy and anti-framing headers
  are set.
- Changing your password logs out your other devices. Removing a user logs
  them out everywhere.

## Not built yet

- **Roles:** every user can do everything, including settings and the
  Channex connection.
- **Rate plans:** one price per room type per night. There's no separate
  "room only" vs "with breakfast" price.
- **Several hotels in one installation:** run one copy per hotel for now.
- **Email/WhatsApp alerts:** alerts show in the dashboard only.
- **Password reset by email:** for now, whoever runs the server resets it:
  `npm run reset-password -- you@example.com 'new password'` (with Docker:
  `docker exec channel-manager node scripts/reset-password.js you@example.com 'new password'`).
