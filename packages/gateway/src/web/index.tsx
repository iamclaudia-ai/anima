import { createRoot } from "react-dom/client";
import { Router, ErrorBoundary } from "@claudia/ui";
import "@claudia/ui/styles";

import { chatRoutes } from "@claudia/ext-chat/routes";
import { controlRoutes } from "@claudia/ext-control/routes";
import { audiobooksRoutes } from "@claudia/ext-audiobooks/routes";

if (window.location.hash.startsWith("#/")) {
  const path = window.location.hash.slice(1);
  window.history.replaceState(null, "", path);
}

// PWA — inject manifest and apple-touch-icon dynamically to avoid
// Bun's HTML bundler trying to resolve the href paths at build time.
const manifestLink = document.createElement("link");
manifestLink.rel = "manifest";
manifestLink.href = "/manifest.json";
document.head.appendChild(manifestLink);

const appleTouchIcon = document.createElement("link");
appleTouchIcon.rel = "apple-touch-icon";
appleTouchIcon.href = "/icons/icon-180x180.png";
document.head.appendChild(appleTouchIcon);

if (import.meta.env.DEV) {
  const script = document.createElement("script");
  script.src = "https://unpkg.com/react-grab/dist/index.global.js";
  script.crossOrigin = "anonymous";
  document.head.appendChild(script);
}

const allRoutes = [...controlRoutes, ...chatRoutes, ...audiobooksRoutes];

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <Router routes={allRoutes} />
  </ErrorBoundary>,
);

// Register service worker for PWA functionality.
// Skip SW in dev to avoid reload loops during active local rebuilds.
if ("serviceWorker" in navigator && !import.meta.env.DEV) {
  let reloadedForUpdate = false;

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/service-worker.js")
      .then((registration) => {
        console.log("Service Worker registered:", registration.scope);

        // Check for updates periodically (every hour)
        setInterval(
          () => {
            registration.update();
          },
          60 * 60 * 1000,
        );

        // Listen for updates
        registration.addEventListener("updatefound", () => {
          const newWorker = registration.installing;
          if (newWorker) {
            newWorker.addEventListener("statechange", () => {
              if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
                // New version available: let controllerchange own the single reload.
                console.log("New version available! Waiting for activation...");
              }
            });
          }
        });
      })
      .catch((error) => {
        console.error("Service Worker registration failed:", error);
      });
  });

  // Listen for controller change (new service worker activated)
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadedForUpdate) return;
    reloadedForUpdate = true;
    window.location.reload();
  });
}
