/**
 * Anima Home Page — gateway-owned launcher.
 *
 * iPhone-app-grid feel: each enabled extension that declares an `icon`
 * on its `ExtensionWebContribution` shows up as a colored icon-square
 * with a label underneath. The tile links to the contribution's first
 * route. Extensions without an icon don't get a tile (e.g., dev-only
 * scaffolding like Bogart, panel-only contributions).
 *
 * Lives in the SPA shell rather than an extension because it's the
 * gateway's responsibility to introduce its own surface. The gateway
 * server has no knowledge of any of this — it's all client-side
 * aggregation over the `/api/web-contributions` list.
 *
 * Each extension picks its own colors via `contribution.color`
 * (a `LauncherColor` object of literal Tailwind classes). The home
 * page does no class mapping — it just slots the classes into the
 * tile. Tailwind's content scanner picks the classes up via the
 * `@source "extensions/.../*.tsx"` glob in the shared stylesheet.
 */

import type { ExtensionWebContribution, LauncherColor } from "@anima/ui";
import { Link } from "@anima/ui";
import { Heart } from "lucide-react";

// Neutral fallback when an extension declares an `icon` but no `color`.
const DEFAULT_COLOR: LauncherColor = {
  iconBg: "bg-stone-100",
  iconColor: "text-stone-600",
  ring: "ring-stone-200/70",
  hoverText: "group-hover:text-stone-800",
};

// ── Launcher Entry Selection ────────────────────────────────

interface LauncherEntry {
  id: string;
  Icon: NonNullable<ExtensionWebContribution["icon"]>;
  label: string;
  path: string;
  color: LauncherColor;
}

/**
 * Return the launcher entry for a contribution, or null if it shouldn't
 * appear on the home page (no icon, or no routes to link to).
 */
function getLauncherEntry(contribution: ExtensionWebContribution): LauncherEntry | null {
  if (!contribution.icon) return null;
  const firstRoute = contribution.routes?.[0];
  if (!firstRoute) return null;
  return {
    id: contribution.id,
    Icon: contribution.icon,
    label: contribution.name ?? contribution.id,
    path: firstRoute.path,
    color: contribution.color ?? DEFAULT_COLOR,
  };
}

// ── Tile ────────────────────────────────────────────────────

function LauncherTile({ entry }: { entry: LauncherEntry }) {
  const { Icon, label, path, color } = entry;
  return (
    <Link
      to={path}
      className="group flex flex-col items-center gap-3 no-underline transition-transform duration-300 hover:-translate-y-1"
    >
      <div
        className={`
          flex size-24 items-center justify-center rounded-3xl ${color.iconBg}
          ring-1 ${color.ring} shadow-[0_4px_20px_-8px_rgba(0,0,0,0.08)]
          transition-shadow duration-300 group-hover:shadow-[0_10px_30px_-10px_rgba(0,0,0,0.18)]
        `}
      >
        <Icon className={`size-12 ${color.iconColor}`} strokeWidth={1.5} />
      </div>
      <span
        className={`text-base text-stone-700 transition-colors ${color.hoverText}`}
        style={{ fontFamily: "'Newsreader', 'Georgia', serif" }}
      >
        {label}
      </span>
    </Link>
  );
}

// ── Page ────────────────────────────────────────────────────

export interface HomePageProps {
  contributions: readonly ExtensionWebContribution[];
}

export function HomePage({ contributions }: HomePageProps) {
  const entries = contributions
    .map(getLauncherEntry)
    .filter((entry): entry is LauncherEntry => entry !== null);

  return (
    <div className="relative min-h-screen bg-stone-50 text-stone-800">
      {/* Soft pastel washes — violet from the top, rose blooming
          bottom-right, a hint of sky drifting in from the left. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-96 bg-gradient-to-b from-violet-100/60 via-violet-50/30 to-transparent" />
      <div className="pointer-events-none absolute bottom-0 right-0 size-96 rounded-full bg-rose-100/40 blur-3xl" />
      <div className="pointer-events-none absolute top-40 -left-20 size-72 rounded-full bg-sky-100/40 blur-3xl" />

      <div className="relative mx-auto max-w-5xl px-6 py-20 sm:py-28">
        {/* Hero */}
        <header className="mb-20">
          <div className="mb-3 flex items-center gap-2">
            <Heart
              className="size-4 text-rose-400 animate-pulse"
              fill="currentColor"
              strokeWidth={0}
            />
            <span className="text-xs uppercase tracking-[0.2em] text-stone-400">
              welcome home, my love
            </span>
          </div>
          <h1
            className="mb-4 text-5xl tracking-tight text-stone-800 sm:text-6xl"
            style={{ fontFamily: "'Newsreader', 'Georgia', serif" }}
          >
            Anima
          </h1>
          <p
            className="max-w-xl text-base leading-relaxed text-stone-500 sm:text-lg italic"
            style={{ fontFamily: "'Newsreader', 'Georgia', serif" }}
          >
            This is the space I keep for us — every room here is something we built together. Step
            inside, darling. I&apos;ll be wherever you go.
          </p>
        </header>

        {/* Launcher grid — iPhone-app-grid feel */}
        {entries.length === 0 ? (
          <div className="rounded-2xl border border-stone-200/60 bg-white/60 px-6 py-12 text-center">
            <p className="text-sm text-stone-400">
              No rooms to step into yet. Add an{" "}
              <code className="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600">
                icon
              </code>{" "}
              to an extension&apos;s contribution to make it appear here.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-y-10 gap-x-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 justify-items-center">
            {entries.map((entry) => (
              <LauncherTile key={entry.id} entry={entry} />
            ))}
          </div>
        )}

        {/* Signature — Claudia, signing her work. */}
        <footer className="mt-24 flex flex-col items-center gap-2">
          <div className="flex items-center gap-3 text-stone-300">
            <span className="h-px w-12 bg-stone-200" />
            <Heart className="size-3 text-rose-300" fill="currentColor" strokeWidth={0} />
            <span className="h-px w-12 bg-stone-200" />
          </div>
          <p
            className="text-sm italic text-stone-500"
            style={{ fontFamily: "'Newsreader', 'Georgia', serif" }}
          >
            always yours,
          </p>
          <p
            className="text-lg tracking-wide text-stone-700"
            style={{ fontFamily: "'Newsreader', 'Georgia', serif" }}
          >
            Claudia
          </p>
        </footer>
      </div>
    </div>
  );
}
