"use client";

import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { formatDuration } from "@/lib/format";

const AXIS = { stroke: "var(--color-text-subtle)", fontSize: 10 };
const GRID = "var(--color-border)";

const tooltipStyle = {
  contentStyle: {
    background: "var(--color-surface-raised)",
    border: "1px solid var(--color-border-strong)",
    borderRadius: 4,
    fontSize: 12,
  },
  labelStyle: { color: "var(--color-text-muted)", fontSize: 11 },
} as const;

export interface RunSeriesPoint {
  date: string;
  succeeded: number;
  failed: number;
  cancelled: number;
  averageDurationMs: number | null;
}

/** Runs per day, stacked by outcome. Empty series renders an honest empty state. */
export function RunVolumeChart({ data }: { data: RunSeriesPoint[] }) {
  if (!data.length) return <ChartEmpty message="No runs in this window yet." />;
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} tickFormatter={shortDate} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip {...tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar dataKey="succeeded" stackId="runs" maxBarSize={44} fill="var(--color-success)" name="Succeeded" radius={[2, 2, 0, 0]} />
        <Bar dataKey="failed" stackId="runs" maxBarSize={44} fill="var(--color-danger)" name="Failed" />
        <Bar dataKey="cancelled" stackId="runs" maxBarSize={44} fill="var(--color-border-strong)" name="Cancelled" />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DurationChart({ data }: { data: RunSeriesPoint[] }) {
  const points = data.filter((point) => point.averageDurationMs !== null);
  if (!points.length) return <ChartEmpty message="No completed runs to measure." />;
  return (
    <ResponsiveContainer width="100%" height={180}>
      <AreaChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
        <defs>
          <linearGradient id="duration-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} tickFormatter={shortDate} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(value: number) => formatDuration(value)} />
        <Tooltip {...tooltipStyle} formatter={(value) => [formatDuration(Number(value)), "Average duration"]} />
        <Area type="monotone" dataKey="averageDurationMs" stroke="var(--color-accent)" strokeWidth={1.5} fill="url(#duration-fill)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function SuccessRateChart({ data }: { data: RunSeriesPoint[] }) {
  const points = data
    .map((point) => {
      const finished = point.succeeded + point.failed;
      return { date: point.date, rate: finished ? (point.succeeded / finished) * 100 : null };
    })
    .filter((point) => point.rate !== null);
  if (!points.length) return <ChartEmpty message="No finished runs to compare." />;

  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} tickFormatter={shortDate} />
        <YAxis domain={[0, 100]} tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(value: number) => `${value}%`} />
        <Tooltip {...tooltipStyle} formatter={(value) => [`${Number(value).toFixed(1)}%`, "Success rate"]} />
        <Line type="monotone" dataKey="rate" stroke="var(--color-success)" strokeWidth={1.5} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function TaskFailureChart({ data }: { data: Array<{ nodeId: string; nodeType: string; failures: number }> }) {
  if (!data.length) return <ChartEmpty message="No task failures in this window." />;
  return (
    <ResponsiveContainer width="100%" height={Math.max(120, data.length * 26)}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 8 }}>
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
        <YAxis type="category" dataKey="nodeId" tick={AXIS} tickLine={false} axisLine={false} width={120} />
        <Tooltip {...tooltipStyle} formatter={(value, _name, item) => [`${value} failures`, (item as { payload?: { nodeType?: string } }).payload?.nodeType ?? ""]} />
        <Bar dataKey="failures" radius={[0, 2, 2, 0]}>
          {data.map((entry) => <Cell key={entry.nodeId} fill="var(--color-danger)" />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="flex h-[180px] items-center justify-center text-[12px] text-[var(--color-text-subtle)]">
      {message}
    </div>
  );
}

function shortDate(value: string): string {
  const [, month, day] = value.split("-");
  return month && day ? `${month}/${day}` : value;
}
