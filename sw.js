/* ============================================================
   sw.js  —  CallDaddy Service Worker
   Handles: FCM background push + App shell caching
   ============================================================ */

// Firebase compat scripts (works in service workers)
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

const CACHE_NAME = 'calldaddy-v1';
const APP_SHELL  = ['/', '/index.html', '/style.css', '/app.js', '/manifest.json', '/offline.html'];

// ── Firebase init (same config as app.js) ──────────────────
firebase.initializeApp({
  apiKey:            'AIzaSyD1IglO0fuaIh9TYZLqAm4LDUJsCYN9h5Q',
  authDomain:        'calldaddy-63149.firebaseapp.com',
  projectId:         'calldaddy-63149',
  storageBucket:     'calldaddy-63149.firebasestorage.app',
  messagingSenderId: '154336897139',
  appId:             '1:154336897139:web:bc27a1a50bc7d8c5a4a206',
});

const messaging = firebase.messaging();

// ── App Shell Caching ──────────────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('/api/') || e.request.url.includes('/auth/')) return;
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).catch(
      () => caches.match('/offline.html')
    ))
  );
});

// ── FCM Background Message Handler ────────────────────────
// Called when a push arrives and the app is in background/closed
messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  const type = data.type || 'MESSAGE';

  const notifOptions = {
    body:             type === 'CALL'
      ? 'Someone is calling via your QR sticker. Tap to answer.'
      : 'You received a message via your QR sticker. Tap to reply.',
    icon:             '/icons/icon-192x192.png',
    badge:            '/icons/badge-72x72.png',
    tag:              data.sessionId,
    data,
    requireInteraction: type === 'CALL',
    vibrate:          [300, 100, 300, 100, 300],
    silent:           false,
  };

  if (type === 'CALL') {
    notifOptions.title   = '📞 Incoming Call — CallDaddy';
    notifOptions.actions = [
      { action: 'accept', title: '✅ Accept' },
      { action: 'reject', title: '❌ Reject'  },
    ];
  } else {
    notifOptions.title = '💬 New Message — CallDaddy';
  }

  return self.registration.showNotification(notifOptions.title, notifOptions);
});

// ── Notification Click Handler ─────────────────────────────
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { sessionId, type } = e.notification.data || {};
  const action = e.action; // 'accept' or 'reject' or '' (body click)

  const url = action === 'reject'
    ? `/?sessionId=${sessionId}&action=reject`
    : `/?sessionId=${sessionId}&type=${type}&action=incoming`;

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Focus existing window if open
      for (const client of list) {
        if (client.url.startsWith(self.location.origin)) {
          client.focus();
          return client.navigate(url);
        }
      }
      // Otherwise open new window
      return clients.openWindow(url);
    })
  );
});
