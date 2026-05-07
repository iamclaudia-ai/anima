/**
 * Anima SPA bootstrap.
 *
 * Loads the gateway's set of extension web contributions dynamically at
 * startup — no static import of any per-extension module. The flow:
 *
 *   1. Fetch /api/web-contributions for the list of bundle URLs.
 *   2. Dynamic import() each bundle. The browser resolves bare imports
 *      (react, @anima/ui, etc.) via the importmap declared in index.html,
 *      so every extension shares the same module instances we use here.
 *   3. Validate each module's default export against the contribution shape.
 *   4. Aggregate routes / panels / layouts and render.
 *
 * Failures for individual extensions are logged and skipped — one bad
 * contribution shouldn't prevent the SPA from loading.
 */

import { createRoot } from "react-dom/client";
import {
  Router,
  ErrorBoundary,
  ExtensionConfigProvider,
  GatewayClientProvider,
  GlobalNotifications,
  LoginGate,
} from "@anima/ui";
import type {
  ExtensionConfigMap,
  ExtensionWebContribution,
  PanelContribution,
  PanelRegistry,
  Route,
} from "@anima/ui";
import type { LayoutDefinition } from "@anima/shared";
import { HomePage } from "./HomePage";
import "@anima/ui/styles";

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

// ── Dynamic-import contribution loader ──────────────────────

interface WebContributionEntry {
  extensionId: string;
  jsUrl: string;
  /** Public, client-safe config slice for this extension (anima.json `webConfig`). */
  webConfig?: Record<string, unknown>;
}

interface LoadedContribution {
  contribution: ExtensionWebContribution;
  webConfig: Record<string, unknown>;
}

/**
 * Lightweight runtime check for the contribution shape. Zod would be
 * overkill (and would balloon the SPA bundle); we just need to confirm
 * the extension exported a plausible default before mounting it.
 */
function isContribution(value: unknown): value is ExtensionWebContribution {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string") return false;
  if (candidate.name !== undefined && typeof candidate.name !== "string") return false;
  if (candidate.order !== undefined && typeof candidate.order !== "number") return false;
  if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") return false;
  // `icon` is a React component reference — could be a plain function
  // OR a forwardRef object (lucide-react wraps every icon in
  // `forwardRef`, which returns `{ $$typeof, render }`, NOT a function).
  // Accept either; React will complain at render time if it's bogus.
  if (
    candidate.icon !== undefined &&
    typeof candidate.icon !== "function" &&
    typeof candidate.icon !== "object"
  ) {
    return false;
  }
  if (
    candidate.color !== undefined &&
    (typeof candidate.color !== "object" || candidate.color === null)
  ) {
    return false;
  }
  if (candidate.routes !== undefined && !Array.isArray(candidate.routes)) return false;
  if (candidate.panels !== undefined && !Array.isArray(candidate.panels)) return false;
  if (
    candidate.layouts !== undefined &&
    (typeof candidate.layouts !== "object" || candidate.layouts === null)
  ) {
    return false;
  }
  return true;
}

async function loadWebContributions(): Promise<LoadedContribution[]> {
  let entries: WebContributionEntry[];
  try {
    const response = await fetch("/api/web-contributions");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { contributions?: WebContributionEntry[] };
    entries = body.contributions ?? [];
  } catch (error) {
    console.error("Failed to fetch web contributions list", error);
    return [];
  }

  const settled = await Promise.allSettled(
    entries.map(async (entry) => {
      const mod = (await import(/* @vite-ignore */ entry.jsUrl)) as { default?: unknown };
      if (!isContribution(mod.default)) {
        throw new Error(`invalid default export shape from ${entry.extensionId}`);
      }
      return mod.default;
    }),
  );

  const contributions: LoadedContribution[] = [];
  settled.forEach((result, index) => {
    const entry = entries[index]!;
    if (result.status === "fulfilled") {
      contributions.push({
        contribution: result.value,
        webConfig: entry.webConfig ?? {},
      });
    } else {
      console.error(
        `Skipping web contribution from ${entry.extensionId}:`,
        result.reason instanceof Error ? result.reason.message : result.reason,
      );
    }
  });
  return contributions;
}

async function bootstrap(): Promise<void> {
  const allLoaded = await loadWebContributions();
  const enabledLoaded = allLoaded.filter((entry) => entry.contribution.enabled !== false);
  const webContributions = enabledLoaded
    .map((entry) => entry.contribution)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || (a.id ?? "").localeCompare(b.id ?? ""));

  // Build the id → webConfig map the SPA exposes via ExtensionConfigProvider.
  const extensionConfigs: ExtensionConfigMap = {};
  for (const { contribution, webConfig } of enabledLoaded) {
    if (contribution.id) extensionConfigs[contribution.id] = webConfig;
  }

  // ── Aggregate routes / panels / layouts ─────────────────────
  // The gateway owns `/` as the home page launcher. Prepending the
  // built-in route guarantees it wins the "first match wins" lookup in
  // <Router>, regardless of what extensions claim — extensions get
  // namespaced paths (`/chat`, `/memory`, etc.) and contribute their
  // first route as a launcher tile via the `icon` + `label` convention.
  const builtinRoutes: Route[] = [
    {
      path: "/",
      component: () => <HomePage contributions={webContributions} />,
      title: "Home",
      label: "Home",
    },
  ];
  const allRoutes: Route[] = [
    ...builtinRoutes,
    ...webContributions.flatMap(
      (contribution) => (contribution.routes as Route[] | undefined) ?? [],
    ),
  ];
  const panelRegistry: PanelRegistry = new Map();
  for (const contribution of webContributions) {
    const panels = (contribution.panels as PanelContribution[] | undefined) ?? [];
    for (const panel of panels) {
      panelRegistry.set(panel.id, {
        id: panel.id,
        title: panel.title,
        icon: panel.icon,
        renderer: panel.renderer,
        component: panel.component,
      });
    }
  }
  const allLayouts: Record<string, LayoutDefinition> = Object.assign(
    {},
    ...webContributions.map((contribution) => contribution.layouts ?? {}),
  );

  // ── Render ──────────────────────────────────────────────────
  createRoot(document.getElementById("root")!).render(
    <ErrorBoundary>
      <LoginGate>
        <GatewayClientProvider>
          <ExtensionConfigProvider configs={extensionConfigs}>
            <GlobalNotifications>
              <Router routes={allRoutes} layouts={allLayouts} panelRegistry={panelRegistry} />
            </GlobalNotifications>
          </ExtensionConfigProvider>
        </GatewayClientProvider>
      </LoginGate>
    </ErrorBoundary>,
  );
}

bootstrap().catch((error) => {
  console.error("SPA bootstrap failed", error);
  const root = document.getElementById("root");
  if (root) {
    root.innerHTML = `
      <div style="padding: 40px; font-family: system-ui, sans-serif; color: #b91c1c;">
        <h1 style="font-size: 20px; margin: 0 0 12px;">Anima failed to load</h1>
        <pre style="white-space: pre-wrap; font-size: 13px; color: #475569;">${
          error instanceof Error ? error.message : String(error)
        }</pre>
        <p style="margin-top: 16px; color: #475569;">Check the browser console for details.</p>
      </div>
    `;
  }
});

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
