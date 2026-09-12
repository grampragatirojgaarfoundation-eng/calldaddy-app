// CallDaddy Service Worker — FCM Push + Offline Cache
// Firebase Messaging SDK (compat version for SW)
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

const CACHE = 'calldaddy-v1';
const SHELL = ['/', '/index.html', '/app.js', '/manifest.json', '/icon-192.png'];

firebase.initializeApp({
  apiKey:            "AIzaSyD1IglO0fuaIh9TYZLqAm4LDUJsCYN9h5Q",
  authDomain:        "calldaddy-63149.firebaseapp.com",
  projectId:         "calldaddy-63149",
  storageBucket:     "calldaddy-63149.firebasestorage.app",
  messagingSenderId: "154336897139",
  appId:             "1:154336897139:web:bc27a1a50bc7d8c5a4a206",
});

const messaging = firebase.messaging();

// ── Install: cache shell ───────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})));
  self.skipWaiting();
});

// ── Activate: delete old caches ───────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// ── Fetch: network-first for API, cache-first for static ──────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/socket.io/')) return;
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
    ).catch(() => caches.match('/index.html'))
  );
});

// ── FCM Background Push (when app is closed) ─────────────────
messaging.onBackgroundMessage(payload => {
  const type = payload.data?.type;
  if (type === 'INCOMING_CALL') {
    self.registration.showNotification('📞 Incoming Call — CallDaddy', {
      body: 'Someone scanned your QR and wants to talk.',
      icon: '/icon-192.png',
      badge: '/icon-96.png',
      tag: 'incoming-call',
      requireInteraction: true,
      vibrate: [300, 100, 300, 100, 300],
      actions: [
        { action: 'accept',  title: '✓ Accept'  },
        { action: 'decline', title: '✕ Decline' },
      ],
      data: { sessionId: payload.data?.sessionId },
    });
  } else if (type === 'INCOMING_MESSAGE') {
    self.registration.showNotification('💬 CallDaddy: New Message', {
      body: 'Someone near your QR sent you a message.',
      icon: '/icon-192.png',
      tag: 'incoming-msg',
      data: { sessionId: payload.data?.sessionId },
    });
  }
});

// ── Notification Click ─────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const sid  = e.notification.data?.sessionId;
  const action = e.action;

  if (action === 'accept' && sid) {
    e.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        for (const c of list) {
          if ('focus' in c) { c.postMessage({ type: 'ACCEPT_CALL', sessionId: sid }); return c.focus(); }
        }
        return clients.openWindow(`/?call=${sid}`);
      })
    );
  } else if (action === 'decline' && sid) {
    fetch('/auth/me', { credentials: 'include' }).then(r => r.ok &&
      fetch(`/api/call/decline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid }), credentials: 'include' })
    );
  } else {
    e.waitUntil(clients.openWindow('/'));
  }
});

// ── Listen to FCM token refresh ───────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
