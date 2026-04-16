import type { ActivityEventRead } from "@/api/generated/model";

const SYSTEM_ACTIVITY_EVENT_TYPES = new Set([
  "agent.heartbeat",
  "task.assignee_woken",
  "task.assignee_wake_failed",
  "task.presence_reconcile_failed",
]);

type SessionSignal = {
  key?: string | null;
  title?: string | null;
  subtitle?: string | null;
};

export const isSystemActivityEvent = (
  event: Pick<ActivityEventRead, "event_type" | "message">,
): boolean => SYSTEM_ACTIVITY_EVENT_TYPES.has((event.event_type ?? "").trim().toLowerCase());

export const isSystemSession = (session: SessionSignal): boolean => {
  const haystack = [session.key, session.title, session.subtitle]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return (
    haystack.includes(":heartbeat") ||
    haystack.includes("heartbeat") ||
    haystack.includes("dreaming-narrative") ||
    haystack.includes(":subagent:") ||
    haystack.includes(" subagent ")
  );
};
