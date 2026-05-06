import { useState, useEffect, useRef, useCallback } from "react";
import { useImmer } from "use-immer";
import { useGatewayClient } from "./useGatewayClient";
import { mergeRequestTags } from "./requestTags";
import type {
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ErrorBlock,
  Usage,
  Attachment,
} from "../types";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const MIN_TOOL_SIM_TICK_MS = 30;
const MAX_TOOL_SIM_TICK_MS = 2000;
const DEFAULT_TOOL_SIM_TICK_MS = 100;
const GLOBAL_EVENT_SUBSCRIPTIONS = ["voice.*", "hook.*"] as const;

// Re-export workspace/session types for consumers
export interface WorkspaceInfo {
  id: string;
  name: string;
  cwd: string;
  general: boolean;
  /** User-pinned — sorts to the top of the workspace list with a visual badge. */
  pinned?: boolean;
  cwdDisplay: string; // Normalized path with ~ for display
  createdAt: string;
  updatedAt: string;
}

export interface SessionInfo {
  sessionId: string;
  created?: string;
  modified?: string;
  messageCount?: number;
  firstPrompt?: string;
  gitBranch?: string;
}

export interface GitStatusInfo {
  branch: string | null;
  ahead: number;
  behind: number;
  dirty: {
    modified: number;
    added: number;
    deleted: number;
    untracked: number;
    renamed: number;
    total: number;
  };
  pr: {
    number: number;
    url: string;
    title: string;
    state: string;
    isDraft?: boolean;
  } | null;
}

export interface SubagentInfo {
  subagentId: string;
  parentSessionId: string;
  agent: string;
  purpose: string;
  status: "running" | "completed" | "failed" | "interrupted";
  prompt?: string;
  cwd?: string;
  error?: string;
  startedAt?: string;
  updatedAt?: string;
  previewText?: string;
}

// ─── Options ─────────────────────────────────────────────────

export interface UseChatGatewayOptions {
  /**
   * Explicit session ID (CC UUID) to load.
   * Used by web client when navigating to /workspace/:wsId/session/:id.
   * When set, loads history for this specific session.
   */
  sessionId?: string;

  /**
   * Workspace ID — provides CWD context for session operations.
   * Used together with sessionId for the web client session route.
   */
  workspaceId?: string;

  /**
   * Auto-discover mode: get workspace by CWD, find active session.
   * Used by VS Code extension. Provide the CWD string.
   * When set, sends session.get_or_create_workspace on connect.
   */
  autoDiscoverCwd?: string;

  /**
   * Optional default tags that should be attached to session-affecting requests.
   * Used by the web UI to persist things like voice.speak across prompt continuations.
   */
  getDefaultTags?: () => string[] | undefined;
}

// ─── Return Type ─────────────────────────────────────────────

/** Callback for subscribing to raw gateway events */
export type EventListener = (event: string, payload: unknown) => void;

export interface UseChatGatewayReturn {
  messages: Message[];
  isConnected: boolean;
  isQuerying: boolean;
  /** Whether context compaction is currently in progress */
  isCompacting: boolean;
  sessionId: string | null;
  usage: Usage | null;
  eventCount: number;
  streamEventCount: number;
  simulatedEventCount: number;
  toolSimulationIntervalMs: number;
  visibleCount: number;
  /** Total messages in the full session history */
  totalMessages: number;
  /** Whether there are older messages available to load */
  hasMore: boolean;
  workspace: WorkspaceInfo | null;
  sessions: SessionInfo[];
  subagents: SubagentInfo[];
  /** Whether user is scrolled to bottom (for auto-scroll indicator) */
  isAtBottom: boolean;
  sendPrompt(text: string, attachments: Attachment[], tags?: string[]): void;
  sendToolResult(toolUseId: string, content: string, isError?: boolean, tags?: string[]): void;
  sendInterrupt(): void;
  loadEarlierMessages(): void;
  createNewSession(title?: string): void;
  switchSession(sessionId: string): void;
  /** Send a raw gateway request (for listing pages) */
  sendRequest(method: string, params?: Record<string, unknown>, tags?: string[]): void;
  setToolSimulationIntervalMs(ms: number): void;
  /** Subscribe to raw gateway events. Returns unsubscribe function. */
  onEvent(listener: EventListener): () => void;
  /** Server-assigned connection ID for this WebSocket session */
  connectionId: string | null;
  /** Latest hook state per hookId (e.g., { "git-status": { modified: 2, ... } }) */
  hookState: Record<string, unknown>;
  /** Latest git status emitted at end-of-turn for the active session. */
  gitStatus: GitStatusInfo | null;
  messagesContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

// ─── Hook ────────────────────────────────────────────────────

export function useChatGateway(
  gatewayUrl: string,
  options: UseChatGatewayOptions = {},
): UseChatGatewayReturn {
  const { client, isConnected, call } = useGatewayClient(gatewayUrl);
  const [messages, setMessages] = useImmer<Message[]>([]);
  const [isQuerying, setIsQuerying] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [eventCount, setEventCount] = useState(0);
  const [streamEventCount, setStreamEventCount] = useState(0);
  const [simulatedEventCount, setSimulatedEventCount] = useState(0);
  const [toolSimulationIntervalMs, setToolSimulationIntervalMsState] =
    useState(DEFAULT_TOOL_SIM_TICK_MS);
  const [visibleCount, setVisibleCount] = useState(50);
  const [totalMessages, setTotalMessages] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [subagents, setSubagents] = useState<SubagentInfo[]>([]);
  const [hookState, setHookState] = useState<Record<string, unknown>>({});
  const [gitStatus, setGitStatus] = useState<GitStatusInfo | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const connectionIdRef = useRef<string | null>(null);
  const isQueryingRef = useRef(isQuerying);
  const sessionIdRef = useRef(sessionId);
  const workspaceRef = useRef(workspace);
  const historyLoadedRef = useRef(false);
  const sendRequestImplRef = useRef<
    (method: string, params?: Record<string, unknown>, tags?: string[]) => void
  >(() => undefined);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const subscribedSessionRef = useRef<string | null>(null);
  const ignoringHaikuMessageRef = useRef(false);
  const eventListenersRef = useRef<Set<EventListener>>(new Set());
  const activeToolUseIdsRef = useRef<Set<string>>(new Set());
  const toolTickIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const toolSimTickMsRef = useRef(toolSimulationIntervalMs);
  const isAtBottomRef = useRef(true); // Track if user is scrolled to bottom
  const [isAtBottom, setIsAtBottom] = useState(true); // Expose for UI indicator

  const normalizeUsage = useCallback((usageData: Usage): Usage => {
    return {
      input_tokens: usageData.input_tokens || 0,
      cache_creation_input_tokens: usageData.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usageData.cache_read_input_tokens || 0,
      output_tokens: usageData.output_tokens || 0,
    };
  }, []);

  const normalizeSubagent = useCallback((raw: Record<string, unknown>): SubagentInfo | null => {
    const subagentId = typeof raw.subagentId === "string" ? raw.subagentId : null;
    const parentSessionId = typeof raw.parentSessionId === "string" ? raw.parentSessionId : null;
    if (!subagentId || !parentSessionId) return null;

    const statusRaw = typeof raw.status === "string" ? raw.status : "running";
    const status: SubagentInfo["status"] =
      statusRaw === "completed" ||
      statusRaw === "failed" ||
      statusRaw === "interrupted" ||
      statusRaw === "running"
        ? statusRaw
        : "running";

    return {
      subagentId,
      parentSessionId,
      agent: typeof raw.agent === "string" ? raw.agent : "codex",
      purpose: typeof raw.purpose === "string" ? raw.purpose : "subagent",
      status,
      prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
      cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
      error: typeof raw.error === "string" ? raw.error : undefined,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : undefined,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
      previewText: typeof raw.previewText === "string" ? raw.previewText : undefined,
    };
  }, []);

  const sortSubagents = useCallback((items: SubagentInfo[]): SubagentInfo[] => {
    return [...items].sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (a.status !== "running" && b.status === "running") return 1;
      const aTime = Date.parse(a.updatedAt || a.startedAt || "") || 0;
      const bTime = Date.parse(b.updatedAt || b.startedAt || "") || 0;
      return bTime - aTime;
    });
  }, []);

  const applyUsage = useCallback(
    (usageData?: Usage) => {
      if (!usageData) return;
      setUsage(normalizeUsage(usageData));
    },
    [normalizeUsage],
  );

  useEffect(() => {
    isQueryingRef.current = isQuerying;
  }, [isQuerying]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => {
    toolSimTickMsRef.current = toolSimulationIntervalMs;
  }, [toolSimulationIntervalMs]);

  // Track scroll position to determine if auto-scroll should be enabled
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const updateScrollPosition = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      // Consider "at bottom" if within 100px of bottom (accounts for rounding and smooth scroll)
      const atBottom = scrollHeight - scrollTop - clientHeight < 100;
      isAtBottomRef.current = atBottom;
      setIsAtBottom(atBottom);
    };

    // Detect user-initiated scroll interactions (wheel, touch, keyboard)
    // When user manually scrolls during streaming, disable auto-scroll immediately
    const handleUserScroll = (e: Event) => {
      // Ignore key events that originate from editable controls or modifier shortcuts
      // so native text editing shortcuts (Cmd/Ctrl + C/V/X/A/Z) are not disturbed.
      if (e.type === "keydown" && e instanceof KeyboardEvent) {
        const target = e.target as HTMLElement | null;
        const isEditableTarget =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target?.isContentEditable;
        if (isEditableTarget || e.metaKey || e.ctrlKey || e.altKey) {
          return;
        }
      }

      // User is manually scrolling - disable auto-scroll immediately
      isAtBottomRef.current = false;
      setIsAtBottom(false);
      // After user scroll completes, check actual position
      requestAnimationFrame(updateScrollPosition);
    };

    const handleScroll = () => {
      // Natural scroll position updates (not during user interaction)
      updateScrollPosition();
    };

    // Listen for user scroll interactions
    container.addEventListener("wheel", handleUserScroll, { passive: true });
    container.addEventListener("touchstart", handleUserScroll, { passive: true });
    container.addEventListener("keydown", handleUserScroll);
    container.addEventListener("scroll", handleScroll);

    return () => {
      container.removeEventListener("wheel", handleUserScroll);
      container.removeEventListener("touchstart", handleUserScroll);
      container.removeEventListener("keydown", handleUserScroll);
      container.removeEventListener("scroll", handleScroll);
    };
  }, []);

  // Auto-scroll to bottom (instant for history load, smooth for streaming)
  // Only scroll if user is already at the bottom
  useEffect(() => {
    if (!isAtBottomRef.current) return; // Don't fight the user if they scrolled up
    const behavior = historyLoadedRef.current ? "smooth" : "instant";
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, [messages]);

  const sendRequest = useCallback(
    (method: string, params?: Record<string, unknown>, tags?: string[]) => {
      sendRequestImplRef.current(method, params, tags);
    },
    [],
  );

  // Subscribe to session-scoped streaming events when we learn the sessionId
  // Uses client.subscribe()/unsubscribe() so subscriptions are tracked for reconnect restoration
  const subscribeToSession = useCallback(
    (sid: string) => {
      if (subscribedSessionRef.current === sid) return;

      // Unsubscribe from old session's stream if any
      if (subscribedSessionRef.current) {
        void client?.unsubscribe([`session.${subscribedSessionRef.current}.*`]).catch(() => {});
      }

      // Subscribe to this session's stream events
      void client?.subscribe([`session.${sid}.*`]).catch(() => {});
      subscribedSessionRef.current = sid;
      console.log(`[WS] Subscribed to session: session.${sid.slice(0, 8)}...*`);
    },
    [client],
  );

  // ── Message mutation helpers ────────────────────────────────

  const stopToolTickSimulation = useCallback(() => {
    activeToolUseIdsRef.current.clear();
    if (toolTickIntervalRef.current) {
      clearInterval(toolTickIntervalRef.current);
      toolTickIntervalRef.current = null;
    }
  }, []);

  const startToolTickSimulation = useCallback(() => {
    if (toolTickIntervalRef.current) return;
    toolTickIntervalRef.current = setInterval(() => {
      if (!isQueryingRef.current) return;
      setEventCount((c) => c + 1);
      setSimulatedEventCount((c) => c + 1);
    }, toolSimTickMsRef.current);
  }, []);

  const markToolUseStarted = useCallback(
    (toolUseId: string) => {
      activeToolUseIdsRef.current.add(toolUseId);
      startToolTickSimulation();
    },
    [startToolTickSimulation],
  );

  const markToolUseCompleted = useCallback(
    (toolUseId: string) => {
      activeToolUseIdsRef.current.delete(toolUseId);
      if (activeToolUseIdsRef.current.size === 0) stopToolTickSimulation();
    },
    [stopToolTickSimulation],
  );

  const setToolSimulationIntervalMs = useCallback(
    (ms: number) => {
      const next = Math.max(MIN_TOOL_SIM_TICK_MS, Math.min(MAX_TOOL_SIM_TICK_MS, Math.round(ms)));
      setToolSimulationIntervalMsState(next);
      toolSimTickMsRef.current = next;

      if (toolTickIntervalRef.current) {
        clearInterval(toolTickIntervalRef.current);
        toolTickIntervalRef.current = null;
        if (activeToolUseIdsRef.current.size > 0 && isQueryingRef.current) {
          startToolTickSimulation();
        }
      }
    },
    [startToolTickSimulation],
  );

  const addBlock = useCallback(
    (block: ContentBlock) => {
      setMessages((draft) => {
        const lastMsg = draft[draft.length - 1];
        if (lastMsg && lastMsg.role === "assistant") {
          lastMsg.blocks.push(block);
        }
      });
    },
    [setMessages],
  );

  const appendToCurrentBlock = useCallback(
    (text: string, field: string = "content") => {
      setMessages((draft) => {
        const lastMsg = draft[draft.length - 1];
        if (lastMsg?.role === "assistant") {
          const lastBlock = lastMsg.blocks[lastMsg.blocks.length - 1];
          if (lastBlock) {
            if (field === "content" && "content" in lastBlock) {
              (lastBlock as TextBlock).content += text;
            } else if (field === "input" && "input" in lastBlock) {
              (lastBlock as ToolUseBlock).input += text;
            }
          }
        }
      });
    },
    [setMessages],
  );

  const updateToolResult = useCallback(
    (toolUseId: string, result: { content: string; is_error?: boolean }) => {
      setMessages((draft) => {
        for (const msg of draft) {
          if (msg.role !== "assistant") continue;
          for (const block of msg.blocks) {
            if (block.type === "tool_use" && block.id === toolUseId) {
              block.result = result;
              return;
            }
          }
        }
      });
    },
    [setMessages],
  );

  // ── Stream event handler ───────────────────────────────────

  const handleStreamEvent = useCallback(
    (eventType: string, payload: Record<string, unknown>) => {
      setEventCount((c) => c + 1);
      setStreamEventCount((c) => c + 1);

      // Auto-enable thinking for streaming content events (mid-turn recovery after HMR/refresh)
      // Only after history has loaded — otherwise stale events during reconnect cause false positives
      if (
        !isQueryingRef.current &&
        historyLoadedRef.current &&
        ![
          "ping",
          "turn_start",
          "turn_stop",
          "user_message",
          "api_warning",
          "api_error",
          "process_started",
          "process_ended",
          "session_stale",
          "process_died",
          "git_status",
        ].includes(eventType)
      ) {
        setIsQuerying(true);
        setEventCount(0);
        setStreamEventCount(0);
        setSimulatedEventCount(0);
      }

      switch (eventType) {
        case "user_message": {
          // Broadcast from another connection — add to our message list
          const senderConnectionId = payload.connectionId as string | undefined;
          if (senderConnectionId && senderConnectionId === connectionIdRef.current) break; // skip our own

          const rawContent = payload.content as string | unknown[];
          const blocks: ContentBlock[] = [];
          if (typeof rawContent === "string") {
            blocks.push({ type: "text", content: rawContent });
          } else if (Array.isArray(rawContent)) {
            for (const item of rawContent as Record<string, unknown>[]) {
              if (item.type === "text") {
                blocks.push({ type: "text", content: (item.text as string) || "" });
              } else if (item.type === "image") {
                const src = item.source as Record<string, string>;
                blocks.push({ type: "image", mediaType: src.media_type, data: src.data });
              } else if (item.type === "document") {
                const src = item.source as Record<string, string>;
                blocks.push({
                  type: "file",
                  mediaType: src.media_type,
                  data: src.data,
                  filename: "",
                });
              }
            }
          }
          if (blocks.length > 0) {
            setMessages((draft) => {
              draft.push({ role: "user", blocks, timestamp: Date.now() });
            });
          }
          break;
        }

        case "turn_start":
          setIsQuerying(true);
          setEventCount(0);
          setStreamEventCount(0);
          setSimulatedEventCount(0);
          break;

        case "turn_stop":
          stopToolTickSimulation();
          setIsQuerying(false);
          break;

        case "git_status": {
          const p = payload as Partial<GitStatusInfo> & { sessionId?: string };
          setGitStatus({
            branch: p.branch ?? null,
            ahead: p.ahead ?? 0,
            behind: p.behind ?? 0,
            dirty: p.dirty ?? {
              modified: 0,
              added: 0,
              deleted: 0,
              untracked: 0,
              renamed: 0,
              total: 0,
            },
            pr: p.pr ?? null,
          });
          break;
        }

        case "message_start": {
          // Filter out Haiku model responses (they contain <is_displaying_contents> artifacts)
          const message = payload.message as { model?: string } | undefined;
          if (message?.model?.includes("haiku")) {
            ignoringHaikuMessageRef.current = true;
            return;
          }

          ignoringHaikuMessageRef.current = false;
          setMessages((draft) => {
            const lastMsg = draft[draft.length - 1];
            if (!lastMsg || lastMsg.role !== "assistant" || lastMsg.blocks.length > 0) {
              draft.push({ role: "assistant", blocks: [], timestamp: Date.now() });
            }
          });
          break;
        }

        case "message_stop":
          // Individual message done — turn may continue with tool calls
          if (ignoringHaikuMessageRef.current) {
            ignoringHaikuMessageRef.current = false;
            return;
          }
          break;

        case "content_block_start": {
          if (ignoringHaikuMessageRef.current) return;

          const block = payload.content_block as
            | { type: string; id?: string; name?: string }
            | undefined;
          if (!block) return;
          if (block.type === "text") addBlock({ type: "text", content: "" });
          else if (block.type === "thinking") addBlock({ type: "thinking", content: "" });
          else if (block.type === "tool_use") {
            const toolUseId = block.id || generateId();
            addBlock({ type: "tool_use", id: toolUseId, name: block.name || "", input: "" });
            markToolUseStarted(toolUseId);
          }
          break;
        }

        case "content_block_delta": {
          if (ignoringHaikuMessageRef.current) return;

          const delta = payload.delta as
            | { type: string; text?: string; thinking?: string; partial_json?: string }
            | undefined;
          if (!delta) return;
          if (delta.type === "text_delta" && delta.text) appendToCurrentBlock(delta.text);
          else if (delta.type === "thinking_delta" && delta.thinking)
            appendToCurrentBlock(delta.thinking);
          else if (delta.type === "input_json_delta" && delta.partial_json)
            appendToCurrentBlock(delta.partial_json, "input");
          break;
        }

        case "request_tool_results": {
          const results = payload.tool_results as
            | Array<{ tool_use_id: string; content: string; is_error?: boolean }>
            | undefined;
          for (const result of results || []) {
            markToolUseCompleted(result.tool_use_id);
            updateToolResult(result.tool_use_id, {
              content: result.content,
              is_error: result.is_error,
            });
          }
          break;
        }

        case "message_delta": {
          if (ignoringHaikuMessageRef.current) return;

          const delta = payload.delta as { stop_reason?: string } | undefined;
          if (delta?.stop_reason === "abort") {
            setMessages((draft) => {
              const lastMsg = draft[draft.length - 1];
              if (lastMsg?.role === "assistant") lastMsg.aborted = true;
            });
          }
          applyUsage(payload.usage as Usage | undefined);
          break;
        }

        case "compaction_start":
          setIsCompacting(true);
          console.log("[Compaction] ⚡ Started");
          break;

        case "compaction_end": {
          setIsCompacting(false);
          const trigger = (payload.trigger as string) || "auto";
          const preTokens = (payload.pre_tokens as number) || 0;
          console.log(`[Compaction] ✓ Complete (trigger: ${trigger}, pre_tokens: ${preTokens})`);

          // Update usage immediately after compaction
          applyUsage(payload.usage as Usage | undefined);

          // Insert a compaction boundary marker into messages
          setMessages((draft) => {
            draft.push({
              role: "compaction_boundary",
              blocks: [],
              timestamp: Date.now(),
              compaction: {
                trigger: trigger as "manual" | "auto",
                pre_tokens: preTokens,
              },
            });
          });
          break;
        }

        case "process_died": {
          stopToolTickSimulation();
          setIsCompacting(false); // Clear stuck compaction state
          setIsQuerying(false); // Clear stuck querying state
          const exitCode = (payload.exitCode as number) || 0;
          const reason = (payload.reason as string) || "Process died";
          console.error(`[Runtime] Process died unexpectedly (exit code: ${exitCode}): ${reason}`);

          // Add error message to chat
          setMessages((draft) => {
            draft.push({
              role: "assistant",
              blocks: [
                {
                  type: "error",
                  message: `Claude process died unexpectedly (exit code: ${exitCode}). Please restart the session.`,
                  status: exitCode,
                },
              ],
              timestamp: Date.now(),
            });
          });
          break;
        }

        case "session_stale": {
          const minutes = (payload.minutesSinceActivity as number) || 0;
          console.warn(`[Runtime] Session appears stale (${minutes}m since last activity)`);
          break;
        }

        case "api_error": {
          stopToolTickSimulation();
          console.error(`[API Error] ${payload.status}: ${payload.message}`);
          const errorBlock: ErrorBlock = {
            type: "error",
            message: (payload.message as string) || `API error ${payload.status}`,
            status: payload.status as number,
          };
          // Ensure there's an assistant message to attach to
          setMessages((draft) => {
            const lastMsg = draft[draft.length - 1];
            if (lastMsg?.role === "assistant") {
              lastMsg.blocks.push(errorBlock);
            } else {
              draft.push({ role: "assistant", blocks: [errorBlock], timestamp: Date.now() });
            }
          });
          setIsQuerying(false);
          break;
        }

        case "api_warning": {
          console.warn(
            `[API Retry] Attempt ${payload.attempt}/${payload.maxRetries}: ${payload.message}`,
          );
          const warningBlock: ErrorBlock = {
            type: "error",
            message:
              (payload.message as string) || `API retry ${payload.attempt}/${payload.maxRetries}`,
            status: payload.status as number,
            isRetrying: true,
            attempt: payload.attempt as number,
            maxRetries: payload.maxRetries as number,
            retryInMs: payload.retryInMs as number,
          };
          // Add retry indicator to current assistant message
          setMessages((draft) => {
            const lastMsg = draft[draft.length - 1];
            if (lastMsg?.role === "assistant") {
              lastMsg.blocks.push(warningBlock);
            } else {
              draft.push({ role: "assistant", blocks: [warningBlock], timestamp: Date.now() });
            }
          });
          break;
        }

        default:
          break;
      }
    },
    [
      addBlock,
      appendToCurrentBlock,
      updateToolResult,
      setMessages,
      markToolUseStarted,
      markToolUseCompleted,
      applyUsage,
      stopToolTickSimulation,
    ],
  );

  const handleGatewayResponse = useCallback(
    (method: string, payload: Record<string, unknown>) => {
      // Track session ID from any response that includes it
      if (payload.sessionId && typeof payload.sessionId === "string") {
        setSessionId(payload.sessionId as string);
      }

      // ── session.get_history ──
      if (method === "session.get_history") {
        const historyMessages = payload.messages as Message[] | undefined;
        const historyUsage = payload.usage as Usage | undefined;
        const historyGitStatus = payload.gitStatus as
          | (GitStatusInfo & { capturedAt?: string })
          | undefined;
        const total = (payload.total as number) || 0;
        const more = (payload.hasMore as boolean) || false;
        const offset = (payload.offset as number) || 0;

        if (historyMessages && historyMessages.length > 0) {
          if (offset > 0) {
            // Loading earlier messages — prepend to existing
            setMessages((draft) => {
              draft.unshift(...historyMessages);
            });
            setVisibleCount((c) => c + historyMessages.length);
            // Preserve scroll position after prepend
            const container = messagesContainerRef.current;
            if (container) {
              const prevScrollHeight = container.scrollHeight;
              requestAnimationFrame(() => {
                const newScrollHeight = container.scrollHeight;
                container.scrollTop = newScrollHeight - prevScrollHeight;
              });
            }
          } else {
            // Initial load — replace all messages
            setMessages(() => historyMessages);
            setVisibleCount(historyMessages.length);
          }
          console.log(
            `[History] Loaded ${historyMessages.length}/${total} messages (offset: ${offset}, hasMore: ${more})`,
          );
        }
        // Mark history as loaded (even if empty) so streaming auto-recovery can activate.
        // Brief delay lets any stale events from reconnect settle first.
        if (offset === 0) {
          setTimeout(() => {
            historyLoadedRef.current = true;
          }, 100);
        }
        setTotalMessages(total);
        setHasMore(more);
        if (offset === 0 && historyGitStatus) {
          setGitStatus({
            branch: historyGitStatus.branch ?? null,
            ahead: historyGitStatus.ahead ?? 0,
            behind: historyGitStatus.behind ?? 0,
            dirty: historyGitStatus.dirty ?? {
              modified: 0,
              added: 0,
              deleted: 0,
              untracked: 0,
              renamed: 0,
              total: 0,
            },
            pr: historyGitStatus.pr ?? null,
          });
        }
        // Always set usage - use provided data or initialize to zero if not available
        if (historyUsage) {
          setUsage(normalizeUsage(historyUsage));
        } else if (offset === 0) {
          // Initialize with zero usage on first load if backend doesn't provide it
          setUsage({
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
          });
        }
      }

      // ── session.get_or_create_workspace (VS Code auto-discover) ──
      if (method === "session.get_or_create_workspace") {
        const ws = payload.workspace as WorkspaceInfo | undefined;
        if (ws) {
          setWorkspace(ws);
          console.log(
            `[Workspace] ${payload.created ? "Created" : "Loaded"}: ${ws.name} (${ws.id}), cwd: ${ws.cwd}`,
          );

          // Load session list for this workspace (uses cwd)
          sendRequest("session.list_sessions", { cwd: ws.cwd });
        }
      }

      // ── session.get_workspace (fetch single workspace) ──
      if (method === "session.get_workspace") {
        const ws = payload.workspace as WorkspaceInfo | undefined;
        if (ws) {
          setWorkspace(ws);
          console.log(`[Workspace] Loaded: ${ws.name} (${ws.id})`);
        }
      }

      // ── session.list_sessions ──
      if (method === "session.list_sessions") {
        const sessionList = payload.sessions as SessionInfo[] | undefined;
        if (sessionList) {
          setSessions(sessionList);
          console.log(
            `[Sessions] Loaded ${sessionList.length} sessions`,
            sessionList.map((s) => `${s.sessionId.slice(0, 8)}…`),
          );

          // If we don't have a session yet, auto-select the most recent one
          // In route-scoped mode, the caller controls session selection.
          // Never auto-select from list_sessions there.
          if (optionsRef.current.sessionId) {
            return;
          }

          if (sessionList.length > 0 && !sessionIdRef.current) {
            const mostRecent = sessionList[0]; // already sorted by modified desc
            setSessionId(mostRecent.sessionId);
            subscribeToSession(mostRecent.sessionId);
            sendRequest("session.get_history", { sessionId: mostRecent.sessionId, limit: 50 });
            sendRequest("session.list_subagents", { parentSessionId: mostRecent.sessionId });
          }
        }
      }

      // ── session.create_session ──
      if (method === "session.create_session") {
        const newSessionId = payload.sessionId as string | undefined;
        if (newSessionId) {
          setSessionId(newSessionId);
          subscribeToSession(newSessionId);
          setMessages(() => []);
          setSubagents(() => []);
          setUsage(null);
          setGitStatus(null);
          setTotalMessages(0);
          setHasMore(false);
          historyLoadedRef.current = false;
          console.log(`[Session] Created: ${newSessionId}`);
          sendRequest("session.list_subagents", { parentSessionId: newSessionId });
          // Refresh session list
          if (workspaceRef.current?.cwd) {
            sendRequest("session.list_sessions", { cwd: workspaceRef.current.cwd });
          }
        }
      }

      // ── session.switch_session ──
      if (method === "session.switch_session") {
        const switchedSessionId = payload.sessionId as string | undefined;
        if (switchedSessionId) {
          setSessionId(switchedSessionId);
          subscribeToSession(switchedSessionId);
          setMessages(() => []);
          setSubagents(() => []);
          setUsage(null);
          setGitStatus(null);
          setTotalMessages(0);
          setHasMore(false);
          historyLoadedRef.current = false;
          console.log(`[Session] Switched to: ${switchedSessionId}`);
          sendRequest("session.get_history", { sessionId: switchedSessionId, limit: 50 });
          sendRequest("session.list_subagents", { parentSessionId: switchedSessionId });
          if (workspaceRef.current?.cwd) {
            sendRequest("session.list_sessions", { cwd: workspaceRef.current.cwd });
          }
        }
      }

      // ── session.get_info ──
      if (method === "session.get_info") {
        // In route-scoped mode, ignore global active-session info from other workspaces.
        if (optionsRef.current.sessionId) {
          return;
        }
        if (payload.sessionId) {
          const infoSessionId = payload.sessionId as string;
          setSessionId(infoSessionId);
          subscribeToSession(infoSessionId);
          sendRequest("session.list_subagents", { parentSessionId: infoSessionId });
        }
        if (payload.workspaceId && payload.workspaceName) {
          setWorkspace((prev) =>
            prev
              ? {
                  ...prev,
                  id: payload.workspaceId as string,
                  name: payload.workspaceName as string,
                }
              : null,
          );
        }
      }

      // ── session.list_subagents ──
      if (method === "session.list_subagents") {
        const subagentList = Array.isArray(payload.subagents)
          ? payload.subagents
              .map((item) =>
                item && typeof item === "object"
                  ? normalizeSubagent(item as Record<string, unknown>)
                  : null,
              )
              .filter((item): item is SubagentInfo => Boolean(item))
          : [];
        const currentSessionId = sessionIdRef.current;
        setSubagents(() =>
          sortSubagents(
            subagentList.filter(
              (subagent) => !currentSessionId || subagent.parentSessionId === currentSessionId,
            ),
          ),
        );
      }
    },
    [
      normalizeSubagent,
      normalizeUsage,
      sendRequest,
      setMessages,
      sortSubagents,
      subscribeToSession,
    ],
  );

  const handleGatewayEvent = useCallback(
    (eventName: string, payload: unknown) => {
      // Capture server-assigned connectionId on connect
      if (eventName === "gateway.welcome") {
        const welcomePayload = payload as { connectionId?: string };
        if (welcomePayload?.connectionId) {
          connectionIdRef.current = welcomePayload.connectionId;
        } else if (client?.connectionId) {
          connectionIdRef.current = client.connectionId;
        }
        return;
      }

      // Streaming events: "session.{sessionId}.{eventType}"
      // Extract the eventType (everything after "session.{sessionId}.")
      const parts = eventName.split(".");

      if (parts[0] === "session" && parts.length >= 3) {
        const eventSessionId = parts[1] || null;
        if (!eventSessionId) {
          return;
        }
        const eventType = parts.slice(2).join(".");
        const eventPayload = (payload ?? {}) as Record<string, unknown>;

        if (eventSessionId !== sessionIdRef.current) {
          setSubagents((prev) => {
            const idx = prev.findIndex((subagent) => subagent.subagentId === eventSessionId);
            if (idx < 0) return prev;
            const next = [...prev];
            const current = next[idx];
            const merged: SubagentInfo = { ...current, updatedAt: new Date().toISOString() };

            if (eventType === "content_block_delta") {
              const delta = eventPayload.delta as { type?: string; text?: string } | undefined;
              if (delta?.type === "text_delta" && delta.text) {
                const appended = `${merged.previewText || ""}${delta.text}`;
                merged.previewText = appended.length > 280 ? appended.slice(-280) : appended;
              }
            } else if (eventType === "turn_stop") {
              merged.status = eventPayload.stop_reason === "abort" ? "interrupted" : "completed";
            } else if (eventType === "process_died") {
              merged.status = "failed";
              merged.error =
                typeof eventPayload.reason === "string" ? eventPayload.reason : "Runtime failed";
            } else {
              return prev;
            }

            next[idx] = merged;
            return sortSubagents(next);
          });
          return;
        }

        handleStreamEvent(eventType, (payload ?? {}) as Record<string, unknown>);
      }

      // Hook events: "hook.{hookId}.{event}" — store latest state per hookId
      if (parts[0] === "hook" && parts.length >= 3) {
        const hookId = parts[1];
        setHookState((prev) => ({ ...prev, [hookId]: payload }));
      }

      // Fire raw event listeners (for voice, extensions, etc.)
      for (const listener of eventListenersRef.current) {
        try {
          listener(eventName, payload);
        } catch {
          // Don't let listener errors break the event loop
        }
      }
    },
    [client, handleStreamEvent, sortSubagents],
  );

  useEffect(() => {
    sendRequestImplRef.current = (method, params, tags) => {
      const callOptions = tags?.length ? { tags } : undefined;
      void call(method, params, callOptions)
        .then((payload) => {
          if (payload && typeof payload === "object") {
            handleGatewayResponse(method, payload as Record<string, unknown>);
          } else {
            handleGatewayResponse(method, {});
          }
        })
        .catch((error) => {
          console.error(`[Gateway] ${method} failed`, error);
        });
    };
  }, [call, handleGatewayResponse]);

  useEffect(() => {
    if (!client) return;
    const unsubscribe = client.on("*", handleGatewayEvent);
    return () => unsubscribe();
  }, [client, handleGatewayEvent]);

  // Reset subscription tracking on disconnect so reconnect re-subscribes properly
  useEffect(() => {
    if (!isConnected) {
      subscribedSessionRef.current = null;
    }
  }, [isConnected]);

  useEffect(() => {
    if (!isConnected) {
      console.log("Disconnected from Gateway");
      return;
    }

    console.log("Connected to Anima Gateway");

    // Subscribe to voice and hook events (global, not session-scoped)
    // Use client.subscribe() so these are tracked for automatic reconnect restoration
    void client?.subscribe([...GLOBAL_EVENT_SUBSCRIPTIONS]).catch(() => {});

    const opts = optionsRef.current;

    if (opts.sessionId) {
      // ── Web client: explicit session ID (CC UUID) ──
      // Load history and subscribe to stream
      setSessionId(opts.sessionId);
      subscribeToSession(opts.sessionId);
      sendRequest("session.get_history", { sessionId: opts.sessionId, limit: 50 });
      sendRequest("session.list_subagents", { parentSessionId: opts.sessionId });
      // Look up workspace for CWD context (needed for send-prompt auto-resume)
      if (opts.workspaceId) {
        sendRequest("session.get_workspace", { id: opts.workspaceId });
      }
    } else if (opts.autoDiscoverCwd) {
      // ── VS Code: auto-discover by CWD ──
      // This triggers workspace creation + session discovery + history loading
      sendRequest("session.get_or_create_workspace", { cwd: opts.autoDiscoverCwd });
    } else {
      // ── No session specified (e.g. listing pages) ──
      // Just get basic info
      sendRequest("session.get_info");
    }
  }, [client, isConnected, sendRequest, subscribeToSession]);

  useEffect(() => {
    return () => {
      const events: string[] = [...GLOBAL_EVENT_SUBSCRIPTIONS];
      if (subscribedSessionRef.current) {
        events.push(`session.${subscribedSessionRef.current}.*`);
        subscribedSessionRef.current = null;
      }
      void client?.unsubscribe(events).catch(() => {
        // Ignore cleanup unsubscribe failures during route transitions/shutdown.
      });
    };
  }, [client]);

  useEffect(() => {
    return () => {
      stopToolTickSimulation();
    };
  }, [stopToolTickSimulation]);

  // ── Actions ────────────────────────────────────────────────

  const sendPrompt = useCallback(
    (text: string, attachments: Attachment[], tags?: string[]) => {
      if ((!text.trim() && attachments.length === 0) || !isConnected) return;
      // Optimistic turn-start so thinking UI appears immediately even if stream
      // turn_start event is delayed or dropped.
      setIsQuerying(true);
      setEventCount(0);
      setStreamEventCount(0);
      setSimulatedEventCount(0);
      stopToolTickSimulation();

      const blocks: ContentBlock[] = [
        ...attachments
          .filter((f) => f.type === "image")
          .map((f) => ({
            type: "image" as const,
            mediaType: f.mediaType,
            data: f.data,
          })),
        ...attachments
          .filter((f) => f.type === "file")
          .map((f) => ({
            type: "file" as const,
            mediaType: f.mediaType,
            data: f.data,
            filename: f.filename,
          })),
        ...(text.trim() ? [{ type: "text" as const, content: text }] : []),
      ];

      setMessages((draft) => {
        draft.push({ role: "user", blocks, timestamp: Date.now() });
      });

      // Build content for the API — plain string if text-only, array of content blocks if attachments
      let content: string | unknown[];
      if (attachments.length === 0) {
        content = text;
      } else {
        content = [
          ...attachments
            .filter((f) => f.type === "image")
            .map((f) => ({
              type: "image",
              source: { type: "base64", media_type: f.mediaType, data: f.data },
            })),
          ...attachments
            .filter((f) => f.type === "file")
            .map((f) => ({
              type: "document",
              source: { type: "base64", media_type: f.mediaType, data: f.data },
            })),
          ...(text.trim() ? [{ type: "text", text }] : []),
        ];
      }

      // Pass session ID so the gateway targets the right session
      const sid = sessionIdRef.current;
      if (!sid) {
        console.warn("[sendPrompt] missing sessionId");
        return;
      }
      const params: Record<string, unknown> = {
        content,
        sessionId: sid,
        cwd: workspaceRef.current?.cwd,
      };
      sendRequest(
        "session.send_prompt",
        params,
        mergeRequestTags(tags, optionsRef.current.getDefaultTags?.()),
      );
    },
    [isConnected, sendRequest, setMessages, stopToolTickSimulation],
  );

  const sendToolResult = useCallback(
    (toolUseId: string, content: string, isError = false, tags?: string[]) => {
      const sid = sessionIdRef.current;
      if (!sid) {
        console.warn("[sendToolResult] missing sessionId");
        return;
      }
      sendRequest(
        "session.send_tool_result",
        { sessionId: sid, toolUseId, content, isError },
        mergeRequestTags(tags, optionsRef.current.getDefaultTags?.()),
      );
    },
    [sendRequest],
  );

  const sendInterrupt = useCallback(() => {
    if (!isQueryingRef.current) return;
    if (!sessionIdRef.current) return;
    sendRequest("session.interrupt_session", { sessionId: sessionIdRef.current });
  }, [sendRequest]);

  const loadEarlierMessages = useCallback(() => {
    if (!hasMore) return;
    if (!sessionIdRef.current) return;
    // Request next page of older messages from the server
    const offset = messages.length;
    const params: Record<string, unknown> = {
      sessionId: sessionIdRef.current,
      limit: 50,
      offset,
    };
    sendRequest("session.get_history", params);
  }, [hasMore, messages.length, sendRequest]);

  const createNewSession = useCallback(
    (_title?: string) => {
      if (!workspace?.cwd) return;
      if (subscribedSessionRef.current) {
        void client?.unsubscribe([`session.${subscribedSessionRef.current}.*`]).catch(() => {});
        subscribedSessionRef.current = null;
      }
      setSubagents(() => []);
      sendRequest("session.create_session", { cwd: workspace.cwd });
    },
    [client, sendRequest, workspace?.cwd],
  );

  const switchSession = useCallback(
    (sid: string) => {
      sendRequest("session.switch_session", { sessionId: sid, cwd: workspace?.cwd });
    },
    [sendRequest, workspace?.cwd],
  );

  const onEvent = useCallback((listener: EventListener): (() => void) => {
    eventListenersRef.current.add(listener);
    return () => {
      eventListenersRef.current.delete(listener);
    };
  }, []);

  return {
    messages,
    isConnected,
    isQuerying,
    isCompacting,
    sessionId,
    usage,
    eventCount,
    streamEventCount,
    simulatedEventCount,
    toolSimulationIntervalMs,
    visibleCount,
    totalMessages,
    hasMore,
    workspace,
    sessions,
    subagents,
    isAtBottom,
    sendPrompt,
    sendToolResult,
    sendInterrupt,
    loadEarlierMessages,
    createNewSession,
    switchSession,
    sendRequest,
    setToolSimulationIntervalMs,
    onEvent,
    connectionId: connectionIdRef.current,
    hookState,
    gitStatus,
    messagesContainerRef,
    messagesEndRef,
  };
}
