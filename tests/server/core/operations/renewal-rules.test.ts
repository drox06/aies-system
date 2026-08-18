import { describe, expect, it } from "vitest";
import {
  PM_TICKET_LEAD_DAYS,
  RENEWAL_REASONS,
  RENEWAL_WINDOWS,
  daysUntil,
  dueContractRenewals,
  dueEquipmentRenewals,
  plannedVisitDates,
  sortLeads,
  visitsToRaise,
} from "@/server/core/operations/renewal-rules";

/**
 * specs/04-operations-projects.md §16's renewal loop.
 *
 * §16 calls this "where the recurring revenue in this business lives", and every case below is a way
 * that revenue goes quietly missing: a window measured from the wrong instant, four different
 * conversations collapsed into one alert, the same contract raised ninety nights running until
 * everybody filters it.
 */

const at = (days: number, from = new Date("2026-06-15T09:00:00Z")) =>
  new Date(from.getTime() + days * 24 * 60 * 60 * 1000);

const NOW = new Date("2026-06-15T09:00:00Z");

const contract = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  number: "AIESMC-260001",
  accountId: "acc-1",
  endDate: at(30),
  status: "active",
  renewalFlaggedAt: null,
  ...over,
});

const equipment = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  accountId: "acc-1",
  description: "Ultrasonic flowmeter DN100",
  tagNumber: "FT-101",
  serialNumber: "SN-9",
  status: "active",
  warrantyEnd: null,
  calibrationDueAt: null,
  nextPMDueAt: null,
  ...over,
});

describe("§16's four windows", () => {
  it("is the four the spec names, with the days it gives", () => {
    expect([...RENEWAL_REASONS]).toEqual([
      "contract_expiring",
      "calibration_due",
      "warranty_expiring",
      "service_overdue",
    ]);
    expect(RENEWAL_WINDOWS.contract).toBe(90);
    expect(RENEWAL_WINDOWS.calibration).toBe(60);
  });
});

describe("counting days", () => {
  /**
   * Both instants are floored to a date first. Without that, "in 90 days" is inside or outside the
   * window depending on the hour the nightly sweep runs, and a lead appears on Wednesday and
   * vanishes on Thursday for no reason anybody can see.
   */
  it("ignores the time of day", () => {
    const morning = new Date("2026-06-15T01:00:00Z");
    const evening = new Date("2026-06-15T23:00:00Z");
    expect(daysUntil(new Date("2026-06-20T12:00:00Z"), morning)).toBe(5);
    expect(daysUntil(new Date("2026-06-20T00:30:00Z"), evening)).toBe(5);
  });

  it("goes negative once the date is past", () => {
    expect(daysUntil(at(-7), NOW)).toBe(-7);
  });
});

describe("contracts inside their last 90 days", () => {
  it("raises one that ends inside the window", () => {
    const leads = dueContractRenewals([contract({ endDate: at(45) })], NOW);
    expect(leads).toHaveLength(1);
    expect(leads[0]!.reason).toBe("contract_expiring");
    expect(leads[0]!.label).toMatch(/ends in 45 days/);
  });

  it("leaves one that is further out alone", () => {
    expect(dueContractRenewals([contract({ endDate: at(120) })], NOW)).toHaveLength(0);
  });

  it("still raises one that has already lapsed, because that is worse not better", () => {
    const leads = dueContractRenewals([contract({ endDate: at(-10) })], NOW);
    expect(leads).toHaveLength(1);
    expect(leads[0]!.label).toMatch(/ends 10 days ago/);
  });

  /**
   * A sweep that re-raises the same contract for ninety consecutive nights teaches sales to filter
   * the alert — and then the ninety-first, a real lapse, is filtered too. Same reasoning as #83.
   */
  it("does not raise one that has already been flagged", () => {
    expect(dueContractRenewals([contract({ renewalFlaggedAt: at(-2) })], NOW)).toHaveLength(0);
  });

  it("ignores contracts that are not running", () => {
    expect(dueContractRenewals([contract({ status: "cancelled" })], NOW)).toHaveLength(0);
    expect(dueContractRenewals([contract({ status: "draft" })], NOW)).toHaveLength(0);
  });

  /** A lead nobody can argue from gets closed as noise. */
  it("carries the argument for the call, not just the date", () => {
    const [lead] = dueContractRenewals([contract()], NOW);
    expect(lead!.pitch).toMatch(/a gap means the next call is a breakdown/i);
  });
});

describe("equipment due for something", () => {
  it("raises a calibration inside 60 days", () => {
    const leads = dueEquipmentRenewals([equipment({ calibrationDueAt: at(30) })], NOW);
    expect(leads[0]!.reason).toBe("calibration_due");
    expect(leads[0]!.label).toMatch(/FT-101 — calibration due in 30 days/);
  });

  it("says so more loudly once a calibration is overdue", () => {
    const leads = dueEquipmentRenewals([equipment({ calibrationDueAt: at(-14) })], NOW);
    expect(leads[0]!.label).toMatch(/14 days overdue/);
  });

  /**
   * A warranty that has already ended is not a renewal lead — it is the past. The maintenance
   * conversation it implies is a different one, and dressing it up as an expiring warranty would
   * have the salesperson say something untrue on the call.
   */
  it("stops raising a warranty once it has already ended", () => {
    expect(dueEquipmentRenewals([equipment({ warrantyEnd: at(-1) })], NOW)).toHaveLength(0);
    expect(dueEquipmentRenewals([equipment({ warrantyEnd: at(30) })], NOW)).toHaveLength(1);
  });

  it("raises service only once it is actually past due", () => {
    expect(dueEquipmentRenewals([equipment({ nextPMDueAt: at(5) })], NOW)).toHaveLength(0);
    const leads = dueEquipmentRenewals([equipment({ nextPMDueAt: at(-20) })], NOW);
    expect(leads[0]!.reason).toBe("service_overdue");
    expect(leads[0]!.label).toMatch(/20 days past its service date/);
  });

  /**
   * The design decision this file exists to protect. One transmitter whose warranty ends the same
   * month its calibration falls due is **two** conversations — different urgency, often different
   * person — and a single "needs attention" flag would drop one of them.
   */
  it("raises both reasons when one item is due for two things", () => {
    const leads = dueEquipmentRenewals(
      [equipment({ calibrationDueAt: at(20), warrantyEnd: at(40) })],
      NOW,
    );
    expect(leads.map((lead) => lead.reason).sort()).toEqual([
      "calibration_due",
      "warranty_expiring",
    ]);
  });

  /** Null is "nobody recorded a date", which is neither due nor not due. docs/DECISIONS.md #71. */
  it("says nothing about a date nobody has recorded", () => {
    expect(dueEquipmentRenewals([equipment()], NOW)).toHaveLength(0);
  });

  it("ignores equipment that is no longer in service", () => {
    expect(
      dueEquipmentRenewals([equipment({ status: "decommissioned", calibrationDueAt: at(1) })], NOW),
    ).toHaveLength(0);
  });

  it("names the item by tag, then serial, then description", () => {
    const [byTag] = dueEquipmentRenewals([equipment({ calibrationDueAt: at(1) })], NOW);
    expect(byTag!.label).toMatch(/^FT-101/);

    const [bySerial] = dueEquipmentRenewals(
      [equipment({ tagNumber: null, calibrationDueAt: at(1) })],
      NOW,
    );
    expect(bySerial!.label).toMatch(/^SN-9/);

    const [byDescription] = dueEquipmentRenewals(
      [equipment({ tagNumber: null, serialNumber: null, calibrationDueAt: at(1) })],
      NOW,
    );
    expect(byDescription!.label).toMatch(/^Ultrasonic flowmeter/);
  });
});

describe("ordering", () => {
  it("puts the most urgent first, overdue before merely due", () => {
    const leads = sortLeads(
      dueEquipmentRenewals(
        [
          equipment({ id: "a", calibrationDueAt: at(50) }),
          equipment({ id: "b", calibrationDueAt: at(-30) }),
          equipment({ id: "c", calibrationDueAt: at(5) }),
        ],
        NOW,
      ),
    );
    expect(leads.map((lead) => lead.entityId)).toEqual(["b", "c", "a"]);
  });
});

describe("planning the visits a contract owes", () => {
  it("spaces a four-visit year evenly, starting one interval in", () => {
    const dates = plannedVisitDates({
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      visitsPerYear: 4,
    });
    expect(dates).toHaveLength(4);
    // Not on the start date: a contract signed today does not owe a preventive visit today.
    expect(daysUntil(dates[0]!, new Date("2026-01-01"))).toBeGreaterThan(80);
  });

  it("gives a half-year contract half the visits", () => {
    const dates = plannedVisitDates({
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-06-30"),
      visitsPerYear: 4,
    });
    expect(dates).toHaveLength(2);
  });

  it("never plans past the end date", () => {
    const end = new Date("2026-12-31");
    const dates = plannedVisitDates({
      startDate: new Date("2026-01-01"),
      endDate: end,
      visitsPerYear: 12,
    });
    for (const date of dates) expect(date.getTime()).toBeLessThanOrEqual(end.getTime());
  });

  it("returns nothing for a term that does not run forwards", () => {
    expect(
      plannedVisitDates({
        startDate: new Date("2026-06-01"),
        endDate: new Date("2026-01-01"),
        visitsPerYear: 4,
      }),
    ).toEqual([]);
  });
});

describe("raising the tickets a contract owes", () => {
  it("raises only the visits inside the lead time", () => {
    const planned = [at(3), at(10), at(60)];
    const due = visitsToRaise(planned, [], NOW);
    expect(due).toHaveLength(2);
    expect(PM_TICKET_LEAD_DAYS).toBe(14);
  });

  /** A contract that raised its own visit twice would have a crew turn up twice and bill once. */
  it("does not raise one that already has its ticket", () => {
    const planned = [at(3), at(10)];
    const due = visitsToRaise(planned, [at(3)], NOW);
    expect(due).toHaveLength(1);
    expect(daysUntil(due[0]!, NOW)).toBe(10);
  });

  it("still raises a visit whose date has slipped past", () => {
    expect(visitsToRaise([at(-5)], [], NOW)).toHaveLength(1);
  });
});
