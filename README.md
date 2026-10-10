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

Data is stored in `data/channel-manager.db`. Set `PORT` or `DB_FILE` to change where it runs and where data is stored.
On first start it creates a demo hotel: 3 room types and 4 OTAs, all simulated.

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
  sync.js            background worker that pushes queued cells to each OTA
  channels/
    base.js          the interface every OTA connection implements
    simulated.js     a fake OTA used for the demo
    index.js         maps channel code -> adapter
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

## Going live with real OTAs

The four OTAs here are **simulated**. Writing to a real Booking.com, Agoda or
MakeMyTrip listing is not possible through a public API. Each OTA only gives
API access to approved *connectivity partners*. You have two ways to get it:

1. **Become a connectivity partner** with each OTA. You apply, sign their
   agreement, get sandbox credentials and pass their certification. This takes
   weeks to months per OTA. Then write one adapter per OTA in `src/channels/`
   (extend `ChannelAdapter` and implement `pushUpdates`) and register it in
   `src/channels/index.js`. Point the OTA's reservation notifications at
   `/api/channels/:code/bookings`. Some OTAs only let you poll for new
   reservations; for those, add a poller that calls `receiveBooking`.
2. **Use an existing connectivity provider / channel-manager API** that is
   already certified with the OTAs. You write one adapter against that
   provider's API, and it handles each OTA for you. This is usually the fastest
   way to go live.

Nothing else (calendar, queue, retries, booking handling, dashboard) needs to change.

## Before production

- Add login and access control. There is no authentication yet.
- Verify webhook signatures and use HTTPS.
- Support multiple properties and rate plans (e.g. room-only vs. breakfast included). Right now there is one hotel with one rate per room type.
- Add alerts (email/WhatsApp) for overbookings and channels that keep failing.
