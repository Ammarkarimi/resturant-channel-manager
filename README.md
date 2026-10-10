# Hotel Channel Manager

Change your room rates and availability **once**, and the change goes out to
every OTA your hotel is listed on: Booking.com, Agoda, MakeMyTrip, Expedia and
so on. You no longer log in to each extranet one by one.

When a guest books on one OTA, the rooms come off sale on **all** the others
automatically, so you don't get overbooked.

## What it does

| Feature | How |
|---|---|
| **One-click bulk update** | Pick room types, a date range and (optionally) weekdays, then set rate, rooms available, minimum stay or stop-sell. Press **Update all channels**. |
| **Close out / reopen** | One button stops (or restarts) sales for the selected rooms and dates on every OTA. |
| **Calendar** | Two-week grid per room type. Click any night to edit it. Closed or sold-out nights show in red. |
| **Per-channel pricing** | Each OTA has a markup % (to cover its commission). You enter one base rate; Booking.com might get +15%, MakeMyTrip +12%. |
| **Booking sync** | OTAs post bookings and cancellations to a webhook. Availability is lowered or restored in the shared pool and pushed to every channel. Duplicate webhooks are ignored. A booking for nights that were already full is flagged **Overbooked**. |
| **Reliable delivery** | Every change goes into a sync queue. If an OTA's API is down, its updates are retried with backoff while the other channels carry on. Failed updates can be retried with one click. |
| **"What guests see"** | For each OTA, a view of what it currently shows next to what it should show, with ✓ when they match. |

## Run it

Requires Node.js 22.13 or newer (it uses the built-in SQLite). There is no database to install.

```bash
npm install
npm start          # http://localhost:3000
npm test
```

Data is stored in `data/channel-manager.db`. Settings go in a `.env` file (see `.env.example`).
On first start it creates a demo hotel: 3 room types and 4 simulated OTAs.
To reach the real OTAs, connect Channex as described below.

**Try it:**
1. Set a new rate for next weekend and press **Update all channels**. Then open **View on Agoda** and check the new price (with markup) is there.
2. Open **Simulate a booking**, book 2 Suites on Booking.com, and check that MakeMyTrip, Agoda and Expedia now show the Suite as closed.
3. Tick **Simulate API outage** on Expedia and make a change. Expedia shows *Retrying* while the other channels update. Untick it and Expedia catches up.

## How it's built

```
src/
  db.js              SQLite schema + demo seed
  inventory.js       the calendar (single source of truth) and bulk updates
  bookings.js        incoming bookings / cancellations from OTAs
  queue.js           marks changed cells as "needs pushing" per channel
  sync.js            background worker that pushes queued cells to each channel
  channels/
    base.js          the interface every connection implements
    channex.js       sends the calendar to Channex (ranges, rate plans)
    simulated.js     a fake OTA used for the demo
    index.js         picks the adapter for a channel
  providers/channex/
    client.js        Channex API client (auth, errors, pagination)
    index.js         connect / map rooms / pull bookings
    revisions.js     applies a Channex booking revision to the calendar
  app.js             REST API + serves the dashboard
public/              dashboard (plain HTML/CSS/JS, no build step)
test/                end-to-end API tests
```

The queue stores *which* cells changed, not their values. The worker reads the
latest values when it sends. Ten quick edits to the same night are sent as one
update, and a channel can never end up with stale values left over from an
earlier, slower push.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/inventory?start=YYYY-MM-DD&days=14` | Calendar grid |
| POST | `/api/inventory/bulk` | `{room_type_ids, start_date, end_date, weekdays?, set: {rate?, available?, min_stay?, stop_sell?}}` |
| GET | `/api/channels` | Channels with sync status |
| PATCH | `/api/channels/:code` | `{enabled?, rate_markup_pct?, simulate_outage?}` |
| GET | `/api/channels/:code/listings` | What the OTA shows vs. what it should show |
| POST | `/api/channels/:code/bookings` | Booking webhook: `{external_ref, room_id, check_in, check_out, rooms, guest_name?, total?}` |
| POST | `/api/channels/:code/bookings/:ref/cancel` | Cancellation webhook |
| GET | `/api/bookings` · `/api/sync/log` | Lists |
| POST | `/api/sync/retry` | Retry failed pushes |
| GET | `/api/providers/channex` | Connection status |
| GET | `/api/providers/channex/properties` · `/properties/:id/rooms` | Channex properties, room types and rate plans |
| POST | `/api/providers/channex/connect` | `{property_id, mappings: [{room_type_id, channex_room_type_id, channex_rate_plan_id}]}` |
| POST | `/api/providers/channex/disconnect` · `/pull` · `/webhook` | Disconnect, check bookings now, Channex webhook |

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

## Before production

- Add login and access control. There is no authentication yet.
- Verify webhook signatures and use HTTPS.
- Support multiple properties and rate plans (e.g. room-only vs. breakfast included). Right now there is one hotel with one rate per room type.
- Add alerts (email/WhatsApp) for overbookings and channels that keep failing.
