// Soonstep Comm, téléphone : l'appli s'ouvre sans réseau ; les visuels déjà vus restent sur le téléphone.
const VERSION = '1.10.1-e830df39';
const COQUILLE = `coquille-${VERSION}`;
const VISUELS = 'visuels-v1';
const FICHIERS = [
  './', 'index.html', `style.css?v=${VERSION}`, `base.js?v=${VERSION}`,
  'fonts/plus-jakarta-sans-latin.woff2', 'fonts/plus-jakarta-sans-latin-ext.woff2',
  'img/glyphe-couleur.svg', 'img/icone-180.png', 'img/icone-192.png', 'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(COQUILLE).then((c) => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((cles) => Promise.all(cles.filter((k) => k !== COQUILLE && k !== VISUELS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const chemin = url.pathname;

  // Le contenu (posts, réglages de base) : le réseau d'abord, la dernière copie sinon.
  if (chemin.endsWith('/d/contenu.bin')) {
    e.respondWith(fetch(new Request(e.request, { cache: 'no-store' })).then((r) => {
      if (r.ok) { const copie = r.clone(); caches.open(VISUELS).then((c) => c.put('d/contenu.bin', copie)); }
      return r;
    }).catch(() => caches.open(VISUELS).then((c) => c.match('d/contenu.bin')).then((r) => r || Response.error())));
    return;
  }

  // Les visuels chiffrés ne changent jamais sous un même nom : le cache d'abord.
  if (chemin.includes('/d/')) {
    e.respondWith(caches.open(VISUELS).then(async (c) => {
      const deja = await c.match(e.request);
      if (deja) return deja;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    }));
    return;
  }

  // L'interface : le réseau d'abord (sans le cache HTTP de 10 min de GitHub Pages), le cache hors ligne.
  const frais = e.request.mode === 'navigate'
    ? new Request(url.href, { cache: 'no-cache', credentials: 'same-origin' })
    : new Request(e.request, { cache: 'no-cache' });
  e.respondWith(fetch(frais).then((r) => {
    if (r.ok) { const copie = r.clone(); caches.open(COQUILLE).then((c) => c.put(e.request, copie)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: false }).then((r) => r || caches.match('index.html'))));
});
