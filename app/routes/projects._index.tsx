import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function meta() {
  return [{ title: "Projects - Pactlane" }];
}

export default function ProjectsRoute() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const { data, isLoading, error } = useActionQuery("list-projects", {});
  const createProject = useActionMutation("create-project", {
    onSuccess: (project) => void navigate(`/projects/${project.id}`),
    onError: (err) =>
      toast.error(actionErrorMessage(err) ?? "Could not create the project."),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    createProject.mutate({ name, description: null });
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-6">
      <h1 className="text-xl font-semibold">Projects</h1>

      <form onSubmit={submit} className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="project-name">New project</Label>
          <Input
            id="project-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Project name"
            maxLength={200}
            required
          />
        </div>
        <Button type="submit" disabled={createProject.isPending}>
          {createProject.isPending ? "Creating…" : "Create"}
        </Button>
      </form>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {actionErrorMessage(error) ?? "Could not load your projects."}
        </p>
      ) : isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : data?.projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">No projects yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {data?.projects.map((project) => (
            <li key={project.id}>
              <Link
                to={`/projects/${project.id}`}
                className="block py-3 text-sm font-medium hover:underline"
              >
                {project.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
