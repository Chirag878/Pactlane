import { useEffect, useMemo, useRef } from "react";

import {
  buildSegments,
  unlocatedQuotes,
  type EvidenceRange,
} from "@/lib/transcript-highlight";

/**
 * The original transcript, read-only. The selected item's verified quotations
 * are highlighted in place; any it cannot locate are listed beneath instead,
 * never guessed at.
 */
export function TranscriptPanel({
  transcript,
  evidence,
  heading,
}: {
  transcript: string;
  evidence: EvidenceRange[];
  heading: string | null;
}) {
  const segments = useMemo(
    () => buildSegments(transcript, evidence),
    [transcript, evidence],
  );
  const unlocated = useMemo(
    () => unlocatedQuotes(transcript, evidence),
    [transcript, evidence],
  );
  const firstMark = useRef<HTMLElement | null>(null);

  useEffect(() => {
    firstMark.current?.scrollIntoView({ block: "nearest" });
  }, [segments]);

  let markSeen = false;
  return (
    <details
      open
      aria-labelledby="transcript-heading"
      className="group rounded-xl border bg-card"
    >
      <summary className="cursor-pointer list-none px-4 py-3 marker:hidden">
        <h2 id="transcript-heading" className="text-base font-semibold">
          Transcript
        </h2>
      </summary>
      <div className="flex flex-col gap-3 border-t p-4 pt-3">
        <p className="text-xs text-muted-foreground">
          {heading
            ? `Source for: ${heading}`
            : "Select an analysis item to see its source."}
        </p>
        <div
          tabIndex={0}
          role="region"
          aria-label="Original transcript"
          className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/30 p-4 text-sm leading-relaxed lg:max-h-[calc(100vh-14rem)]"
        >
          {segments.length === 0
            ? transcript
            : segments.map((segment, index) => {
                if (!segment.highlighted) {
                  return <span key={index}>{segment.text}</span>;
                }
                const ref = markSeen ? undefined : firstMark;
                markSeen = true;
                return (
                  <mark
                    key={index}
                    ref={ref}
                    className="rounded-sm bg-primary/15 px-0.5 text-foreground"
                  >
                    {segment.text}
                  </mark>
                );
              })}
        </div>
        {unlocated.length > 0 ? (
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium">Not located in the transcript</p>
            <ul className="flex flex-col gap-1">
              {unlocated.map((item, index) => (
                <li
                  key={index}
                  className="border-s-2 border-destructive ps-3 text-muted-foreground"
                >
                  {item.sourceQuote}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}
