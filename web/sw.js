/* 리뷰시트 서비스워커 — 폰 알림만 한다(캐시 없음). iOS 는 홈 화면에 추가한 앱에서만 푸시를 받는다(16.4+). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  // iOS 는 받은 푸시마다 알림을 꼭 띄워야 구독이 안 끊긴다
  e.waitUntil(self.registration.showNotification(d.title || '리뷰시트', { body: d.body || '', tag: d.tag || undefined, icon: '/icon-180.png', badge: '/icon-180.png', data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    const w = ws.find(c => 'focus' in c);
    if (w) return w.navigate ? w.navigate(url).then(c => (c || w).focus()) : w.focus();
    return self.clients.openWindow(url);
  }));
});
