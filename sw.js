// オフラインでもアプリを起動できるよう、アプリ本体だけをキャッシュする（動画・音声・APIは対象外）
const VERSION = "v2";
const CACHE = "jimaku-studio-" + VERSION;
const ASSETS = [
  "./", "index.html", "style.css", "app.js", "manifest.webmanifest",
  "lib/gemini.js", "lib/media.js", "lib/store.js", "lib/subs.js",
  "vendor/mediabunny.min.mjs",
  "icons/icon-32.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("jimaku-studio-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// 同じサイトのファイルだけ扱う。ネット優先で最新版を取り、つながらない時はキャッシュを使う
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html")))
  );
});
