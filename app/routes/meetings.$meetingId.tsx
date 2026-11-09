import {
  ensureAgentEngineReadiness,
  sendToAgentChat,
} from "@agent-native/core/client/agent-chat";
import {
  actionErrorMessage,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { buildSettingsRoute } from "@agent-native/core/client/navigation";
import { useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";

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

  const selected = useMemo(() => {
    if (!meeting || !selectedId) return null;
    return (
      [
        ...meeting.decisions,
        ...meeting.commitments,
        ...meeting.linkedCommitments,
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
      <div className="mx-auto w-full max-w-3xl p-6">
        <p className="text-sm text-muted-foreground">Loading…</p>
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

  // On a narrow screen the transcript sits below, so bring it into view.
  function revealTranscript() {
    if (!window.matchMedia("(min-width: 1024px)").matches) {
      transcriptRef.current?.scrollIntoView({ block: "start" });
    }
  }

  function select(id: string) {
    setInspected(null);
    const same = selectedId === id;
    setSelectedId(same ? null : id);
    if (!same) revealTranscript();
  }

  const items = [...meeting.decisions, ...meeting.commitments];
  const pending = items.filter((item) => item.needsReview).length;
  // A rejected commitment no longer asks for attention, so its quotations are not counted.
  const unverified = [
    ...meeting.decisions,
    ...meeting.commitments.filter((c) => c.reviewState !== "rejected"),
  ]
    .flatMap((item) => item.evidence)
    .filter((e) => e.verificationStatus !== "verified").length;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6">
      <header className="flex flex-col gap-1">
        <Link
          to={`/projects/${meeting.projectId}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          Back to project
        </Link>
        <h1 className="text-xl font-semibold">{meeting.title}</h1>
        <p className="text-sm text-muted-foreground">{meeting.meetingDate}</p>
      </header>

      {meeting.analysisSaved ? (
        <section
          aria-labelledby="overview-heading"
          className="flex flex-col gap-3"
        >
          <h2 id="overview-heading" className="text-base font-semibold">
            Overview
          </h2>
          <p className="max-w-3xl text-sm">{meeting.summary}</p>
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
        </section>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-start">
        <div
          ref={transcriptRef}
          className="order-2 scroll-mt-4 lg:sticky lg:top-6 lg:order-1"
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

        <div className="order-1 flex flex-col gap-8 lg:order-2">
          {meeting.transcript ? (
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
          ) : null}

          {meeting.linkedCommitments.length > 0 ? (
            <section
              aria-labelledby="linked-heading"
              className="flex flex-col gap-3"
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

          {meeting.analysisSaved ? (
            <>
              <section
                aria-labelledby="decisions-heading"
                className="flex flex-col gap-3"
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
                className="flex flex-col gap-3"
              >
                <h2
                  id="commitments-heading"
                  className="text-base font-semibold"
                >
                  Commitments
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
            </>
          ) : (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-muted-foreground">
                This meeting has not been analyzed yet.
              </p>
              <Button
                type="button"
                onClick={requestAnalysis}
                disabled={analysisState === "checking"}
              >
                {analysisState === "checking"
                  ? "Checking AI setup…"
                  : "Analyze with AI"}
              </Button>
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
