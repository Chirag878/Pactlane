import { Badge } from "@/components/ui/badge";

export const EVIDENCE_LABELS = {
  verified: { label: "Verified in transcript", variant: "secondary" },
  missing: { label: "Not found in transcript", variant: "destructive" },
  ambiguous: { label: "Occurs more than once", variant: "destructive" },
  unverified: { label: "Unverified", variant: "outline" },
} as const;

export type EvidenceStatus = keyof typeof EVIDENCE_LABELS;

export interface EvidenceItem {
  id: string;
  sourceQuote: string;
  verificationStatus: EvidenceStatus;
}

/** Quotations as the AI gave them, each with the server's verdict on the transcript. */
export function EvidenceList({ evidence }: { evidence: EvidenceItem[] }) {
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

/** One line summarising all quotations of an item. */
export function summarizeEvidence(evidence: EvidenceItem[]) {
  if (evidence.length === 0) {
    return { label: "No quotation", variant: "outline" } as const;
  }
  const verified = evidence.filter(
    (item) => item.verificationStatus === "verified",
  ).length;
  if (verified === evidence.length) {
    return { label: "Evidence verified", variant: "secondary" } as const;
  }
  return {
    label: `${verified} of ${evidence.length} quotations verified`,
    variant: "destructive",
  } as const;
}
