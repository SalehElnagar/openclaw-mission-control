import type {
  BoardGroupBoardSnapshot,
  BoardRead,
  BoardGroupTaskSummary,
} from "@/api/generated/model";

export type WorkflowStageKey =
  | "backlog"
  | "planning"
  | "active"
  | "review"
  | "security"
  | "qa"
  | "done"
  | "other";

type WorkflowStageDefinition = {
  key: WorkflowStageKey;
  label: string;
  description: string;
  aliases: string[];
};

const normalize = (value?: string | null) =>
  (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");

const WORKFLOW_STAGE_DEFINITIONS: WorkflowStageDefinition[] = [
  {
    key: "backlog",
    label: "Backlog",
    description: "New epics waiting for lead intake.",
    aliases: ["requirements", "backlog"],
  },
  {
    key: "planning",
    label: "Planning",
    description: "Lead has scoped the work and it is ready to route.",
    aliases: ["ready", "planning"],
  },
  {
    key: "active",
    label: "Active",
    description: "Execution work is in motion.",
    aliases: ["in progress", "active"],
  },
  {
    key: "review",
    label: "Review",
    description: "Builder output is waiting for review.",
    aliases: ["review"],
  },
  {
    key: "security",
    label: "Security",
    description: "Security validation is in progress.",
    aliases: ["security review", "security"],
  },
  {
    key: "qa",
    label: "QA",
    description: "Final validation and acceptance checks.",
    aliases: ["qa", "quality assurance"],
  },
  {
    key: "done",
    label: "Done",
    description: "Completed work and accepted outcomes.",
    aliases: ["done", "complete", "completed"],
  },
  {
    key: "other",
    label: "Other",
    description: "Unmapped workflow stage.",
    aliases: [],
  },
];

const STAGE_BY_ALIAS = new Map<string, WorkflowStageKey>();
WORKFLOW_STAGE_DEFINITIONS.forEach((stage) => {
  stage.aliases.forEach((alias) => {
    STAGE_BY_ALIAS.set(alias, stage.key);
  });
});

export const WORKFLOW_STAGE_ORDER: WorkflowStageKey[] =
  WORKFLOW_STAGE_DEFINITIONS.map((stage) => stage.key);

export const resolveWorkflowStageKey = (
  source?: Pick<BoardRead, "name" | "slug"> | string | null,
): WorkflowStageKey => {
  if (typeof source === "string") {
    return STAGE_BY_ALIAS.get(normalize(source)) ?? "other";
  }
  const slugMatch = STAGE_BY_ALIAS.get(normalize(source?.slug));
  if (slugMatch) return slugMatch;
  return STAGE_BY_ALIAS.get(normalize(source?.name)) ?? "other";
};

export const getWorkflowStageDefinition = (
  key: WorkflowStageKey,
): WorkflowStageDefinition =>
  WORKFLOW_STAGE_DEFINITIONS.find((stage) => stage.key === key) ??
  WORKFLOW_STAGE_DEFINITIONS[WORKFLOW_STAGE_DEFINITIONS.length - 1]!;

export const getWorkflowStageLabel = (key: WorkflowStageKey) =>
  getWorkflowStageDefinition(key).label;

export const getWorkflowStageDescription = (key: WorkflowStageKey) =>
  getWorkflowStageDefinition(key).description;

export const getTaskWorkflowStageKey = (task: Pick<BoardGroupTaskSummary, "board_name">) =>
  resolveWorkflowStageKey(task.board_name);

export const findWorkflowBacklogBoard = (
  boards: BoardGroupBoardSnapshot[],
): BoardGroupBoardSnapshot | null =>
  boards.find((item) => resolveWorkflowStageKey(item.board) === "backlog") ?? null;
