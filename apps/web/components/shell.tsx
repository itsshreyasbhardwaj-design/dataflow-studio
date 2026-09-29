"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, AlertTriangle, BarChart3, Database, GitBranch, Layers, Plug, Search, Settings, Workflow,
} from "lucide-react";
import { Badge, Button, KeyHint, Spinner } from "./ui";

const NAV = [
  { href: "/", label: "Dashboard", icon: Activity },
  { href: "/pipelines", label: "Pipelines", icon: Workflow },
  { href: "/runs", label: "Runs", icon: Layers },
  { href: "/datasets", label: "Datasets", icon: Database },
  { href: "/lineage", label: "Lineage", icon: GitBranch },
  { href: "/incidents", label: "Incidents", icon: AlertTriangle },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/connectors", label: "Connectors", icon: Plug },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export interface ShellProps {
  children: React.ReactNode;
  principal: { userId: string; organizationId: string; role: string };
  storeDriver: "memory" | "postgres";
  openIncidents: number;
}

export function Shell({ children, principal, storeDriver, openIncidents }: ShellProps) {
  const pathname = usePathname();
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-[var(--color-surface)] focus:px-2 focus:py-1">
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-screen w-52 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] md:flex">
        <div className="flex h-12 items-center gap-2 border-b border-[var(--color-border)] px-3">
          <div className="grid size-6 place-items-center rounded bg-[var(--color-accent-strong)] text-[11px] font-bold text-white">DF</div>
          <span className="text-[13px] font-semibold tracking-tight">DataFlow Studio</span>
        </div>

        <nav className="flex-1 overflow-y-auto p-2" aria-label="Main">
          {NAV.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={clsx(
                  "mb-0.5 flex items-center justify-between gap-2 rounded px-2 py-1.5 text-[12.5px] transition-colors",
                  active
                    ? "bg-[var(--color-surface-raised)] font-medium text-[var(--color-text)]"
                    : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]",
                )}
              >
                <span className="flex items-center gap-2">
                  <Icon className="size-3.5" aria-hidden />
                  {item.label}
                </span>
                {item.href === "/incidents" && openIncidents > 0 && (
                  <Badge tone="danger" mono>{openIncidents}</Badge>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-[var(--color-border)] p-2">
          {storeDriver === "memory" && (
            <div className="mb-2 rounded border border-[color-mix(in_oklch,var(--color-warning)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-warning)_10%,transparent)] px-2 py-1.5 text-[11px] text-[var(--color-warning)]">
              In-memory store · not durable
            </div>
          )}
          <div className="px-1 text-[11px] text-[var(--color-text-subtle)]">
            <div className="truncate">{principal.userId}</div>
            <div className="mono mt-0.5">{principal.role}</div>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]/95 px-3 backdrop-blur">
          <button
            onClick={() => setSearchOpen(true)}
            className="flex h-7 flex-1 items-center gap-2 rounded border border-[var(--color-border-strong)] bg-[var(--color-canvas)] px-2 text-left text-[12.5px] text-[var(--color-text-subtle)] hover:border-[var(--color-accent)] md:max-w-md"
          >
            <Search className="size-3.5" aria-hidden />
            Search pipelines, runs, datasets…
            <span className="ml-auto hidden md:inline"><KeyHint>⌘K</KeyHint></span>
          </button>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <Button variant="primary" size="sm" onClick={() => { window.location.href = "/pipelines/new"; }}>
              New pipeline
            </Button>
          </div>
        </header>

        <main id="main" className="min-w-0 flex-1">{children}</main>
      </div>

      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const stored = window.localStorage.getItem("dataflow-theme");
    if (stored === "light" || stored === "dark") {
      setTheme(stored);
      document.documentElement.dataset["theme"] = stored;
    }
  }, []);
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      onClick={() => {
        const next = theme === "dark" ? "light" : "dark";
        setTheme(next);
        document.documentElement.dataset["theme"] = next;
        window.localStorage.setItem("dataflow-theme", next);
      }}
    >
      {theme === "dark" ? "Light" : "Dark"}
    </Button>
  );
}

interface SearchHit {
  type: string;
  id: string;
  title: string;
  subtitle?: string;
  href: string;
}

/** ⌘K search across pipelines, runs, datasets, incidents and connections. */
function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const search = useCallback(async (value: string) => {
    if (!value.trim()) { setHits([]); return; }
    setLoading(true);
    try {
      const response = await fetch(`/api/v1/search?q=${encodeURIComponent(value)}`, { headers: { accept: "application/json" } });
      const payload = (await response.json()) as { items?: SearchHit[] };
      setHits(payload.items ?? []);
      setSelected(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) { setQuery(""); setHits([]); return; }
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const handle = setTimeout(() => void search(query), 150);
    return () => clearTimeout(handle);
  }, [query, search]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 p-4 pt-[12vh]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="card mx-auto w-full max-w-xl overflow-hidden shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
          <Search className="size-4 text-[var(--color-text-subtle)]" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              if (event.key === "ArrowDown") { event.preventDefault(); setSelected((s) => Math.min(s + 1, hits.length - 1)); }
              if (event.key === "ArrowUp") { event.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
              if (event.key === "Enter" && hits[selected]) { router.push(hits[selected]!.href); onClose(); }
            }}
            placeholder="Search pipelines, runs, datasets, incidents…"
            className="h-7 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--color-text-subtle)]"
            aria-label="Search query"
          />
          {loading && <Spinner />}
        </div>

        <ul className="max-h-80 overflow-y-auto" role="listbox">
          {hits.map((hit, index) => (
            <li key={`${hit.type}:${hit.id}`}>
              <Link
                href={hit.href}
                onClick={onClose}
                role="option"
                aria-selected={index === selected}
                className={clsx(
                  "flex items-center gap-2 px-3 py-2 text-[12.5px]",
                  index === selected ? "bg-[var(--color-surface-raised)]" : "hover:bg-[var(--color-surface-raised)]",
                )}
              >
                <Badge tone="neutral" mono>{hit.type}</Badge>
                <span className="truncate font-medium">{hit.title}</span>
                {hit.subtitle && <span className="ml-auto truncate text-[11px] text-[var(--color-text-subtle)]">{hit.subtitle}</span>}
              </Link>
            </li>
          ))}
          {!hits.length && query.trim() && !loading && (
            <li className="px-3 py-6 text-center text-[12.5px] text-[var(--color-text-subtle)]">No matches for “{query}”</li>
          )}
          {!query.trim() && (
            <li className="px-3 py-4 text-[11.5px] text-[var(--color-text-subtle)]">
              Type to search. <KeyHint>↑</KeyHint> <KeyHint>↓</KeyHint> to navigate, <KeyHint>↵</KeyHint> to open, <KeyHint>esc</KeyHint> to close.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
