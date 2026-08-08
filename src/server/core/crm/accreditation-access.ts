import { db } from "@/lib/db";
import { ACCREDITATION_ENTITY_TYPE } from "@/server/core/crm/accreditation-rules";
import { registerFileAccessChecker } from "@/server/core/storage/access";

/**
 * Who may download an accreditation certificate.
 *
 * Module 00's default is "only the uploader", which is the right default and the wrong answer here:
 * PD uploads the certificate, but the salesperson deciding whether to quote needs to see it, and
 * the president needs it for an audit. So CRM registers its own rule, which is exactly what
 * `registerFileAccessChecker` exists for.
 *
 * Read access follows `crm.view` rather than `accreditation.manage`: viewing the evidence that a
 * customer accredited AIES is not the same privilege as editing the record. Record-level scoping
 * still applies — a salesperson without `crm.view_all` can only reach certificates for accounts
 * they own.
 */
registerFileAccessChecker(ACCREDITATION_ENTITY_TYPE, async (user, file) => {
  if (!user.permissions.has("crm.view")) return false;
  if (user.permissions.has("crm.view_all") || user.permissions.has("accreditation.manage")) {
    return true;
  }

  // file.entityId is the AccreditationRecord id; the scope question is about its account's owner.
  const record = await db.accreditationRecord.findUnique({
    where: { id: file.entityId },
    select: { account: { select: { ownerId: true } } },
  });
  return record?.account.ownerId === user.id;
});
