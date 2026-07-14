// Minimal service worker for Web Push. The browser has already decrypted
// the RFC 8291 payload by the time `push` fires — event.data is your
// plaintext. pushforge sends whatever bytes you give it; this example
// assumes plain text (send JSON and parse it here if you need structure).

self.addEventListener("push", (event) => {
  const text = event.data ? event.data.text() : "(empty push)";
  event.waitUntil(
    self.registration.showNotification("pushforge demo", {
      body: text,
      // icon: "/icon-192.png",  // add your own assets
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow("/"));
});
