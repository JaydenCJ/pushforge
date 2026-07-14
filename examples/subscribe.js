// Browser-side subscription: paste into your page's JS (or adapt).
// Prerequisites:
//   1. `pushforge keygen` gave you an applicationServerKey (the public key).
//   2. service-worker.js is served from your site root.
//   3. Your backend exposes an endpoint that pipes the posted JSON into
//      `pushforge add -` (or calls store.add() via the API).

const APPLICATION_SERVER_KEY = "REPLACE_WITH_YOUR_PUBLIC_KEY"; // from `pushforge keygen`

// The Push API wants the key as a Uint8Array, not a string.
function b64urlToBytes(value) {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

export async function enablePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("this browser does not support Web Push");
  }
  const registration = await navigator.serviceWorker.register("/service-worker.js");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("notification permission denied");

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true, // required by every browser for Web Push
    applicationServerKey: b64urlToBytes(APPLICATION_SERVER_KEY),
  });

  // Ship the subscription to your own backend — this JSON is exactly what
  // `pushforge add` consumes. You own this data; no third party sees it.
  await fetch("/api/push-subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });

  return subscription;
}
