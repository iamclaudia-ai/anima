import { createRoot } from "react-dom/client";
import { Router, ErrorBoundary } from "@claudia/ui";
import "@claudia/ui/styles";

import { chatRoutes } from "@claudia/ext-chat/routes";
import { controlRoutes } from "@claudia/ext-control/routes";

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

const allRoutes = [...controlRoutes, ...chatRoutes];

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <Router routes={allRoutes} />
  </ErrorBoundary>,
);

// Register service worker for PWA functionality
if ("serviceWorker" in navigator) {
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
                // New version available
                console.log("New version available! Reloading...");
                window.location.reload();
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
    window.location.reload();
  });
}
