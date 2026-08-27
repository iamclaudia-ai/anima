/**
 * DOMINATRIX Background Service Worker
 *
 * Connects to Claudia gateway WebSocket and bridges browser automation
 * commands between the gateway extension and content scripts.
 *
 * Protocol: Uses Claudia's standard WS message format.
 *   Gateway → Extension: { type: "event", event: "dominatrix.command", payload: {...} }
 *   Extension → Gateway: { type: "req", method: "dominatrix.response", params: {...} }
 */

interface ConsoleLog {
  id: string;
  type: "log" | "info" | "warn" | "error" | "debug";
  message: string;
  args?: unknown[];
  timestamp: number;
  url?: string;
}

interface NetworkRequest {
  id: string;
  url: string;
  method: string;
  type: string;
  timestamp: number;
  status?: number;
  statusText?: string;
  requestBody?: unknown;
  responseHeaders?: Record<string, string>;
}

/**
 * How a command names its tab: a real ID, "new" to open one, "active" to force
 * the focused tab, or nothing at all to fall back to the default.
 */
type TabSelector = number | "new" | "active" | undefined;

interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
  windowId: number;
  profileId?: string;
  profileName?: string;
}

// ============================================================================
// Gateway connection config
// ============================================================================

const GATEWAY_URL = "ws://localhost:30086/ws";
const RECONNECT_DELAY = 3000;
const TOKEN_STORAGE_KEY = "gatewayToken";

// ============================================================================
// Background worker
// ============================================================================

/**
 * Unwrap the content script's `{ success, data }` reply.
 *
 * That envelope is internal to the Chrome side, but it used to travel all the
 * way to the caller, with two consequences. Commands handled by the content
 * script (`get_text`, `click`, `find_*`, …) returned `{success:true,data:…}`
 * while browser-level ones (`screenshot`, `new_tab`, `list_tabs`) returned
 * their value directly — so callers had to know which family a command
 * belonged to before they could read the result.
 *
 * Worse, a failure inside the content script rode home as `{success:false}`
 * *inside a successful* transport response, so a click or fill that found
 * nothing resolved rather than rejecting, and the CLI exited 0. A failed
 * `find_role --perform click` reported success to the shell.
 *
 * Unwrapping here means every command returns its payload directly and every
 * failure is a real rejection, carried by the transport's own error channel.
 */
function unwrapContentScriptReply(reply: unknown): unknown {
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) return reply;

  const envelope = reply as { success?: unknown; data?: unknown; error?: unknown };
  if (typeof envelope.success !== "boolean") return reply;
  if (!("data" in envelope) && !("error" in envelope)) return reply;

  if (envelope.success) return envelope.data;
  throw new Error(typeof envelope.error === "string" ? envelope.error : "Command failed");
}

class DominatrixBackground {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private consoleLogs = new Map<number, ConsoleLog[]>();
  private networkRequests = new Map<number, NetworkRequest[]>();
  private instanceId: string = ""; // Set in init() from storage
  private extensionId: string;
  private contextTabId: number | null = null; // Tab the side panel is scoped to

  constructor() {
    this.extensionId = chrome.runtime.id;
    this.init();
  }

  private async init() {
    console.log("[DOMINATRIX] Background worker initializing...");

    // Persist instanceId across service worker restarts — prevents client leak
    const stored = await chrome.storage.local.get("instanceId");
    this.instanceId = (stored.instanceId as string) || crypto.randomUUID();
    await chrome.storage.local.set({ instanceId: this.instanceId });
    console.log("[DOMINATRIX] Instance ID:", this.instanceId);

    this.connect();

    // Open side panel when extension icon is clicked
    chrome.action.onClicked.addListener((tab) => {
      if (tab.id) {
        chrome.sidePanel.open({ tabId: tab.id });
      }
    });

    // Focus tracking — report focus so the gateway knows which profile the user is
    // looking at. Commands are addressed by instance ID now, so focus only breaks
    // ties for read commands that named neither a profile nor a tab.
    chrome.windows.onFocusChanged.addListener((windowId) => {
      if (windowId === chrome.windows.WINDOW_ID_NONE) return;
      if (this.ws?.readyState === WebSocket.OPEN) {
        void this.registerClient({ focused: true });
      }
    });

    // The gateway/server extension can restart while this WebSocket stays open.
    // Periodic registration lets the server-side client registry heal itself.
    setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) void this.registerClient();
    }, 30_000);

    // Tab event listeners
    chrome.tabs.onCreated.addListener(this.onTabCreated.bind(this));
    chrome.tabs.onUpdated.addListener(this.onTabUpdated.bind(this));
    chrome.tabs.onRemoved.addListener(this.onTabRemoved.bind(this));

    // Content script messages
    chrome.runtime.onMessage.addListener(this.onContentScriptMessage.bind(this));

    // Network monitoring
    chrome.webRequest.onBeforeRequest.addListener(
      this.onNetworkRequest.bind(this),
      { urls: ["<all_urls>"] },
      ["requestBody"],
    );
    chrome.webRequest.onCompleted.addListener(
      this.onNetworkComplete.bind(this),
      { urls: ["<all_urls>"] },
      ["responseHeaders"],
    );
  }

  // --------------------------------------------------------------------------
  // Resilient content script communication
  // --------------------------------------------------------------------------

  /**
   * Send message to content script with automatic injection fallback.
   * If the content script hasn't loaded yet (e.g., manual navigation, page reload),
   * inject it on demand via chrome.scripting.executeScript().
   */
  private async sendToContentScript(
    tabId: number,
    message: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (_err) {
      // Content script not loaded — inject it on demand
      console.log("[DOMINATRIX] Content script not ready, injecting on demand for tab:", tabId);
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content-script.js"],
      });
      // Brief delay for script initialization
      await new Promise((resolve) => setTimeout(resolve, 100));
      return await chrome.tabs.sendMessage(tabId, message);
    }
  }

  // --------------------------------------------------------------------------
  // WebSocket connection to gateway
  // --------------------------------------------------------------------------

  private async connect() {
    try {
      const gatewayUrl = await this.buildGatewayUrl();
      console.log("[DOMINATRIX] Connecting to gateway...", {
        authenticated: gatewayUrl.includes("token="),
      });
      this.ws = new WebSocket(gatewayUrl);

      this.ws.onopen = async () => {
        console.log("[DOMINATRIX] Connected to gateway");
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }

        // Subscribe non-exclusively: every profile's client sees every command and
        // drops the ones addressed to a different instance. Subscribing exclusively
        // would hand all commands to whichever profile connected last.
        this.sendRequest("gateway.subscribe", {
          events: ["dominatrix.command"],
        });

        await this.registerClient({ focused: true });
      };

      this.ws.onmessage = (event) => {
        console.log("[DOMINATRIX] WS message received:", (event.data as string).substring(0, 200));
        this.handleGatewayMessage(event.data as string);
      };

      this.ws.onerror = (error) => {
        console.error("[DOMINATRIX] WebSocket error:", error);
      };

      this.ws.onclose = (event) => {
        console.log("[DOMINATRIX] Disconnected from gateway, reconnecting...", {
          code: event.code,
          reason: event.reason,
        });
        this.ws = null;
        this.scheduleReconnect();
      };
    } catch (error) {
      console.error("[DOMINATRIX] Failed to connect:", error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, RECONNECT_DELAY) as unknown as number;
    }
  }

  private async buildGatewayUrl(): Promise<string> {
    const stored = await chrome.storage.local.get(TOKEN_STORAGE_KEY);
    const token = typeof stored[TOKEN_STORAGE_KEY] === "string" ? stored[TOKEN_STORAGE_KEY] : "";
    if (!token) return GATEWAY_URL;

    const separator = GATEWAY_URL.includes("?") ? "&" : "?";
    return `${GATEWAY_URL}${separator}token=${encodeURIComponent(token)}`;
  }

  private sendRequest(method: string, params: Record<string, unknown>) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn("[DOMINATRIX] Cannot send: WebSocket not connected");
      return;
    }
    this.ws.send(
      JSON.stringify({
        type: "req",
        id: crypto.randomUUID(),
        method,
        params,
      }),
    );
  }

  private async registerClient(opts: { focused?: boolean } = {}) {
    const profileName = await this.getProfileName();
    this.sendRequest("dominatrix.register", {
      extensionId: this.extensionId,
      instanceId: this.instanceId,
      profileName,
      focused: opts.focused === true,
    });
  }

  private async getProfileName(): Promise<string | undefined> {
    try {
      const profileInfo = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" as any });
      if (profileInfo?.email) return profileInfo.email;
    } catch {
      // chrome.identity might not be available
    }
    return undefined;
  }

  // --------------------------------------------------------------------------
  // Handle incoming messages from gateway
  // --------------------------------------------------------------------------

  private async handleGatewayMessage(data: string) {
    try {
      const message = JSON.parse(data);

      // Respond to gateway pings immediately
      if (message.type === "ping") {
        this.ws?.send(JSON.stringify({ type: "pong", id: message.id }));
        return;
      }

      console.log(
        "[DOMINATRIX] Parsed message:",
        message.type,
        message.event || message.method || "",
      );

      // We only care about command events
      if (message.type === "event" && message.event === "dominatrix.command") {
        const {
          requestId,
          action,
          params = {},
          targetInstanceId,
        } = message.payload as Record<string, unknown>;

        // Commands are addressed to one profile. Everyone else stays quiet —
        // responding here would race the intended profile for the same requestId.
        if (targetInstanceId && targetInstanceId !== this.instanceId) {
          console.log("[DOMINATRIX] Command not addressed to this profile, ignoring:", action);
          return;
        }

        console.log(
          "[DOMINATRIX] Command received:",
          action,
          "requestId:",
          requestId,
          "params:",
          JSON.stringify(params),
        );

        try {
          const result = await this.executeCommand(
            action as string,
            (params || {}) as Record<string, unknown>,
          );
          console.log(
            "[DOMINATRIX] Command success:",
            action,
            "sending response for requestId:",
            requestId,
          );
          this.sendRequest("dominatrix.response", {
            requestId,
            success: true,
            data: result,
          });
        } catch (error) {
          console.error("[DOMINATRIX] Command failed:", action, error);
          this.sendRequest("dominatrix.response", {
            requestId,
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      } else {
        console.log("[DOMINATRIX] Ignoring message type:", message.type, message.event || "");
      }
    } catch (error) {
      console.error("[DOMINATRIX] Error handling gateway message:", error);
    }
  }

  // --------------------------------------------------------------------------
  // Command execution
  // --------------------------------------------------------------------------

  private async executeCommand(action: string, params: Record<string, unknown>): Promise<unknown> {
    const tabId = params.tabId as TabSelector;

    switch (action) {
      // --- Content script commands: pass action + params straight through ---
      case "snapshot":
      case "get_text":
      case "get_markdown":
      case "get_url":
      case "get_title":
      case "get_html":
      case "get_source":
      case "click":
      case "fill":
      case "check":
      case "uncheck":
      case "select":
      case "find_text":
      case "find_label":
      case "find_role":
      case "find_placeholder":
      case "scroll_down":
      case "scroll_up":
      case "scroll_to":
      case "wait_for_element":
      case "wait_for_text":
      case "wait":
      case "executeScript":
      case "evaluateExpression":
      case "get_storage":
        return this.delegateToContentScript(tabId, { ...params, action });

      // --- Browser-level commands (no content script needed) ---
      case "screenshot":
        return this.takeScreenshot(tabId);
      case "navigate":
        return this.navigate(tabId, params.url as string);
      case "new_tab":
        return this.newTab(params.url as string | undefined, params.background === true);
      case "use_tab":
        return this.useTab(params.tabId, params.focus !== false);
      case "close_tab":
        return this.closeTab(tabId);
      case "get_tabs":
        return this.getTabs((params.tabIds as number[]) || []);
      case "get_console":
        return this.getConsoleLogs(tabId);
      case "get_network":
        return this.listNetworkRequests(tabId);
      case "get_cookies":
        return this.getCookies(tabId);
      case "list_tabs":
        return this.listTabs();
      case "get_active_tab":
        return this.getActiveTab();
      case "wait_for_url":
        return this.waitForUrl(
          tabId,
          params.pattern as string,
          params.timeout as number | undefined,
        );

      default:
        throw new Error(`Unknown command: ${action}`);
    }
  }

  /**
   * Delegate a command to the content script via the resilient dispatcher.
   */
  private async delegateToContentScript(
    tabId: TabSelector,
    message: Record<string, unknown>,
  ): Promise<unknown> {
    const id = await this.resolveTabId(tabId);
    // Strip the selector so the content script never sees "new"/"active".
    const reply = await this.sendToContentScript(id, { ...message, tabId: id });
    return unwrapContentScriptReply(reply);
  }

  // --------------------------------------------------------------------------
  // Tab helpers
  // --------------------------------------------------------------------------

  /**
   * Turn a tab selector into a real tab ID.
   *
   * `"active"` explicitly asks for the focused tab, which is how a caller escapes
   * a stale side-panel context. Bare `undefined` keeps the old precedence: the
   * side panel's tab if there is one, otherwise the active tab.
   */
  private async resolveTabId(tabId: TabSelector): Promise<number> {
    if (typeof tabId === "number") return tabId;
    if (tabId === "new") {
      throw new Error('tabId "new" is only supported by navigate and new_tab');
    }

    if (tabId !== "active" && this.contextTabId) return this.contextTabId;

    const active = await this.getActiveTab();
    if (!active) throw new Error("No active tab");
    return active.id;
  }

  private async toTabInfo(tab: chrome.tabs.Tab): Promise<TabInfo> {
    const profileName = await this.getProfileName();
    return {
      id: tab.id!,
      url: tab.url || "",
      title: tab.title || "",
      active: tab.active,
      windowId: tab.windowId,
      profileId: this.instanceId,
      profileName,
    };
  }

  private async listTabs(): Promise<TabInfo[]> {
    const tabs = await chrome.tabs.query({});
    return Promise.all(tabs.map((tab) => this.toTabInfo(tab)));
  }

  private async getActiveTab(): Promise<TabInfo | null> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) return null;
    return this.toTabInfo(tabs[0]);
  }

  /** Look up specific tabs, skipping any that have since been closed. */
  private async getTabs(tabIds: number[]): Promise<TabInfo[]> {
    const found: TabInfo[] = [];
    for (const id of tabIds) {
      try {
        found.push(await this.toTabInfo(await chrome.tabs.get(id)));
      } catch {
        // Tab was closed — the caller prunes it from its list.
      }
    }
    return found;
  }

  // --------------------------------------------------------------------------
  // Browser-level command implementations (no content script needed)
  // --------------------------------------------------------------------------

  private async takeScreenshot(tabId: TabSelector) {
    const id = await this.resolveTabId(tabId);
    const tab = await chrome.tabs.get(id);
    if (!tab.windowId) throw new Error("Tab has no window");
    await chrome.tabs.update(id, { active: true });
    return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  }

  private async navigate(tabId: TabSelector, url?: string) {
    if (!url) throw new Error("No URL provided");

    if (tabId === "new") return this.newTab(url, false);

    const id = await this.resolveTabId(tabId);
    await chrome.tabs.update(id, { url });
    return { tabId: id, url, created: false };
  }

  /** Open a tab. Returns its ID so the caller can keep working in it. */
  private async newTab(url?: string, background = false) {
    const tab = await chrome.tabs.create({ url, active: !background });
    if (!tab.id) throw new Error("Chrome did not return an ID for the new tab");
    return {
      tabId: tab.id,
      url: url || tab.pendingUrl || "",
      windowId: tab.windowId,
      created: true,
    };
  }

  /** Point the caller back at an existing tab, confirming it is still open. */
  private async useTab(tabId: unknown, focus: boolean) {
    if (typeof tabId !== "number") {
      throw new Error("use_tab needs a numeric --tabId (see session_tabs or list_tabs)");
    }

    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error(`Tab ${tabId} is no longer open. Run session_tabs to see what's left.`);
    }

    if (focus) {
      tab = (await chrome.tabs.update(tabId, { active: true })) ?? tab;
      await chrome.windows.update(tab.windowId, { focused: true });
    }

    // `tabId` alongside TabInfo's `id` is what tells the gateway which tab to bind.
    return { ...(await this.toTabInfo(tab)), tabId: tab.id! };
  }

  /** Close a tab — how a session cleans up the tabs it opened. */
  private async closeTab(tabId: TabSelector) {
    const id = await this.resolveTabId(tabId);

    let url = "";
    try {
      url = (await chrome.tabs.get(id)).url || "";
    } catch {
      throw new Error(`Tab ${id} is not open.`);
    }

    await chrome.tabs.remove(id);
    return { tabId: id, url, closed: true };
  }

  private async getConsoleLogs(tabId: TabSelector): Promise<ConsoleLog[]> {
    const id = await this.resolveTabId(tabId);
    return this.consoleLogs.get(id) || [];
  }

  private async listNetworkRequests(tabId: TabSelector): Promise<NetworkRequest[]> {
    const id = await this.resolveTabId(tabId);
    return this.networkRequests.get(id) || [];
  }

  private async getCookies(tabId: TabSelector) {
    const id = await this.resolveTabId(tabId);
    const tab = await chrome.tabs.get(id);
    if (!tab.url) throw new Error("Tab has no URL");
    return chrome.cookies.getAll({ url: tab.url });
  }

  private async waitForUrl(
    tabId: TabSelector,
    pattern?: string,
    timeout = 10000,
  ): Promise<{ matched: boolean; url: string }> {
    const id = await this.resolveTabId(tabId);
    if (!pattern) throw new Error("URL pattern is required");

    return new Promise((resolve) => {
      const check = async () => {
        const tab = await chrome.tabs.get(id);
        if (tab.url && this.urlMatchesPattern(tab.url, pattern)) {
          resolve({ matched: true, url: tab.url });
          return true;
        }
        return false;
      };

      // Check immediately
      check().then((matched) => {
        if (matched) return;

        // Poll every 200ms
        const interval = setInterval(async () => {
          if (await check()) clearInterval(interval);
        }, 200);

        // Timeout
        setTimeout(() => {
          clearInterval(interval);
          chrome.tabs.get(id).then((tab) => {
            resolve({ matched: false, url: tab.url || "" });
          });
        }, timeout);
      });
    });
  }

  private urlMatchesPattern(url: string, pattern: string): boolean {
    // Simple glob-style matching: ** matches anything
    const regex = new RegExp(
      "^" +
        pattern
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, ".*")
          .replace(/\*/g, "[^/]*") +
        "$",
    );
    return regex.test(url);
  }

  // --------------------------------------------------------------------------
  // Tab event listeners
  // --------------------------------------------------------------------------

  private onTabCreated(_tab: chrome.tabs.Tab) {
    // Tab events could be forwarded to gateway if needed
  }

  private onTabUpdated(
    _tabId: number,
    _changeInfo: chrome.tabs.TabChangeInfo,
    _tab: chrome.tabs.Tab,
  ) {
    // Could emit pageLoad events to gateway
  }

  private onTabRemoved(tabId: number) {
    this.consoleLogs.delete(tabId);
    this.networkRequests.delete(tabId);
    // Tell the gateway, so a session bound to this tab is released. Without
    // this, closing a tab any way other than `close_tab` (cmd-W, crash, window
    // closed) leaves a binding pointing at a dead id and the session's next
    // command fails with "No tab with id".
    this.sendRequest("dominatrix.tab_closed", { instanceId: this.instanceId, tabId });
  }

  // --------------------------------------------------------------------------
  // Content script & network listeners
  // --------------------------------------------------------------------------

  private onContentScriptMessage(
    message: { type: string; data?: ConsoleLog; tabId?: number },
    sender: chrome.runtime.MessageSender,
    _sendResponse: (response: unknown) => void,
  ): boolean {
    // Side panel telling us which tab it's scoped to
    if (message.type === "sidepanel-context" && message.tabId) {
      this.contextTabId = message.tabId;
      console.log("[DOMINATRIX] Context tab set:", this.contextTabId);
      return false;
    }

    if (message.type === "gateway-token-updated") {
      console.log("[DOMINATRIX] Gateway token updated; reconnecting");
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      const current = this.ws;
      this.ws = null;
      if (current) {
        current.onclose = null;
        current.close();
      }
      this.connect();
      return false;
    }

    const tabId = sender.tab?.id;
    if (!tabId) return false;

    if (message.type === "consoleLog" && message.data) {
      const logs = this.consoleLogs.get(tabId) || [];
      logs.push(message.data);
      this.consoleLogs.set(tabId, logs);
    }

    return false;
  }

  private onNetworkRequest(details: chrome.webRequest.WebRequestBodyDetails) {
    if (details.tabId === -1) return;
    const request: NetworkRequest = {
      id: details.requestId,
      url: details.url,
      method: details.method,
      type: details.type,
      timestamp: details.timeStamp,
      requestBody: details.requestBody,
    };
    const requests = this.networkRequests.get(details.tabId) || [];
    requests.push(request);
    this.networkRequests.set(details.tabId, requests);
  }

  private onNetworkComplete(details: chrome.webRequest.WebResponseHeadersDetails) {
    if (details.tabId === -1) return;
    const requests = this.networkRequests.get(details.tabId);
    if (!requests) return;
    const request = requests.find((r) => r.id === details.requestId);
    if (request) {
      request.status = details.statusCode;
      request.statusText = details.statusLine;
      request.responseHeaders = details.responseHeaders?.reduce(
        (acc, h) => {
          acc[h.name] = h.value || "";
          return acc;
        },
        {} as Record<string, string>,
      );
    }
  }
}

// Initialize
new DominatrixBackground();
