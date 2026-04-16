"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center gap-4 p-8">
      <div className="rounded-full bg-rose-100 p-3 dark:bg-rose-900/30">
        <AlertTriangle className="h-6 w-6 text-rose-600 dark:text-rose-400" />
      </div>
      <div className="text-center">
        <h2 className="font-heading text-lg font-semibold text-strong">
          Dashboard failed to load
        </h2>
        <p className="mt-1 max-w-md text-sm text-muted">
          {error.message || "An unexpected error occurred."}
        </p>
      </div>
      <button
        type="button"
        onClick={reset}
        className="inline-flex items-center gap-2 rounded-lg bg-[color:var(--accent)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
      >
        <RefreshCw className="h-4 w-4" />
        Try again
      </button>
    </div>
  );
}
