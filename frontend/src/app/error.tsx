"use client";

import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import Link from "next/link";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-app px-6">
      <div className="rounded-full bg-rose-100 p-4 dark:bg-rose-900/30">
        <AlertTriangle className="h-8 w-8 text-rose-600 dark:text-rose-400" />
      </div>
      <div className="text-center">
        <h1 className="font-heading text-2xl font-bold text-strong">
          Something went wrong
        </h1>
        <p className="mt-2 max-w-md text-sm text-muted">
          An unexpected error occurred. You can try again or return to the
          dashboard.
        </p>
        {error.message ? (
          <pre className="mt-4 max-w-lg overflow-x-auto rounded-lg bg-[color:var(--surface-muted)] p-3 text-left text-xs text-muted">
            {error.message}
          </pre>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-2 rounded-lg bg-[color:var(--accent)] px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90"
        >
          <RefreshCw className="h-4 w-4" />
          Try again
        </button>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] px-4 py-2.5 text-sm font-medium text-strong transition hover:bg-[color:var(--surface-muted)]"
        >
          <Home className="h-4 w-4" />
          Dashboard
        </Link>
      </div>
    </div>
  );
}
