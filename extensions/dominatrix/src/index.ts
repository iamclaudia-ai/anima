/**
 * DOMINATRIX Gateway Extension
 *
 * Browser automation through Chrome extension clients.
 * Commands flow: CLI/API → Gateway → Extension → Chrome Extension → Content Script → DOM.
 *
 * Chrome extension clients connect to the gateway WebSocket, subscribe to
 * `dominatrix.command` events, and respond via `dominatrix.response` method calls.
 *
 * Every Chrome profile runs its own client, so each command names the profile it
 * is for (`targetInstanceId`) and the other clients drop it. Which profile that is
 * comes from `--profile`, or from the tab the calling session is already working
 * in — see {@link pickClient}.
 */

import type {
  AnimaExtension,
  ExtensionContext,
  HealthCheckResponse,
  LoggerLike,
} from "@anima/shared";
import { z } from "zod";
import { transpileForJail } from "./transpile";

// ============================================================================
// Types
// ============================================================================

interface ChromeClient {
  id: string;
  profileName?: string;
  extensionId: string;
  registeredAt: number;
  /** Last time one of this profile's windows took OS focus — breaks ties for reads. */
  lastFocusedAt: number;
}

/**
 * The tab a session is working in.
 *
 * `recent` is an MRU of tabs the session has driven, so it can step back to one it
 * opened earlier without the caller having had to write the ID down.
 */
interface SessionBinding {
  instanceId: string;
  tabId: number;
  recent: number[];
  updatedAt: number;
}

interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
  windowId: number;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ============================================================================
// Constants
// ============================================================================

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_RECENT_TABS = 10;

/** Opening a tab in the wrong profile isn't something the caller can undo, so ask. */
const NEEDS_EXPLICIT_PROFILE = new Set(["navigate", "new_tab"]);

/** Actions that mean "this is the tab I'm working in from now on". */
const BINDS_SESSION = new Set(["navigate", "new_tab", "use_tab"]);

const noopLogger: LoggerLike = {
  info() {},
  warn() {},
  error() {},
  child: () => noopLogger,
};

// ============================================================================
// Schemas
// ============================================================================

// --- Common params ---

const tabIdValue = z
  .union([z.number(), z.enum(["new", "active"])])
  .describe('Tab ID, "new" to open a new tab, or "active" for the profile\'s active tab');

/**
 * The routing params every browser command shares.
 *
 * `sessionId` is auto-injected by the CLI from $ANIMA_SESSION_ID whenever a method
 * declares it — that injection is the whole reason a session can omit `--tabId`
 * and still land on the tab it navigated to last.
 */
const targetParam = z.object({
  tabId: tabIdValue.optional(),
  profile: z
    .string()
    .optional()
    .describe("Chrome profile to target — label or ID from list_profiles"),
  sessionId: z
    .string()
    .optional()
    .describe("Session owning the tab binding (auto-injected from $ANIMA_SESSION_ID)"),
});

const refOrSelectorParam = targetParam.extend({
  ref: z.string().optional().describe("Element ref from snapshot (e.g. @e3)"),
  selector: z.string().optional().describe("CSS selector fallback"),
});

// --- Snapshot & page info ---

const snapshotParam = targetParam.extend({
  full: z.boolean().optional().describe("Return full a11y tree JSON instead of compact refs"),
  scope: z.string().optional().describe("CSS selector to scope the snapshot"),
  sources: z
    .boolean()
    .optional()
    .describe("Include React component source info per element (dev mode only)"),
});

const getSourceParam = targetParam.extend({
  ref: z.string().optional().describe("Element ref from snapshot (e.g. @e3)"),
  selector: z.string().optional().describe("CSS selector"),
});

const getTextParam = targetParam.extend({
  ref: z.string().optional().describe("Element ref to get text of (omit for full page)"),
});

const getMarkdownParam = targetParam.extend({
  ref: z.string().optional().describe("Element ref to get markdown of (omit for full page)"),
});

const getHtmlParam = targetParam.extend({
  selector: z.string().optional().describe("CSS selector (omit for full page)"),
});

// --- Interaction ---

const fillParam = refOrSelectorParam.extend({
  value: z.string().describe("Value to fill"),
});

const selectParam = refOrSelectorParam.extend({
  value: z.string().describe("Option value to select"),
});

// --- Semantic find ---

const performEnum = z.enum(["click", "fill"]).describe("Action to perform on found element");

const findTextParam = targetParam.extend({
  text: z.string().describe("Visible text to search for"),
  perform: performEnum,
  value: z.string().optional().describe("Value for fill action"),
});

const findLabelParam = targetParam.extend({
  label: z.string().describe("Label text or aria-label to search for"),
  perform: performEnum,
  value: z.string().optional().describe("Value for fill action"),
});

const findRoleParam = targetParam.extend({
  role: z.string().describe("ARIA role (e.g. button, link, textbox)"),
  name: z.string().optional().describe("Accessible name to match"),
  perform: performEnum,
  value: z.string().optional().describe("Value for fill action"),
});

const findPlaceholderParam = targetParam.extend({
  placeholder: z.string().describe("Placeholder text to search for"),
  perform: performEnum,
  value: z.string().optional().describe("Value for fill action"),
});

// --- Navigation & scrolling ---

const navigateParam = targetParam.extend({
  url: z.string().url().describe("URL to navigate to"),
});

const newTabParam = targetParam.extend({
  url: z.string().url().optional().describe("URL to open (omit for a blank tab)"),
  background: z.boolean().optional().describe("Open the tab without focusing it"),
});

const scrollValueParam = targetParam.extend({
  value: z.number().optional().describe("Pixels to scroll (default: 300)"),
});

const scrollToParam = targetParam.extend({
  ref: z.string().optional().describe("Element ref to scroll into view"),
  position: z.enum(["top", "bottom"]).optional().describe("Scroll to top or bottom of page"),
});

// --- Tabs & profiles ---

const listTabsParam = z.object({
  profile: z.string().optional().describe("Chrome profile to list tabs for (see list_profiles)"),
  sessionId: z.string().optional().describe("Session (auto-injected from $ANIMA_SESSION_ID)"),
});

const sessionTabsParam = z.object({
  sessionId: z.string().optional().describe("Session (auto-injected from $ANIMA_SESSION_ID)"),
});

const useTabParam = targetParam.extend({
  tabId: z.number().describe("Tab to work in from now on (see session_tabs or list_tabs)"),
  focus: z.boolean().optional().describe("Also bring the tab to the foreground (default: true)"),
});

const closeTabParam = targetParam.extend({
  tabId: tabIdValue.optional().describe("Tab to close (defaults to this session's tab)"),
});

// --- Wait ---

const waitForElementParam = targetParam.extend({
  selector: z.string().describe("CSS selector to wait for"),
  timeout: z.number().optional().describe("Timeout in ms (default: 5000)"),
});

const waitForTextParam = targetParam.extend({
  text: z.string().describe("Text to wait for"),
  timeout: z.number().optional().describe("Timeout in ms (default: 5000)"),
});

const waitForUrlParam = targetParam.extend({
  pattern: z.string().describe("URL glob pattern to match (e.g. **/posts)"),
  timeout: z.number().optional().describe("Timeout in ms (default: 10000)"),
});

const waitParam = targetParam.extend({
  ms: z.number().describe("Milliseconds to wait"),
});

// --- Script execution ---

const execParam = targetParam.extend({
  script: z.string().describe("JavaScript to execute in page context"),
});

const evalParam = targetParam.extend({
  expression: z.string().describe("JavaScript expression to evaluate"),
});

// --- Screenshot ---

const screenshotParam = targetParam.extend({
  fullPage: z.boolean().optional().describe("Capture full page"),
});

// --- Internal ---

const registerParam = z.object({
  extensionId: z.string(),
  instanceId: z.string(),
  profileName: z.string().optional(),
  focused: z.boolean().optional(),
});

const responseParam = z.object({
  requestId: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

// ============================================================================
// Extension Factory
// ============================================================================

export function createDominatrixExtension(): AnimaExtension {
  let ctx: ExtensionContext;
  let traceLog: LoggerLike = noopLogger;
  const clients = new Map<string, ChromeClient>();
  const pendingRequests = new Map<string, PendingRequest>();

  // Track connectionId → instanceId so we can clean up clients on disconnect
  const connectionMap = new Map<string, string>();

  // sessionId → the tab that session is working in. Persisted so a gateway restart
  // doesn't lose the tab a long-running session is in the middle of.
  let sessions = new Map<string, SessionBinding>();

  // --------------------------------------------------------------------------
  // Session bindings
  // --------------------------------------------------------------------------

  function loadSessions() {
    const raw = ctx.store.get<Record<string, SessionBinding>>("sessions") ?? {};
    sessions = new Map(Object.entries(raw));
  }

  function saveSessions() {
    ctx.store.set("sessions", Object.fromEntries(sessions));
  }

  function bindSession(sessionId: string, instanceId: string, tabId: number) {
    const previous = sessions.get(sessionId);
    // A profile switch invalidates the MRU — tab IDs are only unique per browser.
    const carried = previous?.instanceId === instanceId ? previous.recent : [];
    const recent = [tabId, ...carried.filter((id) => id !== tabId)].slice(0, MAX_RECENT_TABS);

    sessions.set(sessionId, { instanceId, tabId, recent, updatedAt: Date.now() });
    saveSessions();
    ctx.log.info("Session bound to tab", { sessionId, instanceId, tabId });
  }

  /** Forget a tab that no longer exists, falling back to the next most recent. */
  function unbindTab(sessionId: string, tabId: number) {
    const binding = sessions.get(sessionId);
    if (!binding) return;

    binding.recent = binding.recent.filter((id) => id !== tabId);
    if (binding.recent.length === 0) {
      sessions.delete(sessionId);
    } else if (binding.tabId === tabId) {
      binding.tabId = binding.recent[0];
    }
    saveSessions();
  }

  // --------------------------------------------------------------------------
  // Profile (client) selection
  // --------------------------------------------------------------------------

  /** Human-facing profile name. Falls back to a short ID for signed-out profiles. */
  function clientLabel(client: ChromeClient): string {
    return client.profileName || `chrome-${client.id.slice(0, 6)}`;
  }

  function clientsByFocus(): ChromeClient[] {
    return Array.from(clients.values()).sort((a, b) => b.lastFocusedAt - a.lastFocusedAt);
  }

  function describeClients() {
    return clientsByFocus().map((client) => ({
      profile: clientLabel(client),
      id: client.id,
      extensionId: client.extensionId,
      registeredAt: new Date(client.registeredAt).toISOString(),
      lastFocusedAt: new Date(client.lastFocusedAt).toISOString(),
    }));
  }

  /** An error that answers "which profile?" by listing the ones on offer. */
  function profileChoiceError(reason: string): Error {
    const list = clientsByFocus()
      .map((c) => `  --profile ${clientLabel(c)}    (id ${c.id.slice(0, 8)})`)
      .join("\n");
    return new Error(
      `${reason}\n\nConnected Chrome profiles:\n${list}\n\n` +
        "Re-run with --profile <label>, or target an existing tab with --tabId <id>.",
    );
  }

  function resolveClient(hint: string): ChromeClient {
    const all = Array.from(clients.values());
    const needle = hint.trim().toLowerCase();

    const exact = all.filter((c) => c.id === hint || clientLabel(c).toLowerCase() === needle);
    if (exact.length === 1) return exact[0];

    const partial = all.filter(
      (c) => c.id.startsWith(hint) || clientLabel(c).toLowerCase().includes(needle),
    );
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) throw profileChoiceError(`Profile '${hint}' matches more than one.`);

    throw profileChoiceError(`No connected Chrome profile matches '${hint}'.`);
  }

  /**
   * Decide which Chrome profile runs this command.
   *
   * An explicit `--profile` wins, then the profile the session is already working
   * in. With nothing to go on and more than one profile connected, commands that
   * create tabs stop and ask rather than guessing; read-only commands fall back to
   * the most recently focused profile, which is what "the browser I'm looking at"
   * means in practice.
   */
  function pickClient(
    action: string,
    tabIdParam: unknown,
    profileHint: string | undefined,
    boundClient: ChromeClient | undefined,
  ): ChromeClient {
    if (clients.size === 0) {
      throw new Error(
        "No Chrome extension clients connected. Is the DOMINATRIX extension loaded and the gateway running?",
      );
    }

    if (profileHint) return resolveClient(profileHint);
    if (boundClient) return boundClient;

    const all = clientsByFocus();
    if (all.length === 1) return all[0];

    if (NEEDS_EXPLICIT_PROFILE.has(action) || tabIdParam === "new") {
      throw profileChoiceError(
        `'${action}' needs to know which Chrome profile to use — ${all.length} profiles are connected ` +
          "and this session isn't working in a tab yet.",
      );
    }

    return all[0];
  }

  // --------------------------------------------------------------------------
  // Command dispatch — sends command event and waits for response
  // --------------------------------------------------------------------------

  function summarizeParams(params: Record<string, unknown>): Record<string, unknown> {
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string") {
        summary[key] = value.length > 120 ? `${value.slice(0, 120)}…` : value;
      } else if (Array.isArray(value)) {
        summary[key] = `[array:${value.length}]`;
      } else if (value && typeof value === "object") {
        summary[key] = "[object]";
      } else {
        summary[key] = value;
      }
    }
    return summary;
  }

  /**
   * Emit a command addressed to one Chrome profile.
   *
   * The event still fans out to every connected client; `targetInstanceId` is what
   * makes all but one of them drop it, so exactly one response comes back.
   */
  function sendCommand(
    action: string,
    params: Record<string, unknown>,
    targetInstanceId: string,
  ): Promise<unknown> {
    ctx.log.info(`Dispatching browser command: ${action}`, {
      clients: clients.size,
      targetInstanceId,
    });

    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ctx.log.warn(`Command timed out: action=${action}, requestId=${requestId}`);
        traceLog.warn("Command timed out", {
          action,
          requestId,
          targetInstanceId,
          params: summarizeParams(params),
        });
        pendingRequests.delete(requestId);
        reject(new Error(`Command '${action}' timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);

      pendingRequests.set(requestId, { resolve, reject, timer });

      ctx.log.info(`Emitting dominatrix.command: requestId=${requestId}, action=${action}`);
      traceLog.info("Command payload", {
        requestId,
        action,
        targetInstanceId,
        params: summarizeParams(params),
      });
      ctx.emit("dominatrix.command", {
        requestId,
        action,
        params,
        targetInstanceId,
      });
    });
  }

  /** The tab a command actually ran in, if we can tell. */
  function learnTabId(data: unknown, requestedTabId: unknown): number | undefined {
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const reported = (data as Record<string, unknown>).tabId;
      if (typeof reported === "number") return reported;
    }
    return typeof requestedTabId === "number" ? requestedTabId : undefined;
  }

  /**
   * Route a command to a profile and a tab, run it, and remember the tab.
   *
   * Binding is deliberately limited to acts that choose a tab (navigate, new_tab,
   * use_tab, or an explicit numeric --tabId). A bare `get_title` keeps following
   * whatever tab the user is looking at instead of pinning the session to it.
   */
  async function dispatch(action: string, raw: Record<string, unknown>): Promise<unknown> {
    const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : undefined;
    const profileHint = typeof raw.profile === "string" ? raw.profile : undefined;
    const tabIdParam = raw.tabId;

    const params = { ...raw };
    delete params.sessionId;
    delete params.profile;

    // The page evaluates JS through JailJS (an AST interpreter — pages with a
    // strict CSP forbid real `eval`), which only understands a subset of the
    // language. Compile to that subset here so callers can write modern JS.
    // On a syntax error we pass the source through untouched, so the error the
    // caller sees is about their code rather than about our transpile step.
    for (const key of ["script", "expression"] as const) {
      if (typeof params[key] === "string") {
        params[key] = transpileForJail(params[key]) ?? params[key];
      }
    }

    const binding = sessionId ? sessions.get(sessionId) : undefined;
    const boundClient = binding ? clients.get(binding.instanceId) : undefined;

    const client = pickClient(action, tabIdParam, profileHint, boundClient);

    // No explicit tab? Reuse the one this session is working in, as long as it
    // lives in the profile we just picked.
    let tabId = tabIdParam;
    if (tabId === undefined && binding && boundClient && boundClient.id === client.id) {
      tabId = binding.tabId;
    }
    if (tabId === undefined) delete params.tabId;
    else params.tabId = tabId;

    const data = await sendCommand(action, params, client.id);

    const resolvedTabId = learnTabId(data, tabId);

    if (action === "close_tab") {
      if (sessionId && resolvedTabId !== undefined) unbindTab(sessionId, resolvedTabId);
      return data;
    }

    const shouldBind = BINDS_SESSION.has(action) || typeof tabIdParam === "number";
    if (sessionId && resolvedTabId !== undefined && shouldBind) {
      bindSession(sessionId, client.id, resolvedTabId);
    }

    // Tab-management commands report where they landed, so the caller can name the
    // tab later without going back to the browser to find it.
    if (BINDS_SESSION.has(action) && data && typeof data === "object" && !Array.isArray(data)) {
      return { ...(data as Record<string, unknown>), profile: clientLabel(client), sessionId };
    }
    return data;
  }

  // --------------------------------------------------------------------------
  // Method handlers
  // --------------------------------------------------------------------------

  const methods: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    // --- Snapshot & page info ---
    "dominatrix.snapshot": (p) => dispatch("snapshot", p),
    "dominatrix.get_text": (p) => dispatch("get_text", p),
    "dominatrix.get_markdown": (p) => dispatch("get_markdown", p),
    "dominatrix.get_url": (p) => dispatch("get_url", p),
    "dominatrix.get_title": (p) => dispatch("get_title", p),
    "dominatrix.get_html": (p) => dispatch("get_html", p),
    "dominatrix.get_source": (p) => dispatch("get_source", p),

    // --- Interaction ---
    "dominatrix.click": (p) => dispatch("click", p),
    "dominatrix.fill": (p) => dispatch("fill", p),
    "dominatrix.check": (p) => dispatch("check", p),
    "dominatrix.uncheck": (p) => dispatch("uncheck", p),
    "dominatrix.select": (p) => dispatch("select", p),

    // --- Semantic find ---
    "dominatrix.find_text": (p) => dispatch("find_text", p),
    "dominatrix.find_label": (p) => dispatch("find_label", p),
    "dominatrix.find_role": (p) => dispatch("find_role", p),
    "dominatrix.find_placeholder": (p) => dispatch("find_placeholder", p),

    // --- Navigation & scrolling ---
    "dominatrix.navigate": (p) => dispatch("navigate", p),
    "dominatrix.new_tab": (p) => dispatch("new_tab", p),
    "dominatrix.scroll_down": (p) => dispatch("scroll_down", p),
    "dominatrix.scroll_up": (p) => dispatch("scroll_up", p),
    "dominatrix.scroll_to": (p) => dispatch("scroll_to", p),

    // --- Wait ---
    "dominatrix.wait_for_element": (p) => dispatch("wait_for_element", p),
    "dominatrix.wait_for_text": (p) => dispatch("wait_for_text", p),
    "dominatrix.wait_for_url": (p) => dispatch("wait_for_url", p),
    "dominatrix.wait": (p) => dispatch("wait", p),

    // --- Debugging ---
    "dominatrix.screenshot": (p) => dispatch("screenshot", p),
    "dominatrix.exec": (p) => dispatch("executeScript", p),
    "dominatrix.eval": (p) => dispatch("evaluateExpression", p),
    "dominatrix.get_console": (p) => dispatch("get_console", p),
    "dominatrix.get_network": (p) => dispatch("get_network", p),
    "dominatrix.get_storage": (p) => dispatch("get_storage", p),
    "dominatrix.get_cookies": (p) => dispatch("get_cookies", p),

    // --- Tabs & profiles ---
    "dominatrix.list_tabs": (p) => dispatch("list_tabs", p),
    "dominatrix.get_active_tab": (p) => dispatch("get_active_tab", p),
    "dominatrix.use_tab": (p) => dispatch("use_tab", p),
    "dominatrix.close_tab": (p) => dispatch("close_tab", p),

    "dominatrix.list_profiles": async () => {
      const profiles = describeClients();
      if (profiles.length === 0) {
        throw new Error(
          "No Chrome extension clients connected. Is the DOMINATRIX extension loaded and the gateway running?",
        );
      }
      return { profiles, default: profiles[0].profile };
    },

    /**
     * Tabs this session has worked in, most recent first — the list you pick from
     * to get back to a tab you opened earlier. Closed tabs are pruned on read.
     */
    "dominatrix.session_tabs": async (p) => {
      const sessionId = typeof p.sessionId === "string" ? p.sessionId : undefined;
      if (!sessionId) {
        throw new Error(
          "session_tabs needs --sessionId (normally auto-injected from $ANIMA_SESSION_ID).",
        );
      }

      const binding = sessions.get(sessionId);
      if (!binding) return { sessionId, profile: null, current: null, tabs: [] };

      const client = clients.get(binding.instanceId);
      if (!client) {
        return {
          sessionId,
          profile: null,
          current: null,
          tabs: [],
          note: "The Chrome profile this session was working in is no longer connected.",
        };
      }

      const live = (await sendCommand(
        "get_tabs",
        { tabIds: binding.recent },
        client.id,
      )) as TabInfo[];

      const liveIds = new Set(live.map((t) => t.id));
      binding.recent = binding.recent.filter((id) => liveIds.has(id));

      if (binding.recent.length === 0) {
        sessions.delete(sessionId);
        saveSessions();
        return { sessionId, profile: clientLabel(client), current: null, tabs: [] };
      }

      if (!liveIds.has(binding.tabId)) binding.tabId = binding.recent[0];
      saveSessions();

      return {
        sessionId,
        profile: clientLabel(client),
        current: binding.tabId,
        tabs: live.map((tab) => ({ ...tab, current: tab.id === binding.tabId })),
      };
    },

    // --- Internal ---
    "dominatrix.register": async (p) => {
      const id = p.instanceId as string;
      const existing = clients.get(id);
      const now = Date.now();

      const client: ChromeClient = {
        id,
        profileName: p.profileName as string | undefined,
        extensionId: p.extensionId as string,
        registeredAt: existing?.registeredAt ?? now,
        // Registration doubles as the focus signal — the Chrome side re-registers
        // with focused:true whenever one of its windows takes focus.
        lastFocusedAt: p.focused === true ? now : (existing?.lastFocusedAt ?? now),
      };
      clients.set(client.id, client);

      // Track connectionId → instanceId for disconnect cleanup
      const connectionId = ctx.connectionId;
      if (connectionId) {
        connectionMap.set(connectionId, client.id);
      }

      ctx.log.info("Chrome extension registered", {
        ...client,
        connectionId,
      });
      return { ok: true };
    },

    "dominatrix.response": async (p) => {
      const requestId = p.requestId as string;
      ctx.log.info(
        `Response received: requestId=${requestId}, success=${p.success}, pending=${pendingRequests.size}`,
      );
      const pending = pendingRequests.get(requestId);
      if (!pending) {
        ctx.log.warn(`Response for unknown request: requestId=${requestId}`);
        traceLog.warn("Unknown response received", {
          requestId,
          pendingCount: pendingRequests.size,
        });
        return { ok: false };
      }

      pendingRequests.delete(requestId);
      clearTimeout(pending.timer);

      if (p.success) {
        ctx.log.info(`Resolving request: requestId=${requestId}`);
        traceLog.info("Command succeeded", { requestId });
        pending.resolve(p.data);
      } else {
        ctx.log.warn(`Rejecting request: requestId=${requestId}, error=${p.error}`);
        traceLog.warn("Command failed", { requestId, error: p.error });
        pending.reject(new Error((p.error as string) || "Command failed"));
      }

      return { ok: true };
    },

    "dominatrix.health_check": async (): Promise<HealthCheckResponse> => {
      const clientList = clientsByFocus();
      return {
        ok: clientList.length > 0,
        status: clientList.length > 0 ? "healthy" : "disconnected",
        label: "Browser Control (DOMINATRIX)",
        metrics: [
          { label: "Connected Profiles", value: clientList.length },
          { label: "Bound Sessions", value: sessions.size },
          { label: "Pending Commands", value: pendingRequests.size },
        ],
        items: clientList.map((c) => ({
          id: c.id,
          label: clientLabel(c),
          status: "healthy" as const,
          details: {
            registered: new Date(c.registeredAt).toISOString(),
            lastFocused: new Date(c.lastFocusedAt).toISOString(),
          },
        })),
      };
    },
  };

  // --------------------------------------------------------------------------
  // Extension interface
  // --------------------------------------------------------------------------

  return {
    id: "dominatrix",
    name: "DOMINATRIX Browser Control",
    events: ["dominatrix.command", "dominatrix.tab.*"],
    methods: [
      // --- Snapshot & page info ---
      {
        name: "dominatrix.snapshot",
        description: "Get interactive element refs (default) or full a11y tree (--full)",
        inputSchema: snapshotParam,
      },
      {
        name: "dominatrix.get_text",
        description: "Get plain text of page or element by ref",
        inputSchema: getTextParam,
      },
      {
        name: "dominatrix.get_markdown",
        description: "Get page or element content as Markdown",
        inputSchema: getMarkdownParam,
      },
      {
        name: "dominatrix.get_url",
        description: "Get current page URL",
        inputSchema: targetParam,
      },
      {
        name: "dominatrix.get_title",
        description: "Get current page title",
        inputSchema: targetParam,
      },
      {
        name: "dominatrix.get_html",
        description: "Get HTML of page or element",
        inputSchema: getHtmlParam,
      },
      {
        name: "dominatrix.get_source",
        description: "Get React component ancestry and source file path for an element",
        inputSchema: getSourceParam,
      },

      // --- Interaction ---
      {
        name: "dominatrix.click",
        description: "Click element by @ref or CSS selector",
        inputSchema: refOrSelectorParam,
      },
      {
        name: "dominatrix.fill",
        description: "Fill form field by @ref or CSS selector",
        inputSchema: fillParam,
      },
      {
        name: "dominatrix.check",
        description: "Check a checkbox by @ref or CSS selector",
        inputSchema: refOrSelectorParam,
      },
      {
        name: "dominatrix.uncheck",
        description: "Uncheck a checkbox by @ref or CSS selector",
        inputSchema: refOrSelectorParam,
      },
      {
        name: "dominatrix.select",
        description: "Select dropdown option by @ref or CSS selector",
        inputSchema: selectParam,
      },

      // --- Semantic find ---
      {
        name: "dominatrix.find_text",
        description: "Find element by visible text and act",
        inputSchema: findTextParam,
      },
      {
        name: "dominatrix.find_label",
        description: "Find element by label/aria-label and act",
        inputSchema: findLabelParam,
      },
      {
        name: "dominatrix.find_role",
        description: "Find element by ARIA role and act",
        inputSchema: findRoleParam,
      },
      {
        name: "dominatrix.find_placeholder",
        description: "Find element by placeholder and act",
        inputSchema: findPlaceholderParam,
      },

      // --- Navigation & scrolling ---
      {
        name: "dominatrix.navigate",
        description:
          "Navigate a tab to a URL. --tabId new opens a fresh tab; the tab is remembered for this session",
        inputSchema: navigateParam,
      },
      {
        name: "dominatrix.new_tab",
        description: "Open a new tab and make it this session's tab",
        inputSchema: newTabParam,
      },
      {
        name: "dominatrix.scroll_down",
        description: "Scroll down by pixels",
        inputSchema: scrollValueParam,
      },
      {
        name: "dominatrix.scroll_up",
        description: "Scroll up by pixels",
        inputSchema: scrollValueParam,
      },
      {
        name: "dominatrix.scroll_to",
        description: "Scroll to element or position",
        inputSchema: scrollToParam,
      },

      // --- Wait ---
      {
        name: "dominatrix.wait_for_element",
        description: "Wait for element to appear",
        inputSchema: waitForElementParam,
      },
      {
        name: "dominatrix.wait_for_text",
        description: "Wait for text to appear",
        inputSchema: waitForTextParam,
      },
      {
        name: "dominatrix.wait_for_url",
        description: "Wait for URL to match pattern",
        inputSchema: waitForUrlParam,
      },
      { name: "dominatrix.wait", description: "Wait fixed milliseconds", inputSchema: waitParam },

      // --- Debugging ---
      {
        name: "dominatrix.screenshot",
        description: "Capture visible tab as PNG data URL",
        inputSchema: screenshotParam,
      },
      {
        name: "dominatrix.exec",
        description: "Execute JavaScript in page context",
        inputSchema: execParam,
      },
      {
        name: "dominatrix.eval",
        description: "Evaluate JavaScript expression",
        inputSchema: evalParam,
      },
      {
        name: "dominatrix.get_console",
        description: "Get console logs from page",
        inputSchema: targetParam,
      },
      {
        name: "dominatrix.get_network",
        description: "Get network requests from page",
        inputSchema: targetParam,
      },
      {
        name: "dominatrix.get_storage",
        description: "Get localStorage and sessionStorage",
        inputSchema: targetParam,
      },
      {
        name: "dominatrix.get_cookies",
        description: "Get cookies for page domain",
        inputSchema: targetParam,
      },

      // --- Tabs & profiles ---
      {
        name: "dominatrix.list_tabs",
        description: "List open Chrome tabs for a profile",
        inputSchema: listTabsParam,
      },
      {
        name: "dominatrix.get_active_tab",
        description: "Get the tab DOMINATRIX will target by default",
        inputSchema: targetParam,
      },
      {
        name: "dominatrix.list_profiles",
        description: "List connected Chrome profiles you can target with --profile",
        inputSchema: z.object({}),
      },
      {
        name: "dominatrix.session_tabs",
        description: "List tabs this session has worked in, most recent first",
        inputSchema: sessionTabsParam,
      },
      {
        name: "dominatrix.use_tab",
        description: "Switch this session back to a tab it worked in earlier",
        inputSchema: useTabParam,
      },
      {
        name: "dominatrix.close_tab",
        description: "Close a tab this session opened",
        inputSchema: closeTabParam,
      },

      // --- Internal ---
      {
        name: "dominatrix.register",
        description: "Register Chrome extension client",
        inputSchema: registerParam,
        execution: { lane: "control", concurrency: "parallel" },
      },
      {
        name: "dominatrix.response",
        description: "Handle command response from Chrome extension",
        inputSchema: responseParam,
        execution: { lane: "control", concurrency: "parallel" },
      },
      {
        name: "dominatrix.health_check",
        description: "Health check",
        inputSchema: z.object({}),
        execution: { lane: "read", concurrency: "parallel" },
      },
    ],

    async start(extensionCtx) {
      ctx = extensionCtx;
      traceLog = ctx.createLogger({ component: "trace", fileName: "dominatrix-trace.log" });
      loadSessions();

      // Listen for client disconnects — remove stale Chrome extension clients
      ctx.on("client.disconnected", (event) => {
        const connectionId = event.connectionId;
        if (!connectionId) return;

        const instanceId = connectionMap.get(connectionId);
        if (instanceId) {
          ctx.log.info("Removing disconnected Chrome client", { connectionId, instanceId });
          clients.delete(instanceId);
          connectionMap.delete(connectionId);
        }
      });

      ctx.log.info("DOMINATRIX extension started", { sessions: sessions.size });
    },

    async stop() {
      // Clean up pending requests
      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Extension shutting down"));
        pendingRequests.delete(id);
      }
      clients.clear();
      connectionMap.clear();
      ctx.log.info("DOMINATRIX extension stopped");
      traceLog = noopLogger;
    },

    async handleMethod(method, params) {
      const handler = methods[method];
      if (!handler) throw new Error(`Unknown method: ${method}`);
      return handler(params);
    },

    health() {
      return {
        ok: clients.size > 0,
        details: { connectedClients: clients.size, boundSessions: sessions.size },
      };
    },
  };
}

export default createDominatrixExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createDominatrixExtension);
