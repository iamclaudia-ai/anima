import { createRoot } from "react-dom/client";
import {
  Router,
  ErrorBoundary,
  GatewayClientProvider,
  GlobalNotifications,
  LoginGate,
} from "@anima/ui";
import type { PanelRegistry, Route } from "@anima/ui";
import type { LayoutDefinition } from "@anima/shared";
import { extensionWebContributions } from "./extension-web-contributions.generated";
import "@anima/ui/styles";

const webContributions = [...extensionWebContributions]
  .filter((contribution) => contribution.enabled !== false)
  .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));

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

if (import.meta.env?.DEV) {
  const script = document.createElement("script");
  script.src = "https://unpkg.com/react-grab/dist/index.global.js";
  script.crossOrigin = "anonymous";
  document.head.appendChild(script);
}

// ── Aggregate routes from all extension web contributions ───
const allRoutes: Route[] = webContributions.flatMap((contribution) => contribution.routes ?? []);

// ── Build panel registry from all extensions ────────────────
const panelRegistry: PanelRegistry = new Map();
for (const contribution of webContributions) {
  for (const panel of contribution.panels ?? []) {
    panelRegistry.set(panel.id, {
      id: panel.id,
      title: panel.title,
      icon: panel.icon,
      component: panel.component,
    });
  }
}

// ── Merge layout definitions from all extensions ────────────
const allLayouts: Record<string, LayoutDefinition> = Object.assign(
  {},
  ...webContributions.map((contribution) => contribution.layouts ?? {}),
);

// ── Render ──────────────────────────────────────────────────
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <LoginGate>
      <GatewayClientProvider>
        <GlobalNotifications>
          <Router routes={allRoutes} layouts={allLayouts} panelRegistry={panelRegistry} />
        </GlobalNotifications>
      </GatewayClientProvider>
    </LoginGate>
  </ErrorBoundary>,
);

// ── Service Worker ──────────────────────────────────────────
// Register service worker for PWA functionality.
// Skip SW in dev to avoid reload loops during active local rebuilds.
if ("serviceWorker" in navigator && !import.meta.env?.DEV) {
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
