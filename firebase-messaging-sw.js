importScripts('https://www.gstatic.com/firebasejs/10.4.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.4.0/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: "AIzaSyD1IglO0fuaIh9TYZLqAm4LDUJsCYN9h5Q",
    authDomain: "calldaddy-63149.firebaseapp.com",
    projectId: "calldaddy-63149",
    storageBucket: "calldaddy-63149.firebasestorage.app",
    messagingSenderId: "154336897139",
    appId: "1:154336897139:web:bc27a1a50bc7d8c5a4a206"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
    const data = payload.data || {};
    const title = data.title || 'CallDaddy';
    const isCall = data.type === 'call';

    const options = {
        body: data.body || 'Tap to open.',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        requireInteraction: true,
        renotify: true,
        tag: 'calldaddy-alert',
        vibrate: isCall ? [500, 500, 500, 500, 500, 500] : [300, 100, 300],
        data: { url: data.url || 'https://calldaddy.in/', qrId: data.qrId || '' },
        actions: isCall
            ? [ { action: 'answer', title: '✅ Answer Call' }, { action: 'reject', title: '❌ Reject Call' } ]
            : [ { action: 'open', title: '💬 View Message' } ]
    };

    return self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    const notifData = event.notification.data || {};
    const urlToOpen = notifData.url;

    if (event.action === 'reject' && notifData.qrId) {
        event.waitUntil(fetch('https://calldaddy.in/api/reject-call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qrId: notifData.qrId }) }).catch(() => {}));
        return;
    }

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
            for (const client of clientList) { if ('focus' in client) { client.navigate(urlToOpen); return client.focus(); } }
            if (clients.openWindow) return clients.openWindow(urlToOpen);
        })
    );
});