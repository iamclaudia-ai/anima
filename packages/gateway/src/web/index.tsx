import { createRoot } from "react-dom/client";
import { Router, ErrorBoundary, GatewayClientProvider, GlobalNotifications } from "@claudia/ui";
import type { PanelRegistry } from "@claudia/ui";
import type { LayoutDefinition } from "@claudia/shared";
import "@claudia/ui/styles";

// ── Extension route imports ─────────────────────────────────
import { chatRoutes, chatPanels, chatLayouts } from "@claudia/ext-chat/routes";
import { controlRoutes } from "@claudia/ext-control/routes";
import { memoryRoutes } from "@claudia/memory/routes";
import { audiobooksRoutes } from "@claudia/ext-audiobooks/routes";
import { presenterRoutes } from "@claudia/ext-presenter/routes";
// Editor panel disabled — code-server iframe not yet configured for embedding.
// import { editorPanels } from "@claudia/ext-editor/routes";

// ── Hash-to-path redirect (PWA / legacy links) ─────────────
if (window.location.hash.startsWith("#/")) {
  const path = window.location.hash.slice(1);
  window.history.replaceState(null, "", path);
}

// ── PWA manifest injection ──────────────────────────────────
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

// ── Aggregate routes from all extensions ────────────────────
const allRoutes = [
  ...controlRoutes,
  ...memoryRoutes,
  ...presenterRoutes,
  ...chatRoutes,
  ...audiobooksRoutes,
];

// ── Build panel registry from all extensions ────────────────
// Editor panels disabled until code-server iframe embedding is sorted out.
const panelRegistry: PanelRegistry = new Map();
for (const panel of [...chatPanels]) {
  panelRegistry.set(panel.id, {
    id: panel.id,
    title: panel.title,
    icon: panel.icon,
    component: panel.component,
  });
}

// ── Merge layout definitions from all extensions ────────────
const allLayouts: Record<string, LayoutDefinition> = {
  ...chatLayouts,
};

// ── Render ──────────────────────────────────────────────────
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <GatewayClientProvider>
      <GlobalNotifications>
        <Router routes={allRoutes} layouts={allLayouts} panelRegistry={panelRegistry} />
      </GlobalNotifications>
    </GatewayClientProvider>
  </ErrorBoundary>,
);

// ── Service Worker ──────────────────────────────────────────
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
