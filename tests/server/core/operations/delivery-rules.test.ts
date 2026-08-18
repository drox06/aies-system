import { describe, expect, it } from "vitest";
import {
  ATTEMPT_FAILURE_CAUSES,
  DELIVERY_MODES,
  DELIVERY_STATUSES,
  canComplete,
  canLeaveForSite,
  checkAttempt,
  deliveryReport,
  statusAfterAttempt,
  unsignedStanding,
  type DeliveryAttempt,
} from "@/server/core/operations/delivery-rules";

/**
 * specs/04-operations-projects.md §13, as pure functions.
 *
 * §20 names two cases this has to satisfy, and both are about evidence rather than movement:
 * "three failed attempts then a successful signed delivery produces one DR, three logged attempts
 * with causes, and exactly one `sales_order.goods_delivered`", and "a courier POD alone does not
 * complete the ticket".
 */

const attempt = (over: Partial<DeliveryAttempt> = {}): DeliveryAttempt => ({
  attemptNo: 1,
  at: "2026-08-18T02:00:00.000Z",
  contactReached: true,
  itemDelivered: true,
  drSigned: true,
  ...over,
});

describe("§13's vocabulary", () => {
  it("is the two modes, nine statuses and seven causes the spec names", () => {
    expect([...DELIVERY_MODES]).toEqual(["own_vehicle", "courier"]);
    expect(DELIVERY_STATUSES).toHaveLength(9);
    expect([...ATTEMPT_FAILURE_CAUSES]).toEqual([
      "contact_unavailable",
      "site_closed",
      "wrong_address",
      "customer_refused",
      "access_denied",
      "incomplete_items",
      "vehicle_problem",
    ]);
  });
});

describe("§13.1's blocking gate: no DR, no movement", () => {
  it("refuses to send a crew without an issued delivery receipt", () => {
    const check = canLeaveForSite({ mode: "own_vehicle", drIssuedAt: null });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/nothing for the customer to sign/);
  });

  /** Same gate, different reason: §13.2 puts the DR in the box. */
  it("refuses to book a courier without one", () => {
    const check = canLeaveForSite({ mode: "courier", drIssuedAt: null });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/nothing to send with the shipment/);
  });

  it("lets the crew go once the receipt exists", () => {
    expect(canLeaveForSite({ mode: "own_vehicle", drIssuedAt: new Date() }).ok).toBe(true);
  });
});

describe("§13.1's attempt loop", () => {
  it("refuses a failed attempt with no cause", () => {
    const check = checkAttempt({ itemDelivered: false, drSigned: false, contactReached: false });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/Say why the delivery failed/);
  });

  it("accepts a failed attempt with one of §13's causes", () => {
    const check = checkAttempt({
      itemDelivered: false,
      drSigned: false,
      contactReached: false,
      failureReason: "site_closed",
    });
    expect(check.ok).toBe(true);
  });

  it("refuses a cause that is not on the list", () => {
    const check = checkAttempt({
      itemDelivered: false,
      drSigned: false,
      contactReached: false,
      failureReason: "nobody_answered",
    });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/not one of §13's failure causes/);
  });

  it("refuses an attempt that both delivered and failed", () => {
    const check = checkAttempt({
      itemDelivered: true,
      drSigned: true,
      contactReached: true,
      failureReason: "site_closed",
    });
    expect(check.ok).toBe(false);
  });

  /** §13.1 step 6: delivered but unsigned is a billing risk, said at the moment it happens. */
  it("warns when the goods are handed over without a signature", () => {
    const check = checkAttempt({ itemDelivered: true, drSigned: false, contactReached: true });
    expect(check.ok).toBe(true);
    expect(check.warnings.join(" ")).toMatch(/cannot bill until the signed delivery receipt/);
  });

  it("loops a failure back to attempting, and parks every delivery until the receipt arrives", () => {
    expect(statusAfterAttempt({ itemDelivered: false, drSigned: false })).toBe("attempting");
    expect(statusAfterAttempt({ itemDelivered: true, drSigned: false })).toBe("delivered_unsigned");
  });

  /**
   * The case that cost two integration failures. A driver ticking "signed" has told us what happened
   * at the gate; the signed receipt is the artefact, and until it is uploaded AIES holds a claim and
   * no document. An attempt that closed the flow on the tick alone meant the later call carrying the
   * actual signature was refused as a duplicate — and, worse, that a delivery could reach `completed`
   * with nothing to invoice against.
   */
  it("never completes a delivery on the driver's word alone", () => {
    expect(statusAfterAttempt({ itemDelivered: true, drSigned: true })).toBe("delivered_unsigned");
  });
});

describe("§13.2's rule: a courier POD is not a signature", () => {
  /** The sentence the whole section turns on, and the one with money attached. */
  it("refuses to complete on a courier proof of delivery alone", () => {
    const check = canComplete({
      mode: "courier",
      courierPodFileId: "file-pod",
      drSignedAt: null,
    });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/not a signed delivery receipt/);
  });

  it("completes once the signed receipt comes back", () => {
    const check = canComplete({
      mode: "courier",
      courierPodFileId: "file-pod",
      drSignedAt: new Date(),
    });
    expect(check.ok).toBe(true);
  });

  it("applies the same rule to own-vehicle deliveries", () => {
    expect(canComplete({ mode: "own_vehicle", drSignedAt: null }).ok).toBe(false);
    expect(canComplete({ mode: "own_vehicle", drSignedAt: new Date() }).ok).toBe(true);
  });
});

describe("§13's escalation clock", () => {
  it("is not overdue while it is inside the window", () => {
    const standing = unsignedStanding({ deliveredAt: new Date(), workingDaysSince: 2 });
    expect(standing.overdue).toBe(false);
  });

  it("escalates once the window passes, and says what it costs", () => {
    const standing = unsignedStanding({ deliveredAt: new Date(), workingDaysSince: 3 });
    expect(standing.overdue).toBe(true);
    expect(standing.message).toMatch(/cannot invoice/);
  });

  it("has nothing to measure before delivery", () => {
    expect(unsignedStanding({ deliveredAt: null, workingDaysSince: 9 }).overdue).toBe(false);
  });
});

describe("§13.3's reporting", () => {
  /**
   * §13.3: "repeated failures at one site are a fixable process problem, usually a wrong contact,
   * and nobody currently counts them."
   */
  it("counts failures by cause and names the sites that repeat", () => {
    const report = deliveryReport([
      {
        mode: "own_vehicle",
        siteId: "site-a",
        completed: true,
        attempts: [
          attempt({
            attemptNo: 1,
            itemDelivered: false,
            drSigned: false,
            failureReason: "contact_unavailable",
          }),
          attempt({
            attemptNo: 2,
            itemDelivered: false,
            drSigned: false,
            failureReason: "contact_unavailable",
          }),
          attempt({ attemptNo: 3, itemDelivered: true, drSigned: true }),
        ],
      },
      {
        mode: "courier",
        siteId: "site-b",
        completed: false,
        freightCost: 250000,
        attempts: [
          attempt({
            attemptNo: 1,
            itemDelivered: false,
            drSigned: false,
            failureReason: "wrong_address",
          }),
        ],
      },
    ]);

    expect(report.failedAttempts).toBe(3);
    expect(report.byCause[0]).toMatchObject({ cause: "contact_unavailable", count: 2 });
    expect(report.repeatFailureSites).toEqual([{ siteId: "site-a", count: 2 }]);
  });

  /** Separating our own failures from the customer's, as §8's standby and §11's fault both do. */
  it("separates the failures AIES caused from the ones it did not", () => {
    const report = deliveryReport([
      {
        mode: "own_vehicle",
        siteId: "s",
        completed: false,
        attempts: [
          attempt({
            attemptNo: 1,
            itemDelivered: false,
            drSigned: false,
            failureReason: "site_closed",
          }),
          attempt({
            attemptNo: 2,
            itemDelivered: false,
            drSigned: false,
            failureReason: "incomplete_items",
          }),
        ],
      },
    ]);

    expect(report.causedByUs).toBe(1);
    expect(report.causedByUsPct).toBe(50);
    expect(report.byCause.find((c) => c.cause === "incomplete_items")?.ours).toBe(true);
    expect(report.byCause.find((c) => c.cause === "site_closed")?.ours).toBe(false);
  });

  /** §13.3: "the data needed to decide when to stop driving." */
  it("compares own vehicle against courier", () => {
    const report = deliveryReport([
      { mode: "own_vehicle", completed: true, attempts: [] },
      { mode: "courier", completed: true, freightCost: 180000, attempts: [] },
      { mode: "courier", completed: false, freightCost: 220000, attempts: [] },
    ]);

    expect(report.byMode.own_vehicle).toMatchObject({ deliveries: 1, completed: 1 });
    expect(report.byMode.courier).toMatchObject({ deliveries: 2, completed: 1, freight: 400000 });
  });

  it("reports no rate over no failures", () => {
    expect(deliveryReport([]).causedByUsPct).toBeNull();
  });
});
