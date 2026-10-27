// App shell for the installable app. Pages and scripts come from the network
// when it's available (so updates show up at once) and from the cache when
// it isn't. API calls are never cached: rates and bookings must be live.
const CACHE = 'channel-manager-v3';
const SHELL = [
  '/', '/index.html', '/styles.css', '/manifest.webmanifest', '/voucher.html', '/voucher.css',
  '/js/core.js', '/js/charts.js', '/js/dashboard.js', '/js/calendar.js', '/js/bookings.js', '/js/channels.js',
  '/js/reports.js', '/js/settings.js', '/js/main.js', '/js/voucher.js', '/icons/icon.svg', '/icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html'))),
  );
});
