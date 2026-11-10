import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";

type Access = "none" | "viewer" | "editor";

const ACCESS_LABELS: Record<Access, string> = {
  none: "No access",
  viewer: "Can view",
  editor: "Can edit",
};

/**
 * Who in the organization can open this project. Organization membership
 * alone grants nothing: each member needs a share from the project owner.
 */
export function ProjectAccessPanel({
  projectId,
  organizationId,
  organizationName,
}: {
  projectId: string;
  organizationId: string;
  organizationName: string | null;
}) {
  const members = useActionQuery("list-organization-members", {
    organizationId,
  });
  const shares = useActionQuery("list-resource-shares", {
    resourceType: "project",
    resourceId: projectId,
  });
  const onError = (error: unknown) =>
    toast.error(actionErrorMessage(error) ?? "Could not change access.");
  const grant = useActionMutation("share-resource", {
    onSuccess: () => toast.success("Access updated."),
    onError,
  });
  const revoke = useActionMutation("unshare-resource", {
    onSuccess: () => toast.success("Access removed."),
    onError,
  });
  const busy = grant.isPending || revoke.isPending;

  const ownerEmail = shares.data?.ownerEmail?.toLowerCase() ?? null;
  const roleFor = (email: string): Access => {
    const share = shares.data?.shares.find(
      (row) =>
        row.principalType === "user" && row.principalId.toLowerCase() === email,
    );
    if (!share) return "none";
    return share.role === "viewer" || share.role === "commenter"
      ? "viewer"
      : "editor";
  };

  function change(email: string, next: Access) {
    if (next === "none") {
      revoke.mutate({
        resourceType: "project",
        resourceId: projectId,
        principalType: "user",
        principalId: email,
      });
    } else {
      grant.mutate({
        resourceType: "project",
        resourceId: projectId,
        principalType: "user",
        principalId: email,
        role: next,
        notify: false,
      });
    }
  }

  return (
    <section
      aria-labelledby="project-access-heading"
      className="flex flex-col gap-3 rounded-xl border p-4 sm:p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 id="project-access-heading" className="text-base font-semibold">
          Project access
        </h2>
        <p className="text-sm text-muted-foreground">
          Members of {organizationName ?? "this organization"} see this project
          only when you give them access here. Drafts stay visible to editors
          only.
        </p>
      </div>
      {members.error || shares.error ? (
        <p role="alert" className="text-sm text-destructive">
          {actionErrorMessage(members.error ?? shares.error) ??
            "Could not load project access."}
        </p>
      ) : members.isLoading || shares.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {members.data?.members.map((member) => {
            const isOwner = member.email === ownerEmail;
            const access = roleFor(member.email);
            const selectId = `access-${member.email}`;
            return (
              <li
                key={member.email}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5"
              >
                <span className="min-w-0 truncate text-sm">
                  {member.email}
                  {member.isYou ? (
                    <span className="text-muted-foreground"> (you)</span>
                  ) : null}
                </span>
                {isOwner ? (
                  <Badge variant="secondary">Project owner</Badge>
                ) : (
                  <>
                    <label htmlFor={selectId} className="sr-only">
                      Access for {member.email}
                    </label>
                    <select
                      id={selectId}
                      value={access}
                      disabled={busy}
                      onChange={(event) =>
                        change(member.email, event.target.value as Access)
                      }
                      className="h-8 rounded-md border bg-background px-2 text-sm"
                    >
                      {(Object.keys(ACCESS_LABELS) as Access[]).map((value) => (
                        <option key={value} value={value}>
                          {ACCESS_LABELS[value]}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
