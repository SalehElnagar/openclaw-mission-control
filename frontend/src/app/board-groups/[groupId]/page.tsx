"use client";

export const dynamic = "force-dynamic";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { SignedIn, SignedOut, useAuth } from "@/auth/clerk";
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarRange,
  ChevronDown,
  ChevronRight,
  Clock3,
  Flame,
  GitBranch,
  MessageSquare,
  NotebookText,
  Plus,
  Settings,
  Sparkles,
  Users2,
  X,
} from "lucide-react";

import { ApiError } from "@/api/mutator";
import {
  applyBoardGroupHeartbeatApiV1BoardGroupsGroupIdHeartbeatPost,
  type getBoardGroupSnapshotApiV1BoardGroupsGroupIdSnapshotGetResponse,
  useGetBoardGroupSnapshotApiV1BoardGroupsGroupIdSnapshotGet,
} from "@/api/generated/board-groups/board-groups";
import {
  createBoardGroupMemoryApiV1BoardGroupsGroupIdMemoryPost,
  type listBoardGroupMemoryApiV1BoardGroupsGroupIdMemoryGetResponse,
  streamBoardGroupMemoryApiV1BoardGroupsGroupIdMemoryStreamGet,
  useListBoardGroupMemoryApiV1BoardGroupsGroupIdMemoryGet,
} from "@/api/generated/board-group-memory/board-group-memory";
import { createTaskApiV1BoardsBoardIdTasksPost } from "@/api/generated/tasks/tasks";
import {
  type listAgentsApiV1AgentsGetResponse,
  useListAgentsApiV1AgentsGet,
} from "@/api/generated/agents/agents";
import {
  type getMyMembershipApiV1OrganizationsMeMemberGetResponse,
  useGetMyMembershipApiV1OrganizationsMeMemberGet,
} from "@/api/generated/organizations/organizations";
import type {
  AgentRead,
  BoardGroupHeartbeatApplyResult,
  BoardGroupMemoryRead,
  BoardGroupTaskSummary,
  OrganizationMemberRead,
} from "@/api/generated/model";
import type { BoardGroupBoardSnapshot } from "@/api/generated/model";
import { ActivityFeed } from "@/components/activity/ActivityFeed";
import { Markdown } from "@/components/atoms/Markdown";
import { StatusPill } from "@/components/atoms/StatusPill";
import { SignedOutPanel } from "@/components/auth/SignedOutPanel";
import { DashboardSidebar } from "@/components/organisms/DashboardSidebar";
import { DashboardShell } from "@/components/templates/DashboardShell";
import { BoardChatComposer } from "@/components/BoardChatComposer";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createExponentialBackoff } from "@/lib/backoff";
import { apiDatetimeToMs, localDateInputToUtcIso } from "@/lib/datetime";
import { formatTimestamp } from "@/lib/formatters";
import { isSystemActivityEvent } from "@/lib/operator-signal-filters";
import { cn } from "@/lib/utils";
import {
  findWorkflowBacklogBoard,
  getTaskWorkflowStageKey,
  getWorkflowStageDefinition,
  getWorkflowStageDescription,
  getWorkflowStageLabel,
  resolveWorkflowStageKey,
  WORKFLOW_STAGE_ORDER,
  type WorkflowStageKey,
} from "@/lib/workflow-stages";
import { usePageActive } from "@/hooks/usePageActive";

const modelBadgeLabel = (agent?: AgentRead | null) => {
  const modelRef = agent?.model_primary?.trim();
  if (modelRef) {
    if (modelRef.includes("codex")) return "Codex gpt-5.4";
    if (modelRef.includes("model-router")) return "Foundry router";
    return modelRef.replace(/^.*\//, "").replaceAll("-", " ");
  }
  if (agent?.model_profile) {
    return `${agent.model_profile} profile`;
  }
  return null;
};

const dueLabel = (value?: string | null) => {
  if (!value) return null;
  return `Due ${formatTimestamp(value)}`;
};

const safeCount = (snapshot: BoardGroupBoardSnapshot, key: string) =>
  snapshot.task_counts?.[key] ?? 0;

const canWriteGroupBoards = (
  member: OrganizationMemberRead | null,
  boardIds: Set<string>,
) => {
  if (!member) return false;
  if (member.all_boards_write) return true;
  if (!member.board_access || boardIds.size === 0) return false;
  return member.board_access.some(
    (access) => access.can_write && boardIds.has(access.board_id),
  );
};

type CockpitTaskNode = BoardGroupTaskSummary & {
  children: CockpitTaskNode[];
};

type WorkflowLane = {
  key: WorkflowStageKey;
  label: string;
  description: string;
  updatedAt: string | null;
  tasks: CockpitTaskNode[];
  boardIds: string[];
  inboxCount: number;
  liveCount: number;
};

const COCKPIT_STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  review: 1,
  inbox: 2,
  done: 3,
};

const COCKPIT_PRIORITY_ORDER: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const EPIC_PRIORITIES = [
  { value: "high", label: "High priority" },
  { value: "medium", label: "Medium priority" },
  { value: "low", label: "Low priority" },
] as const;

const compareCockpitTasks = (
  a: BoardGroupTaskSummary,
  b: BoardGroupTaskSummary,
) => {
  const statusDelta =
    (COCKPIT_STATUS_ORDER[a.status] ?? 99) -
    (COCKPIT_STATUS_ORDER[b.status] ?? 99);
  if (statusDelta !== 0) return statusDelta;
  const priorityDelta =
    (COCKPIT_PRIORITY_ORDER[a.priority] ?? 99) -
    (COCKPIT_PRIORITY_ORDER[b.priority] ?? 99);
  if (priorityDelta !== 0) return priorityDelta;
  return b.updated_at.localeCompare(a.updated_at);
};

const buildCockpitTaskTree = (
  tasks: BoardGroupTaskSummary[],
): CockpitTaskNode[] => {
  const byId = new Map<string, CockpitTaskNode>();
  tasks.forEach((task) => {
    byId.set(task.id, { ...task, children: [] });
  });
  const roots: CockpitTaskNode[] = [];
  byId.forEach((node) => {
    const parentId = node.parent_task_id;
    if (parentId && byId.has(parentId)) {
      byId.get(parentId)?.children.push(node);
      return;
    }
    roots.push(node);
  });
  const sortNodes = (nodes: CockpitTaskNode[]) => {
    nodes.sort(compareCockpitTasks);
    nodes.forEach((node) => sortNodes(node.children));
  };
  sortNodes(roots);
  return roots;
};

function GroupChatMessageCard({ message }: { message: BoardGroupMemoryRead }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900">
          {message.source ?? "User"}
        </p>
        <span className="text-xs text-slate-400">
          {formatTimestamp(message.created_at)}
        </span>
      </div>
      <div className="mt-2 select-text cursor-text text-sm leading-relaxed text-slate-900 break-words">
        <Markdown content={message.content} variant="basic" />
      </div>
      {message.tags?.length ? (
        <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-600">
          {message.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-slate-200 bg-white px-2 py-0.5"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const SSE_RECONNECT_BACKOFF = {
  baseMs: 1_000,
  factor: 2,
  jitter: 0.2,
  maxMs: 5 * 60_000,
} as const;
const HAS_ALL_MENTION_RE = /(^|\s)@all\b/i;

export default function BoardGroupDetailPage() {
  const { isSignedIn } = useAuth();
  const params = useParams();
  const groupIdParam = params?.groupId;
  const groupId = Array.isArray(groupIdParam) ? groupIdParam[0] : groupIdParam;
  const isPageActive = usePageActive();

  const [includeDone, setIncludeDone] = useState(false);
  const [perBoardLimit, setPerBoardLimit] = useState(10);
  const [expandedTaskIds, setExpandedTaskIds] = useState<
    Record<string, boolean>
  >({});

  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<BoardGroupMemoryRead[]>([]);
  const [isChatSending, setIsChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatBroadcast, setChatBroadcast] = useState(true);
  const chatMessagesRef = useRef<BoardGroupMemoryRead[]>([]);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const [isNotesOpen, setIsNotesOpen] = useState(false);
  const [notesMessages, setNotesMessages] = useState<BoardGroupMemoryRead[]>(
    [],
  );
  const notesMessagesRef = useRef<BoardGroupMemoryRead[]>([]);
  const notesEndRef = useRef<HTMLDivElement | null>(null);
  const [notesBroadcast, setNotesBroadcast] = useState(true);
  const [isNoteSending, setIsNoteSending] = useState(false);
  const [noteSendError, setNoteSendError] = useState<string | null>(null);

  const [includeBoardLeads, setIncludeBoardLeads] = useState(true);
  const [isHeartbeatApplying, setIsHeartbeatApplying] = useState(false);
  const [heartbeatApplyError, setHeartbeatApplyError] = useState<string | null>(
    null,
  );
  const [heartbeatApplyResult, setHeartbeatApplyResult] =
    useState<BoardGroupHeartbeatApplyResult | null>(null);
  const [showSystemActivity, setShowSystemActivity] = useState(false);
  const [isEpicDialogOpen, setIsEpicDialogOpen] = useState(false);
  const [epicTitle, setEpicTitle] = useState("");
  const [epicDescription, setEpicDescription] = useState("");
  const [epicPriority, setEpicPriority] = useState<string>("high");
  const [epicDueDate, setEpicDueDate] = useState("");
  const [isEpicCreating, setIsEpicCreating] = useState(false);
  const [epicCreateError, setEpicCreateError] = useState<string | null>(null);

  const snapshotQuery =
    useGetBoardGroupSnapshotApiV1BoardGroupsGroupIdSnapshotGet<
      getBoardGroupSnapshotApiV1BoardGroupsGroupIdSnapshotGetResponse,
      ApiError
    >(
      groupId ?? "",
      { include_done: includeDone, per_board_task_limit: perBoardLimit },
      {
        query: {
          enabled: Boolean(isSignedIn && groupId),
          refetchInterval: 30_000,
          refetchOnMount: "always",
          retry: false,
        },
      },
    );

  const snapshot =
    snapshotQuery.data?.status === 200 ? snapshotQuery.data.data : null;
  const group = snapshot?.group ?? null;
  const boards = useMemo(() => snapshot?.boards ?? [], [snapshot?.boards]);
  const boardIdSet = useMemo(() => {
    const ids = new Set<string>();
    boards.forEach((item) => {
      if (item.board?.id) {
        ids.add(item.board.id);
      }
    });
    return ids;
  }, [boards]);
  const groupMentionSuggestions = useMemo(() => {
    const options = new Set<string>(["lead", "all"]);
    boards.forEach((item) => {
      (item.tasks ?? []).forEach((task) => {
        if (task.assignee) {
          options.add(task.assignee);
        }
      });
    });
    return [...options];
  }, [boards]);

  const membershipQuery = useGetMyMembershipApiV1OrganizationsMeMemberGet<
    getMyMembershipApiV1OrganizationsMeMemberGetResponse,
    ApiError
  >({
    query: {
      enabled: Boolean(isSignedIn),
      refetchOnMount: "always",
    },
  });

  const member =
    membershipQuery.data?.status === 200 ? membershipQuery.data.data : null;
  const isAdmin = member?.role === "admin" || member?.role === "owner";
  const canWriteGroup = useMemo(
    () => canWriteGroupBoards(member, boardIdSet),
    [boardIdSet, member],
  );
  const canManageHeartbeat = Boolean(isAdmin && canWriteGroup);
  const agentsQuery = useListAgentsApiV1AgentsGet<
    listAgentsApiV1AgentsGetResponse,
    ApiError
  >(
    { limit: 200 },
    {
      query: {
        enabled: Boolean(isSignedIn && groupId),
        refetchInterval: 30_000,
        refetchOnMount: "always",
        retry: false,
      },
    },
  );
  const groupTasks = useMemo(
    () => boards.flatMap((item) => item.tasks ?? []),
    [boards],
  );
  const cockpitRoots = useMemo(
    () => buildCockpitTaskTree(groupTasks),
    [groupTasks],
  );
  const groupGatewayIds = useMemo(() => {
    const ids = new Set<string>();
    boards.forEach((item) => {
      if (item.board.gateway_id) {
        ids.add(item.board.gateway_id);
      }
    });
    return ids;
  }, [boards]);
  const agents = useMemo<AgentRead[]>(() => {
    if (agentsQuery.data?.status !== 200) return [];
    return agentsQuery.data.data.items ?? [];
  }, [agentsQuery.data]);
  const workloadAgents = useMemo(() => {
    const snapshotWorkload = (snapshot?.agent_workload ?? []).map((item) => ({
      agent: item.agent,
      activeTaskCount: item.active_task_count ?? 0,
      currentTask: item.current_task ?? null,
    }));
    if (snapshotWorkload.length > 0) {
      return snapshotWorkload;
    }
    const filteredAgents = agents.filter((agent) => {
      if (agent.board_id && boardIdSet.has(agent.board_id)) {
        return true;
      }
      return Boolean(agent.is_gateway_main && groupGatewayIds.has(agent.gateway_id));
    });
    const activeTasksByAgentId = new Map<string, BoardGroupTaskSummary[]>();
    groupTasks.forEach((task) => {
      if (!task.assigned_agent_id) return;
      const current = activeTasksByAgentId.get(task.assigned_agent_id) ?? [];
      current.push(task);
      activeTasksByAgentId.set(task.assigned_agent_id, current);
    });
    return filteredAgents.map((agent) => {
      const tasks = [...(activeTasksByAgentId.get(agent.id) ?? [])].sort(
        compareCockpitTasks,
      );
      return {
        agent,
        activeTaskCount: tasks.length,
        currentTask: tasks.find((task) => task.status !== "done") ?? tasks[0] ?? null,
      };
    });
  }, [agents, boardIdSet, groupGatewayIds, groupTasks, snapshot?.agent_workload]);
  const agentById = useMemo(() => {
    const map = new Map<string, AgentRead>();
    workloadAgents.forEach(({ agent }) => {
      map.set(agent.id, agent);
    });
    agents.forEach((agent) => {
      if (!map.has(agent.id)) {
        map.set(agent.id, agent);
      }
    });
    return map;
  }, [agents, workloadAgents]);
  const taskById = useMemo(() => {
    const map = new Map<string, BoardGroupTaskSummary>();
    groupTasks.forEach((task) => {
      map.set(task.id, task);
    });
    return map;
  }, [groupTasks]);
  const workflowStageByBoardId = useMemo(() => {
    const map = new Map<string, WorkflowStageKey>();
    boards.forEach((item) => {
      map.set(item.board.id, resolveWorkflowStageKey(item.board));
    });
    return map;
  }, [boards]);
  const workflowBacklogBoard = useMemo(
    () => findWorkflowBacklogBoard(boards),
    [boards],
  );
  const workflowLanes = useMemo(() => {
    const laneMap = new Map<WorkflowStageKey, WorkflowLane>();
    const ensureLane = (key: WorkflowStageKey) => {
      const current = laneMap.get(key);
      if (current) return current;
      const lane: WorkflowLane = {
        key,
        label: getWorkflowStageLabel(key),
        description: getWorkflowStageDescription(key),
        updatedAt: null,
        tasks: [],
        boardIds: [],
        inboxCount: 0,
        liveCount: 0,
      };
      laneMap.set(key, lane);
      return lane;
    };

    WORKFLOW_STAGE_ORDER.forEach((key) => {
      if (key !== "other") ensureLane(key);
    });

    boards.forEach((item) => {
      const key = resolveWorkflowStageKey(item.board);
      const lane = ensureLane(key);
      lane.boardIds.push(item.board.id);
      lane.inboxCount += safeCount(item, "inbox");
      lane.liveCount += safeCount(item, "in_progress") + safeCount(item, "review");
      lane.updatedAt =
        lane.updatedAt && lane.updatedAt > item.board.updated_at
          ? lane.updatedAt
          : item.board.updated_at;
    });

    cockpitRoots.forEach((task) => {
      const key =
        workflowStageByBoardId.get(task.board_id) ?? getTaskWorkflowStageKey(task);
      ensureLane(key).tasks.push(task);
    });

    return WORKFLOW_STAGE_ORDER.filter((key) => key !== "other").map((key) => {
      const lane = ensureLane(key);
      lane.tasks.sort(compareCockpitTasks);
      return lane;
    });
  }, [boards, cockpitRoots, workflowStageByBoardId]);
  const agendaOverdue = snapshot?.agenda?.overdue ?? [];
  const agendaToday = snapshot?.agenda?.today ?? [];
  const agendaUpcoming = snapshot?.agenda?.upcoming ?? [];
  const memoryPreview = snapshot?.memory_preview ?? [];
  const activityFeed = useMemo(() => snapshot?.activity_feed ?? [], [snapshot]);
  const visibleActivityFeed = useMemo(
    () =>
      showSystemActivity
        ? activityFeed
        : activityFeed.filter((item) => !isSystemActivityEvent(item)),
    [activityFeed, showSystemActivity],
  );
  const blockedCallouts = snapshot?.blocked_tasks ?? [];
  const readyAgentCount = workloadAgents.filter(
    ({ agent }) => agent.status === "online" || agent.status === "standby",
  ).length;
  const cockpitSummary = useMemo(() => {
    const blockedCount = groupTasks.filter((task) => task.is_blocked).length;
    const parentCount = groupTasks.filter((task) => (task.child_count ?? 0) > 0).length;
    const assignedCount = groupTasks.filter((task) => task.assigned_agent_id).length;
    const activeCount = groupTasks.filter(
      (task) => task.status === "in_progress" || task.status === "review",
    ).length;
    return {
      totalTasks: groupTasks.length,
      activeCount,
      blockedCount,
      parentCount,
      assignedCount,
      pendingApprovalsCount: snapshot?.pending_approvals_count ?? 0,
      dueTodayCount: agendaToday.length,
      overdueCount: agendaOverdue.length,
    };
  }, [agendaOverdue.length, agendaToday.length, groupTasks, snapshot?.pending_approvals_count]);

  const chatHistoryQuery =
    useListBoardGroupMemoryApiV1BoardGroupsGroupIdMemoryGet<
      listBoardGroupMemoryApiV1BoardGroupsGroupIdMemoryGetResponse,
      ApiError
    >(
      groupId ?? "",
      { limit: 200, is_chat: true },
      {
        query: {
          enabled: Boolean(isSignedIn && groupId && isChatOpen),
          refetchOnMount: "always",
          retry: false,
        },
      },
    );

  const notesHistoryQuery =
    useListBoardGroupMemoryApiV1BoardGroupsGroupIdMemoryGet<
      listBoardGroupMemoryApiV1BoardGroupsGroupIdMemoryGetResponse,
      ApiError
    >(
      groupId ?? "",
      { limit: 200, is_chat: false },
      {
        query: {
          enabled: Boolean(isSignedIn && groupId && isNotesOpen),
          refetchOnMount: "always",
          retry: false,
        },
      },
    );

  const mergeChatMessages = useCallback(
    (prev: BoardGroupMemoryRead[], next: BoardGroupMemoryRead[]) => {
      const byId = new Map<string, BoardGroupMemoryRead>();
      prev.forEach((item) => {
        byId.set(item.id, item);
      });
      next.forEach((item) => {
        if (item.is_chat) {
          byId.set(item.id, item);
        }
      });
      const merged = Array.from(byId.values());
      merged.sort((a, b) => {
        const aTime = apiDatetimeToMs(a.created_at) ?? 0;
        const bTime = apiDatetimeToMs(b.created_at) ?? 0;
        return aTime - bTime;
      });
      return merged;
    },
    [],
  );

  const mergeNotesMessages = useCallback(
    (prev: BoardGroupMemoryRead[], next: BoardGroupMemoryRead[]) => {
      const byId = new Map<string, BoardGroupMemoryRead>();
      prev.forEach((item) => {
        byId.set(item.id, item);
      });
      next.forEach((item) => {
        if (!item.is_chat) {
          byId.set(item.id, item);
        }
      });
      const merged = Array.from(byId.values());
      merged.sort((a, b) => {
        const aTime = apiDatetimeToMs(a.created_at) ?? 0;
        const bTime = apiDatetimeToMs(b.created_at) ?? 0;
        return aTime - bTime;
      });
      return merged;
    },
    [],
  );

  /**
   * Computes the newest `created_at` timestamp in a list of memory items.
   *
   * We pass this as `since` when reconnecting SSE so we don't re-stream the
   * entire chat history after transient disconnects.
   */
  const latestMemoryTimestamp = useCallback((items: BoardGroupMemoryRead[]) => {
    if (!items.length) return undefined;
    const latest = items.reduce((max, item) => {
      const ts = apiDatetimeToMs(item.created_at);
      return ts === null ? max : Math.max(max, ts);
    }, 0);
    if (!latest) return undefined;
    return new Date(latest).toISOString();
  }, []);

  useEffect(() => {
    chatMessagesRef.current = chatMessages;
  }, [chatMessages]);

  useEffect(() => {
    if (!isChatOpen) return;
    if (chatHistoryQuery.data?.status !== 200) return;
    const items = chatHistoryQuery.data.data.items ?? [];
    setChatMessages((prev) => mergeChatMessages(prev, items));
  }, [chatHistoryQuery.data, isChatOpen, mergeChatMessages]);

  useEffect(() => {
    if (!isChatOpen) return;
    const timeout = window.setTimeout(() => {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }, 50);
    return () => window.clearTimeout(timeout);
  }, [chatMessages, isChatOpen]);

  useEffect(() => {
    if (!isPageActive) return;
    if (!isSignedIn || !groupId) return;
    if (!isChatOpen) return;

    let isCancelled = false;
    const abortController = new AbortController();
    const backoff = createExponentialBackoff(SSE_RECONNECT_BACKOFF);
    let reconnectTimeout: number | undefined;

    const connect = async () => {
      try {
        const since = latestMemoryTimestamp(chatMessagesRef.current);
        const params = { is_chat: true, ...(since ? { since } : {}) };
        const streamResult =
          await streamBoardGroupMemoryApiV1BoardGroupsGroupIdMemoryStreamGet(
            groupId,
            params,
            {
              headers: { Accept: "text/event-stream" },
              signal: abortController.signal,
            },
          );
        if (streamResult.status !== 200) {
          throw new Error("Unable to connect group chat stream.");
        }
        const response = streamResult.data as Response;
        if (!(response instanceof Response) || !response.body) {
          throw new Error("Unable to connect group chat stream.");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!isCancelled) {
          const { value, done } = await reader.read();
          if (done) break;

          // Consider the stream healthy once we receive any bytes (including pings)
          // and reset the backoff so a later disconnect doesn't wait the full max.
          if (value && value.length) {
            backoff.reset();
          }

          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const raw = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const lines = raw.split("\n");
            let eventType = "message";
            let data = "";
            for (const line of lines) {
              if (line.startsWith("event:")) {
                eventType = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                data += line.slice(5).trim();
              }
            }
            if (eventType === "memory" && data) {
              try {
                const payload = JSON.parse(data) as {
                  memory?: BoardGroupMemoryRead;
                };
                if (payload.memory?.is_chat) {
                  setChatMessages((prev) =>
                    mergeChatMessages(prev, [
                      payload.memory as BoardGroupMemoryRead,
                    ]),
                  );
                }
              } catch {
                // Ignore malformed events.
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        if (isCancelled) return;
        if (abortController.signal.aborted) return;
        const delay = backoff.nextDelayMs();
        reconnectTimeout = window.setTimeout(() => {
          if (!isCancelled) void connect();
        }, delay);
      }
    };

    void connect();

    return () => {
      isCancelled = true;
      abortController.abort();
      if (reconnectTimeout) {
        window.clearTimeout(reconnectTimeout);
      }
    };
  }, [
    groupId,
    isChatOpen,
    isPageActive,
    isSignedIn,
    latestMemoryTimestamp,
    mergeChatMessages,
  ]);

  useEffect(() => {
    notesMessagesRef.current = notesMessages;
  }, [notesMessages]);

  useEffect(() => {
    if (!isNotesOpen) return;
    if (notesHistoryQuery.data?.status !== 200) return;
    const items = notesHistoryQuery.data.data.items ?? [];
    setNotesMessages((prev) => mergeNotesMessages(prev, items));
  }, [isNotesOpen, mergeNotesMessages, notesHistoryQuery.data]);

  useEffect(() => {
    if (!isNotesOpen) return;
    const timeout = window.setTimeout(() => {
      notesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }, 50);
    return () => window.clearTimeout(timeout);
  }, [isNotesOpen, notesMessages]);

  useEffect(() => {
    if (!isPageActive) return;
    if (!isSignedIn || !groupId) return;
    if (!isNotesOpen) return;

    let isCancelled = false;
    const abortController = new AbortController();
    const backoff = createExponentialBackoff(SSE_RECONNECT_BACKOFF);
    let reconnectTimeout: number | undefined;

    const connect = async () => {
      try {
        const since = latestMemoryTimestamp(notesMessagesRef.current);
        const params = { is_chat: false, ...(since ? { since } : {}) };
        const streamResult =
          await streamBoardGroupMemoryApiV1BoardGroupsGroupIdMemoryStreamGet(
            groupId,
            params,
            {
              headers: { Accept: "text/event-stream" },
              signal: abortController.signal,
            },
          );
        if (streamResult.status !== 200) {
          throw new Error("Unable to connect group notes stream.");
        }
        const response = streamResult.data as Response;
        if (!(response instanceof Response) || !response.body) {
          throw new Error("Unable to connect group notes stream.");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!isCancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length) {
            backoff.reset();
          }
          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const raw = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const lines = raw.split("\n");
            let eventType = "message";
            let data = "";
            for (const line of lines) {
              if (line.startsWith("event:")) {
                eventType = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                data += line.slice(5).trim();
              }
            }
            if (eventType === "memory" && data) {
              try {
                const payload = JSON.parse(data) as {
                  memory?: BoardGroupMemoryRead;
                };
                if (payload.memory && !payload.memory.is_chat) {
                  setNotesMessages((prev) =>
                    mergeNotesMessages(prev, [
                      payload.memory as BoardGroupMemoryRead,
                    ]),
                  );
                }
              } catch {
                // Ignore malformed events.
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        if (isCancelled) return;
        if (abortController.signal.aborted) return;
        const delay = backoff.nextDelayMs();
        reconnectTimeout = window.setTimeout(() => {
          if (!isCancelled) void connect();
        }, delay);
      }
    };

    void connect();

    return () => {
      isCancelled = true;
      abortController.abort();
      if (reconnectTimeout) {
        window.clearTimeout(reconnectTimeout);
      }
    };
  }, [
    groupId,
    isNotesOpen,
    isPageActive,
    isSignedIn,
    latestMemoryTimestamp,
    mergeNotesMessages,
  ]);

  const sendGroupChat = useCallback(
    async (content: string): Promise<boolean> => {
      if (!isSignedIn || !groupId) {
        setChatError("Sign in to send messages.");
        return false;
      }
      if (!canWriteGroup) {
        setChatError("Read-only access. You cannot post group messages.");
        return false;
      }
      const trimmed = content.trim();
      if (!trimmed) return false;

      setIsChatSending(true);
      setChatError(null);
      try {
        const shouldBroadcast =
          chatBroadcast || HAS_ALL_MENTION_RE.test(trimmed);
        const tags = ["chat", ...(shouldBroadcast ? ["broadcast"] : [])];
        const result =
          await createBoardGroupMemoryApiV1BoardGroupsGroupIdMemoryPost(
            groupId,
            { content: trimmed, tags },
          );
        if (result.status !== 200) {
          throw new Error("Unable to send message.");
        }
        const created = result.data;
        if (created.is_chat) {
          setChatMessages((prev) => mergeChatMessages(prev, [created]));
        }
        return true;
      } catch (err) {
        setChatError(
          err instanceof Error ? err.message : "Unable to send message.",
        );
        return false;
      } finally {
        setIsChatSending(false);
      }
    },
    [canWriteGroup, chatBroadcast, groupId, isSignedIn, mergeChatMessages],
  );

  const sendGroupNote = useCallback(
    async (content: string): Promise<boolean> => {
      if (!isSignedIn || !groupId) {
        setNoteSendError("Sign in to post.");
        return false;
      }
      if (!canWriteGroup) {
        setNoteSendError("Read-only access. You cannot post notes.");
        return false;
      }
      const trimmed = content.trim();
      if (!trimmed) return false;

      setIsNoteSending(true);
      setNoteSendError(null);
      try {
        const shouldBroadcast =
          notesBroadcast || HAS_ALL_MENTION_RE.test(trimmed);
        const tags = ["note", ...(shouldBroadcast ? ["broadcast"] : [])];
        const result =
          await createBoardGroupMemoryApiV1BoardGroupsGroupIdMemoryPost(
            groupId,
            { content: trimmed, tags },
          );
        if (result.status !== 200) {
          throw new Error("Unable to post.");
        }
        const created = result.data;
        if (!created.is_chat) {
          setNotesMessages((prev) => mergeNotesMessages(prev, [created]));
        }
        return true;
      } catch (err) {
        setNoteSendError(
          err instanceof Error ? err.message : "Unable to post.",
        );
        return false;
      } finally {
        setIsNoteSending(false);
      }
    },
    [canWriteGroup, groupId, isSignedIn, mergeNotesMessages, notesBroadcast],
  );

  const applyStandbyPolicy = useCallback(async () => {
    if (!isSignedIn || !groupId) {
      setHeartbeatApplyError("Sign in to update the presence policy.");
      return;
    }
    if (!canManageHeartbeat) {
      setHeartbeatApplyError(
        "Read-only access. You cannot change the presence policy.",
      );
      return;
    }
    setIsHeartbeatApplying(true);
    setHeartbeatApplyError(null);
    try {
      const result =
        await applyBoardGroupHeartbeatApiV1BoardGroupsGroupIdHeartbeatPost(
          groupId,
          { every: "0m", include_board_leads: includeBoardLeads },
        );
      if (result.status !== 200) {
        throw new Error("Unable to apply standby defaults.");
      }
      setHeartbeatApplyResult(result.data);
    } catch (err) {
      setHeartbeatApplyError(
        err instanceof Error
          ? err.message
          : "Unable to apply standby defaults.",
      );
    } finally {
      setIsHeartbeatApplying(false);
    }
  }, [canManageHeartbeat, groupId, includeBoardLeads, isSignedIn]);

  const resetEpicForm = useCallback(() => {
    setEpicTitle("");
    setEpicDescription("");
    setEpicPriority("high");
    setEpicDueDate("");
    setEpicCreateError(null);
  }, []);

  const handleCreateEpic = useCallback(async () => {
    if (!isSignedIn) {
      setEpicCreateError("Sign in to create a new epic.");
      return;
    }
    if (!canWriteGroup) {
      setEpicCreateError("Read-only access. You cannot create epics here.");
      return;
    }
    if (!workflowBacklogBoard?.board.id) {
      setEpicCreateError(
        "No backlog lane is mapped for this workflow. Add a Requirements board first.",
      );
      return;
    }
    const trimmed = epicTitle.trim();
    if (!trimmed) {
      setEpicCreateError("Epic title is required.");
      return;
    }

    setIsEpicCreating(true);
    setEpicCreateError(null);
    try {
      const result = await createTaskApiV1BoardsBoardIdTasksPost(
        workflowBacklogBoard.board.id,
        {
          title: trimmed,
          description: epicDescription.trim() || null,
          status: "inbox",
          priority: epicPriority,
          due_at: localDateInputToUtcIso(epicDueDate),
        },
      );
      if (result.status !== 200) {
        throw new Error("Unable to create epic.");
      }
      setIsEpicDialogOpen(false);
      resetEpicForm();
      await snapshotQuery.refetch();
    } catch (err) {
      setEpicCreateError(
        err instanceof Error ? err.message : "Unable to create epic.",
      );
    } finally {
      setIsEpicCreating(false);
    }
  }, [
    canWriteGroup,
    epicDescription,
    epicDueDate,
    epicPriority,
    epicTitle,
    isSignedIn,
    resetEpicForm,
    snapshotQuery,
    workflowBacklogBoard,
  ]);

  const toggleTaskExpanded = (taskId: string) => {
    setExpandedTaskIds((current) => ({
      ...current,
      [taskId]: !(current[taskId] ?? true),
    }));
  };

  const renderTaskNode = (task: CockpitTaskNode, depth = 0): ReactNode => {
    const hasChildren = task.children.length > 0;
    const isExpanded = expandedTaskIds[task.id] ?? true;
    const assignedAgent = task.assigned_agent_id
      ? agentById.get(task.assigned_agent_id) ?? null
      : null;
    const modelBadge = modelBadgeLabel(assignedAgent);
    const stageLabel = getWorkflowStageLabel(
      workflowStageByBoardId.get(task.board_id) ?? getTaskWorkflowStageKey(task),
    );
    return (
      <div key={task.id} className="space-y-3">
        <div
          className="rounded-3xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 shadow-sm"
          style={{ marginLeft: depth * 18 }}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {hasChildren ? (
                  <button
                    type="button"
                    onClick={() => toggleTaskExpanded(task.id)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[color:var(--border)] bg-[color:var(--surface-muted)] text-muted transition hover:text-strong"
                    aria-label={isExpanded ? "Collapse subtasks" : "Expand subtasks"}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </button>
                ) : (
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[color:var(--border)] bg-[color:var(--surface-muted)] text-quiet">
                    <GitBranch className="h-4 w-4" />
                  </span>
                )}
                <Link
                  href={{
                    pathname: `/boards/${task.board_id}`,
                    query: { taskId: task.id },
                  }}
                  className="min-w-0 text-sm font-semibold text-strong transition hover:text-[color:var(--accent)]"
                >
                  <span className="truncate">{task.title}</span>
                </Link>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                <StatusPill status={task.status} />
                <span className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-2 py-1">
                  {stageLabel}
                </span>
                <span className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-2 py-1">
                  Priority {task.priority}
                </span>
                {task.due_at ? (
                  <span className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-2 py-1">
                    {dueLabel(task.due_at)}
                  </span>
                ) : null}
                {modelBadge ? (
                  <span className="rounded-full border border-[color:var(--accent-soft)] bg-[color:var(--accent-soft)]/40 px-2 py-1 text-[color:var(--accent-strong)]">
                    {modelBadge}
                  </span>
                ) : null}
                {(task.child_count ?? 0) > 0 ? (
                  <span className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-2 py-1">
                    {task.child_count} subtasks
                  </span>
                ) : null}
                {(task.blocked_by_task_ids?.length ?? 0) > 0 ? (
                  <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900">
                    Blocked by {task.blocked_by_task_ids?.length}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="min-w-[12rem] text-right text-xs text-muted">
              <p>
                Assignee:{" "}
                <span className="font-medium text-strong">
                  {task.assignee ?? "Unassigned"}
                </span>
              </p>
              <p className="mt-1">Stage: {stageLabel}</p>
              <p className="mt-1">{formatTimestamp(task.updated_at)}</p>
            </div>
          </div>
        </div>
        {hasChildren && isExpanded ? (
          <div className="space-y-3">
            {task.children.map((child) => renderTaskNode(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <DashboardShell>
      <SignedOut>
        <SignedOutPanel
          message="Sign in to view board groups."
          forceRedirectUrl={`/board-groups/${groupId ?? ""}`}
        />
      </SignedOut>
      <SignedIn>
        <DashboardSidebar />
        <main className="flex-1 overflow-y-auto bg-[color:var(--surface-page)]">
          <div className="sticky top-0 z-30 border-b border-[color:var(--border)] bg-[color:var(--surface)] shadow-sm">
            <div className="px-4 py-4 md:px-8 md:py-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wider text-quiet">
                    Main board
                  </p>
                  <h1 className="mt-2 text-2xl font-semibold tracking-tight text-strong">
                    {group?.name ?? "Development"}
                  </h1>
                  {group?.description ? (
                    <p className="mt-2 max-w-2xl text-sm text-muted">
                      {group.description}
                    </p>
                  ) : (
                    <p className="mt-2 text-sm text-quiet">
                      One operator board for backlog, planning, execution, review,
                      security, QA, and done.
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      setEpicCreateError(null);
                      setIsEpicDialogOpen(true);
                    }}
                    disabled={!canWriteGroup || !workflowBacklogBoard?.board.id}
                    title={
                      canWriteGroup
                        ? workflowBacklogBoard?.board.id
                          ? "Create a new top-level epic"
                          : "Backlog lane is not configured"
                        : "Read-only access"
                    }
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    New Epic
                  </Button>
                  {group?.id ? (
                    <Link
                      href={`/board-groups/${group.id}/edit`}
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                      title="Edit group"
                    >
                      <Settings className="mr-2 h-4 w-4" />
                      Edit
                    </Link>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setIsNotesOpen(false);
                      setNoteSendError(null);
                      setChatError(null);
                      setIsChatOpen(true);
                    }}
                    disabled={!groupId}
                    title="Group chat"
                  >
                    <MessageSquare className="mr-2 h-4 w-4" />
                    Chat
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setIsChatOpen(false);
                      setChatError(null);
                      setNoteSendError(null);
                      setIsNotesOpen(true);
                    }}
                    disabled={!groupId}
                    title="Group notes"
                  >
                    <NotebookText className="mr-2 h-4 w-4" />
                    Notes
                  </Button>
                  <Link
                    href="/boards"
                    className={buttonVariants({ variant: "ghost", size: "sm" })}
                  >
                    Workflow admin
                  </Link>
                </div>
              </div>

              <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300 text-blue-600"
                    checked={includeDone}
                    onChange={(event) => setIncludeDone(event.target.checked)}
                  />
                  Include done
                </label>
                <div className="flex items-center gap-2 text-sm text-slate-700">
                  <span className="text-slate-500">Top tasks per board</span>
                  <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1">
                    {[0, 3, 5, 10].map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={cn(
                          "rounded-md px-2.5 py-1 text-xs font-semibold transition-colors",
                          perBoardLimit === value
                            ? "bg-slate-900 text-white"
                            : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                        )}
                        onClick={() => setPerBoardLimit(value)}
                      >
                        {value === 0 ? "0" : value}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
                  <span className="text-slate-500">Presence policy</span>
                  <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                    Standby by default
                  </span>
                  <span className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
                    Auto-wake on work
                  </span>
                  <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                    Lead 30m · Workers 20m while active
                  </span>
                  <label className="inline-flex items-center gap-2 text-xs text-slate-700">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-blue-600"
                      checked={includeBoardLeads}
                      onChange={(event) =>
                        setIncludeBoardLeads(event.target.checked)
                      }
                      disabled={!canManageHeartbeat}
                    />
                    Reset leads too
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void applyStandbyPolicy()}
                    disabled={isHeartbeatApplying || !canManageHeartbeat}
                    title={
                      canManageHeartbeat
                        ? "Reset group to standby"
                        : "Read-only access"
                    }
                  >
                    {isHeartbeatApplying ? "Applying…" : "Reset to standby"}
                  </Button>
                </div>
                {!canManageHeartbeat ? (
                  <p className="text-xs text-slate-500">
                    Read-only access. You cannot change the presence policy for
                    this group.
                  </p>
                ) : (
                  <p className="text-xs text-slate-500">
                    Idle agents stay quiet and healthy in standby. They wake
                    automatically when real task work appears, then fall back to
                    standby when the work is complete or paused.
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="p-4 md:p-8">
            <div className="space-y-6">
              {heartbeatApplyError ? (
                <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 shadow-sm">
                  {heartbeatApplyError}
                </div>
              ) : null}
              {heartbeatApplyResult ? (
                <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm">
                  <p className="font-semibold text-slate-900">
                    Presence policy updated
                  </p>
                  <p className="mt-1 text-slate-600">
                    Updated {heartbeatApplyResult.updated_agent_ids.length}{" "}
                    agents to standby defaults, failed{" "}
                    {heartbeatApplyResult.failed_agent_ids.length}.
                  </p>
                </div>
              ) : null}

              {snapshotQuery.isLoading ? (
                <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
                  Loading group snapshot…
                </div>
              ) : snapshotQuery.error ? (
                <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700 shadow-sm">
                  {snapshotQuery.error.message}
                </div>
              ) : boards.length === 0 ? (
                <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
                  No boards in this group yet. Assign boards from the board
                  settings page.
                </div>
              ) : (
                <div className="space-y-6">
                  <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
                    <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 shadow-sm">
                      <p className="text-xs uppercase tracking-[0.2em] text-quiet">
                        Active work
                      </p>
                      <p className="mt-2 text-2xl font-semibold text-strong">
                        {cockpitSummary.activeCount}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 shadow-sm">
                      <p className="text-xs uppercase tracking-[0.2em] text-quiet">
                        Blocked
                      </p>
                      <p className="mt-2 text-2xl font-semibold text-strong">
                        {cockpitSummary.blockedCount}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 shadow-sm">
                      <p className="text-xs uppercase tracking-[0.2em] text-quiet">
                        Pending approvals
                      </p>
                      <p className="mt-2 text-2xl font-semibold text-strong">
                        {cockpitSummary.pendingApprovalsCount}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 shadow-sm">
                      <p className="text-xs uppercase tracking-[0.2em] text-quiet">
                        Ready agents
                      </p>
                      <p className="mt-2 text-2xl font-semibold text-strong">
                        {readyAgentCount}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 shadow-sm">
                      <p className="text-xs uppercase tracking-[0.2em] text-quiet">
                        Due today
                      </p>
                      <p className="mt-2 text-2xl font-semibold text-strong">
                        {cockpitSummary.dueTodayCount}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 shadow-sm">
                      <p className="text-xs uppercase tracking-[0.2em] text-quiet">
                        Overdue
                      </p>
                      <p className="mt-2 text-2xl font-semibold text-strong">
                        {cockpitSummary.overdueCount}
                      </p>
                    </div>
                  </section>

                  <section className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_360px]">
                    <div className="space-y-6">
                      <div className="rounded-3xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-quiet">
                              Main board
                            </p>
                            <h2 className="mt-2 text-xl font-semibold text-strong">
                              Epic delivery flow at a glance
                            </h2>
                            <p className="mt-2 max-w-2xl text-sm text-muted">
                              Work now moves through one readable board with
                              operator-facing stages. Each lane hides the raw
                              backend board structure while parent epics keep
                              their subtasks and blockers visible inline.
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              onClick={() => {
                                setEpicCreateError(null);
                                setIsEpicDialogOpen(true);
                              }}
                              disabled={!canWriteGroup || !workflowBacklogBoard?.board.id}
                              title={
                                canWriteGroup
                                  ? workflowBacklogBoard?.board.id
                                    ? "Create a new top-level epic"
                                    : "Backlog lane is not configured"
                                  : "Read-only access"
                              }
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              New Epic
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setIsChatOpen(false);
                                setChatError(null);
                                setNoteSendError(null);
                                setIsNotesOpen(true);
                              }}
                            >
                              <NotebookText className="mr-2 h-4 w-4" />
                              Add note
                            </Button>
                            <Link
                              href="/approvals"
                              className={buttonVariants({ variant: "ghost", size: "sm" })}
                            >
                              Open approvals
                            </Link>
                          </div>
                        </div>

                        <div className="mt-6 overflow-x-auto">
                          <div className="grid auto-cols-[minmax(300px,1fr)] grid-flow-col gap-4 pb-3">
                            {workflowLanes.map((lane) => {
                              return (
                                <div
                                  key={lane.key}
                                  className="rounded-3xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4"
                                >
                                  <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0">
                                      <p className="truncate text-sm font-semibold text-strong">
                                        {lane.label}
                                      </p>
                                      <p className="mt-1 text-xs text-muted">
                                        {lane.description}
                                      </p>
                                      <p className="mt-2 text-[11px] uppercase tracking-[0.2em] text-quiet">
                                        Updated {formatTimestamp(lane.updatedAt)}
                                      </p>
                                    </div>
                                    <div className="flex flex-col items-end gap-2 text-[11px]">
                                      <span className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface)] px-2 py-1 text-muted">
                                        Inbox {lane.inboxCount}
                                      </span>
                                      <span className="rounded-full border border-[color:var(--accent-soft)] bg-[color:var(--accent-soft)]/30 px-2 py-1 text-[color:var(--accent-strong)]">
                                        Live {lane.liveCount}
                                      </span>
                                    </div>
                                  </div>

                                  <div className="mt-4 space-y-3">
                                    {lane.tasks.length > 0 ? (
                                      lane.tasks.map((task) => renderTaskNode(task))
                                    ) : (
                                      <div className="rounded-2xl border border-dashed border-[color:var(--border)] bg-[color:var(--surface)] p-5 text-sm text-muted">
                                        No visible epics in this stage yet.
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>

                      <div className="rounded-3xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
                        <div className="flex items-center gap-2">
                          <Users2 className="h-4 w-4 text-quiet" />
                          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-quiet">
                            Agent workload
                          </p>
                        </div>
                        <p className="mt-2 text-sm text-muted">
                          Who is working on what, which stage they are in, and
                          which model policy is currently attached.
                        </p>
                        <div className="mt-5 grid gap-4 lg:grid-cols-2">
                          {workloadAgents.length > 0 ? (
                            workloadAgents.map(({ agent, activeTaskCount, currentTask }) => (
                              <div
                                key={agent.id}
                                className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-semibold text-strong">
                                      {agent.name}
                                    </p>
                                    <p className="mt-1 text-xs text-muted">
                                      {agent.status_reason ?? "No status context yet."}
                                    </p>
                                  </div>
                                  <StatusPill status={agent.status ?? "offline"} />
                                </div>
                                <div className="mt-4 grid gap-3 text-sm text-muted">
                                  <div className="flex items-center justify-between gap-3">
                                    <span>Active tasks</span>
                                    <span className="font-medium text-strong">
                                      {activeTaskCount}
                                    </span>
                                  </div>
                                  <div className="flex items-start justify-between gap-3">
                                    <span>Current task</span>
                                    <span className="max-w-[14rem] text-right font-medium text-strong">
                                      {currentTask?.title ?? "No active task"}
                                    </span>
                                  </div>
                                  <div className="flex items-start justify-between gap-3">
                                    <span>Stage</span>
                                    <span className="max-w-[14rem] text-right text-strong">
                                      {currentTask
                                        ? getWorkflowStageLabel(getTaskWorkflowStageKey(currentTask))
                                        :
                                        (agent.is_gateway_main
                                          ? "Gateway control"
                                          : "Unassigned")}
                                    </span>
                                  </div>
                                  <div className="flex items-start justify-between gap-3">
                                    <span>Model</span>
                                    <span className="max-w-[14rem] text-right text-strong">
                                      {modelBadgeLabel(agent) ?? "Default policy"}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            ))
                          ) : (
                            <div className="rounded-2xl border border-dashed border-[color:var(--border)] bg-[color:var(--surface-muted)] p-6 text-sm text-muted">
                              No group agents are visible yet.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-6">
                      <div className="rounded-3xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <Sparkles className="h-4 w-4 text-quiet" />
                            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-quiet">
                              Live activity
                            </p>
                          </div>
                          <label className="inline-flex items-center gap-2 text-xs text-muted">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-[color:var(--border)]"
                              checked={showSystemActivity}
                              onChange={(event) =>
                                setShowSystemActivity(event.target.checked)
                              }
                            />
                            Show system
                          </label>
                        </div>
                        <div className="mt-5">
                          <ActivityFeed
                            isLoading={snapshotQuery.isLoading}
                            items={visibleActivityFeed}
                            renderItem={(item) => {
                              const relatedTask = item.task_id
                                ? taskById.get(item.task_id) ?? null
                                : null;
                              return (
                                <div
                                  key={item.id}
                                  className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4"
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <p className="text-sm font-semibold text-strong">
                                        {item.message ?? item.event_type}
                                      </p>
                                      <p className="mt-1 text-xs text-muted">
                                        {(item.actor_label ?? item.actor_type ?? "System") +
                                          " · " +
                                          formatTimestamp(item.created_at)}
                                      </p>
                                    </div>
                                    <span className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface)] px-2 py-1 text-[11px] text-muted">
                                      {item.event_type}
                                    </span>
                                  </div>
                                  {relatedTask ? (
                                    <Link
                                      href={{
                                        pathname: `/boards/${relatedTask.board_id}`,
                                        query: { taskId: relatedTask.id },
                                      }}
                                      className="mt-3 inline-flex items-center gap-2 text-xs font-medium text-[color:var(--accent)]"
                                    >
                                      Open {relatedTask.title}
                                      <ArrowUpRight className="h-3.5 w-3.5" />
                                    </Link>
                                  ) : null}
                                </div>
                              );
                            }}
                          />
                        </div>
                      </div>

                      <div className="rounded-3xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
                        <div className="flex items-center gap-2">
                          <CalendarRange className="h-4 w-4 text-quiet" />
                          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-quiet">
                            Agenda
                          </p>
                        </div>
                        <div className="mt-5 space-y-4">
                          {[
                            {
                              title: "Overdue",
                              icon: Flame,
                              tasks: agendaOverdue,
                            },
                            {
                              title: "Due today",
                              icon: Clock3,
                              tasks: agendaToday,
                            },
                            {
                              title: "Upcoming",
                              icon: CalendarRange,
                              tasks: agendaUpcoming,
                            },
                          ].map((bucket) => (
                            <div
                              key={bucket.title}
                              className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4"
                            >
                              <div className="flex items-center gap-2">
                                <bucket.icon className="h-4 w-4 text-quiet" />
                                <p className="text-sm font-semibold text-strong">
                                  {bucket.title}
                                </p>
                              </div>
                              <div className="mt-3 space-y-2">
                                {bucket.tasks.length > 0 ? (
                                  bucket.tasks.map((task) => (
                                    <Link
                                      key={task.id}
                                      href={{
                                        pathname: `/boards/${task.board_id}`,
                                        query: { taskId: task.id },
                                      }}
                                      className="block rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2 text-sm transition hover:border-[color:var(--accent-soft)]"
                                    >
                                      <p className="font-medium text-strong">
                                        {task.title}
                                      </p>
                                      <p className="mt-1 text-xs text-muted">
                                        {getWorkflowStageLabel(
                                          getTaskWorkflowStageKey(task),
                                        )}{" "}
                                        · {dueLabel(task.due_at)}
                                      </p>
                                    </Link>
                                  ))
                                ) : (
                                  <p className="text-sm text-muted">
                                    Nothing queued here.
                                  </p>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="rounded-3xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <NotebookText className="h-4 w-4 text-quiet" />
                            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-quiet">
                              Decisions and context
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setIsChatOpen(false);
                              setChatError(null);
                              setNoteSendError(null);
                              setIsNotesOpen(true);
                            }}
                          >
                            Open notes
                          </Button>
                        </div>
                        <div className="mt-5 space-y-3">
                          {memoryPreview.length > 0 ? (
                            memoryPreview.map((item) => (
                              <div
                                key={item.id}
                                className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <p className="text-xs uppercase tracking-[0.2em] text-quiet">
                                    {item.source ?? "Memory"}
                                  </p>
                                  <span className="text-xs text-muted">
                                    {formatTimestamp(item.created_at)}
                                  </span>
                                </div>
                                <div className="mt-2 text-sm text-strong">
                                  <Markdown content={item.content} variant="basic" />
                                </div>
                              </div>
                            ))
                          ) : (
                            <div className="rounded-2xl border border-dashed border-[color:var(--border)] bg-[color:var(--surface-muted)] p-5 text-sm text-muted">
                              No shared notes yet. Add a durable note to capture
                              decisions, context, or rollout rules.
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="rounded-3xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="h-4 w-4 text-quiet" />
                          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-quiet">
                            Attention center
                          </p>
                        </div>
                        <div className="mt-4 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="text-sm font-semibold text-strong">
                                Pending approvals
                              </p>
                              <p className="mt-1 text-sm text-muted">
                                {cockpitSummary.pendingApprovalsCount > 0
                                  ? `${cockpitSummary.pendingApprovalsCount} decisions are waiting for review.`
                                  : "No approvals are waiting right now."}
                              </p>
                            </div>
                            <Link
                              href="/approvals"
                              className={buttonVariants({ size: "sm", variant: "outline" })}
                            >
                              Review
                            </Link>
                          </div>
                        </div>
                        <div className="mt-4 space-y-3">
                          {blockedCallouts.length > 0 ? (
                            blockedCallouts.map((task) => (
                              <Link
                                key={task.id}
                                href={{
                                  pathname: `/boards/${task.board_id}`,
                                  query: { taskId: task.id },
                                }}
                                className="block rounded-2xl border border-amber-200 bg-amber-50/80 p-4 text-sm text-amber-950 transition hover:border-amber-300"
                              >
                                <p className="font-semibold">{task.title}</p>
                                <p className="mt-1 text-xs text-amber-900/80">
                                  {getWorkflowStageLabel(
                                    getTaskWorkflowStageKey(task),
                                  )}{" "}
                                  · blocked by {(task.blocked_by_task_ids ?? []).length}
                                  {task.due_at ? ` · ${dueLabel(task.due_at)}` : ""}
                                </p>
                              </Link>
                            ))
                          ) : (
                            <div className="rounded-2xl border border-dashed border-[color:var(--border)] bg-[color:var(--surface-muted)] p-5 text-sm text-muted">
                              No blocked callouts at the moment.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
              )}
            </div>
          </div>
        </main>
      </SignedIn>
      <Dialog
        open={isEpicDialogOpen}
        onOpenChange={(nextOpen) => {
          setIsEpicDialogOpen(nextOpen);
          if (!nextOpen) {
            resetEpicForm();
          }
        }}
      >
        <DialogContent aria-label="Create epic">
          <DialogHeader>
            <DialogTitle>New Epic</DialogTitle>
            <DialogDescription>
              Add a top-level initiative to the backlog. Lead can decompose it
              into implementation, review, and security work from there.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-strong">Title</label>
              <Input
                value={epicTitle}
                onChange={(event) => setEpicTitle(event.target.value)}
                placeholder="e.g. Ship customer-ready billing portal"
                disabled={!canWriteGroup || isEpicCreating}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-strong">
                Brief
              </label>
              <Textarea
                value={epicDescription}
                onChange={(event) => setEpicDescription(event.target.value)}
                placeholder="Short operator brief for Lead intake"
                className="min-h-[120px]"
                disabled={!canWriteGroup || isEpicCreating}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-strong">
                  Priority
                </label>
                <Select
                  value={epicPriority}
                  onValueChange={setEpicPriority}
                  disabled={!canWriteGroup || isEpicCreating}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select priority" />
                  </SelectTrigger>
                  <SelectContent>
                    {EPIC_PRIORITIES.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-strong">
                  Due date
                </label>
                <Input
                  type="date"
                  value={epicDueDate}
                  onChange={(event) => setEpicDueDate(event.target.value)}
                  disabled={!canWriteGroup || isEpicCreating}
                />
              </div>
            </div>
            <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4 text-xs text-muted">
              New epics land in{" "}
              <span className="font-semibold text-strong">
                {workflowBacklogBoard
                  ? getWorkflowStageDefinition("backlog").label
                  : "Backlog"}
              </span>{" "}
              and stay top-level until Lead creates child tasks.
            </div>
            {epicCreateError ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
                {epicCreateError}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsEpicDialogOpen(false)}
              disabled={isEpicCreating}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateEpic}
              disabled={!canWriteGroup || isEpicCreating || !workflowBacklogBoard?.board.id}
            >
              {isEpicCreating ? "Creating…" : "Create Epic"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {isChatOpen || isNotesOpen ? (
        <div
          className="fixed inset-0 z-40 bg-slate-900/20"
          onClick={() => {
            setIsChatOpen(false);
            setChatError(null);
            setIsNotesOpen(false);
            setNoteSendError(null);
          }}
        />
      ) : null}
      <aside
        className={cn(
          "fixed right-0 top-0 z-50 h-full w-[560px] max-w-[96vw] transform border-l border-slate-200 bg-white shadow-2xl transition-transform",
          isChatOpen ? "transform-none" : "translate-x-full",
        )}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Group chat
              </p>
              <p className="mt-1 truncate text-sm font-medium text-slate-900">
                Shared across linked boards. Tag @lead, @name, or @all.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setIsChatOpen(false);
                setChatError(null);
              }}
              className="rounded-lg border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-50"
              aria-label="Close group chat"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex flex-1 flex-col overflow-hidden px-6 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
              <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-blue-600"
                  checked={chatBroadcast}
                  onChange={(event) => setChatBroadcast(event.target.checked)}
                  disabled={!canWriteGroup}
                />
                Broadcast
              </label>
              <p className="text-xs text-slate-500">
                {chatBroadcast
                  ? "Notifies every agent in the group."
                  : "Notifies leads + mentions."}
              </p>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4">
              {chatHistoryQuery.error ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {chatHistoryQuery.error.message}
                </div>
              ) : null}
              {chatError ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {chatError}
                </div>
              ) : null}
              {chatHistoryQuery.isLoading && chatMessages.length === 0 ? (
                <p className="text-sm text-slate-500">Loading…</p>
              ) : chatMessages.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No messages yet. Start the conversation with a broadcast or a
                  mention.
                </p>
              ) : (
                chatMessages.map((message) => (
                  <GroupChatMessageCard key={message.id} message={message} />
                ))
              )}
              <div ref={chatEndRef} />
            </div>

            <BoardChatComposer
              placeholder={
                canWriteGroup
                  ? "Message the whole group. Tag @lead, @name, or @all."
                  : "Read-only access. Group chat is disabled."
              }
              isSending={isChatSending}
              onSend={sendGroupChat}
              disabled={!canWriteGroup}
              mentionSuggestions={groupMentionSuggestions}
            />
          </div>
        </div>
      </aside>
      <aside
        className={cn(
          "fixed right-0 top-0 z-50 h-full w-[560px] max-w-[96vw] transform border-l border-slate-200 bg-white shadow-2xl transition-transform",
          isNotesOpen ? "transform-none" : "translate-x-full",
        )}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Group notes
              </p>
              <p className="mt-1 truncate text-sm font-medium text-slate-900">
                Shared across linked boards. Tag @lead, @name, or @all.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setIsNotesOpen(false);
                setNoteSendError(null);
              }}
              className="rounded-lg border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-50"
              aria-label="Close group notes"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex flex-1 flex-col overflow-hidden px-6 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
              <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-blue-600"
                  checked={notesBroadcast}
                  onChange={(event) => setNotesBroadcast(event.target.checked)}
                  disabled={!canWriteGroup}
                />
                Broadcast
              </label>
              <p className="text-xs text-slate-500">
                {notesBroadcast
                  ? "Notifies every agent in the group."
                  : "Notifies leads + mentions."}
              </p>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4">
              {notesHistoryQuery.error ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {notesHistoryQuery.error.message}
                </div>
              ) : null}
              {noteSendError ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {noteSendError}
                </div>
              ) : null}
              {notesHistoryQuery.isLoading && notesMessages.length === 0 ? (
                <p className="text-sm text-slate-500">Loading…</p>
              ) : notesMessages.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No notes yet. Post a note or a broadcast to share context
                  across boards.
                </p>
              ) : (
                notesMessages.map((message) => (
                  <GroupChatMessageCard key={message.id} message={message} />
                ))
              )}
              <div ref={notesEndRef} />
            </div>

            <BoardChatComposer
              placeholder={
                canWriteGroup
                  ? "Post a shared note for all linked boards. Tag @lead, @name, or @all."
                  : "Read-only access. Notes are disabled."
              }
              isSending={isNoteSending}
              onSend={sendGroupNote}
              disabled={!canWriteGroup}
              mentionSuggestions={groupMentionSuggestions}
            />
          </div>
        </div>
      </aside>
    </DashboardShell>
  );
}
