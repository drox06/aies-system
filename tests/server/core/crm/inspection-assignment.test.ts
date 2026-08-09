import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createInquiryService, getInquiryService } from "@/server/core/crm/inquiry-service";
import {
  assignInspectionService,
  createInspectionRequestService,
  listInspectionAssigneesService,
  listMyInspectionsService,
  INSPECTION_TECHNICAL_ROLES,
} from "@/server/core/crm/inspection-service";
import { transitionInquiryService } from "@/server/core/crm/inquiry-service";

/**
 * specs/01-crm-inquiry.md §5's assignment: "the request is a task assigned to a user with a due
 * date", and the technician has to actually find out about it.
 *
 * The interesting assertions are not that a notification row appears — they are that the person
 * notified is eligible to go, and that they can open the record the notification points at. Both
 * were broken before this change: the picker listed every user and needed a permission only the
 * president holds, and an assigned technician hit NOT_FOUND on the inquiry.
 */

const suffix = randomUUID().slice(0, 8);
const SALES = `sales-${suffix}`;
const actor = { actorId: SALES, actorLabel: "Sales Test" };

const inquiryIds: string[] = [];
const userIds: string[] = [];
const requestIds: string[] = [];

/** A real user holding a real role, because eligibility is a role query. */
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

async function makeInquiryAtEvaluating() {
  const inquiry = await createInquiryService(actor, {
    subject: `Inspection test ${randomUUID().slice(0, 6)}`,
    ownerId: SALES,
  });
  inquiryIds.push(inquiry.id);
  await transitionInquiryService(actor, { inquiryId: inquiry.id, to: "acknowledged" });
  await transitionInquiryService(actor, { inquiryId: inquiry.id, to: "evaluating" });
  return inquiry;
}

afterAll(async () => {
  await db.notification.deleteMany({ where: { recipientId: { in: userIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: inquiryIds } } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: inquiryIds } } });
  await db.eventOutbox.deleteMany({ where: { actorId: SALES } });
  await db.inspectionRequest.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await db.inquiryItem.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await db.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  void requestIds;
});

describe("who a site inspection may be assigned to", () => {
  it("offers every active user, not just the field roles", async () => {
    // Spec.md §1.2 lists "everyone does everything" as a fact of a five-person firm, and §4.3 says
    // users hold multiple roles because there is no clean separation of duties. Refusing to let the
    // president walk a site he is already visiting would be the software inventing a rule the
    // business does not have.
    const technician = await makeUser("technician");
    const finance = await makeUser("finance_officer");

    const ids = (await listInspectionAssigneesService()).map((a) => a.id);
    expect(ids).toContain(technician.id);
    expect(ids).toContain(finance.id);
  });

  it("marks the field roles and sorts them first, so the likely answer leads", async () => {
    const technician = await makeUser("technician");
    const finance = await makeUser("finance_officer");

    const assignees = await listInspectionAssigneesService();
    expect(assignees.find((a) => a.id === technician.id)?.isTechnical).toBe(true);
    expect(assignees.find((a) => a.id === finance.id)?.isTechnical).toBe(false);

    // Every technical entry appears before every non-technical one.
    const lastTechnical = assignees.map((a) => a.isTechnical).lastIndexOf(true);
    const firstOther = assignees.map((a) => a.isTechnical).indexOf(false);
    if (lastTechnical !== -1 && firstOther !== -1) {
      expect(lastTechnical).toBeLessThan(firstOther);
    }

    // And the flag agrees with the role list it is derived from.
    for (const assignee of assignees) {
      const expected = assignee.roles.some((r) =>
        INSPECTION_TECHNICAL_ROLES.includes(r as "technician"),
      );
      expect(assignee.isTechnical, assignee.name).toBe(expected);
    }
  });

  it("excludes a deactivated user", async () => {
    const technician = await makeUser("technician");
    await db.user.update({ where: { id: technician.id }, data: { isActive: false } });

    const assignees = await listInspectionAssigneesService();
    expect(assignees.map((a) => a.id)).not.toContain(technician.id);
  });

  it("refuses a deactivated assignee at creation, before anything is written", async () => {
    // The one remaining bar: assigning work to a dead account sends a notification nobody will ever
    // read, which is the single case where the visit is guaranteed not to happen.
    const gone = await makeUser("technician");
    await db.user.update({ where: { id: gone.id }, data: { isActive: false } });
    const inquiry = await makeInquiryAtEvaluating();

    await expect(
      createInspectionRequestService(actor, {
        inquiryId: inquiry.id,
        purpose: "Survey the panel",
        assignedToId: gone.id,
      }),
    ).rejects.toThrow(/inactive or no longer exists/);

    // Nothing created, and the inquiry was not parked.
    const requests = await db.inspectionRequest.count({ where: { inquiryId: inquiry.id } });
    expect(requests).toBe(0);
    const after = await db.inquiry.findUnique({ where: { id: inquiry.id } });
    expect(after?.status).toBe("evaluating");
  });

  it("lets a non-field user be assigned and notified", async () => {
    const finance = await makeUser("finance_officer");
    const inquiry = await makeInquiryAtEvaluating();

    const request = await createInspectionRequestService(actor, {
      inquiryId: inquiry.id,
      purpose: "Meet the client on site while passing",
      assignedToId: finance.id,
    });
    expect(request.assignedToId).toBe(finance.id);

    const notifications = await db.notification.count({ where: { recipientId: finance.id } });
    expect(notifications).toBe(1);
  });
});

describe("notifying the assigned technician", () => {
  it("notifies on creation, with what the visit has to achieve", async () => {
    const technician = await makeUser("technician");
    const inquiry = await makeInquiryAtEvaluating();

    const request = await createInspectionRequestService(actor, {
      inquiryId: inquiry.id,
      purpose: "Confirm tie-in points and line size",
      requiredOutputs: ["photos", "tag_list"],
      dueAt: new Date(Date.now() + 7 * 86_400_000),
      assignedToId: technician.id,
    });
    requestIds.push(request.id);

    const notifications = await db.notification.findMany({
      where: { recipientId: technician.id },
    });
    expect(notifications).toHaveLength(1);
    // A notification saying only "you have been assigned an inspection" makes the recipient open
    // the record just to find out whether it is urgent.
    expect(notifications[0]!.title).toContain(inquiry.number);
    expect(notifications[0]!.body).toContain("Confirm tie-in points");
    expect(notifications[0]!.body).toContain("Needed by");
    expect(notifications[0]!.body).toContain("tag list");
  });

  it("marks an assigned request as scheduled rather than merely requested", async () => {
    const technician = await makeUser("technician");
    const inquiry = await makeInquiryAtEvaluating();

    const assigned = await createInspectionRequestService(actor, {
      inquiryId: inquiry.id,
      purpose: "Assigned at creation",
      assignedToId: technician.id,
    });
    expect(assigned.status).toBe("scheduled");

    const other = await makeInquiryAtEvaluating();
    const unassigned = await createInspectionRequestService(actor, {
      inquiryId: other.id,
      purpose: "Nobody yet",
    });
    expect(unassigned.status).toBe("requested");
  });

  it("notifies the new person on reassignment", async () => {
    const first = await makeUser("technician");
    const second = await makeUser("technician");
    const inquiry = await makeInquiryAtEvaluating();

    const request = await createInspectionRequestService(actor, {
      inquiryId: inquiry.id,
      purpose: "Initial survey",
      assignedToId: first.id,
    });

    await db.notification.deleteMany({ where: { recipientId: { in: [first.id, second.id] } } });

    await assignInspectionService(actor, {
      inspectionRequestId: request.id,
      assignedToId: second.id,
      dueAt: new Date(Date.now() + 3 * 86_400_000),
    });

    const toSecond = await db.notification.count({ where: { recipientId: second.id } });
    expect(toSecond).toBe(1);
    // The previous holder is deliberately not told: "you no longer have to do this" is not worth
    // an interruption, and the audit row records the change anyway.
    const toFirst = await db.notification.count({ where: { recipientId: first.id } });
    expect(toFirst).toBe(0);

    const audit = await db.auditLog.findFirst({
      where: { entityId: inquiry.id, action: "inspection_assigned" },
    });
    expect(audit?.summary).toContain(second.name);
  });

  it("will not reassign a completed inspection", async () => {
    const technician = await makeUser("technician");
    const inquiry = await makeInquiryAtEvaluating();
    const request = await createInspectionRequestService(actor, {
      inquiryId: inquiry.id,
      purpose: "Done already",
      assignedToId: technician.id,
    });
    await db.inspectionRequest.update({
      where: { id: request.id },
      data: { status: "completed" },
    });

    await expect(
      assignInspectionService(actor, {
        inspectionRequestId: request.id,
        assignedToId: technician.id,
      }),
    ).rejects.toThrow(/cannot be reassigned/);
  });
});

describe("the assigned technician can actually reach the work", () => {
  it("can open the inquiry they were sent to inspect", async () => {
    // The whole point. Before this, scoping was `ownerId = you`, so the notification linked to a
    // record the recipient could not open — worse than not notifying them at all.
    const technician = await makeUser("technician");
    const inquiry = await makeInquiryAtEvaluating();
    await createInspectionRequestService(actor, {
      inquiryId: inquiry.id,
      purpose: "Read the tag numbers off the transmitters",
      assignedToId: technician.id,
    });

    const seen = await getInquiryService(
      { id: technician.id, permissions: new Set(["crm.view"]) },
      inquiry.id,
    );
    expect(seen.id).toBe(inquiry.id);
  });

  it("cannot open an inquiry they were not assigned", async () => {
    const technician = await makeUser("technician");
    const other = await makeInquiryAtEvaluating();

    await expect(
      getInquiryService({ id: technician.id, permissions: new Set(["crm.view"]) }, other.id),
    ).rejects.toThrow(/no longer exists/);
  });

  it("keeps access after completing it, so they can review their own findings", async () => {
    const technician = await makeUser("technician");
    const inquiry = await makeInquiryAtEvaluating();
    const request = await createInspectionRequestService(actor, {
      inquiryId: inquiry.id,
      purpose: "Survey",
      assignedToId: technician.id,
    });
    await db.inspectionRequest.update({
      where: { id: request.id },
      data: { status: "completed", completedAt: new Date() },
    });

    const seen = await getInquiryService(
      { id: technician.id, permissions: new Set(["crm.view"]) },
      inquiry.id,
    );
    expect(seen.id).toBe(inquiry.id);
  });

  it("lists open assignments for My Day, newest deadline first", async () => {
    const technician = await makeUser("technician");
    const soon = await makeInquiryAtEvaluating();
    const later = await makeInquiryAtEvaluating();

    await createInspectionRequestService(actor, {
      inquiryId: later.id,
      purpose: "Later visit",
      assignedToId: technician.id,
      dueAt: new Date(Date.now() + 20 * 86_400_000),
    });
    await createInspectionRequestService(actor, {
      inquiryId: soon.id,
      purpose: "Urgent visit",
      assignedToId: technician.id,
      dueAt: new Date(Date.now() + 2 * 86_400_000),
    });

    const mine = await listMyInspectionsService(technician.id);
    expect(mine).toHaveLength(2);
    expect(mine[0]!.purpose).toBe("Urgent visit");
  });

  it("drops a completed assignment off the My Day list", async () => {
    const technician = await makeUser("technician");
    const inquiry = await makeInquiryAtEvaluating();
    const request = await createInspectionRequestService(actor, {
      inquiryId: inquiry.id,
      purpose: "Finished",
      assignedToId: technician.id,
    });
    await db.inspectionRequest.update({
      where: { id: request.id },
      data: { status: "completed" },
    });

    const mine = await listMyInspectionsService(technician.id);
    expect(mine).toHaveLength(0);
  });
});
