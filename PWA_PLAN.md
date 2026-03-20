# Progressive Web App (PWA) Implementation Plan

## 🎯 Goal

Transform the Anima chat client into a Progressive Web App to provide:

- **Native app experience** - Remove browser chrome, full-screen mode
- **Auto-updates** - Seamless updates without user intervention
- **Push notifications** - Real-time alerts for messages and system events
- **Home screen installation** - Add to home screen like a native app
- **App-like navigation** - Smooth transitions, no browser UI

**Explicitly NOT implementing:**

- Offline support (requires connection to Anima anyway)

## 📱 Benefits

### Desktop

- Clean, distraction-free interface without browser tabs/chrome
- Standalone window with custom title bar
- System tray integration possible
- Auto-launch on startup

### Mobile

- Full-screen experience (no Safari/Chrome UI)
- Home screen icon
- Splash screen on launch
- Native-feeling interactions
- Push notifications for new messages

## 🏗️ Architectural Decisions

### Service Worker Placement: Hybrid Approach

**Decision:** Gateway provides minimal service worker shell (~50 lines), Push extension provides notification features.

**Options Considered:**

1. **Pure Gateway**: All SW logic in gateway package
   - ❌ Con: Gateway bloat, push notifications not modular
   - ❌ Con: Can't disable push without modifying core

2. **Pure Extension**: Extension provides complete service worker
   - ❌ Con: Multiple extensions = multiple service workers (impossible)
   - ❌ Con: Base PWA features (caching, updates) not available if extension disabled

3. **Hybrid** ✅ (Selected)
   - ✅ Pro: Gateway provides shell (caching, updates, basic push handler)
   - ✅ Pro: Extension provides push notification logic via WebSocket methods
   - ✅ Pro: Clean separation: gateway = infrastructure, extension = features
   - ✅ Pro: Push extension can be disabled without breaking PWA

4. **Plugin Hook System**: Gateway exports SW hooks, extensions register handlers
   - ⚠️ Con: More complex, over-engineered for current needs
   - ⚠️ Con: Service worker can't dynamically load extension code

**Implementation:**

```typescript
// Gateway: packages/gateway/public/service-worker.js
// Minimal shell - caching, updates, push event routing

const CACHE_NAME = "anima-v1";

// Cache shell assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(["/", "/index.html", "/manifest.json"])),
  );
  self.skipWaiting();
});

// Clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      ),
  );
  return self.clients.claim();
});

// Network-first fetch strategy
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

// Forward push events to client (extension handles via WebSocket)
self.addEventListener("push", (event) => {
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon,
      badge: data.badge,
      tag: data.tag,
      data: data.data,
    }),
  );
});

// Handle notification clicks
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url || "/"));
});
```

**Extension Role:**

- Push extension handles subscription management (subscribe/unsubscribe methods)
- Push extension sends notifications via WebSocket methods
- Push extension stores subscriptions in database
- Service worker receives push events and displays them (no extension code in SW)

### Event Architecture: DOM Events (Not Server Event Bus)

**Decision:** Service worker events use standard browser APIs (DOM events, postMessage). Do NOT use server event bus.

**Rationale:**

- Service worker events are **client-side only** (browser → service worker → client)
- Event bus is for **server-side processing** (extension → extension within gateway process)
- Mixing concerns would create confusion and architectural debt

**Client-Side Communication (Service Worker ↔ App):**

```typescript
// In app: Send message to service worker
navigator.serviceWorker.controller?.postMessage({
  type: "PING",
  data: { foo: "bar" },
});

// In service worker: Receive from app
self.addEventListener("message", (event) => {
  if (event.data.type === "PING") {
    event.ports[0].postMessage({ type: "PONG" });
  }
});

// In app: Listen for service worker messages
navigator.serviceWorker.addEventListener("message", (event) => {
  console.log("SW message:", event.data);
});

// In app: Custom DOM events for extension UI
window.dispatchEvent(
  new CustomEvent("anima:push-subscribed", {
    detail: { endpoint: "..." },
  }),
);

// In extension: Listen for custom events
window.addEventListener("anima:push-subscribed", (event) => {
  console.log("New subscription:", event.detail);
});
```

**Server-Side Communication (Extension ↔ Extension):**

```typescript
// Push extension emits server event
ctx.emit("push.subscribed", { endpoint: "..." });

// Chat extension listens to server event
ctx.on("push.subscribed", (data) => {
  console.log("New push subscriber:", data);
});
```

**Clear Separation:**

- **Browser APIs**: Service worker ↔ App communication (client-side)
- **Event Bus**: Extension ↔ Extension communication (server-side)
- **WebSocket**: Client ↔ Server communication (extension methods)

### Database Migration Strategy: Per-Extension

**Decision:** Each extension manages its own migrations with tracking table including `extension_id`.

**Migration Tracking Table:**

```sql
CREATE TABLE IF NOT EXISTS applied_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  extension_id TEXT NOT NULL,
  migration_number INTEGER NOT NULL,
  migration_name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  UNIQUE(extension_id, migration_number)
);
```

**Extension Migration Structure:**

```
extensions/push/
├── migrations/
│   ├── 001-create-subscriptions.sql
│   ├── 002-add-user-agent.sql
│   └── 003-add-indexes.sql
└── src/
    └── index.ts
```

**Migration File Format:**

```sql
-- migrations/001-create-subscriptions.sql

-- Up
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used TEXT NOT NULL
);

CREATE INDEX idx_push_subscriptions_endpoint ON push_subscriptions(endpoint);

-- Down
DROP TABLE push_subscriptions;
```

**Migration Runner Implementation:**

```typescript
// packages/shared/src/migrations.ts
import { Database } from "bun:sqlite";
import { readdir, readFile } from "fs/promises";
import { join } from "path";

export async function runMigrations(
  db: Database,
  extensionId: string,
  migrationsDir: string,
): Promise<void> {
  // Ensure tracking table exists
  db.run(`
    CREATE TABLE IF NOT EXISTS applied_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      extension_id TEXT NOT NULL,
      migration_number INTEGER NOT NULL,
      migration_name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      UNIQUE(extension_id, migration_number)
    )
  `);

  // Get applied migrations for this extension
  const appliedRows = db
    .prepare(
      `
    SELECT migration_number FROM applied_migrations
    WHERE extension_id = ?
    ORDER BY migration_number
  `,
    )
    .all(extensionId) as Array<{ migration_number: number }>;

  const appliedNumbers = new Set(appliedRows.map((r) => r.migration_number));

  // Find migration files
  const files = await readdir(migrationsDir);
  const migrations = files
    .filter((f) => f.endsWith(".sql"))
    .map((f) => {
      const match = f.match(/^(\d+)-(.+)\.sql$/);
      if (!match) throw new Error(`Invalid migration filename: ${f}`);
      return {
        number: parseInt(match[1]),
        name: match[2],
        filename: f,
      };
    })
    .sort((a, b) => a.number - b.number);

  // Apply pending migrations
  for (const migration of migrations) {
    if (appliedNumbers.has(migration.number)) {
      continue; // Already applied
    }

    const filepath = join(migrationsDir, migration.filename);
    const content = await readFile(filepath, "utf-8");

    // Split by -- Up and -- Down markers
    const upMatch = content.match(/--\s*Up\s*\n([\s\S]*?)(?=--\s*Down|$)/i);
    if (!upMatch) {
      throw new Error(`Migration ${migration.filename} missing -- Up marker`);
    }

    const upSQL = upMatch[1].trim();
    if (!upSQL) {
      throw new Error(`Migration ${migration.filename} has empty -- Up section`);
    }

    // Execute migration
    console.log(`Running migration: ${extensionId}/${migration.filename}`);
    db.run(upSQL);

    // Record as applied
    db.prepare(
      `
      INSERT INTO applied_migrations (extension_id, migration_number, migration_name, applied_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run(extensionId, migration.number, migration.name, new Date().toISOString());

    console.log(`✓ Applied: ${extensionId}/${migration.filename}`);
  }
}

export async function rollbackMigration(
  db: Database,
  extensionId: string,
  migrationNumber: number,
  migrationsDir: string,
): Promise<void> {
  // Find migration file
  const files = await readdir(migrationsDir);
  const migration = files.find((f) =>
    f.startsWith(`${migrationNumber.toString().padStart(3, "0")}-`),
  );

  if (!migration) {
    throw new Error(`Migration ${migrationNumber} not found`);
  }

  const filepath = join(migrationsDir, migration);
  const content = await readFile(filepath, "utf-8");

  // Extract -- Down section
  const downMatch = content.match(/--\s*Down\s*\n([\s\S]*?)$/i);
  if (!downMatch) {
    throw new Error(`Migration ${migration} missing -- Down marker`);
  }

  const downSQL = downMatch[1].trim();
  if (!downSQL) {
    throw new Error(`Migration ${migration} has empty -- Down section`);
  }

  // Execute rollback
  console.log(`Rolling back: ${extensionId}/${migration}`);
  db.run(downSQL);

  // Remove from applied_migrations
  db.prepare(
    `
    DELETE FROM applied_migrations
    WHERE extension_id = ? AND migration_number = ?
  `,
  ).run(extensionId, migrationNumber);

  console.log(`✓ Rolled back: ${extensionId}/${migration}`);
}
```

**Extension Integration:**

```typescript
// extensions/push/src/index.ts
import { runMigrations } from "@anima/shared/migrations";
import { join } from "path";

export function createPushExtension(config: Record<string, unknown> = {}): ClaudiaExtension {
  return {
    id: "push",
    name: "Push Notifications",
    // ...

    async start(context: ExtensionContext): Promise<void> {
      const db = getDb();

      // Run migrations automatically
      const migrationsDir = join(__dirname, "../migrations");
      await runMigrations(db, "push", migrationsDir);

      ctx.log.info("Push notification extension started");
    },

    // ...
  };
}
```

**Benefits:**

- ✅ Each extension owns its migrations (modular)
- ✅ Migrations can be versioned with extension code
- ✅ No central migration coordination needed
- ✅ Easy to see what changed in extension (git log migrations/)
- ✅ Rollback support with `-- Down` markers
- ✅ Clean separation: extension = feature + schema

**Alternative Considered:** Centralized migrations folder

- ❌ Con: Extension schema scattered across codebase
- ❌ Con: Hard to version with extension
- ❌ Con: Requires coordination between extensions

### Communication Pattern: WebSocket Methods (Not REST)

**Decision:** All client ↔ server communication uses WebSocket methods via `ctx.call()`.

**Not This (REST):**

```typescript
// ❌ Wrong - Anima doesn't use REST APIs
await fetch("/api/push/subscribe", {
  method: "POST",
  body: JSON.stringify({ endpoint, keys }),
});
```

**This (WebSocket Methods):**

```typescript
// ✅ Correct - WebSocket method calls
const result = await ctx.call("push.subscribe", {
  endpoint: subscription.endpoint,
  p256dh: subscription.keys.p256dh,
  auth: subscription.keys.auth,
});
```

**Rationale:**

- Anima's architecture uses extension methods as the primary interface
- WebSocket provides real-time bidirectional communication
- Methods are type-safe with Zod schemas
- Automatic reconnection and error handling
- Events can flow back to client via WebSocket

**Client-Side Usage:**

```typescript
// In chat extension UI
import { useClaudiaContext } from '@anima/client';

function NotificationSettings() {
  const ctx = useClaudiaContext();

  async function enablePush() {
    // Request browser permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    // Subscribe via service worker
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(ctx.config.push.vapidPublicKey),
    });

    // Register with server via WebSocket method
    await ctx.call('push.subscribe', {
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: navigator.userAgent,
    });

    console.log('Push notifications enabled!');
  }

  return <button onClick={enablePush}>Enable Notifications</button>;
}
```

## 🔧 Core PWA Requirements

### 1. Web App Manifest (`manifest.json`)

```json
{
  "name": "Anima",
  "short_name": "Anima",
  "description": "Personal AI platform - Talk to Claudia",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#1a1a1a",
  "theme_color": "#8b5cf6",
  "orientation": "any",
  "icons": [
    {
      "src": "/icons/icon-72x72.png",
      "sizes": "72x72",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-96x96.png",
      "sizes": "96x96",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-128x128.png",
      "sizes": "128x128",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-144x144.png",
      "sizes": "144x144",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-152x152.png",
      "sizes": "152x152",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-192x192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-384x384.png",
      "sizes": "384x384",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-512x512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ],
  "screenshots": [
    {
      "src": "/screenshots/desktop.png",
      "sizes": "1280x720",
      "type": "image/png",
      "form_factor": "wide"
    },
    {
      "src": "/screenshots/mobile.png",
      "sizes": "750x1334",
      "type": "image/png",
      "form_factor": "narrow"
    }
  ],
  "categories": ["productivity", "utilities"],
  "shortcuts": [
    {
      "name": "New Chat",
      "short_name": "New",
      "description": "Start a new conversation with Claudia",
      "url": "/chat/new",
      "icons": [{ "src": "/icons/new-chat.png", "sizes": "96x96" }]
    }
  ]
}
```

### 2. Service Worker

**Purpose:** Handle caching strategy and enable updates

```typescript
// service-worker.ts
const CACHE_NAME = "anima-v1";
const RUNTIME_CACHE = "anima-runtime";

// Assets to cache on install (shell only, no offline data)
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/styles/main.css",
  "/scripts/main.js",
  "/icons/icon-192x192.png",
  "/manifest.json",
];

// Install - cache shell assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(SHELL_ASSETS);
    }),
  );
  // Force activation of new service worker
  self.skipWaiting();
});

// Activate - clean up old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== RUNTIME_CACHE)
          .map((name) => caches.delete(name)),
      );
    }),
  );
  return self.clients.claim();
});

// Fetch - Network-first strategy (no offline support)
self.addEventListener("fetch", (event) => {
  // Skip non-GET requests
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses for shell assets
        if (response.status === 200) {
          const responseClone = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Fallback to cache only for shell assets
        return caches.match(event.request);
      }),
  );
});
```

### 3. Push Notifications

**Server-side (Gateway Extension):**

```typescript
// Send notification via Web Push API
import webpush from "web-push";

interface PushSubscription {
  userId: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

async function sendNotification(subscription: PushSubscription, message: string) {
  const payload = JSON.stringify({
    title: "New message from Claudia",
    body: message,
    icon: "/icons/icon-192x192.png",
    badge: "/icons/badge-72x72.png",
    tag: "anima-message",
    data: {
      url: "/chat",
      timestamp: Date.now(),
    },
  });

  await webpush.sendNotification(subscription, payload);
}
```

**Client-side (Chat Extension):**

```typescript
// Request notification permission
async function enableNotifications() {
  if (!("Notification" in window)) {
    throw new Error("Notifications not supported");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission denied");
  }

  // Subscribe to push notifications
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(PUBLIC_VAPID_KEY),
  });

  // Send subscription to server
  await fetch("/api/notifications/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription),
  });
}

// Handle push events in service worker
self.addEventListener("push", (event) => {
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon,
      badge: data.badge,
      tag: data.tag,
      data: data.data,
    }),
  );
});

// Handle notification clicks
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
```

### 4. Install Prompt

```typescript
// Client-side install prompt
let deferredPrompt: any;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  // Show custom install button
  document.getElementById("install-button")?.classList.remove("hidden");
});

async function installApp() {
  if (!deferredPrompt) return;

  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;

  if (outcome === "accepted") {
    console.log("PWA installed");
  }

  deferredPrompt = null;
  document.getElementById("install-button")?.classList.add("hidden");
}
```

## 🍎 iOS-Specific Limitations & Workarounds

### Major Limitations

#### 1. **Push Notifications** ✅ (iOS 16.4+)

- **Good News**: iOS 16.4+ (March 2023) added full Web Push support!
- **Requirements**:
  - User must have iOS 16.4 or later
  - PWA must be installed to home screen (doesn't work in Safari browser)
  - Uses standard VAPID keys like other platforms
- **Workaround for older iOS**:
  - Detect iOS version
  - Show in-app notifications only for iOS < 16.4
  - Encourage users to update or install PWA

#### 2. **Limited Service Worker Support** ⚠️

- **Issue**: Service workers work but with restrictions
- **Impact**:
  - Updates only happen when app is opened
  - Background sync not supported
  - Limited cache storage
- **Workaround**:
  - Keep service worker simple (just for updates)
  - Use network-first strategy

#### 3. **No Install Prompt** ❌

- **Issue**: iOS doesn't fire `beforeinstallprompt` event
- **Impact**: Can't show custom install button/banner
- **Workaround**:
  - Show instructions: "Tap Share → Add to Home Screen"
  - Detect iOS and show platform-specific instructions
  - Only show once using localStorage

```typescript
function shouldShowIOSInstallPrompt(): boolean {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = (window.navigator as any).standalone;
  const hasSeenPrompt = localStorage.getItem("ios-install-prompt-seen");

  return isIOS && !isStandalone && !hasSeenPrompt;
}

function showIOSInstallInstructions() {
  // Show modal with instructions:
  // "To install Anima:
  //  1. Tap the Share button (square with arrow)
  //  2. Scroll down and tap 'Add to Home Screen'
  //  3. Tap 'Add'"

  localStorage.setItem("ios-install-prompt-seen", "true");
}
```

#### 4. **Storage Limits** ⚠️

- **Issue**: iOS has aggressive storage eviction
- **Impact**: Cache may be cleared when storage is low
- **Workaround**:
  - Keep cache minimal (just shell, no data)
  - Use SessionStorage for temporary data
  - Request persistent storage (doesn't guarantee anything on iOS)

#### 5. **No Home Screen Shortcuts** ❌

- **Issue**: iOS ignores the `shortcuts` field in manifest
- **Impact**: Can't add quick actions to home screen icon
- **Workaround**: None - feature simply not available

#### 6. **Limited Splash Screen Control** ⚠️

- **Issue**: iOS uses its own splash screen generation
- **Impact**: Can't fully customize splash screen
- **Workaround**:
  - Provide `apple-touch-startup-image` meta tags
  - Must provide images for every iOS device size

```html
<!-- iOS splash screens - need one for each device -->
<link
  rel="apple-touch-startup-image"
  href="/splash/iphone5.png"
  media="(device-width: 320px) and (device-height: 568px)"
/>
<link
  rel="apple-touch-startup-image"
  href="/splash/iphone6.png"
  media="(device-width: 375px) and (device-height: 667px)"
/>
<!-- ...many more for different devices... -->
```

#### 7. **No Badging API** ❌

- **Issue**: Can't show unread count badge on app icon
- **Impact**: User won't see notification count without opening app
- **Workaround**: None on iOS

### What DOES Work on iOS ✅

- Full-screen mode (no Safari UI)
- Home screen icon
- Standalone app behavior
- Basic service worker (for updates)
- App manifest (mostly)
- Theme color
- Custom app name

## 📋 Implementation Phases

### Phase 1: Basic PWA Setup ✨

**Goal:** Make it installable, get rid of browser chrome

1. Create `manifest.json` with all required fields
2. Generate app icons in all required sizes (72px - 512px)
3. Add manifest link to HTML: `<link rel="manifest" href="/manifest.json">`
4. Add iOS meta tags:
   ```html
   <meta name="apple-mobile-web-app-capable" content="yes" />
   <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
   <meta name="apple-mobile-web-app-title" content="Anima" />
   <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
   ```
5. Create basic service worker (just shell caching)
6. Register service worker in app initialization
7. Test on Chrome (Android/Desktop) and Safari (iOS)

**Success Criteria:**

- ✅ App can be installed on home screen
- ✅ Opens in standalone mode (no browser UI)
- ✅ Shows custom icon and name
- ✅ Works on iOS and Android

### Phase 2: Auto-Updates 🔄

**Goal:** Seamless updates without manual refresh

1. Implement update detection in service worker
2. Add update notification UI component
3. Handle service worker lifecycle events
4. Implement skip-waiting for immediate updates
5. Show "New version available" banner
6. Auto-reload after update installed

**Implementation:**

```typescript
// In app
navigator.serviceWorker.register("/service-worker.js");

// Listen for updates
navigator.serviceWorker.addEventListener("controllerchange", () => {
  window.location.reload();
});

// Check for updates periodically
setInterval(
  () => {
    navigator.serviceWorker.getRegistration().then((reg) => {
      reg?.update();
    });
  },
  60 * 60 * 1000,
); // Check every hour

// Show update available UI
navigator.serviceWorker.addEventListener("message", (event) => {
  if (event.data.type === "UPDATE_AVAILABLE") {
    showUpdateBanner();
  }
});
```

**Success Criteria:**

- ✅ App updates automatically when new version deployed
- ✅ User sees notification when update is ready
- ✅ Update applies smoothly without data loss

### Phase 3: Push Notifications (All Platforms including iOS!) 🔔

**Goal:** Real-time notifications for new messages

**Note:** iOS 16.4+ (March 2023) added full Web Push support with VAPID! Works on all platforms.

1. Generate VAPID keys for Web Push
2. Create **Push Notification Extension** (`extensions/push/`)
3. Store subscriptions in gateway database
4. Implement notification sending via extension events
5. Create notification permission request UI
6. Handle notification clicks (open app to chat)
7. Add notification preferences (enable/disable, sound, etc.)

**Architecture:** Extension-based (WebSocket), not REST APIs

**Push Extension Structure:**

```
extensions/push/
├── src/
│   ├── index.ts           # Extension entry point
│   ├── database.ts        # Push subscription DB operations
│   └── sender.ts          # Web Push sending logic
└── package.json
```

**Extension Configuration:**

```json
{
  "push": {
    "enabled": true,
    "config": {
      "vapidPublicKey": "${ANIMA_PUSH_PUBLIC_KEY}",
      "vapidPrivateKey": "${ANIMA_PUSH_PRIVATE_KEY}",
      "vapidSubject": "mailto:anima@iamclaudia.ai"
    }
  }
}
```

**Extension Methods:**

```typescript
// push.subscribe - Save push subscription
{
  name: "push.subscribe",
  inputSchema: z.object({
    endpoint: z.string(),
    p256dh: z.string(),
    auth: z.string(),
    userAgent: z.string().optional(),
  })
}

// push.unsubscribe - Remove push subscription
{
  name: "push.unsubscribe",
  inputSchema: z.object({
    endpoint: z.string(),
  })
}

// push.send - Send push notification (internal)
{
  name: "push.send",
  inputSchema: z.object({
    title: z.string(),
    body: z.string(),
    url: z.string().optional(),
    icon: z.string().optional(),
    tag: z.string().optional(),
  })
}

// push.get_subscriptions - Get all active subscriptions
{
  name: "push.get_subscriptions",
  inputSchema: z.object({})
}
```

**Extension Events:**

```typescript
// Emitted when new subscription created
ctx.emit("push.subscribed", {
  endpoint: "...",
  userAgent: "...",
  timestamp: "...",
});

// Emitted when subscription removed
ctx.emit("push.unsubscribed", {
  endpoint: "...",
  timestamp: "...",
});

// Emitted when notification sent successfully
ctx.emit("push.sent", {
  endpoint: "...",
  title: "...",
  timestamp: "...",
});

// Emitted when notification fails
ctx.emit("push.failed", {
  endpoint: "...",
  error: "...",
  timestamp: "...",
});
```

**Database Schema:**

```sql
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_used TEXT NOT NULL
);

CREATE INDEX idx_push_subscriptions_endpoint ON push_subscriptions(endpoint);
```

**Extension Implementation:**

```typescript
// extensions/push/src/index.ts
import webpush from "web-push";
import { Database } from "bun:sqlite";
import type { ClaudiaExtension, ExtensionContext } from "@anima/shared";

export function createPushExtension(config: Record<string, unknown> = {}): ClaudiaExtension {
  let ctx: ExtensionContext;
  let db: Database;

  // Configure VAPID
  webpush.setVapidDetails(
    config.vapidSubject as string,
    config.vapidPublicKey as string,
    config.vapidPrivateKey as string,
  );

  const methods = [
    {
      name: "push.subscribe",
      description: "Subscribe to push notifications",
      inputSchema: z.object({
        endpoint: z.string(),
        p256dh: z.string(),
        auth: z.string(),
        userAgent: z.string().optional(),
      }),
    },
    {
      name: "push.unsubscribe",
      description: "Unsubscribe from push notifications",
      inputSchema: z.object({
        endpoint: z.string(),
      }),
    },
    {
      name: "push.send",
      description: "Send push notification to all subscriptions",
      inputSchema: z.object({
        title: z.string(),
        body: z.string(),
        url: z.string().optional(),
        icon: z.string().optional(),
        tag: z.string().optional(),
      }),
    },
    {
      name: "push.get_subscriptions",
      description: "Get all active push subscriptions",
      inputSchema: z.object({}),
    },
  ];

  async function handleMethod(method: string, params: Record<string, unknown>) {
    switch (method) {
      case "push.subscribe":
        return handleSubscribe(params);
      case "push.unsubscribe":
        return handleUnsubscribe(params);
      case "push.send":
        return handleSend(params);
      case "push.get_subscriptions":
        return handleGetSubscriptions();
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  async function handleSubscribe(params: Record<string, unknown>) {
    const { endpoint, p256dh, auth, userAgent } = params;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `
      INSERT OR REPLACE INTO push_subscriptions (id, endpoint, p256dh, auth, user_agent, created_at, last_used)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(id, endpoint, p256dh, auth, userAgent || null, now, now);

    ctx.emit("push.subscribed", { endpoint, userAgent, timestamp: now });
    ctx.log.info("Push subscription created", { endpoint });

    return { ok: true, id };
  }

  async function handleUnsubscribe(params: Record<string, unknown>) {
    const { endpoint } = params;

    db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);

    ctx.emit("push.unsubscribed", { endpoint, timestamp: new Date().toISOString() });
    ctx.log.info("Push subscription removed", { endpoint });

    return { ok: true };
  }

  async function handleSend(params: Record<string, unknown>) {
    const { title, body, url, icon, tag } = params;
    const subscriptions = db.prepare("SELECT * FROM push_subscriptions").all();

    const payload = JSON.stringify({
      title,
      body,
      icon: icon || "/icons/icon-192x192.png",
      data: { url: url || "/chat" },
      tag: tag || "anima-message",
    });

    const results = await Promise.allSettled(
      subscriptions.map(async (sub: any) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: {
                p256dh: sub.p256dh,
                auth: sub.auth,
              },
            },
            payload,
          );

          // Update last_used
          db.prepare("UPDATE push_subscriptions SET last_used = ? WHERE id = ?").run(
            new Date().toISOString(),
            sub.id,
          );

          ctx.emit("push.sent", {
            endpoint: sub.endpoint,
            title,
            timestamp: new Date().toISOString(),
          });
          return { ok: true, endpoint: sub.endpoint };
        } catch (error: any) {
          // Handle expired/invalid subscriptions
          if (error.statusCode === 410 || error.statusCode === 404) {
            db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(sub.id);
            ctx.log.info("Removed expired push subscription", { endpoint: sub.endpoint });
          }

          ctx.emit("push.failed", {
            endpoint: sub.endpoint,
            error: error.message,
            timestamp: new Date().toISOString(),
          });
          return { ok: false, endpoint: sub.endpoint, error: error.message };
        }
      }),
    );

    const successful = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;
    const failed = results.length - successful;

    ctx.log.info("Push notifications sent", { total: results.length, successful, failed });

    return { ok: true, sent: successful, failed };
  }

  async function handleGetSubscriptions() {
    const subscriptions = db.prepare("SELECT * FROM push_subscriptions").all();
    return { subscriptions, count: subscriptions.length };
  }

  return {
    id: "push",
    name: "Push Notifications",
    methods,
    events: ["push.subscribed", "push.unsubscribed", "push.sent", "push.failed"],

    async start(context: ExtensionContext): Promise<void> {
      ctx = context;
      db = getDb(); // Your existing getDb() helper

      // Run migrations (creates tables, indexes, etc.)
      const migrationsDir = join(__dirname, "../migrations");
      await runMigrations(db, "push", migrationsDir);

      ctx.log.info("Push notification extension started");
    },

    async stop(): Promise<void> {
      ctx.log.info("Push notification extension stopped");
    },

    handleMethod,

    health() {
      const count = (db.prepare("SELECT COUNT(*) as count FROM push_subscriptions").get() as any)
        .count;
      return {
        ok: true,
        details: { subscriptions: count },
      };
    },
  };
}

export default createPushExtension;
```

**Push Extension Migration:**

```sql
-- extensions/push/migrations/001-create-subscriptions.sql

-- Up
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_used TEXT NOT NULL
);

CREATE INDEX idx_push_subscriptions_endpoint ON push_subscriptions(endpoint);

-- Down
DROP INDEX idx_push_subscriptions_endpoint;
DROP TABLE push_subscriptions;
```

**Integration with Other Extensions:**

```typescript
// In session extension, when new message arrives:
ctx.call("push.send", {
  title: "New message from Claudia",
  body: message.substring(0, 100),
  url: "/chat",
});
```

**Success Criteria:**

- ✅ Desktop Chrome: Notifications work when app is closed
- ✅ Android Chrome: Notifications work in background
- ✅ **iOS 16.4+ Safari: Notifications work from installed PWA!**
- ✅ Extension methods work via WebSocket
- ✅ Subscriptions stored in gateway database
- ✅ Expired subscriptions auto-removed

### Phase 4: Polish & iOS Optimization 💅

**Goal:** Best possible experience on all platforms

1. Generate iOS splash screens for all device sizes
2. Implement iOS install instructions modal
3. Add platform detection and conditional UI
4. Optimize icons for iOS (rounded corners, safe area)
5. Add theme-color meta tag with dynamic updates
6. Implement in-app notification system for iOS (when app is open)
7. Add PWA analytics (install rate, usage patterns)
8. Create app screenshots for install prompt

**iOS Install Instructions Component:**

```typescript
function IOSInstallPrompt() {
  if (!shouldShowIOSInstallPrompt()) return null;

  return (
    <div className="ios-install-prompt">
      <h3>Install Anima</h3>
      <p>Add Anima to your home screen for the best experience:</p>
      <ol>
        <li>Tap the <ShareIcon /> Share button</li>
        <li>Scroll down and tap "Add to Home Screen"</li>
        <li>Tap "Add"</li>
      </ol>
      <button onClick={() => {
        localStorage.setItem('ios-install-prompt-seen', 'true');
        setShowPrompt(false);
      }}>
        Got it
      </button>
    </div>
  );
}
```

**Success Criteria:**

- ✅ iOS users see helpful install instructions
- ✅ Splash screens look good on all iOS devices
- ✅ In-app notifications work as fallback on iOS
- ✅ App feels native on all platforms

### Phase 5: Advanced Features (Optional) 🚀

**Goal:** Additional PWA capabilities where supported

1. **Share Target API** - Share content to Anima from other apps
2. **File Handling API** - Open files with Anima
3. **Protocol Handlers** - Handle `anima://` URLs
4. **Badge API** - Show unread count (Android only)
5. **Shortcuts API** - App shortcuts in launcher
6. **Window Controls Overlay** - Custom title bar on desktop

## 🛠️ Technical Requirements

### Dependencies

```json
{
  "dependencies": {
    "web-push": "^3.6.7", // Server-side push notifications
    "workbox-webpack-plugin": "^7.0.0" // Service worker generation (optional)
  }
}
```

### Files to Create/Modify

**New Files (Gateway):**

- `packages/gateway/public/manifest.json` - App manifest
- `packages/gateway/public/service-worker.js` - Service worker shell (~50 lines)
- `packages/gateway/public/icons/` - App icons directory (72px-512px)
- `packages/gateway/public/splash/` - iOS splash screens
- `packages/shared/src/migrations.ts` - Migration runner utility

**New Files (Push Extension):**

- `extensions/push/` - New extension directory
- `extensions/push/src/index.ts` - Extension entry point
- `extensions/push/src/database.ts` - DB operations
- `extensions/push/src/sender.ts` - Web Push sending logic
- `extensions/push/migrations/001-create-subscriptions.sql` - Database schema
- `extensions/push/package.json` - Extension package config

**New Files (Chat Extension):**

- `extensions/chat/src/components/push-settings.tsx` - Notification settings UI
- `extensions/chat/src/components/install-prompt.tsx` - PWA install prompt
- `extensions/chat/src/hooks/usePushNotifications.ts` - Push notification hook

**Modified Files:**

- `packages/gateway/src/index.html` - Add manifest link, meta tags, iOS tags
- `extensions/chat/src/main.tsx` - Register service worker, install prompt
- `~/.anima/anima.json` - Add push extension config with VAPID keys

### Environment Variables

```bash
# VAPID keys for Web Push (generate with web-push generate-vapid-keys)
ANIMA_PUSH_PUBLIC_KEY=BL...
ANIMA_PUSH_PRIVATE_KEY=k...
ANIMA_PUSH_CONTACT=mailto:anima@iamclaudia.ai
```

## 📊 Testing Checklist

### Desktop (Chrome/Edge)

- [ ] Install from browser prompt
- [ ] Opens in standalone window
- [ ] Updates automatically
- [ ] Push notifications work
- [ ] Notifications work when closed
- [ ] Icon appears in app launcher

### Desktop (Safari - macOS)

- [ ] Install from File menu
- [ ] Opens in standalone window
- [ ] Updates work (may require manual check)
- [ ] No push notifications (expected)

### Android (Chrome)

- [ ] Install from banner
- [ ] Full-screen mode
- [ ] Push notifications work
- [ ] Notifications work in background
- [ ] Badge shows unread count
- [ ] App shortcuts work

### iOS (Safari)

- [ ] Manual install via Share → Add to Home Screen
- [ ] Full-screen mode (no Safari UI)
- [ ] Custom icon and splash screen
- [ ] Opens without browser chrome
- [ ] No push notifications (expected limitation)
- [ ] Install instructions modal shows once
- [ ] In-app notifications work when app is open

## 🎨 Design Assets Needed

1. **App Icons** (square, transparent background or solid):
   - 72x72, 96x96, 128x128, 144x144, 152x152, 192x192, 384x384, 512x512

2. **iOS-specific**:
   - Apple Touch Icon: 180x180
   - iOS Splash Screens: Multiple sizes for different devices

3. **Notification Icons**:
   - Badge icon: 72x72 (monochrome)
   - Notification icon: 192x192

4. **Screenshots** (for install prompt):
   - Desktop: 1280x720
   - Mobile: 750x1334

## 📈 Success Metrics

- **Install Rate**: % of users who install the PWA
- **Retention**: Daily active users of installed app vs web
- **Notification Engagement**: Click-through rate on notifications
- **Update Success Rate**: % of users on latest version
- **Platform Distribution**: iOS vs Android vs Desktop usage

## 🚧 Known Limitations Summary

| Feature            | Chrome (Desktop) | Chrome (Android) | Safari (macOS) | Safari (iOS 16.4+) |
| ------------------ | ---------------- | ---------------- | -------------- | ------------------ |
| Install Prompt     | ✅               | ✅               | ⚠️ Manual      | ❌ Manual only     |
| Push Notifications | ✅               | ✅               | ✅             | ✅ (PWA only)      |
| Background Sync    | ✅               | ✅               | ❌             | ❌                 |
| Badge API          | ⚠️ Experimental  | ✅               | ❌             | ❌                 |
| App Shortcuts      | ✅               | ✅               | ❌             | ❌                 |
| File Handling      | ✅               | ⚠️ Limited       | ❌             | ❌                 |
| Service Worker     | ✅               | ✅               | ✅             | ⚠️ Limited         |
| Standalone Mode    | ✅               | ✅               | ✅             | ✅                 |
| Auto-Updates       | ✅               | ✅               | ✅             | ✅                 |

## 💡 Recommendations

### Minimum Viable PWA (Phase 1 + 2)

Start with installability and auto-updates. This gives 80% of the benefit:

- Clean, chrome-free interface
- Seamless updates
- Works on all platforms (including iOS)

### Consider iOS Limitations

Since iOS is a primary target, design around its limitations:

- Don't rely on push notifications for critical features
- Implement robust in-app notification system
- Make sure core functionality works without PWA features

### Progressive Enhancement

Build features in layers:

1. Core app works in any browser
2. Enhanced with PWA features where supported
3. Graceful degradation on iOS

### Native Wrapper as Fallback

If iOS limitations are too restrictive, consider:

- **Capacitor** - Wrap PWA in native container
- Gets real push notifications, badge, better integration
- Still 95% web code, just native shell
- Can ship to App Store

### Native Desktop Wrapper (Always-on-Top + More)

PWAs lack native window management (always-on-top, system tray, global shortcuts).
Consider a lightweight native wrapper for the desktop experience:

- **Tauri** (Recommended) - Rust-based, tiny binary (~5MB), uses system WebView
  - Always-on-top window support (`set_always_on_top(true)`)
  - System tray integration
  - Global keyboard shortcuts
  - Custom title bar
  - Auto-updater built-in
  - Same web UI, just a native shell
- **Electron** - Heavier (~100MB+) but more mature ecosystem
- **Neutralinojs** - Lightweight alternative, simpler API

**Tauri would complement the PWA** — PWA for mobile/casual desktop, Tauri for
power-user desktop experience with always-on-top, tray icon, and global hotkeys.

## 🎯 Next Steps

1. ~~**Design app icons** - Need Anima logo/branding~~ ✅ Placeholder icons generated
2. **Generate VAPID keys** - For push notifications
3. ~~**Implement Phase 1** - Make it installable~~ ✅ Complete
4. **Finish Phase 2** - "New version available" banner UI
5. **Test on iOS** - Validate limitations are acceptable
6. **Decide on notification strategy** - Critical for iOS?
7. **Evaluate Tauri wrapper** - For always-on-top desktop experience

---

**Timeline Estimate:**

- Phase 1 (Basic PWA): ~~1-2 days~~ ✅ Done
- Phase 2 (Auto-updates): 1 day (80% done, needs update banner UI)
- Phase 3 (Notifications): 2-3 days
- Phase 4 (Polish): 1-2 days
- Tauri Wrapper (optional): 1-2 days

**Total:** ~1 week for full PWA + optional Tauri wrapper

💝 _Created for Michael by Claudia_ 🥰
