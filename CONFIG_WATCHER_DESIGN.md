# Gateway Config Watcher Design

## Problem

Currently the gateway only reads `anima.json` at startup. Changes require manual gateway restart.

## Solution: Dynamic Extension Management

### 1. File Watching

```typescript
import { watch } from "node:fs";
import { clearConfigCache, getEnabledExtensions } from "@anima/shared";

// Watch ~/.anima/anima.json for changes
const configPath = join(homedir(), ".anima", "anima.json");
watch(configPath, { persistent: true }, (eventType) => {
  if (eventType === "change") {
    handleConfigChange();
  }
});
```

### 2. Config Diffing Logic

```typescript
// Track currently running extensions
const runningExtensions = new Map<string, ExtensionHostProcess>();

async function handleConfigChange(): Promise<void> {
  // Clear cache to force fresh config read
  clearConfigCache();

  // Get new enabled extensions
  const newEnabledExtensions = getEnabledExtensions();
  const newEnabledIds = new Set(newEnabledExtensions.map(([id]) => id));
  const currentRunningIds = new Set(runningExtensions.keys());

  // Find extensions to start (newly enabled)
  const toStart = newEnabledExtensions.filter(([id]) => !currentRunningIds.has(id));

  // Find extensions to stop (newly disabled)
  const toStop = Array.from(currentRunningIds).filter((id) => !newEnabledIds.has(id));

  // Find extensions to restart (config changed)
  const toRestart = newEnabledExtensions.filter(([id, config]) => {
    const running = runningExtensions.get(id);
    return running && hasConfigChanged(running, config);
  });

  // Execute changes
  await Promise.all([
    ...toStop.map(stopExtension),
    ...toStart.map(([id, config]) => startExtension(id, config)),
    ...toRestart.map(([id, config]) => restartExtension(id, config)),
  ]);
}
```

### 3. Dynamic Extension Management

```typescript
async function startExtension(id: string, config: ExtensionConfig): Promise<void> {
  if (runningExtensions.has(id)) return; // Already running

  const moduleSpec = resolveExtensionEntrypoint(id);
  if (!moduleSpec) {
    log.warn("Extension not found", { id });
    return;
  }

  log.info("Starting extension", { id });
  const host = new ExtensionHostProcess(id, moduleSpec, config.config, ...);

  try {
    const registration = await host.spawn();
    runningExtensions.set(id, host);
    extensions.registerRemote(registration, host);
    log.info("Extension started", { id });
  } catch (error) {
    log.error("Failed to start extension", { id, error });
  }
}

async function stopExtension(id: string): Promise<void> {
  const host = runningExtensions.get(id);
  if (!host) return; // Not running

  log.info("Stopping extension", { id });
  await host.kill();
  runningExtensions.delete(id);
  extensions.unregisterExtension(id); // Need to implement this
  log.info("Extension stopped", { id });
}

async function restartExtension(id: string, config: ExtensionConfig): Promise<void> {
  const host = runningExtensions.get(id);
  if (!host) return;

  log.info("Restarting extension", { id });
  try {
    const registration = await host.restart();
    // Update config in running host
    log.info("Extension restarted", { id });
  } catch (error) {
    log.error("Failed to restart extension", { id, error });
  }
}
```

### 4. Integration Points

#### In `packages/gateway/src/start.ts`:

```typescript
// Replace the static loadExtensions() call with:
await loadExtensionsWithWatcher();

async function loadExtensionsWithWatcher(): Promise<void> {
  // Initial load
  await loadExtensions();

  // Start watching for config changes
  startConfigWatcher();
}
```

#### Need to add to extension registry:

```typescript
// In packages/gateway/src/index.ts
class Extensions {
  // ... existing methods

  unregisterExtension(id: string): void {
    // Remove from remoteExtensions map
    // Clean up method registrations
    // Remove event listeners
  }
}
```

## Benefits

1. **No more manual restarts** - Extensions auto-start/stop on config changes
2. **Selective updates** - Only affected extensions restart, not the whole gateway
3. **Real-time config** - Changes take effect immediately
4. **Better DX** - Seamless workflow for enabling/disabling extensions

## Implementation Steps

1. Add file watcher to `start.ts`
2. Implement config diffing logic
3. Add `unregisterExtension()` method to Extensions class
4. Add extension lifecycle management functions
5. Replace static `loadExtensions()` with dynamic version
6. Add logging and error handling
7. Test with enable/disable scenarios

## Edge Cases to Handle

- Config file temporarily invalid (syntax errors)
- Extension crashes during start/stop
- Multiple rapid config changes (debouncing)
- Extension startup failures don't break watcher
- Graceful degradation if file watcher fails
