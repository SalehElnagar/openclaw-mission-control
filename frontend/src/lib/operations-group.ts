import type { BoardGroupRead } from "@/api/generated/model";

const OPERATIONS_GROUP_CANDIDATES = ["development", "personal engineering"];

const normalize = (value?: string | null) => (value ?? "").trim().toLowerCase();

export const pickOperationsGroup = (
  groups: BoardGroupRead[],
): BoardGroupRead | null => {
  if (!groups.length) return null;
  const directMatch = groups.find((group) =>
    OPERATIONS_GROUP_CANDIDATES.includes(normalize(group.slug)),
  );
  if (directMatch) return directMatch;
  const namedMatch = groups.find((group) =>
    OPERATIONS_GROUP_CANDIDATES.includes(normalize(group.name)),
  );
  if (namedMatch) return namedMatch;
  return groups[0] ?? null;
};

export const getOperationsGroupHref = (groups: BoardGroupRead[]): string => {
  const group = pickOperationsGroup(groups);
  return group ? `/board-groups/${group.id}` : "/boards";
};
