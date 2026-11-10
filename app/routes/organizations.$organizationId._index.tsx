import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { IconLock, IconUsers } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
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

export function meta() {
  return [{ title: "Organization - Pactlane" }];
}

export default function OrganizationRoute() {
  const { organizationId = "" } = useParams();
  const navigate = useNavigate();
  const [projectName, setProjectName] = useState("");
  const { data, isLoading, error } = useActionQuery("get-organization", {
    organizationId,
  });
  const createProject = useActionMutation("create-project", {
    onSuccess: (project) => void navigate(`/projects/${project.id}`),
    onError: (err) =>
      toast.error(actionErrorMessage(err) ?? "Could not create the project."),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    createProject.mutate({
      name: projectName,
      description: null,
      organizationId,
    });
  }

  if (error) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
        <WorkspaceSwitcher
          current={{ kind: "organization", id: organizationId }}
        />
        <p role="alert" className="text-sm text-destructive">
          {actionErrorMessage(error) ?? "Could not load this organization."}
        </p>
        <Link to="/organizations" className="text-sm hover:underline">
          Back to organizations
        </Link>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { organization, projects } = data;
  const { permissions } = organization;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-4 sm:p-6">
      <header className="flex flex-col gap-3">
        <WorkspaceSwitcher
          current={{ kind: "organization", id: organization.id }}
        />
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold">
              {organization.name}
            </h1>
            {organization.description ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {organization.description}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Badge variant="outline">
              You are {ROLE_LABELS[organization.role].toLowerCase()}
            </Badge>
            <Button asChild variant="outline" size="sm">
              <Link to={`/organizations/${organization.id}/members`}>
                <IconUsers className="size-4" strokeWidth={1.8} />
                {organization.memberCount}{" "}
                {organization.memberCount === 1 ? "member" : "members"}
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <section
        aria-labelledby="org-projects-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="org-projects-heading" className="text-base font-semibold">
          Projects you can open
        </h2>
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {permissions.canCreateProjects
              ? "No projects you can open yet. Create one below; it stays private until you share it."
              : "No projects have been shared with you in this organization yet."}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  to={`/projects/${project.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {project.name}
                  </span>
                  <Badge variant="outline">
                    {project.isOwner ? "Your project" : "Shared with you"}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <IconLock className="size-3.5" strokeWidth={1.8} />
          Other organization projects stay hidden unless their owner shares them
          with you, whatever your role.
        </p>
      </section>

      {permissions.canCreateProjects ? (
        <section
          aria-labelledby="org-new-project-heading"
          className="flex flex-col gap-3 rounded-xl border p-4 sm:p-5"
        >
          <h2 id="org-new-project-heading" className="text-base font-semibold">
            New organization project
          </h2>
          <form
            onSubmit={submit}
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
          >
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="org-project-name">Project name</Label>
              <Input
                id="org-project-name"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                maxLength={200}
                required
              />
            </div>
            <Button
              type="submit"
              disabled={
                createProject.isPending || projectName.trim().length === 0
              }
            >
              {createProject.isPending ? "Creating…" : "Create project"}
            </Button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
