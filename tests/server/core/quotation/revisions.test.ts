import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createQuotationService } from "@/server/core/quotation/quotation-service";
import { saveQuotationLinesService } from "@/server/core/quotation/quotation-line-service";
import {
  diffRevisionsService,
  listRevisionsService,
  reviseQuotationService,
} from "@/server/core/quotation/revision-service";
import { diffRevisions } from "@/server/core/quotation/revision-diff";

/**
 * specs/02-quotation.md §5's revisions and §12's locking, against the real database.
 *
 * Three of §12's named tests live here:
 *   - "Sent quotations reject edit attempts at the service layer, not just in the UI."
 *   - "Revision chain: R0 → R1 → R2 keeps one root, supersedes correctly, and the diff is accurate."
 *   - "Concurrent edit of one quotation by two users raises a version conflict rather than a silent
 *      overwrite."
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `rev-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "Revision Test" };

const accountIds: string[] = [];
const quotationIds: string[] = [];

async function makeQuotation() {
  const account = await db.customerAccount.create({
    data: { code: `RV-${randomUUID().slice(0, 12)}`, name: `Rev Co ${suffix}`, ownerId: OWNER },
  });
  accountIds.push(account.id);

  const quotation = await createQuotationService(actor, {
    accountId: account.id,
    title: "Flow meter supply",
  });
  quotationIds.push(quotation.id);

  const saved = await saveQuotationLinesService(actor, {
    quotationId: quotation.id,
    version: quotation.version,
    lines: [
      { description: "DN100 flow meter", quantity: "2", unitCost: "1000.00", markupPct: "25" },
      { description: "Installation kit", quantity: "1", unitCost: "500.00", markupPct: "20" },
    ],
  });

  return { quotation, version: saved.version };
}

afterAll(async () => {
  const all = await db.quotation.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const ids = all.map((q) => q.id);
  await db.auditLog.deleteMany({ where: { entityId: { in: [...ids, ...accountIds] } } });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: ids } } });
  await db.quotation.deleteMany({ where: { parentQuotationId: { in: ids } } });
  await db.quotation.deleteMany({ where: { id: { in: ids } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("the line service is the only writer of the stored figures", () => {
  it("stores exactly what the costing engine returned", async () => {
    const { quotation } = await makeQuotation();
    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });

    // 2 × ₱1,000 at 25% = ₱2,500, plus 1 × ₱500 at 20% = ₱600 → ₱3,100 subtotal.
    expect(stored.subtotal.toString()).toBe("3100");
    expect(stored.totalCost.toString()).toBe("2500");
    expect(stored.marginAmount.toString()).toBe("600");
    // 12% VAT exclusive by default.
    expect(stored.vatAmount.toString()).toBe("372");
    expect(stored.total.toString()).toBe("3472");
  });

  it("stores the landed unit cost, not the raw input", async () => {
    const account = await db.customerAccount.create({
      data: { code: `FX-${randomUUID().slice(0, 12)}`, name: `FX Co ${suffix}`, ownerId: OWNER },
    });
    accountIds.push(account.id);
    const quotation = await createQuotationService(actor, {
      accountId: account.id,
      title: "Imported",
    });
    quotationIds.push(quotation.id);

    await saveQuotationLinesService(actor, {
      quotationId: quotation.id,
      version: quotation.version,
      lines: [
        {
          description: "Imported transmitter",
          quantity: "1",
          unitCost: "100.00",
          costCurrency: "USD",
          costFxRate: "58.5",
          markupPct: "20",
        },
      ],
      fxBufferPct: "3",
    });

    const line = await db.quotationLine.findFirstOrThrow({
      where: { quotationId: quotation.id },
    });
    // $100 × 58.5 × 1.03 = ₱6,025.50 — FX and buffer applied once, at save.
    expect(line.unitCost.toString()).toBe("6025.5");
    expect(line.unitPrice.toString()).toBe("7230.6");
  });
});

describe("§12: concurrent edits conflict rather than overwrite", () => {
  it("rejects a save carrying a stale version", async () => {
    const { quotation, version } = await makeQuotation();

    // Two users opened the same quotation; the first saves.
    await saveQuotationLinesService(actor, {
      quotationId: quotation.id,
      version,
      lines: [
        { description: "First user's line", quantity: "1", unitCost: "10.00", markupPct: "0" },
      ],
    });

    // The second saves against the version they loaded. Silently winning here is the bug.
    await expect(
      saveQuotationLinesService(actor, {
        quotationId: quotation.id,
        version,
        lines: [
          { description: "Second user's line", quantity: "1", unitCost: "20.00", markupPct: "0" },
        ],
      }),
    ).rejects.toThrow(/changed by someone else/);

    const lines = await db.quotationLine.findMany({ where: { quotationId: quotation.id } });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.description).toBe("First user's line");
  });
});

describe("§12: a sent quotation rejects edits at the service layer", () => {
  it("refuses to save lines, and says to revise instead", async () => {
    const { quotation, version } = await makeQuotation();
    await db.quotation.update({ where: { id: quotation.id }, data: { status: "sent" } });

    await expect(
      saveQuotationLinesService(actor, {
        quotationId: quotation.id,
        version,
        lines: [{ description: "Sneaky edit", quantity: "1", unitCost: "1.00", markupPct: "0" }],
      }),
    ).rejects.toThrow(/cannot be edited.*revision/s);
  });
});

describe("§5's revision chain", () => {
  it("keeps one root through R0 → R1 → R2 and numbers them in order", async () => {
    const { quotation } = await makeQuotation();
    await db.quotation.update({ where: { id: quotation.id }, data: { status: "sent" } });

    const r1 = await reviseQuotationService(actor, {
      quotationId: quotation.id,
      revisionReason: "price_negotiation",
    });
    expect(r1.revision).toBe(1);
    expect(r1.displayNumber).toBe(`${quotation.number}REV01`);

    await db.quotation.update({ where: { id: r1.quotationId }, data: { status: "sent" } });
    const r2 = await reviseQuotationService(actor, {
      quotationId: r1.quotationId,
      revisionReason: "customer_scope_change",
    });
    expect(r2.revision).toBe(2);

    const chain = await listRevisionsService(r2.quotationId);
    expect(chain.map((c) => c.revision)).toEqual([0, 1, 2]);
    // One root: R0 has no parent, and both revisions point at it rather than at each other.
    const rows = await db.quotation.findMany({
      where: { id: { in: chain.map((c) => c.id) } },
      select: { id: true, revision: true, parentQuotationId: true },
    });
    const root = rows.find((r) => r.revision === 0)!;
    expect(root.parentQuotationId).toBeNull();
    for (const row of rows.filter((r) => r.revision > 0)) {
      expect(row.parentQuotationId).toBe(root.id);
    }
  });

  it("numbers from the highest revision in the chain, not the one being revised", async () => {
    // Revising R1 while R2 exists must produce R3, or the two would collide on [number, revision].
    const { quotation } = await makeQuotation();
    await db.quotation.update({ where: { id: quotation.id }, data: { status: "sent" } });
    const r1 = await reviseQuotationService(actor, {
      quotationId: quotation.id,
      revisionReason: "error_correction",
    });
    await db.quotation.update({ where: { id: r1.quotationId }, data: { status: "sent" } });
    await reviseQuotationService(actor, {
      quotationId: r1.quotationId,
      revisionReason: "error_correction",
    });

    const r3 = await reviseQuotationService(actor, {
      quotationId: r1.quotationId,
      revisionReason: "validity_extension",
    });
    expect(r3.revision).toBe(3);
  });

  it("copies the lines across so the revision starts from what was quoted", async () => {
    const { quotation } = await makeQuotation();
    await db.quotation.update({ where: { id: quotation.id }, data: { status: "sent" } });
    const r1 = await reviseQuotationService(actor, {
      quotationId: quotation.id,
      revisionReason: "price_negotiation",
    });

    const lines = await db.quotationLine.findMany({ where: { quotationId: r1.quotationId } });
    expect(lines).toHaveLength(2);
  });

  it("does not supersede the prior revision on creation", async () => {
    // §5 supersedes "at the moment the new one is sent" — a half-written revision must not retire
    // the quotation the customer is holding.
    const { quotation } = await makeQuotation();
    await db.quotation.update({ where: { id: quotation.id }, data: { status: "sent" } });
    await reviseQuotationService(actor, {
      quotationId: quotation.id,
      revisionReason: "price_negotiation",
    });

    const source = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(source.status).toBe("sent");
  });

  it("requires a reason from the picklist — it is the ISO 8.2.4 record", async () => {
    const { quotation } = await makeQuotation();
    await db.quotation.update({ where: { id: quotation.id }, data: { status: "sent" } });

    await expect(
      reviseQuotationService(actor, {
        quotationId: quotation.id,
        revisionReason: "because the customer asked",
      }),
    ).rejects.toThrow(/not a revision reason/);
  });

  it("will not revise a draft — there is nothing the customer has seen", async () => {
    const { quotation } = await makeQuotation();
    await expect(
      reviseQuotationService(actor, {
        quotationId: quotation.id,
        revisionReason: "error_correction",
      }),
    ).rejects.toThrow(/cannot be revised/);
  });
});

describe("§5's diff", () => {
  it("reports what actually changed between two revisions", async () => {
    const { quotation } = await makeQuotation();
    await db.quotation.update({ where: { id: quotation.id }, data: { status: "sent" } });
    const r1 = await reviseQuotationService(actor, {
      quotationId: quotation.id,
      revisionReason: "price_negotiation",
    });

    const draft = await db.quotation.findUniqueOrThrow({ where: { id: r1.quotationId } });
    await saveQuotationLinesService(actor, {
      quotationId: r1.quotationId,
      version: draft.version,
      lines: [
        // Quantity changed.
        { description: "DN100 flow meter", quantity: "3", unitCost: "1000.00", markupPct: "25" },
        // "Installation kit" removed, and a new line added.
        { description: "Commissioning", quantity: "1", unitCost: "800.00", markupPct: "10" },
      ],
    });

    const diff = await diffRevisionsService({ fromId: quotation.id, toId: r1.quotationId });
    expect(diff.identical).toBe(false);

    const byKind = (kind: string) =>
      diff.lines.filter((l) => l.kind === kind).map((l) => l.description);
    expect(byKind("changed")).toContain("DN100 flow meter");
    expect(byKind("added")).toContain("Commissioning");
    expect(byKind("removed")).toContain("Installation kit");

    const changed = diff.lines.find((l) => l.description === "DN100 flow meter")!;
    expect(changed.changes?.map((c) => c.field)).toContain("quantity");
    // The total moved, so terms report it — this is the number read aloud on the call.
    expect(diff.terms.map((t) => t.field)).toContain("total");
  });
});

describe("diffRevisions, in isolation", () => {
  const terms = {
    validUntil: "2026-09-01",
    deliveryLeadTime: null,
    paymentTermsId: null,
    warrantyTerms: null,
    exclusions: null,
    assumptions: null,
    total: "100.00",
  };
  const line = (description: string, quantity: string, unitPrice: string) => ({
    lineNo: 1,
    description,
    quantity,
    unitPrice,
    lineTotal: unitPrice,
    isOptional: false,
  });

  it("says so plainly when nothing moved", () => {
    const side = { label: "R0", lines: [line("Meter", "1", "100.00")], terms };
    expect(diffRevisions(side, { ...side, label: "R1" }).identical).toBe(true);
  });

  it("matches by description, so inserting a line does not report every line below as changed", () => {
    // Matching by line number would make this diff unreadable exactly when it matters most.
    const before = { label: "R0", lines: [line("Meter", "1", "100.00")], terms };
    const after = {
      label: "R1",
      lines: [
        { ...line("Freight", "1", "50.00"), lineNo: 1 },
        { ...line("Meter", "1", "100.00"), lineNo: 2 },
      ],
      terms,
    };

    const diff = diffRevisions(before, after);
    expect(diff.lines.filter((l) => l.kind === "changed")).toHaveLength(0);
    expect(diff.lines.filter((l) => l.kind === "added").map((l) => l.description)).toEqual([
      "Freight",
    ]);
  });

  it("pairs duplicate descriptions in order rather than collapsing them", () => {
    const before = {
      label: "R0",
      lines: [line("Meter", "1", "100.00"), { ...line("Meter", "1", "200.00"), lineNo: 2 }],
      terms,
    };
    const after = {
      label: "R1",
      lines: [line("Meter", "1", "100.00"), { ...line("Meter", "1", "250.00"), lineNo: 2 }],
      terms,
    };

    const diff = diffRevisions(before, after);
    expect(diff.lines.filter((l) => l.kind === "changed")).toHaveLength(1);
    expect(diff.lines.filter((l) => l.kind === "unchanged")).toHaveLength(1);
  });
});
