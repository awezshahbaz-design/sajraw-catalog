const V = 'sajraw-v2';
const SHELL = ['./', 'index.html', 'app.js', 'config.js', 'pricing.js', 'pdf-template.js', 'manifest.webmanifest', 'assets/logo.png', 'assets/icon-192.png', 'assets/apple-touch-icon.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.hostname.endsWith('supabase.co')) return; // never cache cloud data/images/auth
  const same = u.origin === location.origin;
  const keep = res => { if (res.ok || res.type === 'opaque') { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); } return res; };
  // own files: network first (updates arrive), cache fallback offline. CDN libs: cache first.
  e.respondWith(same
    ? fetch(r).then(keep).catch(() => caches.match(r).then(h => h || caches.match('index.html')))
    : caches.match(r).then(h => h || fetch(r).then(keep)));
});
