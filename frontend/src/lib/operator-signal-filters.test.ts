import { describe, expect, it } from "vitest";

import { isSystemActivityEvent, isSystemSession } from "./operator-signal-filters";

describe("operator signal filters", () => {
  it("treats heartbeat and wake events as system activity", () => {
    expect(
      isSystemActivityEvent({
        event_type: "agent.heartbeat",
        message: "Recent heartbeat received.",
      }),
    ).toBe(true);
    expect(
      isSystemActivityEvent({
        event_type: "task.assignee_woken",
        message: "Builder heartbeat set online.",
      }),
    ).toBe(true);
  });

  it("keeps normal task activity visible", () => {
    expect(
      isSystemActivityEvent({
        event_type: "task.status_changed",
        message: "Task moved to review.",
      }),
    ).toBe(false);
  });

  it("recognizes heartbeat sessions by key or label", () => {
    expect(
      isSystemSession({
        key: "agent:builder:main:heartbeat",
        title: "Builder heartbeat",
      }),
    ).toBe(true);
    expect(
      isSystemSession({
        key: "agent:builder:main",
        title: "Builder",
        subtitle: "webchat · gpt-5.4",
      }),
    ).toBe(false);
  });

  it("hides obvious internal narrative and subagent sessions", () => {
    expect(
      isSystemSession({
        key: "agent:lead:main:dreaming-narrative-20260416",
        title: "dreaming-narrative-20260416",
      }),
    ).toBe(true);
    expect(
      isSystemSession({
        key: "agent:security:main:subagent:review-1",
        title: "Security subagent review",
      }),
    ).toBe(true);
  });
});
