import {
  MetricCardSkeleton,
  InfoBlockSkeleton,
  ActivityFeedSkeleton,
} from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <div className="flex min-h-screen">
      {/* Sidebar placeholder */}
      <div className="hidden w-[260px] border-r border-[color:var(--border)] bg-[color:var(--surface)] md:block" />
      <main className="flex-1 overflow-y-auto bg-app">
        <div className="p-4 md:p-8">
          {/* Top metric cards */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCardSkeleton />
            <MetricCardSkeleton />
            <MetricCardSkeleton />
            <MetricCardSkeleton />
          </div>

          {/* Info blocks */}
          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
            <InfoBlockSkeleton />
            <InfoBlockSkeleton />
            <InfoBlockSkeleton />
          </div>

          {/* Bottom sections */}
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 md:p-6">
              <div className="mb-3 h-5 w-20 animate-pulse rounded bg-[color:var(--surface-muted)]" />
              <ActivityFeedSkeleton count={4} />
            </div>
            <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 md:p-6">
              <div className="mb-3 h-5 w-28 animate-pulse rounded bg-[color:var(--surface-muted)]" />
              <ActivityFeedSkeleton count={4} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
