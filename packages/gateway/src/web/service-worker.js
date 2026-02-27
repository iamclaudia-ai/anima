/**
 * Claudia Service Worker
 *
 * Minimal shell for PWA functionality:
 * - Caching strategy for shell assets
 * - Auto-updates handling
 * - Push notification event routing
 */

const CACHE_NAME = "claudia-v1";

// Cache shell assets on install
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(["/", "/index.html", "/manifest.json"])),
  );
  // Force activation of new service worker
  self.skipWaiting();
});

// Clean old caches on activate
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      ),
  );
  return self.clients.claim();
});

// Network-first fetch strategy (no offline support)
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

// Forward push events to client (extension handles via WebSocket)
self.addEventListener("push", (event) => {
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || "/icons/icon-192x192.png",
      badge: data.badge,
      tag: data.tag || "claudia-notification",
      data: data.data,
    }),
  );
});

// Handle notification clicks
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || "/"));
});
