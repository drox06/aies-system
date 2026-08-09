import { describe, expect, it } from "vitest";
import {
  assessPrincipal,
  checkPrincipalTransition,
  PRINCIPAL_EXPIRY_WARNING_DAYS,
  PRINCIPAL_STAGES,
  principalStagesFrom,
} from "@/server/core/crm/principal-lifecycle";

/**
 * specs/01-crm-inquiry.md §5c's pipeline rules.
 *
 * §5c asks for "the same treatment as the sales pipeline", so this mirrors the inquiry lifecycle
 * tests — with one real difference worth pinning: this pipeline allows parking and reviving, which
 * §3's does not, because a manufacturer going quiet is normal and an inquiry going quiet is a
 * failure.
 */

const DAY_MS = 86_400_000;

describe("checkPrincipalTransition", () => {
  it("walks the progression one step at a time", () => {
    const steps: [string, string][] = [
      ["identified", "contacted"],
      ["contacted", "in_discussion"],
      ["in_discussion", "samples_pricing"],
      ["samples_pricing", "agreement_draft"],
      ["agreement_draft", "appointed"],
    ];
    for (const [from, to] of steps) {
      expect(checkPrincipalTransition(from, to).ok, `${from} → ${to}`).toBe(true);
    }
  });

  it("refuses to skip stages, and names the one to do first", () => {
    // §5c wants attribution — "which appointments actually earned their keep" — which needs the
    // stages to have actually happened rather than been jumped over.
    const skip = checkPrincipalTransition("contacted", "appointed");
    expect(skip.ok).toBe(false);
    expect(skip.reason).toContain("in discussion");
  });

  it("refuses to move backwards and points at dormant instead", () => {
    const back = checkPrincipalTransition("samples_pricing", "contacted");
    expect(back.ok).toBe(false);
    expect(back.reason).toContain("dormant");
  });

  it("lets anything live be declined or parked as dormant", () => {
    for (const from of ["identified", "contacted", "in_discussion", "samples_pricing"]) {
      expect(checkPrincipalTransition(from, "declined").ok, `${from} → declined`).toBe(true);
      expect(checkPrincipalTransition(from, "dormant").ok, `${from} → dormant`).toBe(true);
    }
  });

  it("revives a dormant prospect wherever the conversation left off", () => {
    // Not back to the top: restarting a two-year relationship at `identified` would lose the
    // history that makes it worth reviving.
    expect(checkPrincipalTransition("dormant", "samples_pricing").ok).toBe(true);
    expect(checkPrincipalTransition("dormant", "contacted").ok).toBe(true);
  });

  it("treats appointed as the one terminal stage", () => {
    const appointed = checkPrincipalTransition("appointed", "dormant");
    expect(appointed.ok).toBe(false);
    expect(appointed.reason).toContain("supplier");
  });

  it("lets a declined prospect be revived — declining is one click from every live stage", () => {
    // Asked for as an emergency undo. Making it permanent meant a misclick could only be fixed by
    // abandoning the record and retyping it, which loses the history that made it worth keeping.
    expect(checkPrincipalTransition("declined", "contacted").ok).toBe(true);
    expect(checkPrincipalTransition("declined", "agreement_draft").ok).toBe(true);
    // Straight back to appointed is allowed too — the agreement gate in the service still applies,
    // so an undo cannot smuggle in an appointment with no paperwork behind it.
    expect(checkPrincipalTransition("declined", "appointed").ok).toBe(true);
  });

  it("rejects a stage that is not a stage", () => {
    expect(checkPrincipalTransition("identified", "negotiating").ok).toBe(false);
    expect(checkPrincipalTransition("nonsense", "contacted").ok).toBe(false);
    expect(checkPrincipalTransition("identified", "identified").ok).toBe(false);
  });

  it("offers no moves at all out of appointed", () => {
    expect(principalStagesFrom("appointed")).toEqual([]);
  });

  it("offers the whole progression out of declined and dormant", () => {
    for (const parked of ["declined", "dormant"]) {
      const options = principalStagesFrom(parked);
      expect(options, parked).toContain("contacted");
      expect(options, parked).toContain("appointed");
      // Not itself, and not the other parked state's own value twice over.
      expect(options, parked).not.toContain(parked);
    }
  });

  it("offers exactly the legal moves from a live stage", () => {
    expect(principalStagesFrom("in_discussion").sort()).toEqual(
      ["declined", "dormant", "samples_pricing"].sort(),
    );
  });

  it("never offers a move the checker would then refuse", () => {
    // The UI builds its buttons from principalStagesFrom, so the two must agree exactly or a button
    // appears that produces an error when pressed.
    for (const from of PRINCIPAL_STAGES) {
      for (const to of principalStagesFrom(from)) {
        expect(checkPrincipalTransition(from, to).ok, `${from} → ${to}`).toBe(true);
      }
    }
  });
});

describe("assessPrincipal", () => {
  const now = new Date("2026-08-09T00:00:00.000Z");
  const at = (days: number) => new Date(now.getTime() + days * DAY_MS);

  it("reports a healthy agreement and price list as valid", () => {
    const health = assessPrincipal(
      { stage: "appointed", agreementExpiresAt: at(300), priceListValidUntil: at(200) },
      now,
    );
    expect(health.agreement).toBe("valid");
    expect(health.priceList).toBe("valid");
    expect(health.priceListUnsafeToQuote).toBe(false);
  });

  it("warns inside the window and expires past it", () => {
    const warning = assessPrincipal(
      {
        stage: "appointed",
        agreementExpiresAt: at(PRINCIPAL_EXPIRY_WARNING_DAYS - 1),
        priceListValidUntil: at(-1),
      },
      now,
    );
    expect(warning.agreement).toBe("expiring");
    expect(warning.priceList).toBe("expired");
  });

  it("flags a lapsed price list as unsafe to quote — but only once appointed", () => {
    // §5c: "A quotation costed from a lapsed price list is a margin incident waiting to happen."
    // A prospect nobody has appointed is not being quoted from, so flagging it would be noise on
    // every row of the early pipeline.
    const appointed = assessPrincipal(
      { stage: "appointed", agreementExpiresAt: at(100), priceListValidUntil: at(-5) },
      now,
    );
    expect(appointed.priceListUnsafeToQuote).toBe(true);

    const prospect = assessPrincipal(
      { stage: "samples_pricing", agreementExpiresAt: null, priceListValidUntil: at(-5) },
      now,
    );
    expect(prospect.priceList).toBe("expired");
    expect(prospect.priceListUnsafeToQuote).toBe(false);
  });

  it("does not invent an expiry where none is recorded", () => {
    const health = assessPrincipal(
      { stage: "identified", agreementExpiresAt: null, priceListValidUntil: null },
      now,
    );
    expect(health.agreement).toBe("none");
    expect(health.priceList).toBe("none");
    expect(health.agreementDaysRemaining).toBeNull();
  });
});
