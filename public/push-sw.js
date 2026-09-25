// Trade notifications from the server (Web Push). Loaded into the app's
// service worker, so they arrive with the app closed and the phone locked.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Nexus Desk", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Nexus Desk", {
      body: data.body || "",
      tag: data.tag,
      icon: "/pwa-192x192.png",
      badge: "/pwa-192x192.png",
      data: { url: data.url || "/" },
    })
  );
});

// Tapping it opens the app (or brings it forward).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
