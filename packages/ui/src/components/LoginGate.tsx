import { useState, type ReactNode, type FormEvent } from "react";
import { getStoredToken, setStoredToken, clearStoredToken } from "../hooks/gateway-url";

interface LoginGateProps {
  children: ReactNode;
}

/**
 * LoginGate — wraps the app and requires a valid gateway token before rendering.
 *
 * On first load:
 * - If a token is in localStorage, render children immediately
 * - If not, show a simple login form
 *
 * The token is validated against POST /api/auth/validate before being accepted.
 */
export function LoginGate({ children }: LoginGateProps) {
  const [hasToken, setHasToken] = useState(() => !!getStoredToken());
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;

    setChecking(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/validate", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${trimmed}`,
          "Content-Type": "application/json",
        },
      });

      if (res.ok) {
        setStoredToken(trimmed);
        setHasToken(true);
      } else {
        setError("Invalid token");
      }
    } catch {
      setError("Could not reach gateway");
    } finally {
      setChecking(false);
    }
  }

  if (hasToken) {
    return <>{children}</>;
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.icon}>💋</div>
        <h1 style={styles.title}>Anima</h1>
        <p style={styles.subtitle}>Enter your gateway token to continue</p>

        <form onSubmit={handleSubmit} style={styles.form}>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="anima_sk_..."
            autoFocus
            autoComplete="off"
            style={styles.input}
          />
          <button type="submit" disabled={checking || !token.trim()} style={styles.button}>
            {checking ? "Validating..." : "Connect"}
          </button>
        </form>

        {error && <p style={styles.error}>{error}</p>}

        <p style={styles.hint}>
          Run <code style={styles.code}>anima token show</code> to see your token
        </p>
      </div>
    </div>
  );
}

/**
 * Logout — clears the stored token and reloads the page.
 */
export function logout(): void {
  clearStoredToken();
  window.location.reload();
}

const styles = {
  container: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    backgroundColor: "#0a0a0a",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  } as const,
  card: {
    background: "#161616",
    border: "1px solid #2a2a2a",
    borderRadius: "16px",
    padding: "48px",
    maxWidth: "400px",
    width: "100%",
    textAlign: "center" as const,
  } as const,
  icon: {
    fontSize: "48px",
    marginBottom: "16px",
  } as const,
  title: {
    color: "#e0e0e0",
    fontSize: "24px",
    fontWeight: 600,
    margin: "0 0 8px 0",
  } as const,
  subtitle: {
    color: "#888",
    fontSize: "14px",
    margin: "0 0 32px 0",
  } as const,
  form: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "12px",
  } as const,
  input: {
    background: "#0a0a0a",
    border: "1px solid #333",
    borderRadius: "8px",
    padding: "12px 16px",
    color: "#e0e0e0",
    fontSize: "14px",
    fontFamily: "monospace",
    outline: "none",
  } as const,
  button: {
    background: "#2563eb",
    color: "white",
    border: "none",
    borderRadius: "8px",
    padding: "12px 16px",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
  } as const,
  error: {
    color: "#ef4444",
    fontSize: "13px",
    marginTop: "12px",
  } as const,
  hint: {
    color: "#555",
    fontSize: "12px",
    marginTop: "24px",
  } as const,
  code: {
    background: "#1a1a1a",
    padding: "2px 6px",
    borderRadius: "4px",
    fontFamily: "monospace",
    fontSize: "11px",
  } as const,
};
