import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registeredApprovalEntityTypes } from "@/server/core/approvals/decision-registry";
import "@/server/core/approvals/register-decision-handlers";

/**
 * Every approval type the platform can raise can also be decided from the global inbox.
 *
 * ## The failure this pins
 *
 * `/approvals` decided requests by calling the engine directly. The engine updates its own row and
 * knows nothing about what an approval *means* — so a cash advance approved from that screen left
 * the advance at `pending_approval`, permanently: approving refused because no request was pending,
 * re-submitting refused because it was no longer a draft.
 *
 * AIESCA-260127 hit it on 2026-08-18, the first day the screen was used in anger. It was
 * deterministic and it applied to quotations and supplier POs equally — nobody had decided one from
 * the inbox yet.
 *
 * The whole test suite was green throughout, because every module's own approval path was correct
 * and well tested. Nothing tested the path a person is most likely to take: the notification says
 * something needs approval, the inbox is where it lands, and the inbox was the broken one.
 */

describe("approval decision handlers", () => {
  it("registers a handler for every entity type that can raise an approval", () => {
    const registered = new Set(registeredApprovalEntityTypes());

    // The types the platform actually raises approvals for, named rather than discovered, so that
    // adding one is a deliberate act that shows up here.
    const raised = ["CashAdvance", "CashAdvanceExtension", "Quotation", "SupplierPO"];

    const missing = raised.filter((type) => !registered.has(type));
    expect(
      missing,
      `These entity types can be sent for approval and nothing says what deciding one should do. ` +
        `A decision on them from /approvals would be refused (which is the safe failure, but still ` +
        `a VP who cannot work). Register a handler in the owning module: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("cannot pass with an empty registry", () => {
    expect(registeredApprovalEntityTypes().length).toBeGreaterThanOrEqual(4);
  });

  /**
   * The barrel is what makes registration happen on the approvals route, whose bundle would
   * otherwise contain none of the owning modules. Same failure mode as the file-access checkers
   * (docs/DECISIONS.md, `register-checkers.ts`), which shipped broken to production for the same
   * reason — a side-effect import nobody guaranteed.
   */
  it("lists every registering module in the barrel", () => {
    const barrel = readFileSync("src/server/core/approvals/register-decision-handlers.ts", "utf8");

    for (const modulePath of [
      "@/server/core/operations/cash-advance-service",
      "@/server/core/order/supplier-po-approval",
      "@/server/core/quotation/approval-service",
    ]) {
      expect(
        barrel,
        `${modulePath} registers a handler and is not imported by the barrel`,
      ).toContain(modulePath);
    }
  });
});
