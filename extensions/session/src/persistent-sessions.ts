export interface PersistentSessionEntry {
  sessionId: string;
  messageCount: number;
  createdAt: string;
}

export interface PersistentSessionStore {
  getEntries(): Record<string, PersistentSessionEntry>;
  setEntries(entries: Record<string, PersistentSessionEntry>): void;
}

export interface PersistentSessionLog {
  info(msg: string, meta?: unknown): void;
}

export interface ActiveSessionLike {
  id: string;
}

export async function resolvePersistentSessionForCwd(args: {
  cwd: string;
  store: PersistentSessionStore;
  listActiveSessions: () => Promise<ActiveSessionLike[]>;
  createSession: (cwd: string) => Promise<string>;
  log: PersistentSessionLog;
  now?: () => string;
  formatSessionId?: (sessionId: string) => string;
}): Promise<string> {
  const entries = args.store.getEntries();
  const entry = entries[args.cwd];

  if (entry?.sessionId) {
    const activeSessions = await args.listActiveSessions();
    const alive = activeSessions.find((session) => session.id === entry.sessionId);

    if (alive) {
      entry.messageCount = (entry.messageCount || 0) + 1;
      args.store.setEntries(entries);
      return entry.sessionId;
    }

    args.log.info("Persistent session not in agent-host, will resume or create", {
      cwd: args.cwd,
      sessionId: args.formatSessionId ? args.formatSessionId(entry.sessionId) : entry.sessionId,
    });

    return entry.sessionId;
  }

  args.log.info("Creating new persistent session", { cwd: args.cwd });
  const sessionId = await args.createSession(args.cwd);

  entries[args.cwd] = {
    sessionId,
    messageCount: 1,
    createdAt: args.now ? args.now() : new Date().toISOString(),
  };
  args.store.setEntries(entries);

  return sessionId;
}

export function rotatePersistentSessions(args: {
  store: PersistentSessionStore;
  maxMessages: number;
  maxAgeHours: number;
  log: PersistentSessionLog;
  now?: () => number;
  formatSessionId?: (sessionId: string) => string;
}): { rotated: string[]; checked: number } {
  const entries = args.store.getEntries();
  const rotated: string[] = [];
  const now = args.now ? args.now() : Date.now();
  const checked = Object.keys(entries).length;

  for (const [cwd, entry] of Object.entries(entries)) {
    const ageHours = (now - new Date(entry.createdAt).getTime()) / (1000 * 60 * 60);
    const needsRotation =
      (args.maxMessages > 0 && entry.messageCount >= args.maxMessages) ||
      (args.maxAgeHours > 0 && ageHours >= args.maxAgeHours);

    if (!needsRotation) continue;

    args.log.info("Rotating persistent session", {
      cwd,
      sessionId: args.formatSessionId ? args.formatSessionId(entry.sessionId) : entry.sessionId,
      messageCount: entry.messageCount,
      ageHours: Math.round(ageHours),
    });
    delete entries[cwd];
    rotated.push(cwd);
  }

  if (rotated.length > 0) {
    args.store.setEntries(entries);
  }

  return { rotated, checked };
}
