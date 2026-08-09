import { describe, expect, it } from "vitest";
import {
  assessInquirySla,
  checkTransition,
  INQUIRY_ACK_SLA_BUSINESS_DAYS,
  INQUIRY_STATUSES,
  userTransitionsFrom,
} from "@/server/core/crm/inquiry-lifecycle";
import { BUSINESS_DAY_MS } from "@/server/core/calendar/business-days";

/**
 * specs/01-crm-inquiry.md §3's lifecycle diagram and its SLA, as rules rather than as a picture.
 *
 * §10 names two of the cases below directly: "SLA escalation fires at the right time and not
 * before; pauses during `inspection_required`."
 */

describe("checkTransition", () => {
  it("allows every edge §3's diagram draws", () => {
    const edges: [string, string][] = [
      ["new", "acknowledged"],
      ["acknowledged", "evaluating"],
      ["evaluating", "inspection_required"],
      ["evaluating", "disqualified"],
      ["inspection_required", "evaluating"],
    ];
    for (const [from, to] of edges) {
      expect(checkTransition(from, to).ok, `${from} → ${to}`).toBe(true);
    }
  });

  it("refuses to skip the middle of the diagram", () => {
    // The one that matters: dragging a card from `new` straight to `won` would make every pipeline
    // report meaningless, and a free-form status column would allow exactly that.
    const skip = checkTransition("new", "won");
    expect(skip.ok).toBe(false);
    expect(skip.reason).toContain("can only move to");
  });

  it("does not let a person set the statuses the quotation owns", () => {
    // §3: "won / lost are set by the quotation outcome, not manually."
    for (const to of ["quoted", "won", "lost"]) {
      const from = to === "quoted" ? "quoting" : "quoted";
      const byHand = checkTransition(from, to);
      expect(byHand.ok, `${from} → ${to} by hand`).toBe(false);
      expect(byHand.reason).toContain("quotation");
      // …but module 02 may, through the system path.
      expect(checkTransition(from, to, { bySystem: true }).ok).toBe(true);
    }
  });

  it("will not reopen a terminal inquiry, and says why", () => {
    const reopen = checkTransition("lost", "evaluating");
    expect(reopen.ok).toBe(false);
    expect(reopen.reason).toContain("Log a new inquiry instead");
  });

  it("rejects a status that is not a status at all", () => {
    expect(checkTransition("new", "in_progress").ok).toBe(false);
    expect(checkTransition("nonsense", "acknowledged").ok).toBe(false);
  });

  it("treats a no-op as a refusal rather than silently succeeding", () => {
    // Otherwise a double-clicked button writes a second audit row saying nothing changed.
    expect(checkTransition("new", "new").ok).toBe(false);
  });

  it("never offers a system-only move to a user", () => {
    for (const status of INQUIRY_STATUSES) {
      expect(userTransitionsFrom(status)).not.toContain("won");
      expect(userTransitionsFrom(status)).not.toContain("lost");
      expect(userTransitionsFrom(status)).not.toContain("quoted");
    }
  });
});

describe("assessInquirySla", () => {
  // Wed 12 Aug 2026, 10:00 Manila.
  const received = new Date("2026-08-12T02:00:00Z");
  const base = {
    status: "new",
    receivedAt: received,
    acknowledgedAt: null,
    slaPausedAt: null,
    slaPausedMs: 0,
  };

  it("is not breached one minute before the deadline, and is one minute after", () => {
    // §10: "fires at the right time and not before." The boundary is the whole assertion.
    const dueAt = new Date(received.getTime() + INQUIRY_ACK_SLA_BUSINESS_DAYS * BUSINESS_DAY_MS);

    const just_before = assessInquirySla(base, new Date(dueAt.getTime() - 60_000));
    expect(just_before.breached).toBe(false);
    expect(just_before.escalatable).toBe(false);

    const just_after = assessInquirySla(base, new Date(dueAt.getTime() + 60_000));
    expect(just_after.breached).toBe(true);
    expect(just_after.escalatable).toBe(true);
  });

  it("gives a Friday-afternoon inquiry until Monday", () => {
    // Fri 14 Aug 2026, 16:00 Manila. Saturday morning must not be a breach — the weekend is not
    // the customer's problem and it is not AIES's either.
    const friday = { ...base, receivedAt: new Date("2026-08-14T08:00:00Z") };
    const saturday = new Date("2026-08-15T08:00:00Z");
    const monday = new Date("2026-08-17T08:30:00Z");

    expect(assessInquirySla(friday, saturday).breached).toBe(false);
    expect(assessInquirySla(friday, monday).breached).toBe(true);
    expect(assessInquirySla(friday, saturday).dueAt.toISOString()).toBe("2026-08-17T08:00:00.000Z");
  });

  it("stops the clock at the acknowledgement rather than letting it keep running", () => {
    const acknowledged = {
      ...base,
      acknowledgedAt: new Date(received.getTime() + 3_600_000), // an hour later
    };
    // A week afterwards, this is still a record that was acknowledged inside its SLA.
    const later = new Date(received.getTime() + 7 * 86_400_000);
    const sla = assessInquirySla(acknowledged, later);
    expect(sla.breached).toBe(false);
    expect(sla.escalatable).toBe(false);
    expect(sla.consumedMs).toBe(3_600_000);
  });

  it("still records a late acknowledgement as a breach", () => {
    const late = {
      ...base,
      acknowledgedAt: new Date(received.getTime() + 3 * BUSINESS_DAY_MS),
    };
    const sla = assessInquirySla(late, new Date(received.getTime() + 10 * 86_400_000));
    expect(sla.breached).toBe(true);
    // Breached, but there is nothing left to chase — somebody did acknowledge it.
    expect(sla.escalatable).toBe(false);
  });

  it("pauses the clock while an inspection is open (§5)", () => {
    // Banked six working hours of pause: the deadline moves out by exactly that much, no more.
    const pausedSix = { ...base, slaPausedMs: 6 * 3_600_000 };
    const atDeadline = new Date(received.getTime() + BUSINESS_DAY_MS + 60_000);

    expect(assessInquirySla(base, atDeadline).breached).toBe(true);
    expect(assessInquirySla(pausedSix, atDeadline).breached).toBe(false);

    const stillLater = new Date(received.getTime() + BUSINESS_DAY_MS + 7 * 3_600_000);
    expect(assessInquirySla(pausedSix, stillLater).breached).toBe(true);
  });

  it("keeps accruing pause while the clock is still stopped", () => {
    const openPause = {
      ...base,
      status: "inspection_required",
      slaPausedAt: received,
    };
    // Three days into an open pause, nothing has been consumed at all.
    const threeDaysOn = new Date("2026-08-17T02:00:00Z");
    const sla = assessInquirySla(openPause, threeDaysOn);
    expect(sla.consumedMs).toBe(0);
    expect(sla.paused).toBe(true);
    expect(sla.breached).toBe(false);
  });

  it("does not escalate an inquiry parked on an inspection even if the clock says overdue", () => {
    // Belt-and-braces: with §3's map an unacknowledged inquiry cannot reach inspection_required,
    // but the pause must survive any future loosening of that map.
    const parked = { ...base, status: "inspection_required", slaPausedAt: null, slaPausedMs: 0 };
    const wayLate = new Date(received.getTime() + 30 * 86_400_000);
    const sla = assessInquirySla(parked, wayLate);
    expect(sla.breached).toBe(true);
    expect(sla.escalatable).toBe(false);
  });
});
