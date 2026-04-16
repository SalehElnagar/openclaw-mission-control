"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

type ErrorBoundaryProps = {
  children: ReactNode;
  fallback?: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
};

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[ErrorBoundary]", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex min-h-[400px] flex-col items-center justify-center gap-4 rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-8">
          <div className="rounded-full bg-rose-100 p-3 dark:bg-rose-900/30">
            <AlertTriangle className="h-6 w-6 text-rose-600 dark:text-rose-400" />
          </div>
          <div className="text-center">
            <h2 className="font-heading text-lg font-semibold text-strong">
              Something went wrong
            </h2>
            <p className="mt-1 max-w-md text-sm text-muted">
              An unexpected error occurred while rendering this section. You can
              try again or navigate to another page.
            </p>
            {this.state.error?.message ? (
              <pre className="mt-3 max-w-lg overflow-x-auto rounded-lg bg-[color:var(--surface-muted)] p-3 text-left text-xs text-muted">
                {this.state.error.message}
              </pre>
            ) : null}
          </div>
          <button
            type="button"
            onClick={this.handleReset}
            className="inline-flex items-center gap-2 rounded-lg bg-[color:var(--accent)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
          >
            <RefreshCw className="h-4 w-4" />
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
