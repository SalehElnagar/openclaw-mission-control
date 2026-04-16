"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Home } from "lucide-react";

const LABEL_MAP: Record<string, string> = {
  dashboard: "Dashboard",
  boards: "Boards",
  agents: "Agents",
  gateways: "Gateways",
  approvals: "Approvals",
  activity: "Live Feed",
  settings: "Settings",
  organization: "Organization",
  tags: "Tags",
  skills: "Skills",
  marketplace: "Marketplace",
  packs: "Packs",
  "board-groups": "Workflow Admin",
  "custom-fields": "Custom Fields",
  new: "New",
  edit: "Edit",
  webhooks: "Webhooks",
};

function segmentLabel(segment: string): string {
  return LABEL_MAP[segment] ?? segment.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function isUuid(segment: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment);
}

export function Breadcrumbs() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length <= 1) return null;

  const crumbs = segments.map((segment, index) => {
    const href = "/" + segments.slice(0, index + 1).join("/");
    const label = isUuid(segment) ? segment.slice(0, 8) + "..." : segmentLabel(segment);
    const isLast = index === segments.length - 1;
    return { href, label, isLast };
  });

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-muted">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1 transition hover:text-strong"
        aria-label="Home"
      >
        <Home className="h-3.5 w-3.5" />
      </Link>
      {crumbs.map((crumb) => (
        <Fragment key={crumb.href}>
          <ChevronRight className="h-3 w-3 text-quiet" />
          {crumb.isLast ? (
            <span className="font-medium text-strong" aria-current="page">
              {crumb.label}
            </span>
          ) : (
            <Link
              href={crumb.href}
              className="transition hover:text-strong"
            >
              {crumb.label}
            </Link>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
