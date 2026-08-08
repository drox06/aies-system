import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { assignRoleService, removeRoleService, type ActorMeta } from "@/server/core/admin/service";
import { writeAuditLog } from "@/server/core/audit/audit";

/**
 * Integration tests against the real seeded dev database — specs/00-foundation.md §11:
 * "an update writes exactly one log row with a correct diff; a forced failure rolls back both
 * the change and the log."
 *
 * Exercises src/server/core/admin/service.ts directly rather than through tRPC/appRouter —
 * importing appRouter pulls in src/auth.ts's full Auth.js config, which only resolves inside the
 * Next.js runtime (fails under plain Vitest with "Cannot find module 'next/server'"). The
 * router.ts/service.ts split (Spec.md §3.5) exists exactly so this logic is testable without it.
 */

let presidentUserId: string;
let testUserId: string;

const actor: ActorMeta = {
  actorId: "",
  actorLabel: "Test Caller",
  ip: "127.0.0.1",
  userAgent: "vitest",
  requestId: "",
};

beforeAll(async () => {
  const president = await db.user.findFirstOrThrow({
    where: { roles: { some: { role: { key: "president" } } } },
  });
  presidentUserId = president.id;
  actor.actorId = presidentUserId;

  const testUser = await db.user.create({
    data: {
      email: `admin-audit-test-${randomUUID()}@aies.local`,
      name: "Admin Audit Test User",
      passwordHash: "x",
    },
  });
  testUserId = testUser.id;
}, 30_000);

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: testUserId } });
  await db.userRole.deleteMany({ where: { userId: testUserId } });
  await db.user.delete({ where: { id: testUserId } });
}, 30_000);

describe("admin service audit logging", () => {
  it("assignRole writes exactly one audit log row with a correct before/after diff", async () => {
    actor.requestId = `test-${randomUUID()}`;

    await assignRoleService(actor, { userId: testUserId, roleKey: "viewer" });

    const logs = await db.auditLog.findMany({
      where: { entityType: "User", entityId: testUserId, action: "role_assigned" },
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]?.actorId).toBe(presidentUserId);
    expect(logs[0]?.diff).toEqual({ roles: { from: [], to: ["viewer"] } });
  }, 30_000);

  it("removeRole writes exactly one audit log row reflecting the removal", async () => {
    actor.requestId = `test-${randomUUID()}`;

    await removeRoleService(actor, { userId: testUserId, roleKey: "viewer" });

    const logs = await db.auditLog.findMany({
      where: { entityType: "User", entityId: testUserId, action: "role_removed" },
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]?.diff).toEqual({ roles: { from: ["viewer"], to: [] } });
  }, 30_000);

  it("a forced audit-write failure rolls back the business change in the same transaction", async () => {
    const rollbackEmail = `rollback-test-${randomUUID()}@aies.local`;

    await expect(
      db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email: rollbackEmail, name: "Rollback Test", passwordHash: "x" },
        });

        // actorLabel is a required field; forcing it null simulates an audit write failing for
        // any reason — what matters is that ANY failure here rolls back the preceding change too.
        await writeAuditLog(tx, {
          actorId: null,
          actorLabel: null as unknown as string,
          action: "create",
          entityType: "User",
          entityId: user.id,
          summary: "forced failure",
        });
      }),
    ).rejects.toThrow();

    const found = await db.user.findUnique({ where: { email: rollbackEmail } });
    expect(found).toBeNull();
  }, 30_000);
});
