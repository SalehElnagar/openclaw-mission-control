import { describe, expect, it } from "vitest";

import type { BoardGroupRead } from "@/api/generated/model";
import { getOperationsGroupHref, pickOperationsGroup } from "./operations-group";

const makeGroup = (overrides: Partial<BoardGroupRead> = {}): BoardGroupRead => ({
  id: "group-1",
  organization_id: "org-1",
  name: "Operations",
  slug: "operations",
  description: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("operations-group helpers", () => {
  it("prefers the development group when present", () => {
    const groups = [
      makeGroup(),
      makeGroup({
        id: "group-2",
        name: "Development",
        slug: "development",
      }),
    ];

    expect(pickOperationsGroup(groups)?.id).toBe("group-2");
    expect(getOperationsGroupHref(groups)).toBe("/board-groups/group-2");
  });

  it("falls back to the first group when no preferred group exists", () => {
    const groups = [makeGroup({ id: "group-a" }), makeGroup({ id: "group-b" })];

    expect(pickOperationsGroup(groups)?.id).toBe("group-a");
    expect(getOperationsGroupHref(groups)).toBe("/board-groups/group-a");
  });
});
