/* Kareer : notifications de la candidature automatique (Web Push). Aucun cache : l'application reste toujours à jour. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Kareer', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Kareer', {
    body: data.body || '',
    icon: '/kareer-logo.png',
    badge: '/kareer-logo.png',
    tag: data.tag,
    renotify: false,
    data: { url: data.url || '/?onglet=assistant' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) { await w.navigate(target).catch(() => {}); return w.focus(); }
    }
    return self.clients.openWindow(target);
  })());
});
