/**
 * Watchdog dashboard client — vanilla TypeScript, no React.
 * Fetches status from API and renders everything client-side.
 */

// ── Types ────────────────────────────────────────────────

interface ServiceStatus {
  name: string;
  pid: number | null;
  processAlive: boolean;
  healthy: boolean;
  healthReason?: string | null;
  healthDetails?: {
    memoryLock?: {
      ownerPid?: number | null;
      heartbeatAgeMs?: number | null;
      stale?: boolean;
      ownerAlive?: boolean | null;
    };
  } | null;
  consecutiveFailures: number;
  lastRestart: string | null;
  history: { timestamp: number; processAlive: boolean; healthy: boolean }[];
}

interface ServerInfo {
  startedAt: number;
  port: number;
}

// ── Utilities ────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / 1024 / 1024).toFixed(1) + "MB";
}

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// ── State ────────────────────────────────────────────────

let currentFile = "";
let offset = 0;
let lines: string[] = [];
let filter = "ALL";
let paused = false;
let autoScroll = true;
let tailPending = false;
let serverStartedAt = 0;
let serverPort = 0;

const MAX_LINES = 2000;

// ── Init: Fetch server info ──────────────────────────────

async function init(): Promise<void> {
  try {
    const res = await fetch("/api/info");
    const info: ServerInfo = await res.json();
    serverStartedAt = info.startedAt;
    serverPort = info.port;
  } catch {
    // Fallback — we'll get it on next status poll
  }

  // Set up event listeners
  $("logFile")?.addEventListener("change", switchLogFile);
  $("filterAll")?.addEventListener("click", (e) => setFilter("ALL", e.target as HTMLElement));
  $("filterInfo")?.addEventListener("click", (e) => setFilter("INFO", e.target as HTMLElement));
  $("filterWarn")?.addEventListener("click", (e) => setFilter("WARN", e.target as HTMLElement));
  $("filterError")?.addEventListener("click", (e) => setFilter("ERROR", e.target as HTMLElement));
  $("pauseBtn")?.addEventListener("click", togglePause);

  // Detect manual scroll
  $("logOutput")?.addEventListener("scroll", function (this: HTMLElement) {
    const atBottom = this.scrollHeight - this.scrollTop - this.clientHeight < 50;
    autoScroll = atBottom;
  });

  // Start polling
  loadLogFiles();
  tailLog();
  refreshStatus();

  setInterval(tailLog, 5000);
  setInterval(refreshStatus, 5000);
  setInterval(loadLogFiles, 30000);
  setInterval(updateUptime, 1000);
}

// ── Uptime Counter ───────────────────────────────────────

function updateUptime(): void {
  if (!serverStartedAt) return;
  const uptimeSec = Math.floor((Date.now() - serverStartedAt) / 1000);
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = uptimeSec % 60;
  const str = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  const el = $("uptime");
  if (el) el.textContent = `uptime ${str} \u00B7 port ${serverPort}`;
}

// ── Log Viewer ───────────────────────────────────────────

async function loadLogFiles(): Promise<void> {
  try {
    const res = await fetch("/api/logs");
    const data = await res.json();
    const select = $("logFile") as HTMLSelectElement | null;
    if (!select) return;
    select.innerHTML = data.files
      .map(
        (f: { name: string; size: number }) =>
          `<option value="${f.name}"${f.name === currentFile ? " selected" : ""}>${f.name} (${formatSize(f.size)})</option>`,
      )
      .join("");
    if (!currentFile && data.files.length > 0) {
      const preferred =
        data.files.find((f: { name: string }) => f.name === "gateway.log") || data.files[0];
      currentFile = preferred.name;
      select.value = currentFile;
    }
  } catch {
    // Silently retry next cycle
  }
}

function switchLogFile(): void {
  const select = $("logFile") as HTMLSelectElement | null;
  if (!select) return;
  currentFile = select.value;
  lines = [];
  offset = 0;
  renderLines();
  tailLog();
}

function setFilter(level: string, btn: HTMLElement): void {
  filter = level;
  document.querySelectorAll(".btn-filter").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  renderLines();
}

function togglePause(): void {
  paused = !paused;
  const btn = $("pauseBtn");
  if (btn) {
    btn.textContent = paused ? "Resume" : "Pause";
    btn.classList.toggle("paused", paused);
  }
}

async function tailLog(): Promise<void> {
  if (!currentFile || paused || tailPending) return;
  tailPending = true;
  try {
    const res = await fetch(
      `/api/logs/${encodeURIComponent(currentFile)}?lines=200&offset=${offset}`,
    );
    const data = await res.json();
    if (data.lines?.length > 0) {
      lines = lines.concat(data.lines);
      if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
      renderLines();
    }
    offset = data.offset;
    const offsetEl = $("offsetInfo");
    if (offsetEl) offsetEl.textContent = `offset: ${offset.toLocaleString()} bytes`;
  } catch {
    // Silently retry next cycle
  } finally {
    tailPending = false;
  }
}

function renderLines(): void {
  const output = $("logOutput");
  if (!output) return;

  const filtered = filter === "ALL" ? lines : lines.filter((l) => l.includes(`[${filter}]`));
  output.innerHTML = filtered
    .map((line) => {
      let cls = "log-line info";
      if (line.includes("[ERROR]")) cls = "log-line error";
      else if (line.includes("[WARN]")) cls = "log-line warn";

      const tsMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
      if (tsMatch) {
        return `<div class="${cls}"><span class="ts">[${tsMatch[1]}]</span>${escapeHtml(line.slice(tsMatch[0].length))}</div>`;
      }
      return `<div class="${cls}">${escapeHtml(line)}</div>`;
    })
    .join("");

  const lineCountEl = $("lineCount");
  if (lineCountEl) {
    lineCountEl.textContent =
      `${filtered.length} lines` + (filter !== "ALL" ? ` (filtered from ${lines.length})` : "");
  }

  if (autoScroll) output.scrollTop = output.scrollHeight;
}

// ── Service Status Polling ───────────────────────────────

async function restartService(id: string): Promise<void> {
  if (!confirm(`Restart ${id}?`)) return;
  try {
    const res = await fetch(`/restart/${id}`, { method: "POST" });
    const data = await res.json();
    alert(data.message);
  } catch (e) {
    alert(`Restart failed: ${e}`);
  }
}

async function refreshStatus(): Promise<void> {
  try {
    const res = await fetch("/status");
    const data: Record<string, ServiceStatus> = await res.json();
    const container = $("serviceCards");
    if (!container) return;

    let html = "";

    for (const [id, svc] of Object.entries(data)) {
      const statusColor = svc.healthy ? "#22c55e" : svc.processAlive ? "#eab308" : "#ef4444";
      const statusText = svc.healthy ? "Healthy" : svc.processAlive ? "Unhealthy" : "Down";
      const sparkline = (svc.history || [])
        .slice(-30)
        .map((h) => {
          const c = h.healthy ? "#22c55e" : h.processAlive ? "#eab308" : "#ef4444";
          return `<span style="display:inline-block;width:4px;height:12px;background:${c};margin-right:1px;border-radius:1px;"></span>`;
        })
        .join("");
      const lastRestart = svc.lastRestart
        ? new Date(svc.lastRestart).toLocaleTimeString()
        : "never";
      const detailLine = svc.healthDetails?.memoryLock
        ? `memory lock: pid ${svc.healthDetails.memoryLock.ownerPid ?? "?"}, age ${Math.round((svc.healthDetails.memoryLock.heartbeatAgeMs ?? 0) / 1000)}s`
        : svc.healthReason
          ? `reason: ${svc.healthReason}`
          : "";

      html +=
        `<div class="card">` +
        `<div class="card-header">` +
        `<span class="status-dot" style="background:${statusColor}"></span>` +
        `<span class="card-title">${svc.name}</span>` +
        `<span class="status-text" style="color:${statusColor}">${statusText}</span>` +
        `</div>` +
        `<div class="card-body">` +
        `<div class="metric"><span class="label">PID</span><span>${svc.pid ?? "—"}</span></div>` +
        `<div class="metric"><span class="label">failures</span><span>${svc.consecutiveFailures}</span></div>` +
        `<div class="metric"><span class="label">last restart</span><span>${lastRestart}</span></div>` +
        (detailLine
          ? `<div class="metric"><span class="label">detail</span><span>${escapeHtml(detailLine)}</span></div>`
          : "") +
        `<div class="sparkline">${sparkline}</div>` +
        `</div>` +
        `<div class="card-actions">` +
        `<button class="btn-restart" data-service="${id}">Restart</button>` +
        `</div></div>`;
    }

    container.innerHTML = html;

    // Bind restart buttons
    container.querySelectorAll<HTMLButtonElement>("[data-service]").forEach((btn) => {
      btn.addEventListener("click", () => restartService(btn.dataset.service!));
    });
  } catch {
    // Silently retry next cycle
  }
}

// ── Start ────────────────────────────────────────────────

init();
