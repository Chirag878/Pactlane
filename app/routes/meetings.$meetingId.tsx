import {
  ensureAgentEngineReadiness,
  sendToAgentChat,
} from "@agent-native/core/client/agent-chat";
import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { buildSettingsRoute } from "@agent-native/core/client/navigation";
import { useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";

import { CommitmentCard } from "@/components/meetings/CommitmentCard";
import {
  EvidenceList,
  summarizeEvidence,
} from "@/components/meetings/EvidenceList";
import {
  LinkReviewPanel,
  type InspectRange,
} from "@/components/meetings/LinkReviewPanel";
import { TranscriptPanel } from "@/components/meetings/TranscriptPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function meta() {
  return [{ title: "Meeting - Pactlane" }];
}

const NO_EVIDENCE: never[] = [];

export default function MeetingRoute() {
  const { meetingId = "" } = useParams();
  const [analysisState, setAnalysisState] = useState<
    "idle" | "checking" | "missing" | "unavailable"
  >("idle");
  const [searchParams] = useSearchParams();
  // A link from the Trail arrives with the item whose source should be shown.
  const [selectedId, setSelectedId] = useState<string | null>(
    searchParams.get("highlight"),
  );
  const [inspected, setInspected] = useState<InspectRange | null>(null);
  const [publishConfirmationOpen, setPublishConfirmationOpen] = useState(false);
  const [publishProblem, setPublishProblem] = useState<string | null>(null);
  // A source link (?highlight=) must open on the transcript it points into.
  const [mobileView, setMobileView] = useState<"analysis" | "transcript">(
    searchParams.get("highlight") ? "transcript" : "analysis",
  );
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const {
    data: meeting,
    isLoading,
    error,
    refetch,
  } = useActionQuery("get-meeting", { id: meetingId });
  const { data: people = [] } = useActionQuery(
    "list-people",
    { projectId: meeting?.projectId ?? "" },
    { enabled: Boolean(meeting) },
  );
  const publish = useActionMutation("publish-meeting-analysis", {
    onSuccess: (result) => {
      setPublishConfirmationOpen(false);
      setPublishProblem(null);
      void refetch();
      toast.success(
        result.changed
          ? "Meeting analysis published."
          : "Meeting analysis is already published.",
      );
    },
    onError: (error) => {
      if (
        (error as { errorCode?: unknown } | null)?.errorCode ===
        "analysis_revision_conflict"
      ) {
        setPublishConfirmationOpen(false);
        setPublishProblem(
          "This draft changed after you opened the confirmation. Review the latest analysis before publishing.",
        );
        void refetch();
        return;
      }
      setPublishProblem(
        actionErrorMessage(error) ?? "Could not publish this meeting analysis.",
      );
    },
  });

  const selected = useMemo(() => {
    if (!meeting || !selectedId) return null;
    return (
      [
        ...meeting.decisions,
        ...meeting.commitments,
        ...meeting.linkedCommitments,
        ...meeting.openQuestions,
        ...meeting.blockers,
        ...(meeting.nextMeeting
          ? [
              {
                ...meeting.nextMeeting,
                description:
                  meeting.nextMeeting.purpose ?? "Next meeting suggestion",
              },
            ]
          : []),
      ].find((item) => item.id === selectedId) ?? null
    );
  }, [meeting, selectedId]);

  // Offsets come from the server's match and are re-checked before highlighting.
  const transcriptEvidence = useMemo(
    () =>
      inspected
        ? [
            {
              sourceQuote: inspected.quote,
              sourceStart: inspected.start,
              sourceEnd: inspected.end,
              verificationStatus: "verified",
            },
          ]
        : (selected?.evidence ?? NO_EVIDENCE),
    [inspected, selected],
  );

  if (error) {
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <p role="alert" className="text-sm text-destructive">
          {actionErrorMessage(error) ?? "Could not load this meeting."}
        </p>
      </div>
    );
  }
  if (isLoading || !meeting) {
    return (
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6">
        <Skeleton className="h-5 w-28" />
        <div className="space-y-3">
          <Skeleton className="h-8 w-2/3 max-w-md" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)]">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      </div>
    );
  }

  async function requestAnalysis() {
    if (analysisState === "checking") return;
    setAnalysisState("checking");
    const readiness = await ensureAgentEngineReadiness({ fresh: true }).catch(
      () => "unavailable" as const,
    );
    if (readiness !== "configured") {
      setAnalysisState(readiness === "missing" ? "missing" : "unavailable");
      return;
    }

    sendToAgentChat({
      message: `Analyze the meeting "${meeting!.title}" and save the analysis.`,
      context: JSON.stringify({ meetingId: meeting!.id }),
      submit: true,
      openSidebar: true,
      chatTarget: "local",
    });
    setAnalysisState("idle");
  }

  // On a narrow screen switch to the transcript before bringing it into view.
  function revealTranscript() {
    if (!window.matchMedia("(min-width: 1024px)").matches) {
      setMobileView("transcript");
      requestAnimationFrame(() =>
        transcriptRef.current?.scrollIntoView({ block: "start" }),
      );
    }
  }

  function select(id: string) {
    setInspected(null);
    const same = selectedId === id;
    setSelectedId(same ? null : id);
    if (!same) revealTranscript();
  }

  const visibleAnalysis = meeting.analysisSaved && meeting.analysisVisible;
  const items = [
    ...meeting.decisions,
    ...meeting.commitments,
    ...meeting.openQuestions,
    ...meeting.blockers,
    ...(meeting.nextMeeting ? [meeting.nextMeeting] : []),
  ];
  const pending = items.filter((item) => item.needsReview).length;
  // A rejected commitment no longer asks for attention, so its quotations are not counted.
  const unverified = [
    ...meeting.decisions,
    ...meeting.commitments.filter((c) => c.reviewState !== "rejected"),
    ...meeting.openQuestions,
    ...meeting.blockers,
    ...(meeting.nextMeeting ? [meeting.nextMeeting] : []),
  ]
    .flatMap((item) => item.evidence)
    .filter((e) => e.verificationStatus !== "verified").length;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-3 border-b pb-5">
        <Link
          to={`/projects/${meeting.projectId}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          Back to project
        </Link>
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {meeting.title}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {meeting.meetingDate} · Participants not recorded
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={visibleAnalysis ? "secondary" : "outline"}>
              {!meeting.analysisSaved
                ? "Not analyzed"
                : meeting.analysisPublicationState === "draft"
                  ? "Draft analysis"
                  : "Published analysis"}
            </Badge>
            {visibleAnalysis ? (
              <Badge variant="outline">
                {pending > 0 ? `${pending} need review` : "Review clear"}
              </Badge>
            ) : null}
          </div>
        </div>
      </header>

      {visibleAnalysis ? (
        <section
          aria-labelledby="overview-heading"
          className="flex flex-col gap-4 rounded-xl border bg-card p-5 sm:p-6"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="overview-heading" className="text-lg font-semibold">
              Summary
            </h2>
            <Badge variant="outline">
              {meeting.analysisPublicationState === "draft"
                ? "AI-generated draft · editor review required"
                : "Published after human review"}
            </Badge>
          </div>
          {meeting.analysisPublicationState === "published" ? (
            <p className="text-xs text-muted-foreground">
              {meeting.analysisPublishedBy && meeting.analysisPublishedAt
                ? `Published by ${meeting.analysisPublishedBy} on ${new Date(meeting.analysisPublishedAt).toLocaleString()}.`
                : "Published before review attribution was tracked."}
            </p>
          ) : null}
          <div className="max-w-4xl space-y-3 text-sm leading-relaxed sm:text-base">
            {(meeting.summary ?? "No summary was saved.")
              .split(/\n\s*\n/)
              .map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
          </div>
          <p
            role="status"
            className={cn(
              "text-sm",
              pending > 0 || unverified > 0
                ? "font-medium"
                : "text-muted-foreground",
            )}
          >
            {pending > 0 || unverified > 0
              ? `${pending} item${pending === 1 ? "" : "s"} need review, ${unverified} quotation${unverified === 1 ? "" : "s"} not verified against the transcript.`
              : "Everything here has verified evidence and nothing needs review."}
          </p>
          {meeting.analysisPublicationState === "draft" &&
          meeting.canPublish ? (
            <div className="flex flex-col items-start gap-2 border-t pt-4">
              <p className="text-sm text-muted-foreground">
                Publishing shares this analysis with project viewers. It does
                not confirm individual commitments or change evidence
                verification.
              </p>
              {publishProblem ? (
                <p role="alert" className="text-sm text-destructive">
                  {publishProblem}
                </p>
              ) : null}
              {publishConfirmationOpen ? (
                <div
                  role="dialog"
                  aria-modal="false"
                  aria-labelledby="publish-analysis-title"
                  className="flex w-full max-w-xl flex-col gap-3 rounded-lg border bg-muted/30 p-4"
                >
                  <h3
                    id="publish-analysis-title"
                    className="text-sm font-medium"
                  >
                    Publish this reviewed analysis?
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    The saved summary, decisions, action items, findings, and
                    suggestion will become visible to project viewers.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      onClick={() => {
                        setPublishProblem(null);
                        publish.mutate({
                          meetingId: meeting.id,
                          expectedContentRevision:
                            meeting.analysisContentRevision,
                        });
                      }}
                      disabled={publish.isPending}
                    >
                      {publish.isPending ? "Publishing…" : "Publish analysis"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setPublishConfirmationOpen(false);
                        setPublishProblem(null);
                      }}
                      disabled={publish.isPending}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  onClick={() => setPublishConfirmationOpen(true)}
                >
                  Publish reviewed analysis
                </Button>
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      <div
        className="grid grid-cols-2 rounded-lg border p-1 lg:hidden"
        aria-label="Meeting workspace view"
      >
        <Button
          type="button"
          variant={mobileView === "analysis" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setMobileView("analysis")}
        >
          Analysis
        </Button>
        <Button
          type="button"
          variant={mobileView === "transcript" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setMobileView("transcript")}
        >
          Transcript
        </Button>
      </div>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)] lg:items-start">
        <div
          ref={transcriptRef}
          className={cn(
            "order-2 scroll-mt-4",
            mobileView === "transcript" ? "block" : "hidden",
            "lg:sticky lg:top-6 lg:order-2 lg:block",
          )}
        >
          <TranscriptPanel
            transcript={meeting.transcript ?? ""}
            evidence={transcriptEvidence}
            heading={
              inspected
                ? "the suggested statement"
                : (selected?.description ?? null)
            }
          />
        </div>

        <div
          className={cn(
            "order-1 flex-col gap-8",
            mobileView === "analysis" ? "flex" : "hidden",
            "lg:order-1 lg:flex",
          )}
        >
          {visibleAnalysis && meeting.transcript ? (
            <div className="order-8">
              <LinkReviewPanel
                meetingId={meeting.id}
                projectId={meeting.projectId}
                meetingDate={meeting.meetingDate}
                onInspect={(range) => {
                  setSelectedId(null);
                  setInspected(range);
                  revealTranscript();
                }}
              />
            </div>
          ) : null}

          {visibleAnalysis && meeting.linkedCommitments.length > 0 ? (
            <section
              aria-labelledby="linked-heading"
              className="order-7 flex flex-col gap-3"
            >
              <h2 id="linked-heading" className="text-base font-semibold">
                Earlier commitments discussed here
              </h2>
              {meeting.linkedCommitments.map((commitment) => {
                const isSelected = selectedId === commitment.id;
                return (
                  <article
                    key={commitment.id}
                    className={cn(
                      "flex flex-col gap-2 rounded-lg border p-4",
                      isSelected && "border-primary/60 bg-primary/[0.03]",
                    )}
                  >
                    <h3 className="text-sm font-medium">
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        title="Show the source in the transcript"
                        className="text-start hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => select(commitment.id)}
                      >
                        {commitment.description}
                      </button>
                    </h3>
                    <EvidenceList evidence={commitment.evidence} />
                    <Link
                      to={`/commitments/${commitment.id}`}
                      className="self-start text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      View trail across meetings
                    </Link>
                  </article>
                );
              })}
            </section>
          ) : null}

          {visibleAnalysis ? (
            <>
              <section
                aria-labelledby="decisions-heading"
                className="order-2 flex flex-col gap-3"
              >
                <h2 id="decisions-heading" className="text-base font-semibold">
                  Decisions
                </h2>
                {meeting.decisions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    None recorded.
                  </p>
                ) : (
                  meeting.decisions.map((decision) => {
                    const evidence = summarizeEvidence(decision.evidence);
                    const isSelected = selectedId === decision.id;
                    return (
                      <article
                        key={decision.id}
                        className={cn(
                          "flex flex-col gap-2 rounded-lg border p-4",
                          isSelected && "border-primary/60 bg-primary/[0.03]",
                        )}
                      >
                        <h3 className="text-sm font-medium">
                          <button
                            type="button"
                            aria-pressed={isSelected}
                            title="Show the source in the transcript"
                            className="text-start hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => select(decision.id)}
                          >
                            {decision.description}
                          </button>
                        </h3>
                        <div className="flex flex-wrap gap-1.5">
                          <Badge variant={evidence.variant}>
                            {evidence.label}
                          </Badge>
                          {decision.needsReview ? (
                            <Badge
                              variant="outline"
                              className="border-amber-500/60 text-amber-700 dark:text-amber-400"
                            >
                              Needs review
                            </Badge>
                          ) : null}
                        </div>
                        {decision.needsReview && decision.reviewReason ? (
                          <p className="text-sm">{decision.reviewReason}</p>
                        ) : null}
                        <EvidenceList evidence={decision.evidence} />
                      </article>
                    );
                  })
                )}
              </section>

              <section
                aria-labelledby="commitments-heading"
                className="order-1 flex flex-col gap-3"
              >
                <h2
                  id="commitments-heading"
                  className="text-base font-semibold"
                >
                  Action items
                </h2>
                {meeting.commitments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    None recorded.
                  </p>
                ) : (
                  meeting.commitments.map((commitment) => (
                    <CommitmentCard
                      key={commitment.id}
                      commitment={commitment}
                      people={people}
                      selected={selectedId === commitment.id}
                      onSelect={() => select(commitment.id)}
                      onReloadLatest={() => void refetch()}
                    />
                  ))
                )}
              </section>

              {[
                {
                  id: "questions",
                  title: "Open questions",
                  empty: "No open questions recorded.",
                  items: meeting.openQuestions,
                  order: "order-3",
                },
                {
                  id: "blockers",
                  title: "Blockers and risks",
                  empty: "No blockers or risks recorded.",
                  items: meeting.blockers,
                  order: "order-4",
                },
              ].map((section) => (
                <section
                  key={section.id}
                  aria-labelledby={`${section.id}-heading`}
                  className={cn("flex flex-col gap-3", section.order)}
                >
                  <h2
                    id={`${section.id}-heading`}
                    className="text-base font-semibold"
                  >
                    {section.title}
                  </h2>
                  {section.items.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {section.empty}
                    </p>
                  ) : (
                    section.items.map((item) => {
                      const evidence = summarizeEvidence(item.evidence);
                      const isSelected = selectedId === item.id;
                      return (
                        <article
                          key={item.id}
                          className={cn(
                            "flex flex-col gap-2 rounded-lg border p-4",
                            isSelected && "border-primary/60 bg-primary/[0.03]",
                          )}
                        >
                          <h3 className="text-sm font-medium">
                            <button
                              type="button"
                              aria-pressed={isSelected}
                              className="text-start hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={() => select(item.id)}
                            >
                              {item.description}
                            </button>
                          </h3>
                          <div className="flex flex-wrap gap-1.5">
                            <Badge variant={evidence.variant}>
                              {evidence.label}
                            </Badge>
                            {item.needsReview ? (
                              <Badge
                                variant="outline"
                                className="border-amber-500/60 text-amber-700 dark:text-amber-400"
                              >
                                Needs review
                              </Badge>
                            ) : null}
                          </div>
                          {item.reviewReason ? (
                            <p className="text-sm text-muted-foreground">
                              {item.reviewReason}
                            </p>
                          ) : null}
                          <EvidenceList evidence={item.evidence} />
                        </article>
                      );
                    })
                  )}
                </section>
              ))}

              <section
                aria-labelledby="next-meeting-heading"
                className="order-5 flex flex-col gap-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h2
                    id="next-meeting-heading"
                    className="text-base font-semibold"
                  >
                    Next meeting suggestion
                  </h2>
                  <Badge variant="outline">Review before scheduling</Badge>
                </div>
                {meeting.nextMeeting ? (
                  <article
                    className={cn(
                      "flex flex-col gap-3 rounded-lg border p-4",
                      selectedId === meeting.nextMeeting.id &&
                        "border-primary/60 bg-primary/[0.03]",
                    )}
                  >
                    <button
                      type="button"
                      aria-pressed={selectedId === meeting.nextMeeting.id}
                      className="text-start text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => select(meeting.nextMeeting!.id)}
                    >
                      {meeting.nextMeeting.purpose ??
                        "Follow-up meeting purpose not stated"}
                    </button>
                    <dl className="grid gap-3 text-sm sm:grid-cols-3">
                      <div>
                        <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Date
                        </dt>
                        <dd className="mt-1">
                          {meeting.nextMeeting.proposedDate ??
                            meeting.nextMeeting.statedDateText ??
                            "Unknown"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Time
                        </dt>
                        <dd className="mt-1">
                          {meeting.nextMeeting.proposedTime ??
                            meeting.nextMeeting.statedTimeText ??
                            "Unknown"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Participants
                        </dt>
                        <dd className="mt-1">
                          {meeting.nextMeeting.participants.length > 0
                            ? meeting.nextMeeting.participants.join(", ")
                            : "Unknown"}
                        </dd>
                      </div>
                    </dl>
                    {meeting.nextMeeting.unknowns.length > 0 ? (
                      <p className="text-sm text-muted-foreground">
                        Still unknown: {meeting.nextMeeting.unknowns.join(", ")}
                      </p>
                    ) : null}
                    {meeting.nextMeeting.reviewReason ? (
                      <p className="text-sm">
                        {meeting.nextMeeting.reviewReason}
                      </p>
                    ) : null}
                    <EvidenceList evidence={meeting.nextMeeting.evidence} />
                    <p className="text-xs text-muted-foreground">
                      This is a saved suggestion only. No calendar event has
                      been created.
                    </p>
                  </article>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No follow-up meeting was suggested in the analysis.
                  </p>
                )}
              </section>
            </>
          ) : (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-muted-foreground">
                {meeting.analysisSaved
                  ? "This analysis is awaiting an editor’s publication."
                  : "This meeting has not been analyzed yet."}
              </p>
              {meeting.canPublish && !meeting.analysisSaved ? (
                <Button
                  type="button"
                  onClick={requestAnalysis}
                  disabled={analysisState === "checking"}
                >
                  {analysisState === "checking"
                    ? "Checking AI setup…"
                    : "Analyze with AI"}
                </Button>
              ) : null}
              {analysisState === "missing" ? (
                <p role="status" className="text-sm text-muted-foreground">
                  AI configuration is required before this meeting can be
                  analyzed.{" "}
                  <Link to={buildSettingsRoute("model")} className="underline">
                    Connect a model in Agent settings
                  </Link>
                  , then return here and select Analyze with AI once.
                </p>
              ) : null}
              {analysisState === "unavailable" ? (
                <p role="alert" className="text-sm text-destructive">
                  AI setup could not be verified. Check your model connection
                  and try again; no analysis was submitted.
                </p>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
