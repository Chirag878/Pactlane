import { useActionQuery } from "@agent-native/core/client/hooks";
import {
  IconBuilding,
  IconCheck,
  IconChevronDown,
  IconUser,
} from "@tabler/icons-react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type Workspace =
  | { kind: "personal" }
  | { kind: "organization"; id: string };

export const ROLE_LABELS = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
} as const;

/**
 * Pactlane workspaces: personal projects, or one organization. The active
 * workspace is the page being viewed; switching never changes the framework's
 * own organization, so stored connections are unaffected.
 */
export function WorkspaceSwitcher({ current }: { current: Workspace }) {
  const navigate = useNavigate();
  const { data, isLoading } = useActionQuery("list-my-organizations", {});
  const organizations = data?.organizations ?? [];
  const active =
    current.kind === "organization"
      ? organizations.find((org) => org.id === current.id)
      : null;
  const label =
    current.kind === "personal"
      ? "Personal workspace"
      : (active?.name ?? (isLoading ? "Loading…" : "Organization"));
  const Icon = current.kind === "personal" ? IconUser : IconBuilding;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="max-w-full justify-between gap-2 self-start"
          aria-label={`Workspace: ${label}. Switch workspace`}
        >
          <Icon className="size-4 shrink-0" strokeWidth={1.8} />
          <span className="truncate">{label}</span>
          <IconChevronDown className="size-4 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void navigate("/projects")}>
          <IconUser className="size-4" strokeWidth={1.8} />
          <span className="flex-1">Personal workspace</span>
          {current.kind === "personal" ? (
            <IconCheck className="size-4" aria-label="Current workspace" />
          ) : null}
        </DropdownMenuItem>
        {organizations.map((organization) => (
          <DropdownMenuItem
            key={organization.id}
            onSelect={() => void navigate(`/organizations/${organization.id}`)}
          >
            <IconBuilding className="size-4" strokeWidth={1.8} />
            <span className="min-w-0 flex-1 truncate">{organization.name}</span>
            <span className="text-xs text-muted-foreground">
              {ROLE_LABELS[organization.role]}
            </span>
            {current.kind === "organization" &&
            current.id === organization.id ? (
              <IconCheck className="size-4" aria-label="Current workspace" />
            ) : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void navigate("/organizations")}>
          {organizations.length === 0
            ? "Create an organization"
            : "All organizations"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
