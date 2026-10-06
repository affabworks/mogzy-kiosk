// Offline shell: everything the kiosk needs (including the face models) is cached after the first load.
const V = "mogzy-v13";
const FILES = ["./","index.html","app.js","config.js","manifest.json","logo.png","icon-180.png","icon-192.png","icon-512.png","icon-512-maskable.png","face-api.js",
  "tiny_face_detector_model-weights_manifest.json","tiny_face_detector_model.bin",
  "face_landmark_68_model-weights_manifest.json","face_landmark_68_model.bin",
  "face_recognition_model-weights_manifest.json","face_recognition_model.bin"];
self.addEventListener("install", e => { e.waitUntil(caches.open(V).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;   // API calls always go to the network
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); return r; })
                .catch(() => caches.match(e.request, { ignoreSearch: true })));
});

self.addEventListener("push", e => {
  let d = {}; try { d = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(d.title || "Mogzy", { body: d.body || "", tag: d.tag, icon: "icon-192.png", badge: "icon-192.png", data: { url: d.url || "./admin.html" } }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const u = new URL(e.notification.data.url, self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => { const c = cs.find(x => x.url.startsWith(u.split("#")[0])); return c ? c.focus() : clients.openWindow(u); }));
});
