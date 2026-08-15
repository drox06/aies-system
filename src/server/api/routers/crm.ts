import { z } from "zod";
import {
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  createAccountService,
  deleteAccountService,
  getAccountService,
  listAccountsService,
  setPrimaryContactService,
  updateAccountService,
  type ActorMeta,
} from "@/server/core/crm/account-service";
import {
  deleteContactService,
  listContactsService,
  upsertContactService,
} from "@/server/core/crm/contact-service";
import {
  ACCREDITATION_STATUSES,
  getAccreditationForAccount,
  listAccreditationsService,
  startAccreditationService,
  updateAccreditationService,
} from "@/server/core/crm/accreditation-service";
import { acknowledgeRenewalService } from "@/server/core/crm/accreditation-renewal";
import {
  ACTIVITY_ENTITY_TYPES,
  ACTIVITY_TYPES,
  listActivitiesService,
  logActivityService,
} from "@/server/core/crm/activity-service";
import { findDuplicateAccounts } from "@/server/core/crm/duplicates";
import {
  INQUIRY_SOURCES,
  INQUIRY_STATUSES,
  INSPECTION_OUTPUTS,
  LOST_REASONS,
  SERVICE_TYPES,
} from "@/server/core/crm/inquiry-lifecycle";
import {
  assignInquiryService,
  createInquiryService,
  listInquiryOwnersService,
  getInquiryService,
  listInquiriesService,
  listRequirementTemplatesService,
  overrideRequirementsService,
  setInquiryItemsService,
  transitionInquiryService,
  updateInquiryService,
  upsertRequirementTemplateService,
} from "@/server/core/crm/inquiry-service";
import {
  assignInspectionService,
  cancelInspectionService,
  completeInspectionService,
  createInspectionRequestService,
  listInspectionAssigneesService,
  listMyInspectionsService,
} from "@/server/core/crm/inspection-service";
import { EXCLUSIVITY_TERMS, PRINCIPAL_STAGES } from "@/server/core/crm/principal-lifecycle";
import {
  createPrincipalService,
  getPrincipalService,
  listPrincipalsService,
  transitionPrincipalService,
  updatePrincipalService,
} from "@/server/core/crm/principal-service";
import { mergeAccountsService, previewMergeService } from "@/server/core/crm/merge-service";
import { getMyDayService, getPipelineService } from "@/server/core/crm/pipeline-service";
import { p, router, type Context } from "@/server/api/trpc";

function actorMeta(
  ctx: Context & { user: { id: string; name: string; permissions: ReadonlySet<string> } },
): ActorMeta {
  return {
    actorId: ctx.user.id,
    actorLabel: ctx.user.name,
    // Read from the session, never the request body: a client that could assert its own permissions
    // could acknowledge somebody else's inquiry.
    permissions: ctx.user.permissions,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  };
}

/** Shared by create and update. Everything optional on update; `name` is required on create. */
const accountFields = {
  legalName: z.string().nullish(),
  tin: z.string().nullish(),
  industry: z.string().nullish(),
  accountType: z.enum(ACCOUNT_TYPES).optional(),
  website: z.string().nullish(),
  email: z.string().email().nullish().or(z.literal("")),
  phone: z.string().nullish(),
  billingAddress: z.unknown().optional(),
  shippingAddress: z.unknown().optional(),
  // A string, not a number: money crosses the wire as a decimal string so it never passes through
  // a float on the way to Prisma's Decimal.
  creditLimit: z.string().nullish(),
  currency: z.string().optional(),
  ownerId: z.string().nullish(),
  parentAccountId: z.string().nullish(),
  customFields: z.unknown().optional(),
};

export const crmRouter = router({
  listAccounts: p("crm.view")
    .input(
      z
        .object({
          search: z.string().optional(),
          status: z.enum(ACCOUNT_STATUSES).optional(),
          page: z.number().int().positive().optional(),
          pageSize: z.number().int().positive().max(100).optional(),
          sortKey: z.string().nullish(),
          sortDir: z.enum(["asc", "desc"]).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => listAccountsService(ctx.user, input ?? {})),

  getAccount: p("crm.view")
    .input(z.object({ accountId: z.string() }))
    .query(({ ctx, input }) => getAccountService(ctx.user, input.accountId)),

  /**
   * specs/01-crm-inquiry.md §7 — called by the create form *before* submitting, so the warning
   * arrives while the user can still act on it. Gated on `crm.create` rather than `crm.view`:
   * it is only useful to someone about to create, and it reveals account names.
   */
  checkDuplicateAccounts: p("crm.create")
    .input(
      z.object({
        name: z.string(),
        tin: z.string().nullish(),
        email: z.string().nullish(),
        excludeAccountId: z.string().nullish(),
      }),
    )
    .query(({ input }) => findDuplicateAccounts(input)),

  createAccount: p("crm.create")
    .input(z.object({ name: z.string().min(1), ...accountFields }))
    .mutation(({ ctx, input }) => createAccountService(actorMeta(ctx), input)),

  updateAccount: p("crm.edit")
    .input(
      z.object({
        accountId: z.string(),
        name: z.string().min(1).optional(),
        status: z.enum(ACCOUNT_STATUSES).optional(),
        ...accountFields,
      }),
    )
    .mutation(({ ctx, input }) => updateAccountService(actorMeta(ctx), input)),

  deleteAccount: p("crm.delete")
    .input(z.object({ accountId: z.string() }))
    .mutation(({ ctx, input }) => deleteAccountService(actorMeta(ctx), input)),

  setPrimaryContact: p("crm.edit")
    .input(
      z.object({
        accountId: z.string(),
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        position: z.string().nullish(),
        mobile: z.string().nullish(),
        email: z.string().email().nullish().or(z.literal("")),
        phone: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => setPrimaryContactService(actorMeta(ctx), input)),

  // ---- contacts, several per customer ----------------------------------------------------------
  // `setPrimaryContact` above stays: it is the one-field shortcut the account dialog uses when a
  // customer is first created. These are the full list, for the customer with four plants.

  listContacts: p("crm.view")
    .input(z.object({ accountId: z.string() }))
    .query(({ input }) => listContactsService(input.accountId)),

  upsertContact: p("crm.edit")
    .input(
      z.object({
        contactId: z.string().nullish(),
        accountId: z.string(),
        siteId: z.string().nullish(),
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        position: z.string().nullish(),
        department: z.string().nullish(),
        email: z.string().email().nullish().or(z.literal("")),
        mobile: z.string().nullish(),
        phone: z.string().nullish(),
        isPrimary: z.boolean().optional(),
        isDecisionMaker: z.boolean().optional(),
        notes: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => upsertContactService(actorMeta(ctx), input)),

  /** `crm.edit`, not `crm.delete`: removing a name from a list is not deleting a customer record. */
  deleteContact: p("crm.edit")
    .input(z.object({ contactId: z.string(), reason: z.string().nullish() }))
    .mutation(({ ctx, input }) => deleteContactService(actorMeta(ctx), input)),

  // ---- accreditation (specs/01-crm-inquiry.md §5b) --------------------------------------------
  // §9 puts this with admin_manager (PD), visible to president and vice_president.

  listAccreditations: p("accreditation.manage").query(() => listAccreditationsService()),

  getAccreditation: p("crm.view")
    .input(z.object({ accountId: z.string() }))
    .query(({ input }) => getAccreditationForAccount(input.accountId)),

  startAccreditation: p("accreditation.manage")
    .input(z.object({ accountId: z.string(), ownerId: z.string().nullish() }))
    .mutation(({ ctx, input }) => startAccreditationService(actorMeta(ctx), input)),

  updateAccreditation: p("accreditation.manage")
    .input(
      z.object({
        accreditationId: z.string(),
        status: z.enum(ACCREDITATION_STATUSES).optional(),
        submittedAt: z.string().nullish(),
        accreditedAt: z.string().nullish(),
        expiresAt: z.string().nullish(),
        referenceNumber: z.string().nullish(),
        customerPortalUrl: z.string().nullish(),
        customerContactId: z.string().nullish(),
        rejectionReason: z.string().nullish(),
        notes: z.string().nullish(),
        ownerId: z.string().nullish(),
        certificateFileId: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => updateAccreditationService(actorMeta(ctx), input)),

  /**
   * PD acknowledging the renewal as one of their tasks, which starts the clock the stalled-renewal
   * sweep measures. Raises a president approval first when the customer is blacklisted or dormant;
   * that branch lives in the approval workflow's condition, not here.
   */
  acknowledgeRenewal: p("accreditation.manage")
    .input(z.object({ accreditationId: z.string() }))
    .mutation(({ ctx, input }) => acknowledgeRenewalService(actorMeta(ctx), input)),

  // ---- inquiries (specs/01-crm-inquiry.md §§2-5) -----------------------------------------------

  listInquiries: p("crm.view")
    .input(
      z
        .object({
          search: z.string().optional(),
          status: z.enum(INQUIRY_STATUSES).optional(),
          ownerId: z.string().optional(),
          accountId: z.string().optional(),
          page: z.number().int().positive().optional(),
          pageSize: z.number().int().positive().max(100).optional(),
          sortKey: z.string().nullish(),
          sortDir: z.enum(["asc", "desc"]).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => listInquiriesService(ctx.user, input ?? {})),

  getInquiry: p("crm.view")
    .input(z.object({ inquiryId: z.string() }))
    .query(({ ctx, input }) => getInquiryService(ctx.user, input.inquiryId)),

  createInquiry: p("crm.create")
    .input(
      z.object({
        subject: z.string().min(1),
        description: z.string().nullish(),
        accountId: z.string().nullish(),
        siteId: z.string().nullish(),
        contactId: z.string().nullish(),
        source: z.enum(INQUIRY_SOURCES).optional(),
        sourceRef: z.string().nullish(),
        receivedAt: z.coerce.date().nullish(),
        industry: z.string().nullish(),
        estimatedValue: z.string().nullish(),
        currency: z.string().optional(),
        requiredByDate: z.coerce.date().nullish(),
        requirements: z.record(z.string(), z.unknown()).optional(),
        ownerId: z.string().nullish(),
        items: z
          .array(
            z.object({
              description: z.string().min(1),
              quantity: z.string().optional(),
              unit: z.string().optional(),
              manufacturer: z.string().nullish(),
              modelNumber: z.string().nullish(),
              serviceType: z.enum(SERVICE_TYPES).nullish(),
              notes: z.string().nullish(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) => createInquiryService(actorMeta(ctx), input)),

  updateInquiry: p("crm.edit")
    .input(
      z.object({
        inquiryId: z.string(),
        subject: z.string().min(1).optional(),
        description: z.string().nullish(),
        accountId: z.string().nullish(),
        siteId: z.string().nullish(),
        contactId: z.string().nullish(),
        source: z.enum(INQUIRY_SOURCES).optional(),
        receivedAt: z.coerce.date().nullish(),
        industry: z.string().nullish(),
        estimatedValue: z.string().nullish(),
        requiredByDate: z.coerce.date().nullish(),
        nextFollowUpAt: z.coerce.date().nullish(),
        qualification: z.unknown().optional(),
        requirements: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(({ ctx, input }) => updateInquiryService(actorMeta(ctx), input)),

  setInquiryItems: p("crm.edit")
    .input(
      z.object({
        inquiryId: z.string(),
        items: z.array(
          z.object({
            description: z.string().min(1),
            quantity: z.string().optional(),
            unit: z.string().optional(),
            manufacturer: z.string().nullish(),
            modelNumber: z.string().nullish(),
            serviceType: z.enum(SERVICE_TYPES).nullish(),
            notes: z.string().nullish(),
          }),
        ),
      }),
    )
    .mutation(({ ctx, input }) => setInquiryItemsService(actorMeta(ctx), input)),

  /**
   * The §3 state machine's only door.
   *
   * `bySystem` is deliberately **not** in this input schema. It exists so module 02 can mirror a
   * quotation outcome onto the inquiry, and exposing it here would let anyone with `crm.edit` post
   * `{ to: "won", bySystem: true }` and mark a sale that never happened.
   */
  transitionInquiry: p("crm.edit")
    .input(
      z.object({
        inquiryId: z.string(),
        to: z.enum(INQUIRY_STATUSES),
        lostReason: z.enum(LOST_REASONS).nullish(),
        lostToCompetitor: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => transitionInquiryService(actorMeta(ctx), input)),

  /**
   * The salespeople a new inquiry can be logged for. Gated on `crm.create`, because the person
   * filling in the form is the person who needs this list.
   */
  inquiryOwners: p("crm.create").query(() => listInquiryOwnersService()),

  assignInquiry: p("inquiry.assign")
    .input(z.object({ inquiryId: z.string(), ownerId: z.string() }))
    .mutation(({ ctx, input }) => assignInquiryService(actorMeta(ctx), input)),

  overrideRequirements: p("crm.edit")
    .input(z.object({ inquiryId: z.string(), reason: z.string().min(10) }))
    .mutation(({ ctx, input }) => overrideRequirementsService(actorMeta(ctx), input)),

  listRequirementTemplates: p("crm.view").query(() => listRequirementTemplatesService()),

  /** §4: "editable in settings". Sits with the permission that already governs system-wide config
   *  rather than `crm.edit` — changing a template changes the gate for everybody. */
  upsertRequirementTemplate: p("admin.manage_custom_fields")
    .input(
      z.object({
        serviceType: z.enum(SERVICE_TYPES),
        label: z.string().min(1),
        fields: z.array(
          z.object({
            key: z.string().min(1),
            label: z.string().min(1),
            type: z.enum(["text", "number", "select", "boolean"]),
            required: z.boolean(),
            help: z.string().optional(),
            options: z.array(z.string()).optional(),
          }),
        ),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => upsertRequirementTemplateService(actorMeta(ctx), input)),

  // ---- inspection requests (§5) ----------------------------------------------------------------

  requestInspection: p("inspection.request")
    .input(
      z.object({
        inquiryId: z.string(),
        siteId: z.string().nullish(),
        purpose: z.string().min(1),
        questions: z.string().nullish(),
        requiredOutputs: z.array(z.enum(INSPECTION_OUTPUTS)).optional(),
        windowStart: z.coerce.date().nullish(),
        windowEnd: z.coerce.date().nullish(),
        assignedToId: z.string().nullish(),
        dueAt: z.coerce.date().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => createInspectionRequestService(actorMeta(ctx), input)),

  /**
   * Who a site inspection may be given to.
   *
   * Gated on `inspection.request`, not `admin.manage_users`: the form that needs this list is used
   * by whoever raises the inspection, and only the president holds the admin permission. Before
   * this existed the dropdown was empty for everyone else.
   */
  inspectionAssignees: p("inspection.request").query(() => listInspectionAssigneesService()),

  /** Open inspections assigned to the caller — the technician's own list. */
  myInspections: p("crm.view").query(({ ctx }) => listMyInspectionsService(ctx.user.id)),

  /** Assign or reassign an open inspection, notifying whoever takes it on. */
  assignInspection: p("inspection.request")
    .input(
      z.object({
        inspectionRequestId: z.string(),
        assignedToId: z.string(),
        dueAt: z.coerce.date().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => assignInspectionService(actorMeta(ctx), input)),

  completeInspection: p("crm.edit")
    .input(
      z.object({
        inspectionRequestId: z.string(),
        findings: z.string().nullish(),
        reportFileId: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => completeInspectionService(actorMeta(ctx), input)),

  cancelInspection: p("crm.edit")
    .input(z.object({ inspectionRequestId: z.string(), reason: z.string().nullish() }))
    .mutation(({ ctx, input }) => cancelInspectionService(actorMeta(ctx), input)),

  // ---- activities (§2) -------------------------------------------------------------------------

  listActivities: p("crm.view")
    .input(
      z.object({
        entityType: z.enum(ACTIVITY_ENTITY_TYPES),
        entityId: z.string(),
        limit: z.number().int().positive().max(200).optional(),
      }),
    )
    .query(({ input }) => listActivitiesService(input)),

  // ---- pipeline views (§6) and merge (§7) -------------------------------------------------------

  /** §6's kanban. Scoped like every other CRM read. */
  pipeline: p("crm.view").query(({ ctx }) => getPipelineService(ctx.user)),

  /** §6's My Day. Always the caller's own work, even for someone holding `crm.view_all`. */
  myDay: p("crm.view").query(({ ctx }) => getMyDayService(ctx.user)),

  previewMerge: p("crm.merge")
    .input(z.object({ survivorId: z.string(), mergedId: z.string() }))
    .query(({ input }) => previewMergeService(input)),

  /** §7's merge. `crm.merge` sits with president and vice-president — it cannot be undone. */
  mergeAccounts: p("crm.merge")
    .input(
      z.object({
        survivorId: z.string(),
        mergedId: z.string(),
        reason: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => mergeAccountsService(actorMeta(ctx), input)),

  // ---- principal prospects (specs/01-crm-inquiry.md §5c) ---------------------------------------
  // §9 puts this with marketing_manager (EM), visible to president and vice_president.

  listPrincipals: p("principal_prospect.manage")
    .input(
      z
        .object({ stage: z.enum(PRINCIPAL_STAGES).optional(), search: z.string().optional() })
        .optional(),
    )
    .query(({ input }) => listPrincipalsService(input ?? {})),

  getPrincipal: p("principal_prospect.manage")
    .input(z.object({ prospectId: z.string() }))
    .query(({ input }) => getPrincipalService(input.prospectId)),

  createPrincipal: p("principal_prospect.manage")
    .input(
      z.object({
        companyName: z.string().min(1),
        country: z.string().nullish(),
        website: z.string().nullish(),
        productLines: z.array(z.string()).optional(),
        contactName: z.string().nullish(),
        email: z.string().email().nullish().or(z.literal("")),
        phone: z.string().nullish(),
        targetIndustries: z.array(z.string()).optional(),
        competingBrands: z.array(z.string()).optional(),
        estimatedOpportunity: z.string().nullish(),
        ownerId: z.string().nullish(),
        notes: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => createPrincipalService(actorMeta(ctx), input)),

  updatePrincipal: p("principal_prospect.manage")
    .input(
      z.object({
        prospectId: z.string(),
        companyName: z.string().min(1).optional(),
        country: z.string().nullish(),
        website: z.string().nullish(),
        productLines: z.array(z.string()).optional(),
        contactName: z.string().nullish(),
        email: z.string().email().nullish().or(z.literal("")),
        phone: z.string().nullish(),
        targetIndustries: z.array(z.string()).optional(),
        competingBrands: z.array(z.string()).optional(),
        estimatedOpportunity: z.string().nullish(),
        exclusivity: z.enum(EXCLUSIVITY_TERMS).optional(),
        distributorAgreementFileId: z.string().nullish(),
        agreementSignedAt: z.coerce.date().nullish(),
        agreementExpiresAt: z.coerce.date().nullish(),
        priceListFileId: z.string().nullish(),
        priceListReceivedAt: z.coerce.date().nullish(),
        priceListValidUntil: z.coerce.date().nullish(),
        trainingStatus: z.string().nullish(),
        technicalContactId: z.string().nullish(),
        notes: z.string().nullish(),
        nextFollowUpAt: z.coerce.date().nullish(),
        ownerId: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => updatePrincipalService(actorMeta(ctx), input)),

  /**
   * The §5c pipeline's only door. Appointing emits `principal.appointed` for module 03.
   *
   * Still gated on `principal_prospect.manage`, because that is what it takes to move a prospect
   * along at all. The narrower `principal.appoint` check lives in the service rather than here,
   * since it applies to exactly one of the eight destinations — a second procedure would have split
   * one state machine across two doors.
   */
  transitionPrincipal: p("principal_prospect.manage")
    .input(
      z.object({
        prospectId: z.string(),
        to: z.enum(PRINCIPAL_STAGES),
        reason: z.string().nullish(),
        overrideDocuments: z.string().max(500).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => transitionPrincipalService(actorMeta(ctx), input)),

  logActivity: p("crm.create")
    .input(
      z.object({
        entityType: z.enum(ACTIVITY_ENTITY_TYPES),
        entityId: z.string(),
        type: z.enum(ACTIVITY_TYPES),
        subject: z.string().min(1),
        body: z.string().nullish(),
        occurredAt: z.coerce.date().nullish(),
        durationMin: z.number().int().positive().nullish(),
        participantIds: z.array(z.string()).optional(),
        contactIds: z.array(z.string()).optional(),
        outcome: z.string().nullish(),
        nextStepDue: z.coerce.date().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => logActivityService(actorMeta(ctx), input)),
});
