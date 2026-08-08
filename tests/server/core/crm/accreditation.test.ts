import { describe, expect, it } from "vitest";
import {
  assertCanBeAccredited,
  assessAccreditation,
  RENEWAL_WARNING_DAYS,
} from "@/server/core/crm/accreditation-service";

/**
 * specs/01-crm-inquiry.md §5b, as narrowed by the company: the documents AIES submits to *get*
 * accredited live on each customer's own portal, so this system tracks only the outcome — the
 * certificate the customer issued and its expiry. See docs/DECISIONS.md #19.
 *
 * That makes the derivation the whole of the logic. A record can *say* accredited while its expiry
 * passed last week, and nobody runs a job before opening a page, so the date has to win.
 */

const NOW = new Date("2026-08-08T00:00:00.000Z");
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

describe("assessAccreditation", () => {
  it("leaves a healthy accreditation alone and does not block selling", () => {
    const health = assessAccreditation({ status: "accredited", expiresAt: daysFromNow(300) }, NOW);
    expect(health.effectiveStatus).toBe("accredited");
    expect(health.blocksSelling).toBe(false);
    expect(health.daysUntilExpiry).toBe(300);
  });

  it("flips accredited to expired once the expiry date has passed", () => {
    // The stored status is stale by definition here — the date is the fact.
    const health = assessAccreditation({ status: "accredited", expiresAt: daysFromNow(-1) }, NOW);
    expect(health.effectiveStatus).toBe("expired");
    expect(health.blocksSelling).toBe(true);
  });

  it("reads as renewal_due inside the warning window, and still allows selling", () => {
    const health = assessAccreditation(
      { status: "accredited", expiresAt: daysFromNow(RENEWAL_WARNING_DAYS - 1) },
      NOW,
    );
    expect(health.effectiveStatus).toBe("renewal_due");
    // Still valid, just expiring — a warning, not a stop.
    expect(health.blocksSelling).toBe(false);
  });

  it("stays plain accredited outside the warning window", () => {
    const health = assessAccreditation(
      { status: "accredited", expiresAt: daysFromNow(RENEWAL_WARNING_DAYS + 5) },
      NOW,
    );
    expect(health.effectiveStatus).toBe("accredited");
  });

  it("treats every in-progress state as unable to issue a PO", () => {
    // §5b: "Quoting a customer who cannot issue you a PO is wasted effort." Halfway through
    // submission is still not accredited.
    for (const status of ["not_started", "preparing", "submitted", "under_review", "rejected"]) {
      const health = assessAccreditation({ status, expiresAt: null }, NOW);
      expect(health.blocksSelling, `${status} should block`).toBe(true);
    }
  });

  it("does not invent an expiry when none is recorded", () => {
    const health = assessAccreditation({ status: "accredited", expiresAt: null }, NOW);
    expect(health.daysUntilExpiry).toBeNull();
    // No date means nothing contradicts the stored status.
    expect(health.effectiveStatus).toBe("accredited");
  });
});

describe("assertCanBeAccredited", () => {
  it("allows accredited when both the certificate and an expiry date exist", () => {
    const gate = assertCanBeAccredited({
      certificateFileId: "file_cert",
      expiresAt: daysFromNow(365),
    });
    expect(gate.ok).toBe(true);
    expect(gate.reasons).toEqual([]);
  });

  it("blocks accredited with no certificate, in words a user can act on", () => {
    const gate = assertCanBeAccredited({ certificateFileId: null, expiresAt: daysFromNow(365) });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(" ")).toContain("certificate issued by the customer");
  });

  it("blocks accredited with no expiry date", () => {
    // Without it the record never becomes renewal_due, so it is never chased — the failure §5b
    // exists to fix.
    const gate = assertCanBeAccredited({ certificateFileId: "file_cert", expiresAt: null });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(" ")).toContain("expiry date");
  });

  it("reports both problems at once rather than one at a time", () => {
    const gate = assertCanBeAccredited({ certificateFileId: null, expiresAt: null });
    expect(gate.reasons).toHaveLength(2);
  });

  it("is the entire evidence base now the document checklist is gone", () => {
    // Pinned deliberately: with §5b's checklist removed, these two fields are all that stands
    // between "we think we are accredited" and evidence of it.
    expect(assertCanBeAccredited({ certificateFileId: "f", expiresAt: null }).ok).toBe(false);
    expect(assertCanBeAccredited({ certificateFileId: null, expiresAt: daysFromNow(1) }).ok).toBe(
      false,
    );
  });
});
