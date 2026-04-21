/**
 * Side panel script — detects context tab and loads the Anima chat UI in an iframe.
 */

export {}; // Force module scope to avoid GATEWAY_URL redeclaration conflict

const GATEWAY_URL = "http://localhost:30086";
const TOKEN_STORAGE_KEY = "gatewayToken";

const iframe = document.getElementById("chat") as HTMLIFrameElement;
const banner = document.getElementById("banner") as HTMLDivElement;

// Detect which tab the side panel is open on and set it as context
async function initWithTabContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.runtime.sendMessage({ type: "sidepanel-context", tabId: tab.id });
    }
  } catch {
    // Side panel context is best-effort
  }

  iframe.src = `${GATEWAY_URL}/`;
}

// Track tab changes — if user switches tabs while panel is open
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.runtime.sendMessage({ type: "sidepanel-context", tabId: activeInfo.tabId });
});

initWithTabContext();

iframe.addEventListener("load", () => {
  banner.classList.remove("visible");
});

iframe.addEventListener("error", () => {
  banner.textContent = "Cannot connect to Anima gateway";
  banner.classList.add("visible");
});

// Health check retry
let retryCount = 0;
async function getGatewayToken(): Promise<string> {
  const stored = await chrome.storage.local.get(TOKEN_STORAGE_KEY);
  return typeof stored[TOKEN_STORAGE_KEY] === "string" ? stored[TOKEN_STORAGE_KEY] : "";
}

async function saveGatewayToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [TOKEN_STORAGE_KEY]: token });
  chrome.runtime.sendMessage({ type: "gateway-token-updated" });
}

async function promptForGatewayToken(): Promise<boolean> {
  const token = window.prompt("Enter your Anima gateway token from `anima token show`:");
  if (!token?.trim()) return false;
  const trimmed = token.trim();
  if (!(await validateGatewayToken(trimmed))) {
    banner.textContent = "Invalid Anima gateway token";
    banner.classList.add("visible");
    return false;
  }
  await saveGatewayToken(trimmed);
  return true;
}

async function validateGatewayToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(`${GATEWAY_URL}/api/auth/validate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureGatewayToken(): Promise<string | null> {
  const existing = await getGatewayToken();
  if (existing && (await validateGatewayToken(existing))) return existing;

  if (existing) {
    await chrome.storage.local.remove(TOKEN_STORAGE_KEY);
  }

  const saved = await promptForGatewayToken();
  return saved ? getGatewayToken() : null;
}

async function checkConnection() {
  const token = await ensureGatewayToken();
  if (!token) {
    banner.textContent = "Anima gateway token required";
    banner.classList.add("visible");
    setTimeout(checkConnection, 5000);
    return;
  }

  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

  fetch(`${GATEWAY_URL}/health`, { headers })
    .then(async (r) => {
      if (r.status === 401) {
        const saved = await promptForGatewayToken();
        if (saved) setTimeout(checkConnection, 250);
        throw new Error("Unauthorized");
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(() => {
      banner.classList.remove("visible");
      retryCount = 0;
    })
    .catch(() => {
      retryCount++;
      if (retryCount > 2) {
        banner.textContent = "Cannot connect to Anima gateway — is it running?";
        banner.classList.add("visible");
      }
      setTimeout(checkConnection, 5000);
    });
}
checkConnection();
