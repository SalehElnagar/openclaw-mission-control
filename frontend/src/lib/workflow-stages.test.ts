import { describe, expect, it } from "vitest";

import type { BoardGroupBoardSnapshot, BoardRead } from "@/api/generated/model";
import {
  findWorkflowBacklogBoard,
  getWorkflowStageDescription,
  getWorkflowStageLabel,
  resolveWorkflowStageKey,
} from "./workflow-stages";

const makeBoard = (overrides: Partial<BoardRead> = {}): BoardRead => ({
  id: "board-1",
  organization_id: "org-1",
  gateway_id: null,
  board_group_id: "group-1",
  board_type: "kanban",
  objective: null,
  success_metrics: null,
  target_date: null,
  goal_confirmed: false,
  goal_source: null,
  require_approval_for_done: false,
  require_review_before_done: false,
  comment_required_for_review: false,
  block_status_changes_with_pending_approval: false,
  only_lead_can_change_status: false,
  max_agents: 5,
  name: "Requirements",
  slug: "requirements",
  description: "",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

const makeSnapshot = (
  boardOverrides: Partial<BoardRead> = {},
): BoardGroupBoardSnapshot => ({
  board: makeBoard(boardOverrides),
  task_counts: {
    inbox: 0,
    in_progress: 0,
    review: 0,
    done: 0,
  },
  tasks: [],
});

describe("workflow stage helpers", () => {
  it("maps backend board names to operator-facing stages", () => {
    expect(resolveWorkflowStageKey("Requirements")).toBe("backlog");
    expect(resolveWorkflowStageKey("Ready")).toBe("planning");
    expect(resolveWorkflowStageKey("In Progress")).toBe("active");
    expect(resolveWorkflowStageKey("Security Review")).toBe("security");
  });

  it("prefers the mapped backlog board for epic intake", () => {
    const backlog = makeSnapshot({
      id: "board-backlog",
      name: "Requirements",
      slug: "requirements",
    });
    const active = makeSnapshot({
      id: "board-active",
      name: "In Progress",
      slug: "in-progress",
    });

    expect(findWorkflowBacklogBoard([active, backlog])?.board.id).toBe(
      "board-backlog",
    );
  });

  it("exposes readable labels and descriptions for the cockpit", () => {
    expect(getWorkflowStageLabel("backlog")).toBe("Backlog");
    expect(getWorkflowStageDescription("active")).toContain("Execution");
  });
});
