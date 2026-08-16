import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  SCOPE_CHANGE_CHASE_WORKING_DAYS,
  dismissScopeChangeService,
  promptRevisionOnScopeChange,
  sweepUnactionedScopeChanges,
} from "@/server/core/quotation/scope-change-service";
import { reviseQuotationService } from "@/server/core/quotation/revision-service";
import { createQuotationService } from "@/server/core/quotation/quotation-service";
import { addBusinessDays } from "@/server/core/calendar/business-days";
import type { AuthedUser } from "@/server/core/rbac/types";

/**
 * The record half of specs/04-operations-projects.md §6.1's link (docs/DECISIONS.md #59).
 *
 * The event and the notification are covered in tests/server/core/operations/site-inspection.test.ts.
 * What is here is everything that stops the link being fire-and-forget: the mark stays on the
 * quotation, the nightly sweep chases it, revising clears it, and dismissing it demands a reason.
 *
 * The reason this exists at all: notifying and stopping put the platform's self-described
 * highest-value link on its weakest channel. Miss the bell and nothing ever surfaces the finding
 * again — the crew mobilises three weeks later against a quotation nobody revised.
 */

const suffix = randomUUID().slice(0, 8);
const accountIds: string[] = [];
const inquiryIds: string[] = [];
const quotationIds: string[] = [];
const userIds: string[] = [];

async function makeUser(roleKey: string, permissions: string[]): Promise<AuthedUser> {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  const user = await db.user.create({
    data: {
      email: `sc-${roleKey}-${randomUUID().slice(0, 8)}@test.local`,
      name: `${roleKey} ${randomUUID().slice(0, 4)}`,
      passwordHash: "x",
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  userIds.push(user.id);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roleKeys: [roleKey],
    permissions: new Set(permissions),
  };
}

const actorFor = (user: AuthedUser) => ({ actorId: user.id, actorLabel: user.name });

/** A quotation behind an inquiry, which is the route a pre-quotation survey takes. */
async function makeQuotedInquiry(seller: AuthedUser) {
  const account = await db.customerAccount.create({
    data: { code: `SC-${randomUUID().slice(0, 12)}`, name: `SC Co ${suffix}`, ownerId: seller.id },
  });
  accountIds.push(account.id);

  const inquiry = await db.inquiry.create({
    data: {
      number: `TEST-INQ-${randomUUID().slice(0, 8)}`,
      accountId: account.id,
      subject: `Scope change record ${suffix}`,
      ownerId: seller.id,
      source: "email",
    },
  });
  inquiryIds.push(inquiry.id);

  const quotation = await createQuotationService(actorFor(seller), {
    accountId: account.id,
    inquiryId: inquiry.id,
    title: "Supply and install two transfer pumps",
  });
  quotationIds.push(quotation.id);

  return { account, inquiry, quotation };
}

const flag = (inquiryId: string, notes = "Two extra tie-in points not on the drawing.") =>
  promptRevisionOnScopeChange({
    siteInspectionId: `insp-${randomUUID().slice(0, 8)}`,
    number: "AIESSIR-260099",
    inquiryId,
    notes,
  });

afterAll(async () => {
  await db.notification.deleteMany({ where: { recipientId: { in: userIds } } });
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...quotationIds, ...inquiryIds, ...accountIds] } },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: userIds } } });
  await db.searchIndex.deleteMany({
    where: { entityId: { in: [...quotationIds, ...inquiryIds] } },
  });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  // Revisions are quotations too, and they point at their root.
  await db.quotation.deleteMany({ where: { parentQuotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("the mark on the quotation", () => {
  it("writes the finding onto the document, not only into a notification", async () => {
    const seller = await makeUser("marketing_manager", ["quotation.create"]);
    const { inquiry, quotation } = await makeQuotedInquiry(seller);

    await flag(inquiry.id);

    const marked = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(marked.scopeChangeFlaggedAt).not.toBeNull();
    expect(marked.scopeChangeNotes).toContain("tie-in points");
    expect(marked.scopeChangeSource).toBe("AIESSIR-260099");
    expect(marked.scopeChangeResolvedAt).toBeNull();
  });

  /**
   * A second survey must not overwrite a finding nobody has dealt with.
   *
   * The newer one still notifies — the person needs to know — but silently replacing the older
   * notes would lose the first finding, which is the thing this whole mechanism exists to stop.
   */
  it("does not overwrite an open mark with a later one", async () => {
    const seller = await makeUser("marketing_manager", ["quotation.create"]);
    const { inquiry, quotation } = await makeQuotedInquiry(seller);

    await flag(inquiry.id, "First finding: two extra tie-ins.");
    await flag(inquiry.id, "Second finding: the slab needs coring.");

    const marked = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(marked.scopeChangeNotes).toContain("First finding");

    // Both were told, so nothing is lost — the second notification says the first is still open.
    const notifications = await db.notification.findMany({
      where: { recipientId: seller.id, type: "quotation.scope_change_identified" },
    });
    expect(notifications).toHaveLength(2);
    expect(notifications.some((n) => /still open/.test(n.body ?? ""))).toBe(true);
  });
});

describe("resolving it", () => {
  it("clears automatically when the quotation is revised", async () => {
    const seller = await makeUser("marketing_manager", ["quotation.create", "quotation.revise"]);
    const { inquiry, quotation } = await makeQuotedInquiry(seller);

    await flag(inquiry.id);
    // §5 only allows revising a quotation the customer has seen.
    await db.quotation.update({ where: { id: quotation.id }, data: { status: "sent" } });

    await reviseQuotationService(actorFor(seller), {
      quotationId: quotation.id,
      revisionReason: "customer_scope_change",
    });

    const source = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(source.scopeChangeResolvedAt).not.toBeNull();
    expect(source.scopeChangeResolution).toBe("revised");

    // The new revision is the *answer* to the mark, not another instance of it.
    const revision = await db.quotation.findFirstOrThrow({
      where: { parentQuotationId: quotation.id },
    });
    expect(revision.scopeChangeFlaggedAt).toBeNull();
  });

  it("demands a real reason to close it without revising", async () => {
    const seller = await makeUser("marketing_manager", ["quotation.create", "quotation.revise"]);
    const { inquiry, quotation } = await makeQuotedInquiry(seller);
    await flag(inquiry.id);

    await expect(
      dismissScopeChangeService(actorFor(seller), { quotationId: quotation.id, reason: "no" }),
    ).rejects.toThrow(/Say why/);

    await dismissScopeChangeService(actorFor(seller), {
      quotationId: quotation.id,
      reason: "Absorbed — the two tie-ins were already inside the lump sum.",
    });

    const closed = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(closed.scopeChangeResolution).toBe("dismissed");
    expect(closed.scopeChangeResolutionNote).toContain("Absorbed");

    // The reason is what somebody reads when the job overruns, so it is in the audit trail too.
    const log = await db.auditLog.findFirst({
      where: { entityId: quotation.id, action: "scope_change_dismissed" },
    });
    expect(log?.summary).toContain("Absorbed");
  });

  it("refuses to dismiss a quotation with no open scope change", async () => {
    const seller = await makeUser("marketing_manager", ["quotation.create", "quotation.revise"]);
    const { quotation } = await makeQuotedInquiry(seller);

    await expect(
      dismissScopeChangeService(actorFor(seller), {
        quotationId: quotation.id,
        reason: "Nothing to close here at all.",
      }),
    ).rejects.toThrow(/no open scope change/);
  });
});

describe("the nightly chase", () => {
  /**
   * The reason the sweep exists: emitting once is right, but *once, ever* also means *never again*.
   */
  it("leaves a fresh finding alone and chases it once it goes stale", async () => {
    const seller = await makeUser("marketing_manager", ["quotation.create"]);
    const { inquiry, quotation } = await makeQuotedInquiry(seller);
    await flag(inquiry.id);

    const flaggedAt = (await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } }))
      .scopeChangeFlaggedAt!;

    // The day it was raised: nothing to chase yet.
    const early = await sweepUnactionedScopeChanges(flaggedAt);
    expect(early.chased.map((row) => row.id)).not.toContain(quotation.id);

    // Three working days later, counted on the working calendar so a Friday finding is not chased
    // on a Sunday.
    const due = addBusinessDays(flaggedAt, SCOPE_CHANGE_CHASE_WORKING_DAYS);
    const late = await sweepUnactionedScopeChanges(new Date(due.getTime() + 60_000));
    expect(late.chased.map((row) => row.id)).toContain(quotation.id);

    const chased = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(chased.scopeChangeChasedAt).not.toBeNull();
  });

  it("does not chase again inside the window", async () => {
    const seller = await makeUser("marketing_manager", ["quotation.create"]);
    const { inquiry, quotation } = await makeQuotedInquiry(seller);
    await flag(inquiry.id);

    const flaggedAt = (await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } }))
      .scopeChangeFlaggedAt!;
    const due = new Date(
      addBusinessDays(flaggedAt, SCOPE_CHANGE_CHASE_WORKING_DAYS).getTime() + 60_000,
    );

    await sweepUnactionedScopeChanges(due);
    // The next night: chased yesterday, so silent today.
    const again = await sweepUnactionedScopeChanges(new Date(due.getTime() + 86_400_000));
    expect(again.chased.map((row) => row.id)).not.toContain(quotation.id);
  });

  it("stops chasing once somebody has dealt with it", async () => {
    const seller = await makeUser("marketing_manager", ["quotation.create", "quotation.revise"]);
    const { inquiry, quotation } = await makeQuotedInquiry(seller);
    await flag(inquiry.id);
    await dismissScopeChangeService(actorFor(seller), {
      quotationId: quotation.id,
      reason: "Absorbed into the lump sum, agreed with the customer.",
    });

    const flaggedAt = (await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } }))
      .scopeChangeFlaggedAt!;
    const result = await sweepUnactionedScopeChanges(
      new Date(addBusinessDays(flaggedAt, 30).getTime()),
    );
    expect(result.chased.map((row) => row.id)).not.toContain(quotation.id);
  });
});
