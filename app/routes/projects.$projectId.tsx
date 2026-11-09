import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import { CommitmentLedger } from "@/components/trail/CommitmentLedger";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function meta() {
  return [{ title: "Project - Pactlane" }];
}

const today = () => {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

export default function ProjectRoute() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [meetingDate, setMeetingDate] = useState(today);
  const [transcript, setTranscript] = useState("");

  const { data, isLoading, error } = useActionQuery("list-meetings", {
    projectId,
  });
  const createMeeting = useActionMutation("create-meeting", {
    onSuccess: (meeting) => void navigate(`/meetings/${meeting.id}`),
    onError: (err) =>
      toast.error(actionErrorMessage(err) ?? "Could not save the meeting."),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    createMeeting.mutate({ projectId, title, meetingDate, transcript });
  }

  if (error) {
    return (
      <div className="mx-auto w-full max-w-2xl p-6">
        <p role="alert" className="text-sm text-destructive">
          {actionErrorMessage(error) ?? "Could not load this project."}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 p-6">
      <h1 className="text-xl font-semibold">
        {data?.project.name ?? (isLoading ? "Loading…" : "Project")}
      </h1>

      <CommitmentLedger projectId={projectId} />

      <div className="grid gap-10 lg:grid-cols-2 lg:items-start">
        <section
          aria-labelledby="meetings-heading"
          className="flex flex-col gap-3"
        >
          <h2 id="meetings-heading" className="text-base font-semibold">
            Meetings
          </h2>
          {data && data.meetings.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border">
              {data.meetings.map((meeting) => (
                <li key={meeting.id}>
                  <Link
                    to={`/meetings/${meeting.id}`}
                    className="flex items-center justify-between gap-3 py-3 text-sm hover:underline"
                  >
                    <span className="min-w-0 truncate font-medium">
                      {meeting.title}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                      {meeting.meetingDate}
                      <Badge variant="outline">
                        {meeting.processingStatus !== "processed"
                          ? "Not analyzed"
                          : meeting.analysisPublicationState === "draft"
                            ? "Draft"
                            : "Published"}
                      </Badge>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No meetings yet. Add the first one here.
            </p>
          )}
        </section>

        <section
          aria-labelledby="new-meeting-heading"
          className="flex flex-col gap-3"
        >
          <h2 id="new-meeting-heading" className="text-base font-semibold">
            Add a meeting
          </h2>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="meeting-title">Meeting title</Label>
                <Input
                  id="meeting-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={200}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="meeting-date">Date</Label>
                <Input
                  id="meeting-date"
                  type="date"
                  value={meetingDate}
                  onChange={(event) => setMeetingDate(event.target.value)}
                  required
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="meeting-transcript">Transcript</Label>
              <Textarea
                id="meeting-transcript"
                value={transcript}
                onChange={(event) => setTranscript(event.target.value)}
                rows={10}
                required
              />
            </div>
            <Button
              type="submit"
              className="self-start"
              disabled={createMeeting.isPending}
            >
              {createMeeting.isPending ? "Saving…" : "Save meeting"}
            </Button>
          </form>
        </section>
      </div>
    </div>
  );
}
