"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { DashboardSeriesPoint } from "@/api/generated/model/dashboardSeriesPoint";
import type { DashboardWipPoint } from "@/api/generated/model/dashboardWipPoint";

/* ---------- helpers ---------- */

function formatPeriod(period: string): string {
  const d = new Date(period);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const CHART_COLORS = {
  primary: "var(--accent-strong)",
  comparison: "var(--quiet)",
  inbox: "#6366f1",       // indigo
  inProgress: "#f59e0b",  // amber
  review: "#8b5cf6",      // violet
  done: "#10b981",        // emerald
} as const;

/* ---------- Throughput Area Chart ---------- */

interface ThroughputChartProps {
  primary: DashboardSeriesPoint[];
  comparison: DashboardSeriesPoint[];
}

export function ThroughputChart({ primary, comparison }: ThroughputChartProps) {
  const data = useMemo(() => {
    const map = new Map<string, { period: string; label: string; current: number; previous: number }>();
    for (const p of primary) {
      map.set(p.period, { period: p.period, label: formatPeriod(p.period), current: p.value, previous: 0 });
    }
    for (const p of comparison) {
      const existing = map.get(p.period);
      if (existing) {
        existing.previous = p.value;
      } else {
        map.set(p.period, { period: p.period, label: formatPeriod(p.period), current: 0, previous: p.value });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.period.localeCompare(b.period));
  }, [primary, comparison]);

  if (data.length === 0) {
    return <EmptyChart label="No throughput data yet" />;
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
        <defs>
          <linearGradient id="gradCurrent" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={CHART_COLORS.primary} stopOpacity={0.25} />
            <stop offset="95%" stopColor={CHART_COLORS.primary} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={false} />
        <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip
          contentStyle={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 12,
            color: "var(--text-strong)",
          }}
        />
        <Area
          type="monotone"
          dataKey="previous"
          stroke={CHART_COLORS.comparison}
          fill="none"
          strokeDasharray="4 4"
          strokeWidth={1.5}
          name="Previous"
        />
        <Area
          type="monotone"
          dataKey="current"
          stroke={CHART_COLORS.primary}
          fill="url(#gradCurrent)"
          strokeWidth={2}
          name="Current"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* ---------- WIP Stacked Bar Chart ---------- */

interface WipChartProps {
  points: DashboardWipPoint[];
}

export function WipChart({ points }: WipChartProps) {
  const data = useMemo(
    () =>
      points.map((p) => ({
        label: formatPeriod(p.period),
        Inbox: p.inbox,
        "In Progress": p.in_progress,
        Review: p.review,
        Done: p.done,
      })),
    [points],
  );

  if (data.length === 0) {
    return <EmptyChart label="No WIP data yet" />;
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={false} />
        <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip
          contentStyle={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 12,
            color: "var(--text-strong)",
          }}
        />
        <Bar dataKey="Inbox" stackId="wip" fill={CHART_COLORS.inbox} radius={[0, 0, 0, 0]} />
        <Bar dataKey="In Progress" stackId="wip" fill={CHART_COLORS.inProgress} />
        <Bar dataKey="Review" stackId="wip" fill={CHART_COLORS.review} />
        <Bar dataKey="Done" stackId="wip" fill={CHART_COLORS.done} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ---------- Empty state ---------- */

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-[220px] items-center justify-center rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] text-sm text-muted">
      {label}
    </div>
  );
}
