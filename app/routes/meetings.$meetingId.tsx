import {
  ensureAgentEngineReadiness,
  sendToAgentChat,
} from "@agent-native/core/client/agent-chat";
import {
  actionErrorMessage,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { buildSettingsRoute } from "@agent-native/core/client/navigation";
import { useState } from "react";
import { Link, useParams } from "react-router";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function meta() {
  return [{ title: "Meeting - Pactlane" }];
}

const EVIDENCE_LABELS = {
  verified: { label: "Verified in transcript", variant: "secondary" },
  missing: { label: "Not found in transcript", variant: "destructive" },
  ambiguous: { label: "Occurs more than once", variant: "destructive" },
  unverified: { label: "Unverified", variant: "outline" },
} as const;

type EvidenceStatus = keyof typeof EVIDENCE_LABELS;

interface EvidenceItem {
  id: string;
  sourceQuote: string;
  verificationStatus: EvidenceStatus;
}

function EvidenceList({ evidence }: { evidence: EvidenceItem[] }) {
  if (evidence.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No supporting quotation.</p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {evidence.map((item) => {
        const status = EVIDENCE_LABELS[item.verificationStatus];
        return (
          <li key={item.id} className="flex flex-col items-start gap-1">
            <blockquote className="border-s-2 border-border ps-3 text-sm">
              {item.sourceQuote}
            </blockquote>
            <Badge variant={status.variant}>{status.label}</Badge>
          </li>
        );
      })}
    </ul>
  );
}

function ReviewNotice({ reason }: { reason: string | null }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge variant="destructive">Needs review</Badge>
      {reason ? <p className="text-sm">{reason}</p> : null}
    </div>
  );
}

export default function MeetingRoute() {
  const { meetingId = "" } = useParams();
  const [analysisState, setAnalysisState] = useState<
    "idle" | "checking" | "missing" | "unavailable"
  >("idle");
  const {
    data: meeting,
    isLoading,
    error,
  } = useActionQuery("get-meeting", { id: meetingId });

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

  const items = [...meeting.decisions, ...meeting.commitments];
  const reviewCount = items.filter((item) => item.needsReview).length;
  const unverifiedCount = items
    .flatMap((item) => item.evidence)
    .filter((e) => e.verificationStatus !== "verified").length;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-1">
        <Link
          to={`/projects/${meeting.projectId}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          Back to project
        </Link>
        <h1 className="text-xl font-semibold">{meeting.title}</h1>
        <p className="text-sm text-muted-foreground">{meeting.meetingDate}</p>
      </div>

      {meeting.analysisSaved ? (
        <>
          {reviewCount > 0 || unverifiedCount > 0 ? (
            <p className="text-sm font-medium">
              {reviewCount} item{reviewCount === 1 ? "" : "s"} need review
              {unverifiedCount > 0
                ? `, ${unverifiedCount} quotation${unverifiedCount === 1 ? "" : "s"} not verified`
                : ""}
              .
            </p>
          ) : null}

          <section className="flex flex-col gap-2">
            <h2 className="text-base font-semibold">Summary</h2>
            <p className="text-sm">{meeting.summary}</p>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-base font-semibold">Decisions</h2>
            {meeting.decisions.length === 0 ? (
              <p className="text-sm text-muted-foreground">None recorded.</p>
            ) : (
              meeting.decisions.map((decision) => (
                <article key={decision.id} className="flex flex-col gap-2">
                  <p className="text-sm font-medium">{decision.description}</p>
                  {decision.needsReview ? (
                    <ReviewNotice reason={decision.reviewReason} />
                  ) : null}
                  <EvidenceList evidence={decision.evidence} />
                </article>
              ))
            )}
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-base font-semibold">Commitments</h2>
            {meeting.commitments.length === 0 ? (
              <p className="text-sm text-muted-foreground">None recorded.</p>
            ) : (
              meeting.commitments.map((commitment) => (
                <article key={commitment.id} className="flex flex-col gap-2">
                  <p className="text-sm font-medium">
                    {commitment.description}
                  </p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">Owner</dt>
                    <dd>
                      {commitment.ownerDisplayName ??
                        commitment.statedOwnerName ??
                        "Unassigned"}
                    </dd>
                    <dt className="text-muted-foreground">Due</dt>
                    <dd>
                      {commitment.dueDate ?? "No date"}
                      {commitment.statedDueText
                        ? ` (said: "${commitment.statedDueText}")`
                        : ""}
                    </dd>
                    {commitment.priority ? (
                      <>
                        <dt className="text-muted-foreground">Priority</dt>
                        <dd className="capitalize">{commitment.priority}</dd>
                      </>
                    ) : null}
                  </dl>
                  {commitment.needsReview ? (
                    <ReviewNotice reason={commitment.reviewReason} />
                  ) : null}
                  <EvidenceList evidence={commitment.evidence} />
                </article>
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
            {analysisState === "checking" ? "Checking AI setup…" : "Analyze with AI"}
          </Button>
          {analysisState === "missing" ? (
            <p role="status" className="text-sm text-muted-foreground">
              AI configuration is required before this meeting can be analyzed.{' '}
              <Link to={buildSettingsRoute("model")} className="underline">
                Connect a model in Agent settings
              </Link>
              , then return here and select Analyze with AI once.
            </p>
          ) : null}
          {analysisState === "unavailable" ? (
            <p role="alert" className="text-sm text-destructive">
              AI setup could not be verified. Check your model connection and try again; no analysis was submitted.
            </p>
          ) : null}
        </div>
      )}

      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Transcript
        </summary>
        <p className="mt-2 whitespace-pre-wrap text-sm">{meeting.transcript}</p>
      </details>
    </div>
  );
}
