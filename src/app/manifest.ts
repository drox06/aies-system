import type { MetadataRoute } from "next";

/**
 * specs/00-foundation.md §8: "PWA: manifest, service worker, installable."
 *
 * Served from Next's metadata route rather than a static public/manifest.json so the icon paths
 * stay in one place with the rest of the app's metadata.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AIES Operations Platform",
    short_name: "AIES",
    description: "Internal operations platform for AIES Electromechanical Corporation",
    start_url: "/",
    display: "standalone",
    // Spec.md §6.4: the app bar is navy-800, so the phone's status bar matches rather than
    // leaving a white strip above a navy header.
    background_color: "#F5F7FA",
    theme_color: "#012076",
    orientation: "any",
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // The generated icons carry a 12% inset, which is the safe zone Android needs when it
      // crops an adaptive icon to a circle.
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
