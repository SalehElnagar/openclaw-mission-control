"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  BarChart3,
  Bot,
  Building2,
  CheckCircle2,
  FileText,
  Folder,
  LayoutGrid,
  Network,
  Settings,
  Store,
  Tags,
  Users,
} from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import * as Dialog from "@radix-ui/react-dialog";

type CommandRoute = {
  label: string;
  href: string;
  icon: React.ReactNode;
  keywords?: string[];
};

const NAVIGATION_ROUTES: CommandRoute[] = [
  { label: "Dashboard", href: "/dashboard", icon: <BarChart3 className="h-4 w-4" />, keywords: ["home", "overview", "metrics"] },
  { label: "Live Feed", href: "/activity", icon: <Activity className="h-4 w-4" />, keywords: ["activity", "stream", "log"] },
  { label: "Products", href: "/products", icon: <Bot className="h-4 w-4" />, keywords: ["folders", "planning", "services"] },
  { label: "Docs", href: "/docs", icon: <FileText className="h-4 w-4" />, keywords: ["artifacts", "plans", "briefs"] },
  { label: "Team", href: "/team", icon: <Users className="h-4 w-4" />, keywords: ["agents", "roster", "crew"] },
  { label: "Boards", href: "/boards", icon: <LayoutGrid className="h-4 w-4" />, keywords: ["tasks", "kanban", "projects"] },
  { label: "Agents", href: "/agents", icon: <Bot className="h-4 w-4" />, keywords: ["ai", "workers", "lead", "builder"] },
  { label: "Gateways", href: "/gateways", icon: <Network className="h-4 w-4" />, keywords: ["openclaw", "runtime", "connection"] },
  { label: "Approvals", href: "/approvals", icon: <CheckCircle2 className="h-4 w-4" />, keywords: ["review", "pending", "approve"] },
  { label: "Tags", href: "/tags", icon: <Tags className="h-4 w-4" />, keywords: ["labels", "categorize"] },
  { label: "Skills Marketplace", href: "/skills/marketplace", icon: <Store className="h-4 w-4" />, keywords: ["tools", "plugins"] },
];

const ADMIN_ROUTES: CommandRoute[] = [
  { label: "Workflow Admin", href: "/board-groups", icon: <Folder className="h-4 w-4" />, keywords: ["groups", "workflow"] },
  { label: "Organization", href: "/organization", icon: <Building2 className="h-4 w-4" />, keywords: ["members", "team", "invites"] },
  { label: "Settings", href: "/settings", icon: <Settings className="h-4 w-4" />, keywords: ["profile", "preferences"] },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const navigateTo = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-[20%] z-50 w-full max-w-lg -translate-x-1/2 rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2">
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Dialog.Description className="sr-only">
            Navigate to any page quickly
          </Dialog.Description>
          <Command className="rounded-xl bg-[color:var(--surface)]">
            <CommandInput placeholder="Where do you want to go?" />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandGroup heading="Navigation">
                {NAVIGATION_ROUTES.map((route) => (
                  <CommandItem
                    key={route.href}
                    value={`${route.label} ${(route.keywords ?? []).join(" ")}`}
                    onSelect={() => navigateTo(route.href)}
                    className="flex items-center gap-3 px-3 py-2.5 text-sm text-muted transition data-[selected=true]:bg-[color:var(--accent-soft)] data-[selected=true]:text-strong"
                  >
                    {route.icon}
                    <span>{route.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Administration">
                {ADMIN_ROUTES.map((route) => (
                  <CommandItem
                    key={route.href}
                    value={`${route.label} ${(route.keywords ?? []).join(" ")}`}
                    onSelect={() => navigateTo(route.href)}
                    className="flex items-center gap-3 px-3 py-2.5 text-sm text-muted transition data-[selected=true]:bg-[color:var(--accent-soft)] data-[selected=true]:text-strong"
                  >
                    {route.icon}
                    <span>{route.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
            <div className="border-t border-[color:var(--border)] px-3 py-2">
              <p className="text-xs text-quiet">
                <kbd className="rounded border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-1.5 py-0.5 font-mono text-[10px]">
                  ⌘K
                </kbd>{" "}
                to toggle &middot;{" "}
                <kbd className="rounded border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-1.5 py-0.5 font-mono text-[10px]">
                  ↵
                </kbd>{" "}
                to navigate &middot;{" "}
                <kbd className="rounded border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-1.5 py-0.5 font-mono text-[10px]">
                  esc
                </kbd>{" "}
                to close
              </p>
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
