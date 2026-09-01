"use client";

/**
 * Subscribing this browser to Web Push. Client-only — `PushManager` does not exist on the server.
 *
 * ## The iOS rule, stated once here rather than three times in the UI
 *
 * Safari on iPhone only accepts a push subscription from a page running as an installed Home
 * Screen app (Share → Add to Home Screen), iOS 16.4+. A bookmark or an open Safari tab will never
 * be offered the permission prompt at all — `pushManager` exists on the object but `subscribe()`
 * rejects. There is no workaround; it is Apple's rule, not a bug in this code.
 */

/** `applicationServerKey` wants raw bytes; the VAPID public key arrives base64url from the server.
 *  Wrapped around an explicit `new ArrayBuffer(...)` rather than letting `Uint8Array` infer its
 *  own — TypeScript 5.7's lib.dom typings make plain `new Uint8Array(n)` generic over the wider
 *  `ArrayBufferLike`, which `applicationServerKey`'s `BufferSource` does not accept. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64Safe);
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

export interface DeviceSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string;
}

/**
 * Asks for permission if needed, subscribes, and returns what the server needs to store — or
 * throws with a message a person can actually read, since this is always called from a click and
 * the failure has to explain itself right there rather than in a console nobody on a phone sees.
 */
export async function subscribeThisDevice(vapidPublicKey: string): Promise<DeviceSubscription> {
  if (!pushSupported()) {
    throw new Error("This browser does not support push notifications.");
  }

  if (Notification.permission === "denied") {
    throw new Error(
      "Notifications are blocked for this site. Enable them in the browser's site settings, then try again.",
    );
  }

  const permission =
    Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Permission was not granted, so this device cannot be enabled.");
  }

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    }));

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("The browser did not return a usable subscription. Try again.");
  }

  return {
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    userAgent: navigator.userAgent,
  };
}

/**
 * Unsubscribes the browser itself, not just the server-side row — leaving the browser-side
 * subscription behind would have it silently keep receiving pushes for a device the settings
 * screen claims was removed.
 *
 * Takes the endpoint being removed and only acts if it matches *this* browser's own active
 * subscription. The settings screen lists every device on the account, and "Remove" on a row for
 * a different device must never reach into the browser currently open and unsubscribe it instead.
 */
export async function unsubscribeIfThisDevice(endpoint: string): Promise<void> {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription && subscription.endpoint === endpoint) {
    await subscription.unsubscribe();
  }
}
