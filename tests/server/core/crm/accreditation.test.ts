import { describe, expect, it } from "vitest";
import {
  assertCanBeAccredited,
  assessAccreditation,
  defaultRequirements,
  parseRequirements,
  RENEWAL_WARNING_DAYS,
  type AccreditationRequirement,
} from "@/server/core/crm/accreditation-service";

/**
 * specs/01-crm-inquiry.md §5b. The rule worth testing is not the CRUD, it is the derivation: a
 * record can *say* `accredited` while a document inside it expired last week, which in practice
 * means the accreditation is void. §5b calls that out by name — "a mayor's permit expires annually
 * and quietly invalidates an accreditation" — and §10 requires "a document expiring flips the
 * record to renewal_due and notifies; an expired accreditation shows a warning".
 */

const NOW = new Date("2026-08-08T00:00:00.000Z");

function daysFromNow(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString();
}

function req(overrides: Partial<AccreditationRequirement> = {}): AccreditationRequirement {
  return {
    document: "Mayor's / Business permit (current year)",
    required: true,
    providedFileId: "file_1",
    submittedAt: daysFromNow(-200),
    acceptedAt: daysFromNow(-190),
    expiresAt: null,
    notes: null,
    ...overrides,
  };
}

describe("assessAccreditation", () => {
  it("leaves a healthy accreditation alone and does not block selling", () => {
    const health = assessAccreditation(
      {
        status: "accredited",
        expiresAt: new Date(daysFromNow(300)),
        requirements: [req({ expiresAt: daysFromNow(300) })],
      },
      NOW,
    );
    expect(health.effectiveStatus).toBe("accredited");
    expect(health.blocksSelling).toBe(false);
    expect(health.expiringDocuments).toEqual([]);
  });

  it("flips accredited to expired when the record's own expiry has passed", () => {
    // Nobody remembers to run a job before opening the page, so stored status alone is not
    // trustworthy.
    const health = assessAccreditation(
      { status: "accredited", expiresAt: new Date(daysFromNow(-1)), requirements: [] },
      NOW,
    );
    expect(health.effectiveStatus).toBe("expired");
    expect(health.blocksSelling).toBe(true);
  });

  it("§5b: one expired REQUIRED document invalidates an otherwise-accredited record", () => {
    const health = assessAccreditation(
      {
        status: "accredited",
        // The overall accreditation still has a year to run...
        expiresAt: new Date(daysFromNow(365)),
        // ...but the mayor's permit lapsed last week.
        requirements: [req({ expiresAt: daysFromNow(-7) })],
      },
      NOW,
    );
    expect(health.effectiveStatus).toBe("expired");
    expect(health.blocksSelling).toBe(true);
    expect(health.expiringDocuments[0]?.daysRemaining).toBe(-7);
  });

  it("does not let an expired OPTIONAL document invalidate the accreditation", () => {
    // A lapsed ISO certificate is worth flagging, but it is not what the customer gated the PO on.
    const health = assessAccreditation(
      {
        status: "accredited",
        expiresAt: new Date(daysFromNow(365)),
        requirements: [
          req({ document: "ISO certificates", required: false, expiresAt: daysFromNow(-30) }),
        ],
      },
      NOW,
    );
    expect(health.effectiveStatus).toBe("renewal_due");
    expect(health.blocksSelling).toBe(false);
  });

  it("§10: a document entering the warning window flips the record to renewal_due", () => {
    const health = assessAccreditation(
      {
        status: "accredited",
        expiresAt: new Date(daysFromNow(365)),
        requirements: [req({ expiresAt: daysFromNow(RENEWAL_WARNING_DAYS - 1) })],
      },
      NOW,
    );
    expect(health.effectiveStatus).toBe("renewal_due");
    // Still sellable — this is a warning, not a stop.
    expect(health.blocksSelling).toBe(false);
  });

  it("ignores a document expiring beyond the warning window", () => {
    const health = assessAccreditation(
      {
        status: "accredited",
        expiresAt: new Date(daysFromNow(365)),
        requirements: [req({ expiresAt: daysFromNow(RENEWAL_WARNING_DAYS + 5) })],
      },
      NOW,
    );
    expect(health.effectiveStatus).toBe("accredited");
    expect(health.expiringDocuments).toEqual([]);
  });

  it("treats every in-progress state as unable to issue a PO", () => {
    // §5b: "Quoting a customer who cannot issue you a PO is wasted effort." Halfway through
    // submission is still not accredited.
    for (const status of ["not_started", "preparing", "submitted", "under_review", "rejected"]) {
      const health = assessAccreditation({ status, expiresAt: null, requirements: [] }, NOW);
      expect(health.blocksSelling, `${status} should block`).toBe(true);
    }
  });

  it("lists required documents that were never provided", () => {
    const health = assessAccreditation(
      {
        status: "preparing",
        expiresAt: null,
        requirements: [
          req({ document: "SEC registration", providedFileId: null, submittedAt: null }),
          req({ document: "BIR Form 2303", providedFileId: "file_2" }),
          // Optional and missing — not chased.
          req({
            document: "PCAB licence",
            required: false,
            providedFileId: null,
            submittedAt: null,
          }),
        ],
      },
      NOW,
    );
    expect(health.missingDocuments).toEqual(["SEC registration"]);
  });

  it("sorts expiring documents by urgency, worst first", () => {
    const health = assessAccreditation(
      {
        status: "accredited",
        expiresAt: new Date(daysFromNow(365)),
        requirements: [
          req({ document: "Later", required: false, expiresAt: daysFromNow(60) }),
          req({ document: "Sooner", required: false, expiresAt: daysFromNow(5) }),
        ],
      },
      NOW,
    );
    expect(health.expiringDocuments.map((d) => d.document)).toEqual(["Sooner", "Later"]);
  });

  it("survives a malformed expiry date rather than throwing", () => {
    // The checklist is JSONB; bad data must degrade one panel, not the accounts page.
    const health = assessAccreditation(
      {
        status: "accredited",
        expiresAt: null,
        requirements: [req({ expiresAt: "not-a-date" })],
      },
      NOW,
    );
    expect(health.effectiveStatus).toBe("accredited");
    expect(health.expiringDocuments).toEqual([]);
  });
});

describe("requirements template", () => {
  it("seeds §5b's document list with the statutory ones marked required", () => {
    const list = defaultRequirements();
    const byName = new Map(list.map((r) => [r.document, r]));
    expect(byName.get("SEC registration")?.required).toBe(true);
    expect(byName.get("BIR Form 2303 (Certificate of Registration)")?.required).toBe(true);
    expect(byName.get("Mayor's / Business permit (current year)")?.required).toBe(true);
    // Conditional: PCAB matters for contracting, PhilGEPS for government bidding.
    expect(byName.get("PCAB licence")?.required).toBe(false);
    expect(byName.get("PhilGEPS registration")?.required).toBe(false);
  });

  it("starts every item unprovided, so nothing looks submitted before it is", () => {
    expect(defaultRequirements().every((r) => r.providedFileId === null)).toBe(true);
    expect(defaultRequirements().every((r) => r.acceptedAt === null)).toBe(true);
  });
});

describe("parseRequirements", () => {
  it("returns [] for junk rather than throwing", () => {
    expect(parseRequirements(null)).toEqual([]);
    expect(parseRequirements("nonsense")).toEqual([]);
    expect(parseRequirements([{ notADocument: true }])).toEqual([]);
  });

  it("round-trips a valid checklist", () => {
    const list = defaultRequirements();
    expect(parseRequirements(list)).toHaveLength(list.length);
  });
});

describe("assertCanBeAccredited", () => {
  it("allows accredited when both the certificate and an expiry date exist", () => {
    const gate = assertCanBeAccredited({
      certificateFileId: "file_cert",
      expiresAt: new Date("2027-01-01"),
    });
    expect(gate.ok).toBe(true);
    expect(gate.reasons).toEqual([]);
  });

  it("blocks accredited with no certificate, and says so in words a user can act on", () => {
    const gate = assertCanBeAccredited({ certificateFileId: null, expiresAt: new Date() });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(" ")).toContain("certificate issued by the customer");
  });

  it("blocks accredited with no expiry date", () => {
    // An accreditation with no expiry never becomes renewal_due, so it is never chased — which is
    // exactly the folder-in-someone's-memory failure §5b exists to fix.
    const gate = assertCanBeAccredited({ certificateFileId: "file_cert", expiresAt: null });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(" ")).toContain("expiry date");
  });

  it("reports both problems at once rather than one at a time", () => {
    const gate = assertCanBeAccredited({ certificateFileId: null, expiresAt: null });
    expect(gate.reasons).toHaveLength(2);
  });
});
