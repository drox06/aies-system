import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { sweepDormantAccounts } from "@/server/core/crm/pipeline-service";
import { DORMANT_WITHOUT_PO_DAYS } from "@/server/core/crm/pipeline-rules";

/**
 * The company's 500-day rule: *"log the customer dormant if AIES did not receive a PO from this
 * customer in 500 days."*
 *
 * This sweep is the only thing in the build that changes a business record's status with no person
 * behind it, so what it must **not** touch is more important than what it does. Two of the four
 * tests here are about that.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `dorm-${suffix}`;
const DAY_MS = 86_400_000;

const accountIds: string[] = [];
const poIds: string[] = [];
const fileIds: string[] = [];

async function makeAccount(opts: {
  status?: string;
  createdDaysAgo: number;
  autoDormantAt?: Date | null;
}) {
  const account = await db.customerAccount.create({
    data: {
      code: `DM-${randomUUID().slice(0, 12)}`,
      name: `Dormancy Co ${suffix}`,
      ownerId: OWNER,
      status: opts.status ?? "active",
      createdAt: new Date(Date.now() - opts.createdDaysAgo * DAY_MS),
      autoDormantAt: opts.autoDormantAt ?? null,
    },
  });
  accountIds.push(account.id);
  return account;
}

async function makePo(accountId: string, daysAgo: number) {
  const file = await db.fileObject.create({
    data: {
      entityType: "CustomerPO",
      entityId: accountId,
      storageKey: `CustomerPO/${randomUUID()}-po.pdf`,
      filename: "po.pdf",
      mimeType: "application/pdf",
      size: 10,
      sha256: randomUUID().replace(/-/g, ""),
      uploaderId: OWNER,
    },
  });
  fileIds.push(file.id);

  const po = await db.customerPO.create({
    data: {
      accountId,
      poNumber: `PO-${randomUUID().slice(0, 8)}`,
      poDate: new Date(Date.now() - daysAgo * DAY_MS),
      amount: "50000",
      fileId: file.id,
      receivedById: OWNER,
      receivedAt: new Date(Date.now() - daysAgo * DAY_MS),
    },
  });
  poIds.push(po.id);
  return po;
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { in: accountIds } } });
  await db.customerPO.deleteMany({ where: { id: { in: poIds } } });
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("the 500-day dormancy sweep", () => {
  it("parks a customer whose last purchase order is older than the window", async () => {
    const account = await makeAccount({ createdDaysAgo: DORMANT_WITHOUT_PO_DAYS + 100 });
    await makePo(account.id, DORMANT_WITHOUT_PO_DAYS + 10);

    await sweepDormantAccounts();

    const after = await db.customerAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.status).toBe("dormant");
    // The column that makes the decision reversible — see the sweep's doc comment.
    expect(after.autoDormantAt).not.toBeNull();
  }, 60_000);

  it("parks one that has never ordered anything, counting from when it was created", async () => {
    // A prospect that has sat sixteen months without buying is exactly what dormant describes.
    const account = await makeAccount({ createdDaysAgo: DORMANT_WITHOUT_PO_DAYS + 5 });

    await sweepDormantAccounts();

    const after = await db.customerAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.status).toBe("dormant");
  }, 60_000);

  it("leaves a customer alone while an order is still inside the window", async () => {
    const account = await makeAccount({ createdDaysAgo: DORMANT_WITHOUT_PO_DAYS + 100 });
    await makePo(account.id, DORMANT_WITHOUT_PO_DAYS - 30);

    await sweepDormantAccounts();

    const after = await db.customerAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.status).toBe("active");
  }, 60_000);

  it("never touches a blacklisted customer", async () => {
    // The whole point: `blacklisted` is somebody's decision with a reason behind it, and replacing
    // it with the milder `dormant` would erase that on the day it counts.
    const account = await makeAccount({
      status: "blacklisted",
      createdDaysAgo: DORMANT_WITHOUT_PO_DAYS + 400,
    });

    await sweepDormantAccounts();

    const after = await db.customerAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.status).toBe("blacklisted");
  }, 60_000);

  it("wakes an account it parked itself when an order arrives", async () => {
    const account = await makeAccount({
      status: "dormant",
      createdDaysAgo: DORMANT_WITHOUT_PO_DAYS + 100,
      autoDormantAt: new Date(Date.now() - 30 * DAY_MS),
    });
    await makePo(account.id, 3);

    await sweepDormantAccounts();

    const after = await db.customerAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.status).toBe("active");
    expect(after.autoDormantAt).toBeNull();
  }, 60_000);

  it("leaves a customer somebody parked by hand parked, order or no order", async () => {
    // No `autoDormantAt`, so a person did this. Reviving it would undo somebody's decision without
    // asking them — the sweep only reverses itself.
    const account = await makeAccount({
      status: "dormant",
      createdDaysAgo: DORMANT_WITHOUT_PO_DAYS + 100,
      autoDormantAt: null,
    });
    await makePo(account.id, 2);

    await sweepDormantAccounts();

    const after = await db.customerAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.status).toBe("dormant");
  }, 60_000);

  it("records why the status changed, as the system rather than as a colleague", async () => {
    const account = await makeAccount({ createdDaysAgo: DORMANT_WITHOUT_PO_DAYS + 20 });

    await sweepDormantAccounts();

    const row = await db.auditLog.findFirst({
      where: { entityId: account.id, action: "status_changed" },
    });
    expect(row).not.toBeNull();
    expect(row!.actorId).toBeNull();
    expect(row!.summary).toContain("no purchase order");
  }, 60_000);
});
