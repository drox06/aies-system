import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { PRINCIPAL_APPOINT_PERMISSION } from "@/server/core/crm/principal-lifecycle";
import {
  createPrincipalService,
  transitionPrincipalService,
} from "@/server/core/crm/principal-service";

/**
 * Two things the company asked for after using the app: *"only EA or KJ can approve/appoint
 * principal suppliers"*, and an override of the document requirement — *"sometimes these are not
 * needed for small suppliers"* — restricted to the same two people.
 *
 * The appointment is the one stage change that reaches outside the pipeline: it converts into a
 * module 03 supplier and it is what lets anybody raise an RFQ against the manufacturer. So the
 * interesting cases are all refusals.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `appt-${suffix}`;

/** EM: runs the principal pipeline, cannot appoint. */
const marketing = {
  actorId: OWNER,
  actorLabel: "EM (marketing manager)",
  permissions: new Set(["principal_prospect.manage"]) as ReadonlySet<string>,
};

/** EA: can appoint. */
const president = {
  actorId: OWNER,
  actorLabel: "EA (president)",
  permissions: new Set([
    "principal_prospect.manage",
    PRINCIPAL_APPOINT_PERMISSION,
  ]) as ReadonlySet<string>,
};

const prospectIds: string[] = [];
const fileIds: string[] = [];

/** A prospect walked up to `agreement_draft`, the stage appointing follows. */
async function makeReadyProspect(opts: { withAgreement: boolean }) {
  const prospect = await createPrincipalService(marketing, {
    companyName: `Plotork ${randomUUID().slice(0, 6)}`,
    country: "Germany",
  });
  prospectIds.push(prospect.id);

  for (const stage of ["contacted", "in_discussion", "samples_pricing", "agreement_draft"]) {
    await transitionPrincipalService(marketing, { prospectId: prospect.id, to: stage });
  }

  if (opts.withAgreement) {
    const file = await db.fileObject.create({
      data: {
        entityType: "PrincipalProspect",
        entityId: prospect.id,
        storageKey: `PrincipalProspect/${randomUUID()}-agreement.pdf`,
        filename: "agreement.pdf",
        mimeType: "application/pdf",
        size: 10,
        sha256: randomUUID().replace(/-/g, ""),
        uploaderId: OWNER,
      },
    });
    fileIds.push(file.id);
    await db.principalProspect.update({
      where: { id: prospect.id },
      data: {
        distributorAgreementFileId: file.id,
        agreementExpiresAt: new Date(Date.now() + 365 * 86_400_000),
      },
    });
  }

  return prospect;
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { in: prospectIds } } });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  await db.principalProspect.deleteMany({ where: { id: { in: prospectIds } } });
});

describe("who may appoint a principal", () => {
  it("refuses the marketing manager, with everything up to the agreement still theirs", async () => {
    const prospect = await makeReadyProspect({ withAgreement: true });

    await expect(
      transitionPrincipalService(marketing, { prospectId: prospect.id, to: "appointed" }),
    ).rejects.toThrow(/president or the vice-president/i);

    const after = await db.principalProspect.findUniqueOrThrow({ where: { id: prospect.id } });
    expect(after.stage).toBe("agreement_draft");
  }, 60_000);

  it("lets the president appoint when the agreement is on file", async () => {
    const prospect = await makeReadyProspect({ withAgreement: true });

    const result = await transitionPrincipalService(president, {
      prospectId: prospect.id,
      to: "appointed",
    });

    expect(result.appointed).toBe(true);
    const after = await db.principalProspect.findUniqueOrThrow({ where: { id: prospect.id } });
    expect(after.stage).toBe("appointed");
    expect(after.appointmentOverrideReason).toBeNull();
  }, 60_000);

  it("refuses a caller carrying no permission set at all", async () => {
    // The safe reading of a missing permission set is no. `ActorMeta.permissions` is optional so
    // sweeps and subscribers need not fabricate one, and the acknowledgement check treats absence
    // as "skip" — that default would be wrong here, because nothing appoints a principal
    // automatically.
    const prospect = await makeReadyProspect({ withAgreement: true });

    await expect(
      transitionPrincipalService(
        { actorId: OWNER, actorLabel: "System" },
        { prospectId: prospect.id, to: "appointed" },
      ),
    ).rejects.toThrow(/president or the vice-president/i);
  }, 60_000);
});

describe("appointing without the usual documents", () => {
  it("still refuses the president when no reason is given", async () => {
    const prospect = await makeReadyProspect({ withAgreement: false });

    await expect(
      transitionPrincipalService(president, { prospectId: prospect.id, to: "appointed" }),
    ).rejects.toThrow(/distributor agreement/i);
  }, 60_000);

  it("refuses a reason too short to mean anything", async () => {
    const prospect = await makeReadyProspect({ withAgreement: false });

    await expect(
      transitionPrincipalService(president, {
        prospectId: prospect.id,
        to: "appointed",
        overrideDocuments: "small",
      }),
    ).rejects.toThrow(/distributor agreement/i);
  }, 60_000);

  it("appoints on a written reason, and records it on the prospect", async () => {
    const prospect = await makeReadyProspect({ withAgreement: false });

    await transitionPrincipalService(president, {
      prospectId: prospect.id,
      to: "appointed",
      overrideDocuments: "Small local fabricator, single-order relationship, no distributor terms.",
    });

    const after = await db.principalProspect.findUniqueOrThrow({ where: { id: prospect.id } });
    expect(after.stage).toBe("appointed");
    expect(after.appointmentOverrideReason).toContain("Small local fabricator");
    expect(after.appointmentOverrideBy).toBe(OWNER);
    expect(after.appointmentOverrideAt).not.toBeNull();
  }, 60_000);

  it("writes its own audit row, findable on its own", async () => {
    // "Who appointed this principal without an agreement, and what did they say about it" is a
    // question an ISO 9001 auditor asks by itself.
    const prospect = await makeReadyProspect({ withAgreement: false });
    await transitionPrincipalService(president, {
      prospectId: prospect.id,
      to: "appointed",
      overrideDocuments: "Cash-basis local supplier with no distributor programme at all.",
    });

    const row = await db.auditLog.findFirst({
      where: { entityId: prospect.id, action: "appointment_documents_overridden" },
    });
    expect(row).not.toBeNull();
    expect(row!.summary).toContain("Cash-basis local supplier");
  }, 60_000);

  it("refuses an override attached to a move that has nothing to override", async () => {
    const prospect = await createPrincipalService(marketing, {
      companyName: `Nowhere ${randomUUID().slice(0, 6)}`,
    });
    prospectIds.push(prospect.id);

    await expect(
      transitionPrincipalService(marketing, {
        prospectId: prospect.id,
        to: "contacted",
        overrideDocuments: "This does not apply to moving a prospect to contacted.",
      }),
    ).rejects.toThrow(/only applies to appointing/i);
  }, 60_000);

  it("does not mark an override when the documents were there all along", async () => {
    // Passing a reason on a perfectly documented appointment must not leave the record saying a
    // rule was set aside — that would be a false entry in an audit trail.
    const prospect = await makeReadyProspect({ withAgreement: true });

    await transitionPrincipalService(president, {
      prospectId: prospect.id,
      to: "appointed",
      overrideDocuments: "Typed out of habit, but everything is actually on file here.",
    });

    const after = await db.principalProspect.findUniqueOrThrow({ where: { id: prospect.id } });
    expect(after.appointmentOverrideReason).toBeNull();
  }, 60_000);
});
