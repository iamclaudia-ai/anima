/**
 * ChatPanel — The conversation view.
 *
 * Reads active workspace/session from `useChatPage()`. Empty state when no
 * session is selected (so the user sees a "create one" prompt instead of a
 * blank panel).
 *
 * On mobile, the layout drops the nav panel — so this panel renders a
 * hamburger affordance in ClaudiaChat's Header that slides NavPanel in as
 * an overlay drawer. Auto-closes when the active session changes.
 */

import { useCallback, useEffect, useState } from "react";
import {
  ClaudiaChat,
  getRememberedPanelWidth,
  Link,
  rememberPanelWidth,
  useHeaderSlot,
  useIsMobile,
  useLayoutApi,
  useVoiceEnabled,
} from "@anima/ui";
import { PanelLeft, PanelLeftDashed, Volume2, VolumeX, X } from "lucide-react";
import { useChatPage } from "../context/ChatPageContext";
import { NavPanel } from "./NavPanel";

const NAV_PANEL_ID = "chat.nav";
const NAV_PANEL_DEFAULT_WIDTH = 280;
const EDITOR_PANEL_ID = "editor.viewer";
const EDITOR_PANEL_DEFAULT_WIDTH = 800;

export function ChatPanel() {
  const { activeWorkspace, activeSessionId, chatBridge, isConnected, onNewSession } = useChatPage();
  const isMobile = useIsMobile();
  const [navOpen, setNavOpen] = useState(false);
  // Voice on/off — shared with `ChatInner` via a pub/sub store so the toggle
  // here and the `voice.speak` tag inside the chat see the same value.
  const [voiceEnabled, toggleVoice] = useVoiceEnabled();

  // ── Layout panel toggles (nav + editor) ────────────────────
  // Desktop: each toggle adds/removes its panel from the dockview layout
  // via the LayoutManager's published api. Mobile: the layout doesn't
  // include `chat.nav` (the drawer is an overlay) and skips the editor
  // entirely, so the editor toggle is a no-op there.
  const layoutApi = useLayoutApi();
  const [isNavInLayout, setIsNavInLayout] = useState(false);
  const [isEditorInLayout, setIsEditorInLayout] = useState(false);

  // Mirror dockview's reality into local state so the icons stay in sync
  // with closes-by-drag, persisted-layout restores, etc. Both toggles
  // share one subscription since dockview emits a single change event.
  useEffect(() => {
    if (!layoutApi) return;
    const sync = () => {
      setIsNavInLayout(Boolean(layoutApi.getPanel(NAV_PANEL_ID)));
      setIsEditorInLayout(Boolean(layoutApi.getPanel(EDITOR_PANEL_ID)));
    };
    sync();
    const subscription = layoutApi.onDidLayoutChange(sync);
    return () => subscription.dispose();
  }, [layoutApi]);

  const isNavOpen = isMobile ? navOpen : isNavInLayout;

  const toggleNav = useCallback(() => {
    if (isMobile) {
      setNavOpen((prev) => !prev);
      return;
    }
    if (!layoutApi) return;
    const existing = layoutApi.getPanel(NAV_PANEL_ID);
    if (existing) {
      // Snapshot width before close — clamped by registered min/max
      // constraints, so a future open won't restore a stale extreme.
      rememberPanelWidth(NAV_PANEL_ID, existing.api.width);
      existing.api.close();
      return;
    }
    const ref = layoutApi.getPanel("chat.main");
    if (!ref) return;
    const width = getRememberedPanelWidth(NAV_PANEL_ID) ?? NAV_PANEL_DEFAULT_WIDTH;
    layoutApi.addPanel({
      id: NAV_PANEL_ID,
      component: "panel-wrapper",
      params: { panelId: NAV_PANEL_ID },
      title: "Workspaces",
      position: { referencePanel: ref, direction: "left" },
      initialWidth: width,
    });
    // `initialWidth` is unreliable when adding next to existing siblings —
    // dockview falls back to a 50/50 split. Pin the size in a microtask
    // so dockview has finished placing the panel first. (Same trick the
    // LayoutManager uses for initial layout build.)
    queueMicrotask(() => layoutApi.getPanel(NAV_PANEL_ID)?.api.setSize({ width }));
  }, [isMobile, layoutApi]);

  const toggleEditor = useCallback(() => {
    if (!layoutApi) return;
    const existing = layoutApi.getPanel(EDITOR_PANEL_ID);
    if (existing) {
      rememberPanelWidth(EDITOR_PANEL_ID, existing.api.width);
      existing.api.close();
      return;
    }
    const ref = layoutApi.getPanel("chat.main");
    if (!ref) return;
    const width = getRememberedPanelWidth(EDITOR_PANEL_ID) ?? EDITOR_PANEL_DEFAULT_WIDTH;
    layoutApi.addPanel({
      id: EDITOR_PANEL_ID,
      component: "panel-wrapper",
      params: { panelId: EDITOR_PANEL_ID },
      title: "Editor",
      position: { referencePanel: ref, direction: "right" },
      initialWidth: width,
    });
    queueMicrotask(() => layoutApi.getPanel(EDITOR_PANEL_ID)?.api.setSize({ width }));
  }, [layoutApi]);

  // ── Global header slots ────────────────────────────────────
  // ChatPanel is the canonical owner of "what chat-context is active right
  // now" — workspace name, connection status, link back home. Other
  // panels (editor, voice, …) contribute their own slots; the AppHeader
  // composes them into segments. See `useHeaderSlot` in @anima/ui.
  useHeaderSlot(
    "left",
    "chat.nav-toggle",
    <button
      type="button"
      onClick={toggleNav}
      className="rounded-md p-1.5 text-gray-600 transition-colors hover:bg-white/40 hover:text-gray-800"
      title={isNavOpen ? "Hide workspaces" : "Show workspaces"}
      aria-label={isNavOpen ? "Hide workspaces" : "Show workspaces"}
      aria-pressed={isNavOpen}
    >
      {isNavOpen ? <PanelLeftDashed className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
    </button>,
    { order: 10 },
  );
  useHeaderSlot(
    "left",
    "chat.home",
    <Link to="/" className="text-sm font-semibold text-purple-700 hover:text-purple-800">
      Anima
    </Link>,
    { order: 20 },
  );
  useHeaderSlot(
    "center",
    "chat.workspace",
    <span className="truncate text-sm font-medium text-gray-800">
      {activeWorkspace?.name ?? ""}
    </span>,
  );
  useHeaderSlot(
    "right",
    "editor.toggle",
    <button
      type="button"
      onClick={toggleEditor}
      className="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-white/40"
      title={isEditorInLayout ? "Hide editor" : "Show editor"}
      aria-label={isEditorInLayout ? "Hide editor" : "Show editor"}
      aria-pressed={isEditorInLayout}
    >
      <img
        src={isEditorInLayout ? "/editor/static/vscode.svg" : "/editor/static/vscode-alt.svg"}
        alt=""
        className="h-4 w-4"
      />
    </button>,
    // The editor panel isn't in the mobile layout, so the toggle is
    // meaningless there — skip the slot entirely.
    { order: 60, enabled: !isMobile },
  );
  useHeaderSlot(
    "right",
    "chat.voice",
    <button
      type="button"
      onClick={toggleVoice}
      className={`rounded-md p-1.5 transition-colors hover:bg-white/40 ${
        voiceEnabled ? "text-purple-700" : "text-gray-500"
      }`}
      title={voiceEnabled ? "Voice enabled — click to mute" : "Voice muted — click to enable"}
      aria-label={voiceEnabled ? "Mute voice" : "Enable voice"}
      aria-pressed={voiceEnabled}
    >
      {voiceEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
    </button>,
    { order: 75 },
  );
  useHeaderSlot(
    "right",
    "chat.connection",
    <span
      className={`block h-2 w-2 rounded-full ${isConnected ? "bg-green-500" : "bg-red-500"}`}
      title={isConnected ? "Connected" : "Disconnected"}
    />,
    { order: 90 },
  );

  // Auto-close the mobile drawer when the user picks a session, or when
  // we leave mobile (e.g., user rotates / resizes back to desktop). The
  // AppHeader's nav-toggle is the canonical way to open it now — we used
  // to render an inline hamburger here too, but the header toggle covers
  // both desktop and mobile, so the inline button became redundant.
  useEffect(() => {
    setNavOpen(false);
  }, [activeSessionId, activeWorkspace?.id, isMobile]);

  // Dockview's content container has its own (dark) background — paint over
  // it with white at the panel root so we don't inherit theme colors.
  let body: React.ReactNode;
  if (!activeSessionId || !activeWorkspace) {
    body = (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-white">
        <p className="text-gray-400">
          {activeWorkspace
            ? "No sessions yet for this workspace"
            : "Select a workspace to get started"}
        </p>
        {activeWorkspace && (
          <button
            type="button"
            onClick={() => onNewSession()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700"
          >
            Create new session
          </button>
        )}
      </div>
    );
  } else {
    body = (
      <div className="h-full w-full bg-white">
        <ClaudiaChat
          bridge={chatBridge}
          gatewayOptions={{ sessionId: activeSessionId, workspaceId: activeWorkspace.id }}
          // The global AppHeader already shows workspace name, connection
          // status, and (eventually) the voice toggle — let it own that
          // chrome and skip ClaudiaChat's per-instance Header on the web.
          showHeader={false}
          // Re-mount when workspace/session changes — keeps streaming state clean.
          key={`${activeWorkspace.id}-${activeSessionId}`}
        />
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      {body}
      {isMobile && navOpen && (
        <>
          {/* Backdrop — soft glass tint instead of a flat dim overlay
              gives depth while keeping the underlying chat readable. */}
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
            className="fixed inset-0 z-40 bg-gradient-to-b from-black/10 to-black/20 backdrop-blur-xs"
          />
          {/* Sliding drawer */}
          <div className="fixed inset-y-0 left-0 z-50 w-[85vw] max-w-[320px] bg-white shadow-xl">
            <button
              type="button"
              onClick={() => setNavOpen(false)}
              className="absolute top-2 right-2 z-10 rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
              aria-label="Close navigation"
            >
              <X className="h-5 w-5" />
            </button>
            <NavPanel />
          </div>
        </>
      )}
    </div>
  );
}
