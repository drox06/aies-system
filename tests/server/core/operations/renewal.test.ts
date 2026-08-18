import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  activateContractService,
  createContractService,
  dueRenewalsService,
  getContractService,
  sweepPmTicketsService,
  sweepRenewalsService,
} from "@/server/core/operations/renewal-service";

/**
 * specs/04-operations-projects.md §16's renewal loop, against the real database.
 *
 * §16 calls this "where the recurring revenue in this business lives". What only a real run settles
 * is whether it fires **once** — the rules decide what is due, but "raised already" is a fact in the
 * database, and a sweep that re-raises nightly is the failure that makes the whole loop worthless
 * (docs/DECISIONS.md #83 made the same argument about unsigned delivery receipts).
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `rnw-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "EM (sales)" };

const accountIds: string[] = [];
const contractIds: string[] = [];
const equipmentIds: string[] = [];
const ticketIds: string[] = [];

const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

async function makeAccount() {
  const account = await db.customerAccount.create({
    data: { code: `RNW-${randomUUID().slice(0, 12)}`, name: `RNW Co ${suffix}`, ownerId: OWNER },
  });
  accountIds.push(account.id);
  return account;
}

async function makeEquipment(accountId: string, over: Record<string, unknown> = {}) {
  const item = await db.equipment.create({
    data: {
      accountId,
      description: `Flowmeter ${randomUUID().slice(0, 6)}`,
      tagNumber: `FT-${randomUUID().slice(0, 4)}`,
      status: "active",
      ...over,
    },
  });
  equipmentIds.push(item.id);
  return item;
}

async function makeContract(
  accountId: string,
  over: Partial<Parameters<typeof createContractService>[1]> = {},
) {
  const equipment = await makeEquipment(accountId);
  const contract = await createContractService(actor, {
    accountId,
    startDate: inDays(-300),
    endDate: inDays(45),
    visitsPerYear: 4,
    equipmentIds: [equipment.id],
    contractValue: 250_000,
    ...over,
  });
  contractIds.push(contract.id);
  return contract;
}

afterAll(async () => {
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.maintenanceContract.deleteMany({ where: { id: { in: contractIds } } });
  await db.equipment.deleteMany({ where: { id: { in: equipmentIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: [...contractIds, ...accountIds] } } });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("a maintenance contract", () => {
  it("refuses a term that does not run forwards", async () => {
    const account = await makeAccount();
    await expect(
      createContractService(actor, {
        accountId: account.id,
        startDate: inDays(30),
        endDate: inDays(10),
        visitsPerYear: 2,
      }),
    ).rejects.toThrow(/end after it starts/);
  });

  it("refuses one that owes no visits", async () => {
    const account = await makeAccount();
    await expect(
      createContractService(actor, {
        accountId: account.id,
        startDate: inDays(-10),
        endDate: inDays(100),
        visitsPerYear: 0,
      }),
    ).rejects.toThrow(/owing no visits/);
  });

  /** A contract covering nothing generates visits against nothing and renews into the same. */
  it("will not activate one with no equipment on it", async () => {
    const account = await makeAccount();
    const contract = await createContractService(actor, {
      accountId: account.id,
      startDate: inDays(-10),
      endDate: inDays(100),
      visitsPerYear: 2,
    });
    contractIds.push(contract.id);

    await expect(activateContractService(actor, { contractId: contract.id })).rejects.toThrow(
      /Nothing is covered/,
    );
  });

  it("plans its visits across the term", async () => {
    const account = await makeAccount();
    const contract = await makeContract(account.id, {
      startDate: inDays(-1),
      endDate: inDays(364),
      visitsPerYear: 4,
    });

    const loaded = await getContractService(contract.id);
    expect(loaded!.plannedVisits).toHaveLength(4);
  });
});

describe("§16's renewal loop", () => {
  it("raises a contract inside its last ninety days", async () => {
    const account = await makeAccount();
    const contract = await makeContract(account.id, { endDate: inDays(40) });
    await activateContractService(actor, { contractId: contract.id });

    const due = await dueRenewalsService();
    const mine = due.find((lead) => lead.entityId === contract.id);
    expect(mine).toBeDefined();
    expect(mine!.reason).toBe("contract_expiring");
  });

  /**
   * The assertion the whole design turns on. Ninety nights of the same alert teaches sales to filter
   * it, and then the ninety-first — a real lapse — is filtered too.
   */
  it("raises each contract once, however many nights the sweep runs", async () => {
    const account = await makeAccount();
    const contract = await makeContract(account.id, { endDate: inDays(30) });
    await activateContractService(actor, { contractId: contract.id });

    await sweepRenewalsService();

    const flagged = await db.maintenanceContract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(flagged.renewalFlaggedAt).not.toBeNull();

    // Second night: it must no longer be due.
    const stillDue = await dueRenewalsService();
    expect(stillDue.find((lead) => lead.entityId === contract.id)).toBeUndefined();
  });

  it("emits a lead carrying the argument for the call, not just a date", async () => {
    const account = await makeAccount();
    const item = await makeEquipment(account.id, { calibrationDueAt: inDays(20) });

    await sweepRenewalsService();

    const events = await db.eventOutbox.findMany({ where: { event: "renewal.due" } });
    const mine = events.find((row) => (row.payload as { entityId?: string }).entityId === item.id);
    expect(mine).toBeDefined();
    const payload = mine!.payload as { reason: string; pitch: string };
    expect(payload.reason).toBe("calibration_due");
    expect(payload.pitch).toMatch(/readings nobody can defend/);
  });

  it("raises two leads for one item due for two things", async () => {
    const account = await makeAccount();
    const item = await makeEquipment(account.id, {
      calibrationDueAt: inDays(20),
      warrantyEnd: inDays(60),
    });

    const due = await dueRenewalsService();
    const mine = due.filter((lead) => lead.entityId === item.id);
    expect(mine.map((lead) => lead.reason).sort()).toEqual([
      "calibration_due",
      "warranty_expiring",
    ]);
  });

  it("says nothing about equipment with no dates recorded", async () => {
    const account = await makeAccount();
    const item = await makeEquipment(account.id);

    const due = await dueRenewalsService();
    expect(due.find((lead) => lead.entityId === item.id)).toBeUndefined();
  });
});

describe("PM visits becoming tickets", () => {
  /**
   * §16: "PM contracts auto-generate `after_sales` tickets N days ahead of schedule." The type
   * matters — a PM visit lands in the same queue with the same §8 gates as every other job, rather
   * than in a private lane where mobilisation checks do not apply.
   */
  it("raises an after_sales / preventive ticket for a visit that is close", async () => {
    const account = await makeAccount();
    const contract = await makeContract(account.id, {
      // One visit, ten days out: inside the fourteen-day lead time.
      startDate: inDays(-80),
      endDate: inDays(10),
      visitsPerYear: 4,
    });
    await activateContractService(actor, { contractId: contract.id });

    const result = await sweepPmTicketsService();
    expect(result.raised).toBeGreaterThan(0);

    const tickets = await db.ticket.findMany({ where: { accountId: account.id } });
    tickets.forEach((ticket) => ticketIds.push(ticket.id));

    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets[0]!.type).toBe("after_sales");
    expect(tickets[0]!.subType).toBe("preventive");
    expect(tickets[0]!.title).toMatch(contract.number);
  });

  /** A visit raised twice means a crew turns up twice and bills once. */
  it("does not raise the same visit again on the next night", async () => {
    const account = await makeAccount();
    const contract = await makeContract(account.id, {
      startDate: inDays(-80),
      endDate: inDays(10),
      visitsPerYear: 4,
    });
    await activateContractService(actor, { contractId: contract.id });

    await sweepPmTicketsService();
    const afterFirst = await db.ticket.count({ where: { accountId: account.id } });

    await sweepPmTicketsService();
    const afterSecond = await db.ticket.count({ where: { accountId: account.id } });

    const tickets = await db.ticket.findMany({ where: { accountId: account.id } });
    tickets.forEach((ticket) => ticketIds.push(ticket.id));

    expect(afterSecond).toBe(afterFirst);
  });

  it("leaves a draft contract alone until somebody starts it", async () => {
    const account = await makeAccount();
    await makeContract(account.id, {
      startDate: inDays(-80),
      endDate: inDays(10),
      visitsPerYear: 4,
    });

    await sweepPmTicketsService();
    expect(await db.ticket.count({ where: { accountId: account.id } })).toBe(0);
  });
});
