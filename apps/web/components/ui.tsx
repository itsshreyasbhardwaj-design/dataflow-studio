"use client";

import clsx from "clsx";
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { useEffect, useId, useRef, useState } from "react";

/**
 * Interface primitives.
 *
 * Hand-written rather than generated so the whole surface stays one file with no
 * runtime dependency beyond clsx: every control here is keyboard-operable and
 * carries the ARIA a screen reader needs, which is the part of a component
 * library that actually matters for a tool people use all day.
 */

type Tone = "neutral" | "success" | "danger" | "warning" | "info" | "accent";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "text-[var(--color-text-muted)] bg-[var(--color-surface-raised)] border-[var(--color-border)]",
  success: "text-[var(--color-success)] bg-[color-mix(in_oklch,var(--color-success)_12%,transparent)] border-[color-mix(in_oklch,var(--color-success)_35%,transparent)]",
  danger: "text-[var(--color-danger)] bg-[color-mix(in_oklch,var(--color-danger)_12%,transparent)] border-[color-mix(in_oklch,var(--color-danger)_35%,transparent)]",
  warning: "text-[var(--color-warning)] bg-[color-mix(in_oklch,var(--color-warning)_12%,transparent)] border-[color-mix(in_oklch,var(--color-warning)_35%,transparent)]",
  info: "text-[var(--color-info)] bg-[color-mix(in_oklch,var(--color-info)_12%,transparent)] border-[color-mix(in_oklch,var(--color-info)_35%,transparent)]",
  accent: "text-[var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_12%,transparent)] border-[color-mix(in_oklch,var(--color-accent)_35%,transparent)]",
};

export function Badge({ tone = "neutral", children, className, mono }: { tone?: Tone; children: ReactNode; className?: string; mono?: boolean }) {
  return (
    <span className={clsx(
      "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none",
      TONE_CLASS[tone],
      mono && "mono",
      className,
    )}>
      {children}
    </span>
  );
}

export function StateBadge({ state }: { state: string }) {
  const tone: Tone =
    state === "SUCCESS" ? "success"
    : state === "FAILED" ? "danger"
    : state === "RUNNING" || state === "QUEUED" ? "info"
    : state === "RETRYING" || state === "BLOCKED" ? "warning"
    : "neutral";
  return (
    <Badge tone={tone} mono>
      {state === "RUNNING" && <span className="size-1.5 rounded-full bg-current running-pulse" aria-hidden />}
      {state}
    </Badge>
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md"; loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded border font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-7 px-2 text-[12px]" : "h-8 px-3 text-[13px]",
        variant === "primary" && "border-[var(--color-accent-strong)] bg-[var(--color-accent-strong)] text-white hover:bg-[var(--color-accent)]",
        variant === "secondary" && "border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] text-[var(--color-text)] hover:border-[var(--color-accent)]",
        variant === "ghost" && "border-transparent bg-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]",
        variant === "danger" && "border-[color-mix(in_oklch,var(--color-danger)_45%,transparent)] bg-transparent text-[var(--color-danger)] hover:bg-[color-mix(in_oklch,var(--color-danger)_12%,transparent)]",
        className,
      )}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={clsx("size-3 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Card({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={clsx("card", className)}>{children}</div>;
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3", className)}>
      <div className="min-w-0">
        <h2 className="truncate text-[13px] font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({
  label, value, hint, tone = "neutral", href,
}: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone; href?: string }) {
  const body = (
    <>
      <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-subtle)]">{label}</div>
      <div className={clsx("mt-1 text-[22px] font-semibold leading-none tabular-nums",
        tone === "danger" && "text-[var(--color-danger)]",
        tone === "success" && "text-[var(--color-success)]",
        tone === "warning" && "text-[var(--color-warning)]",
        tone === "info" && "text-[var(--color-info)]",
      )}>{value}</div>
      {hint && <div className="mt-1 text-[11px] text-[var(--color-text-subtle)]">{hint}</div>}
    </>
  );
  return href
    ? <a href={href} className="card block px-3.5 py-3 transition-colors hover:border-[var(--color-accent)]">{body}</a>
    : <div className="card px-3.5 py-3">{body}</div>;
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={clsx(
        "h-8 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-canvas)] px-2 text-[13px]",
        "placeholder:text-[var(--color-text-subtle)] focus:border-[var(--color-accent)] focus:outline-none",
        className,
      )}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={clsx(
        "w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-canvas)] px-2 py-1.5 mono",
        "placeholder:text-[var(--color-text-subtle)] focus:border-[var(--color-accent)] focus:outline-none",
        className,
      )}
    />
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={clsx(
        "h-8 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-canvas)] px-2 text-[13px]",
        "focus:border-[var(--color-accent)] focus:outline-none",
        className,
      )}
    >
      {children}
    </select>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-[12px] font-medium text-[var(--color-text-muted)]">{label}</label>
      {children}
      {error
        ? <p className="text-[11px] text-[var(--color-danger)]">{error}</p>
        : hint ? <p className="text-[11px] text-[var(--color-text-subtle)]">{hint}</p> : null}
    </div>
  );
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={clsx("w-full border-collapse text-[13px]", className)}>{children}</table>
    </div>
  );
}

export function Th({ children, className, align = "left" }: { children?: ReactNode; className?: string; align?: "left" | "right" | "center" }) {
  return (
    <th scope="col" className={clsx(
      "border-b border-[var(--color-border)] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]",
      align === "right" && "text-right", align === "center" && "text-center", align === "left" && "text-left",
      className,
    )}>
      {children}
    </th>
  );
}

export function Td({ children, className, align = "left" }: { children?: ReactNode; className?: string; align?: "left" | "right" | "center" }) {
  return (
    <td className={clsx(
      "border-b border-[var(--color-border)] px-3 py-2 align-middle",
      align === "right" && "text-right", align === "center" && "text-center",
      className,
    )}>
      {children}
    </td>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {icon && <div className="text-[var(--color-text-subtle)]">{icon}</div>}
      <h3 className="text-[14px] font-semibold">{title}</h3>
      {description && <p className="max-w-md text-[12.5px] text-[var(--color-text-muted)]">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: Array<{ id: string; label: string; count?: number }>; active: string; onChange: (id: string) => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={listRef}
      role="tablist"
      className="flex items-center gap-1 border-b border-[var(--color-border)]"
      onKeyDown={(event) => {
        const index = tabs.findIndex((t) => t.id === active);
        if (event.key === "ArrowRight") onChange(tabs[(index + 1) % tabs.length]!.id);
        if (event.key === "ArrowLeft") onChange(tabs[(index - 1 + tabs.length) % tabs.length]!.id);
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={tab.id === active}
          tabIndex={tab.id === active ? 0 : -1}
          onClick={() => onChange(tab.id)}
          className={clsx(
            "-mb-px border-b-2 px-3 py-2 text-[12.5px] font-medium transition-colors",
            tab.id === active
              ? "border-[var(--color-accent)] text-[var(--color-text)]"
              : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]",
          )}
        >
          {tab.label}
          {tab.count !== undefined && <span className="ml-1.5 text-[11px] text-[var(--color-text-subtle)]">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Dialog({
  open, onClose, title, description, children, footer, wide,
}: { open: boolean; onClose: () => void; title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
      // Focus trap: keeps Tab inside the dialog.
      if (event.key === "Tab" && ref.current) {
        const focusable = ref.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable.length) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[10vh]" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        className={clsx("card w-full shadow-2xl", wide ? "max-w-3xl" : "max-w-lg")}
      >
        <div className="border-b border-[var(--color-border)] px-4 py-3">
          <h2 id={titleId} className="text-[14px] font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">{description}</p>}
        </div>
        <div className="px-4 py-3">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Banner({ tone = "info", title, children, onDismiss }: { tone?: Tone; title?: ReactNode; children: ReactNode; onDismiss?: () => void }) {
  return (
    <div role="status" className={clsx("flex items-start gap-2 rounded border px-3 py-2 text-[12.5px]", TONE_CLASS[tone])}>
      <div className="min-w-0 flex-1">
        {title && <div className="font-semibold">{title}</div>}
        <div className={clsx(title && "mt-0.5", "text-[var(--color-text-muted)]")}>{children}</div>
      </div>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" className="text-[var(--color-text-subtle)] hover:text-[var(--color-text)]">×</button>
      )}
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

export function Progress({ value, max = 100, tone = "accent" }: { value: number; max?: number; tone?: Tone }) {
  const percent = Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-[var(--color-surface-raised)]" role="progressbar" aria-valuenow={value} aria-valuemax={max} aria-valuemin={0}>
      <div
        className={clsx("h-full rounded transition-[width]",
          tone === "success" && "bg-[var(--color-success)]",
          tone === "danger" && "bg-[var(--color-danger)]",
          tone === "accent" && "bg-[var(--color-accent)]",
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

export function KeyHint({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-1 py-0.5 mono text-[10px] text-[var(--color-text-muted)]">
      {children}
    </kbd>
  );
}
