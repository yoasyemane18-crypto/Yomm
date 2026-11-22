/**
 * Yeme Bingo - Firebase Cloud Messaging Service Worker (Web / PWA)
 *
 * SETUP:
 * 1. Host this file at your web app root (`/firebase-messaging-sw.js`) so Firebase
 *    Messaging can register background push notifications cleanly.
 * 2. Ensure `firebaseConfig` below matches `FBCFG` in `index.html` and your
 *    Firebase Console -> Project Settings -> Cloud Messaging -> Web Push VAPID key
 *    is pasted into `PUSH_CFG.vapidKey` inside `index.html`.
 */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyDrYOOePFsUCPHCPdNHwB05FPna-F_thvA',
  authDomain: 'wow-878fc.firebaseapp.com',
  databaseURL: 'https://wow-878fc-default-rtdb.firebaseio.com',
  projectId: 'wow-878fc',
  storageBucket: 'wow-878fc.firebasestorage.app',
  messagingSenderId: '498780669062',
  appId: '1:498780669062:web:4610c2fba867f2c2a63d07'
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function (payload) {
  const data = payload.data || {};
  const notif = payload.notification || {};
  const title = notif.title || data.title || 'Yeme Bingo';
  const body = notif.body || data.body || '';
  const screen = data.screen || 'home';

  return self.registration.showNotification(title, {
    body: body,
    icon: '/public/icon-192.png',
    badge: '/public/badge-72.png',
    tag: data.tag || ('yeme-' + screen),
    data: { screen: screen, url: '/?screen=' + encodeURIComponent(screen) }
  });
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const data = (event.notification && event.notification.data) || {};
  const screen = data.screen || 'home';
  const targetUrl = '/?screen=' + encodeURIComponent(screen);

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windowClients) {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if ('focus' in client) {
          client.postMessage({ type: 'YEME_DEEP_LINK', screen: screen });
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
