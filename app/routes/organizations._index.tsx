import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { IconBuilding } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import {
  ROLE_LABELS,
  WorkspaceSwitcher,
} from "@/components/organizations/WorkspaceSwitcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

export function meta() {
  return [{ title: "Organizations - Pactlane" }];
}

export default function OrganizationsRoute() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const { data, isLoading, error } = useActionQuery(
    "list-my-organizations",
    {},
  );
  const create = useActionMutation("create-organization", {
    uiOnly: true,
    onSuccess: ({ organization }) =>
      void navigate(`/organizations/${organization.id}`),
    onError: (err) =>
      toast.error(
        actionErrorMessage(err) ?? "Could not create the organization.",
      ),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate({ name, description: description.trim() || null });
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-4 sm:p-6">
      <header className="flex flex-col gap-3">
        <WorkspaceSwitcher current={{ kind: "personal" }} />
        <h1 className="text-xl font-semibold">Organizations</h1>
        <p className="text-sm text-muted-foreground">
          An organization groups people and projects. Each project stays private
          until its owner shares it with specific members.
        </p>
      </header>

      <section
        aria-labelledby="your-orgs-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="your-orgs-heading" className="text-base font-semibold">
          Your organizations
        </h2>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {actionErrorMessage(error) ?? "Could not load your organizations."}
          </p>
        ) : isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : data?.organizations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You are not in any organization yet. Create one below, or open an
            invitation link someone sent you.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border">
            {data?.organizations.map((organization) => (
              <li key={organization.id}>
                <Link
                  to={`/organizations/${organization.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <IconBuilding
                    className="size-4 shrink-0 text-muted-foreground"
                    strokeWidth={1.8}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {organization.name}
                  </span>
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    {organization.memberCount}{" "}
                    {organization.memberCount === 1 ? "member" : "members"}
                  </span>
                  <Badge variant="outline">
                    {ROLE_LABELS[organization.role]}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="create-org-heading"
        className="flex flex-col gap-3 rounded-xl border p-4 sm:p-5"
      >
        <h2 id="create-org-heading" className="text-base font-semibold">
          Create an organization
        </h2>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-name">Name</Label>
            <Input
              id="org-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-description">
              Description{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="org-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={2000}
              rows={2}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            You become the owner. Ownership can later be transferred to another
            member.
          </p>
          <Button
            type="submit"
            className="self-start"
            disabled={create.isPending || name.trim().length === 0}
          >
            {create.isPending ? "Creating…" : "Create organization"}
          </Button>
        </form>
      </section>
    </div>
  );
}
