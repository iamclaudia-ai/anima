import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useGatewayClientContext } from "../contexts/GatewayClientContext";

// ── Toast data ───────────────────────────────────────────────
interface ToastData {
  id: string;
  message: string;
  taskName: string;
  timestamp: number;
}

// ── Toast component ──────────────────────────────────────────
function Toast({ toast, onDismiss }: { toast: ToastData; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 15_000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className="animate-in slide-in-from-top-2 fade-in duration-300 pointer-events-auto">
      <div className="bg-violet-200/90 backdrop-blur-xl border border-violet-300 rounded-xl px-5 py-4 shadow-2xl shadow-violet-400/20 max-w-md">
        <div className="flex items-start gap-3">
          <div className="shrink-0 w-8 h-8 rounded-full bg-violet-300/60 flex items-center justify-center text-sm">
            💙
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-violet-700 font-semibold mb-1">{toast.taskName}</div>
            <p className="text-sm text-violet-900 leading-relaxed">{toast.message}</p>
          </div>
          <button
            onClick={onDismiss}
            className="shrink-0 text-violet-400 hover:text-violet-600 transition-colors text-xs mt-0.5"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Global notifications provider ────────────────────────────
export function GlobalNotifications({ children }: { children: ReactNode }) {
  const ctx = useGatewayClientContext();
  const client = ctx?.client ?? null;
  const isConnected = ctx?.isConnected ?? false;
  const notificationPermissionRef = useRef(false);
  const [toasts, setToasts] = useState<ToastData[]>([]);

  // Request browser notification permission on mount
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().then((perm) => {
        notificationPermissionRef.current = perm === "granted";
      });
    } else if ("Notification" in window) {
      notificationPermissionRef.current = Notification.permission === "granted";
    }
  }, []);

  // Subscribe to scheduler notifications globally
  useEffect(() => {
    if (!client || !isConnected) return;

    client.subscribe(["scheduler.notification"]);

    const unsub = client.on("scheduler.notification", (_event, raw) => {
      const payload = raw as { taskId?: string; taskName?: string; message?: string };
      const message = payload.message ?? "Task completed";
      const taskName = payload.taskName ?? "Claudia";

      // In-app toast
      const toast: ToastData = {
        id: crypto.randomUUID(),
        message,
        taskName,
        timestamp: Date.now(),
      };
      setToasts((prev) => [...prev, toast]);

      // Browser notification
      if (notificationPermissionRef.current) {
        new Notification(`💙 ${taskName}`, { body: message, icon: "/favicon.ico" });
      }
    });

    return unsub;
  }, [client, isConnected]);

  const dismissToast = useCallback((toastId: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== toastId));
  }, []);

  return (
    <>
      {children}
      {/* Toast overlay — fixed top-right, always on top */}
      {toasts.length > 0 && (
        <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-3 pointer-events-none">
          {toasts.map((toast) => (
            <Toast key={toast.id} toast={toast} onDismiss={() => dismissToast(toast.id)} />
          ))}
        </div>
      )}
    </>
  );
}
