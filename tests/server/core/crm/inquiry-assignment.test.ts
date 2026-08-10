import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { canAcknowledge } from "@/server/core/crm/inquiry-lifecycle";
import {
  assignInquiryService,
  createInquiryService,
  getInquiryService,
  listInquiryOwnersService,
  transitionInquiryService,
} from "@/server/core/crm/inquiry-service";

/**
 * Logging an inquiry *for* somebody else (specs/01-crm-inquiry.md §§2–3).
 *
 * The company's process, in their words: a new inquiry "should be sent to a specific sales person to
 * be assigned by whoever logged the inquiry. then upon acknowledgement of the assigned person, this
 * will continue the current process."
 *
 * Three things have to hold for that to be real rather than decorative:
 *   1. the assignee is told, or the handover happened only inside the app;
 *   2. the acknowledgement is *theirs*, or §3's SLA clock measures nothing — anyone walking past
 *      could stop it without accepting the work;
 *   3. they can open the record, or the notification points at a page they get NOT_FOUND on.
 *
 * All three are checked against the real database, because all three are exactly what a mock would
 * fake away.
 */

const suffix = randomUUID().slice(0, 8);
const CLERK = `clerk-${suffix}`;
const clerk = { actorId: CLERK, actorLabel: "Front Desk" };

const inquiryIds: string[] = [];
const userIds: string[] = [];

async function makeUser(roleKey: string) {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  const user = await db.user.create({
    data: {
      email: `${roleKey}-${randomUUID().slice(0, 8)}@test.local`,
      name: `${roleKey} ${randomUUID().slice(0, 4)}`,
      passwordHash: "x",
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  userIds.push(user.id);
  return user;
}

/** Logged by the clerk, for somebody else — the case the whole file is about. */
async function logFor(ownerId: string, subject = `Assignment test ${randomUUID().slice(0, 6)}`) {
  const inquiry = await createInquiryService(clerk, { subject, ownerId });
  inquiryIds.push(inquiry.id);
  return inquiry;
}

afterAll(async () => {
  await db.notification.deleteMany({ where: { entityId: { in: inquiryIds } } });
  await db.notification.deleteMany({ where: { recipientId: { in: userIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: inquiryIds } } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: inquiryIds } } });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: [CLERK, ...userIds] } } });
  await db.inquiryItem.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await db.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("logging an inquiry for somebody else", () => {
  it("records them as the owner, not the person who typed it", async () => {
    const salesperson = await makeUser("sales");
    const inquiry = await logFor(salesperson.id);

    expect(inquiry.ownerId).toBe(salesperson.id);
    // And the record page can say whose it is without a second round-trip.
    const seen = await getInquiryService(
      { id: salesperson.id, permissions: new Set(["crm.view"]) },
      inquiry.id,
    );
    expect(seen.owner?.name).toBe(salesperson.name);
  });

  it("tells them, naming the inquiry and who handed it over", async () => {
    const salesperson = await makeUser("sales");
    const inquiry = await logFor(salesperson.id, "Two DN100 flow meters for Maynilad");

    const notifications = await db.notification.findMany({
      where: { recipientId: salesperson.id },
    });
    expect(notifications).toHaveLength(1);
    // A notification that says only "you have an inquiry" makes the recipient open the record just
    // to find out whether it matters.
    expect(notifications[0]!.title).toContain(inquiry.number);
    expect(notifications[0]!.title).toContain("Maynilad");
    expect(notifications[0]!.body).toContain("Front Desk");
    expect(notifications[0]!.entityId).toBe(inquiry.id);
  });

  it("does not notify somebody about their own typing", async () => {
    // The commonest case by far: a salesperson logs their own call. An interruption telling them
    // what they just did is how a notification list becomes something nobody reads.
    const salesperson = await makeUser("sales");
    const inquiry = await createInquiryService(
      { actorId: salesperson.id, actorLabel: salesperson.name },
      { subject: `Own call ${randomUUID().slice(0, 6)}`, ownerId: salesperson.id },
    );
    inquiryIds.push(inquiry.id);

    const count = await db.notification.count({ where: { recipientId: salesperson.id } });
    expect(count).toBe(0);
  });

  it("notifies the new person on reassignment", async () => {
    const first = await makeUser("sales");
    const second = await makeUser("sales");
    const inquiry = await logFor(first.id);

    await db.notification.deleteMany({ where: { recipientId: { in: [first.id, second.id] } } });
    await assignInquiryService(clerk, { inquiryId: inquiry.id, ownerId: second.id });

    expect(await db.notification.count({ where: { recipientId: second.id } })).toBe(1);
    // The previous holder is not told, matching the inspection reassignment: "you no longer have to
    // do this" is not worth an interruption, and the audit row records the change.
    expect(await db.notification.count({ where: { recipientId: first.id } })).toBe(0);
  });

  it("offers every active user in the picker, sales first", async () => {
    // Same reasoning as the inspection assignee list, which the company overruled once already:
    // Spec.md §4.3 says a five-person company has no clean separation of duties, so the roles label
    // the obvious choice rather than barring anyone.
    const salesperson = await makeUser("sales");
    const finance = await makeUser("finance_officer");

    const owners = await listInquiryOwnersService();
    expect(owners.map((o) => o.id)).toContain(salesperson.id);
    expect(owners.map((o) => o.id)).toContain(finance.id);
    expect(owners.find((o) => o.id === salesperson.id)?.isSales).toBe(true);
    expect(owners.find((o) => o.id === finance.id)?.isSales).toBe(false);

    const lastSales = owners.map((o) => o.isSales).lastIndexOf(true);
    const firstOther = owners.map((o) => o.isSales).indexOf(false);
    if (lastSales !== -1 && firstOther !== -1) expect(lastSales).toBeLessThan(firstOther);
  });

  it("leaves a deactivated user out of the picker", async () => {
    const gone = await makeUser("sales");
    await db.user.update({ where: { id: gone.id }, data: { isActive: false } });

    expect((await listInquiryOwnersService()).map((o) => o.id)).not.toContain(gone.id);
  });
});

describe("the acknowledgement belongs to the assignee", () => {
  it("lets the assigned person acknowledge, which is what continues the process", async () => {
    const salesperson = await makeUser("sales");
    const inquiry = await logFor(salesperson.id);

    const after = await transitionInquiryService(
      {
        actorId: salesperson.id,
        actorLabel: salesperson.name,
        permissions: new Set(["crm.edit"]),
      },
      { inquiryId: inquiry.id, to: "acknowledged" },
    );

    expect(after.status).toBe("acknowledged");
    expect(after.acknowledgedAt).toBeTruthy();
  });

  it("refuses somebody else, so the SLA clock measures a real acceptance", async () => {
    const salesperson = await makeUser("sales");
    const bystander = await makeUser("technician");
    const inquiry = await logFor(salesperson.id);

    await expect(
      transitionInquiryService(
        {
          actorId: bystander.id,
          actorLabel: bystander.name,
          permissions: new Set(["crm.edit"]),
        },
        { inquiryId: inquiry.id, to: "acknowledged" },
      ),
    ).rejects.toThrow(/assigned to somebody else/);

    // Nothing moved, and the clock is still running.
    const stored = await db.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } });
    expect(stored.status).toBe("new");
    expect(stored.acknowledgedAt).toBeNull();
  });

  it("lets a manager acknowledge on their behalf", async () => {
    // Somebody is on leave and the customer is waiting. Reassignment is the tidy route, but the
    // audit row records who actually clicked either way, which is the part that matters.
    const salesperson = await makeUser("sales");
    const manager = await makeUser("vice_president");
    const inquiry = await logFor(salesperson.id);

    const after = await transitionInquiryService(
      {
        actorId: manager.id,
        actorLabel: manager.name,
        permissions: new Set(["crm.edit", "inquiry.assign"]),
      },
      { inquiryId: inquiry.id, to: "acknowledged" },
    );
    expect(after.status).toBe("acknowledged");

    const audit = await db.auditLog.findFirst({
      where: { entityId: inquiry.id, action: "status_changed" },
      orderBy: { at: "desc" },
    });
    expect(audit?.actorId).toBe(manager.id);
  });

  it("constrains only the acknowledgement, not the rest of the machine", async () => {
    // §3's later moves are collaborative — a colleague who picks up the evaluation is not stealing
    // anything. The rule exists for the one transition that stops a clock.
    const salesperson = await makeUser("sales");
    const colleague = await makeUser("sales");
    const inquiry = await logFor(salesperson.id);

    await transitionInquiryService(
      { actorId: salesperson.id, actorLabel: salesperson.name, permissions: new Set(["crm.edit"]) },
      { inquiryId: inquiry.id, to: "acknowledged" },
    );
    const after = await transitionInquiryService(
      { actorId: colleague.id, actorLabel: colleague.name, permissions: new Set(["crm.edit"]) },
      { inquiryId: inquiry.id, to: "evaluating" },
    );
    expect(after.status).toBe("evaluating");
  });

  it("is the same rule the record page uses to disable the button", () => {
    // The button and the service must not drift, so both call this.
    const owner = { id: "u1", permissions: new Set<string>() };
    expect(canAcknowledge(owner, { ownerId: "u1" })).toBe(true);
    expect(canAcknowledge(owner, { ownerId: "u2" })).toBe(false);
    expect(
      canAcknowledge({ id: "u1", permissions: new Set(["inquiry.assign"]) }, { ownerId: "u2" }),
    ).toBe(true);
    // The browser holds permissions as an array, the server as a Set. Both have to work.
    expect(canAcknowledge({ id: "u1", permissions: ["inquiry.assign"] }, { ownerId: "u2" })).toBe(
      true,
    );
    expect(canAcknowledge({ id: "u1", permissions: ["crm.edit"] }, { ownerId: "u2" })).toBe(false);
  });
});
