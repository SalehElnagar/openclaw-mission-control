"use client";

import { Network } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNodeScope } from "@/components/providers/NodeScopeProvider";
import type { NodeScopeValue } from "@/lib/node-scope";

export function NodeScopeSwitcher() {
  const { enabled, isLoading, options, scope, setScope } = useNodeScope();

  if (!enabled) {
    return null;
  }

  return (
    <div className="relative">
      <Select
        value={scope}
        onValueChange={(value) => setScope(value as NodeScopeValue)}
      >
        <SelectTrigger className="h-9 w-[220px] rounded-md border-[color:var(--border)] bg-[color:var(--surface)] px-3 text-sm font-medium text-strong shadow-none focus:ring-2 focus:ring-[color:var(--accent)]/30 focus:ring-offset-0">
          <span className="flex items-center gap-2">
            <Network className="h-4 w-4 text-muted" />
            <SelectValue
              placeholder={isLoading ? "Loading nodes…" : "Select node scope"}
            />
          </span>
        </SelectTrigger>
        <SelectContent className="min-w-[240px] rounded-md border-[color:var(--border)] bg-[color:var(--surface)] p-1 shadow-xl">
          <div className="px-3 pb-2 pt-2 text-[10px] font-semibold uppercase tracking-wide text-quiet">
            Node scope
          </div>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              className="rounded-md py-2 pl-7 pr-3 text-sm text-strong data-[state=checked]:bg-[color:var(--accent-soft)] data-[state=checked]:text-[color:var(--accent-strong)] focus:bg-[color:var(--surface-muted)]"
            >
              <div className="flex flex-col">
                <span>{option.label}</span>
                <span className="text-xs text-muted">{option.description}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
