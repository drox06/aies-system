// Seed data grows module by module (docs/DECISIONS-CONFIRMED.md is authoritative for the people
// and role data below). Uses its own PrismaClient rather than src/lib/db.ts's singleton — that
// one has dev-mode globalThis caching meant for the Next.js request lifecycle, which a one-shot
// script doesn't need.
import { hash } from "@node-rs/argon2";
import { SEED_CHECKLISTS } from "./seed-checklists";
import { Prisma, PrismaClient } from "@prisma/client";
import { registry } from "../src/server/core/manifests";
import { SEED_REQUIREMENT_TEMPLATES } from "../src/server/core/crm/requirements";

const db = new PrismaClient();

// Forces a reset at first login (mustChangePassword) and TOTP enrollment is forced separately
// regardless — this is a starting password for a dev/staging database, not a production secret.
const SEED_DEFAULT_PASSWORD = process.env.SEED_DEFAULT_PASSWORD ?? "ChangeMe123!Aies";

interface PermissionSeed {
  key: string;
  label: string;
  group: string;
  defaultRoles: string[];
}

// Module 00's own permissions. Business modules (01-10) register theirs through the module
// manifest system (src/server/core/module-registry.ts) once built — these are the ones the
// foundation module itself needs to be usable (specs/00-foundation.md §4.3).
const PERMISSIONS: PermissionSeed[] = [
  {
    key: "admin.manage_users",
    label: "Manage users",
    group: "Administration",
    defaultRoles: ["president"],
  },
  {
    key: "admin.manage_roles",
    label: "Manage roles & permissions",
    group: "Administration",
    defaultRoles: ["president"],
  },
  {
    key: "finance.view_cost",
    label: "View cost & margin",
    group: "Finance",
    defaultRoles: ["president", "vice_president"],
  },
  {
    key: "project.view_pl",
    label: "View project P&L",
    group: "Finance",
    defaultRoles: ["president", "vice_president"],
  },
  {
    key: "quotation.approve",
    label: "Approve quotations",
    group: "Sales",
    defaultRoles: ["vice_president", "president"],
  },
  {
    key: "cash_advance.approve",
    label: "Approve cash advances",
    group: "Finance",
    defaultRoles: ["vice_president", "president"],
  },
  {
    key: "cash_advance.approve_extension",
    label: "Approve cash advance liquidation extensions",
    group: "Finance",
    defaultRoles: ["vice_president", "president"],
  },
  {
    key: "admin.manage_custom_fields",
    label: "Manage custom fields",
    group: "Administration",
    defaultRoles: ["president"],
  },
];

interface RoleSeed {
  key: string;
  name: string;
}

// Five active + four unassigned-but-ready (docs/DECISIONS-CONFIRMED.md "The five users" + §4.2).
const ROLES: RoleSeed[] = [
  { key: "president", name: "President" },
  { key: "vice_president", name: "Vice President" },
  { key: "admin_manager", name: "Admin Manager" },
  { key: "operations_manager", name: "Operations Manager" },
  // Renamed 2026-08-17 at the company's request: EM covers sales as well as marketing. The key
  // stays `marketing_manager` — it is written into RolePermission rows, every manifest's
  // defaultRoles and every permission check, so changing it would be a migration to alter a label.
  { key: "marketing_manager", name: "Sales and Marketing Manager" },
  { key: "technician", name: "Technician" },
  { key: "sales", name: "Sales" },
  { key: "finance_officer", name: "Finance Officer" },
  { key: "viewer", name: "Viewer" },
];

interface NamedUserSeed {
  email: string;
  name: string;
  roleKey: string;
}

// Real names weren't provided beyond initials — using the initials as `name` rather than
// fabricating full names. An admin can fill these in post-seed (specs/00-foundation.md §4.3).
const NAMED_USERS: NamedUserSeed[] = [
  { email: "ea@aieselectromech.com", name: "EA", roleKey: "president" },
  { email: "kj@aieselectromech.com", name: "KJ", roleKey: "vice_president" },
  { email: "pd@aieselectromech.com", name: "PD", roleKey: "admin_manager" },
  { email: "dj@aieselectromech.com", name: "DJ", roleKey: "operations_manager" },
  { email: "em@aieselectromech.com", name: "EM", roleKey: "marketing_manager" },
];

// One demo user per unassigned role, clearly marked and on a non-company domain
// (specs/00-foundation.md §4.3: "Seed one demo user per role for testing").
const DEMO_ROLE_KEYS = ["technician", "sales", "finance_officer", "viewer"];

interface ApprovalRuleSeed {
  key: string;
  label: string;
  escalateAfterHours: number;
}

// VP approves all of these; President is the automatic fallback (Spec.md §4.4, docs/DECISIONS-
// CONFIRMED.md #35). Default windows: cash advances 4 working hours, everything else 24 — counted
// on the working calendar, so a Friday submission does not escalate over the weekend
// (docs/DECISIONS.md #29).
const APPROVAL_RULES: ApprovalRuleSeed[] = [
  { key: "quotation.approve", label: "Quotation approval", escalateAfterHours: 24 },
  { key: "cash_advance.approve", label: "Cash advance approval", escalateAfterHours: 4 },
  {
    key: "cash_advance.approve_extension",
    label: "Cash advance liquidation extension approval",
    escalateAfterHours: 24,
  },
  { key: "payment_terms.approve", label: "Payment terms change approval", escalateAfterHours: 24 },
  // specs/03-order-procurement.md §5: "the Vice President approves supplier POs, matching quotation
  // approval." A separate key from `quotation.approve` though both resolve to the VP today — they
  // are decisions about different risks (a price AIES will charge, money AIES will spend), and
  // sharing a key would mean routing spending elsewhere silently moved quotation approval with it.
  { key: "supplier_po.approve", label: "Supplier PO approval", escalateAfterHours: 24 },
];

/**
 * Every permission that should exist: module 00's own, plus whatever the business modules declare
 * in their manifests.
 *
 * specs/00-foundation.md §3 is explicit that modules own their permissions and the app assembles
 * them at boot — but until module 01 nothing consumed `registry.permissions`, because module 00's
 * manifest declares none. So a business module could declare `crm.view`, have it validated for
 * collisions at boot, and still never reach the database — leaving every `p("crm.view")`
 * procedure permanently 403 with nothing obviously wrong. This is the join that makes the
 * manifest system real rather than decorative.
 *
 * Collision handling is left to `buildModuleRegistry`, which already throws at boot if two modules
 * claim one key; by the time this runs the set is known-unique.
 */
function allPermissions(): PermissionSeed[] {
  return [
    ...PERMISSIONS,
    ...registry.permissions.map((p) => ({
      key: p.key,
      label: p.label,
      group: p.group,
      defaultRoles: p.defaultRoles ?? [],
    })),
  ];
}

async function seedRolesAndPermissions() {
  for (const role of ROLES) {
    await db.role.upsert({
      where: { key: role.key },
      update: { name: role.name },
      create: { key: role.key, name: role.name, isSystem: true },
    });
  }

  for (const permission of allPermissions()) {
    await db.permission.upsert({
      where: { key: permission.key },
      update: { label: permission.label, group: permission.group },
      create: { key: permission.key, label: permission.label, group: permission.group },
    });

    for (const roleKey of permission.defaultRoles) {
      const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
      const perm = await db.permission.findUniqueOrThrow({ where: { key: permission.key } });
      await db.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
        update: {},
        create: { roleId: role.id, permissionId: perm.id },
      });
    }
  }

  // Permissions the manifests no longer declare.
  //
  // The seed adds and updates but never removed, so a permission dropped from a manifest stayed in
  // the database and in the admin role screen forever — which is how eleven of them accumulated
  // across four modules, each granting access to nothing. Pruning here closes that: the manifests
  // are the source of truth, and the database follows them in both directions.
  //
  // Safe because a permission nothing gates cannot be protecting anything. `RolePermission` rows
  // cascade with it.
  const declared = new Set(allPermissions().map((p) => p.key));
  const orphaned = (await db.permission.findMany({ select: { key: true } }))
    .map((p) => p.key)
    .filter((key) => !declared.has(key));
  if (orphaned.length > 0) {
    await db.permission.deleteMany({ where: { key: { in: orphaned } } });
    console.log(
      `Removed ${orphaned.length} permission(s) no manifest declares: ${orphaned.join(", ")}.`,
    );
  }

  console.log(
    `Seeded ${ROLES.length} roles and ${allPermissions().length} permissions ` +
      `(${PERMISSIONS.length} foundation + ${registry.permissions.length} from module manifests).`,
  );
}

async function seedUser(email: string, name: string, roleKey: string, isDemoUser: boolean) {
  const passwordHash = await hash(SEED_DEFAULT_PASSWORD);
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });

  const user = await db.user.upsert({
    where: { email },
    update: { name, isDemoUser },
    create: {
      email,
      name,
      passwordHash,
      isDemoUser,
      mustChangePassword: true,
    },
  });

  await db.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: role.id } },
    update: {},
    create: { userId: user.id, roleId: role.id },
  });

  return user;
}

async function seedUsers() {
  for (const u of NAMED_USERS) {
    await seedUser(u.email, u.name, u.roleKey, false);
  }
  /**
   * Demo accounts are **off by default** as of 2026-08-17.
   *
   * They share one publicly-known password and exist only to click around a role you are not. On a
   * database holding real work — and certainly on the live one — four such accounts are four ways in
   * that nobody owns. The seed is run again every time a numbering format is added, so deleting them
   * by hand never stuck; this is the half that makes the deletion permanent.
   *
   * Set `SEED_DEMO_USERS=1` for a throwaway database where they are genuinely useful.
   */
  const wantDemoUsers = process.env.SEED_DEMO_USERS === "1";
  if (wantDemoUsers) {
    for (const roleKey of DEMO_ROLE_KEYS) {
      await seedUser(`demo-${roleKey}@aies.local`, `Demo ${roleKey}`, roleKey, true);
    }
  }

  console.log(
    `Seeded ${NAMED_USERS.length} named users` +
      (wantDemoUsers
        ? ` and ${DEMO_ROLE_KEYS.length} demo users`
        : " (demo users skipped — set SEED_DEMO_USERS=1 to include them)") +
      `. Default password: "${SEED_DEFAULT_PASSWORD}" (mustChangePassword is set; TOTP enrollment ` +
      `is forced separately at first login).`,
  );
}

async function seedApprovalRules() {
  for (const rule of APPROVAL_RULES) {
    await db.approvalRule.upsert({
      where: { key: rule.key },
      update: { label: rule.label, escalateAfterHours: rule.escalateAfterHours },
      create: {
        key: rule.key,
        label: rule.label,
        primaryApproverRole: "vice_president",
        fallbackApproverRole: "president",
        escalateAfterHours: rule.escalateAfterHours,
        escalationMode: "parallel",
      },
    });
  }

  console.log(`Seeded ${APPROVAL_RULES.length} approval rules.`);
}

interface NumberingFormatSeed {
  documentType: string;
  format: string;
  label: string;
}

/**
 * Spec.md §5, as the company settled it on 2026-08-16.
 *
 * **One house template: `AIES{CODE}-{YY}{####}`.** Every transaction document carries the company's
 * initials, its own code, the two-digit year and a four-digit counter that restarts each January —
 * `AIESRFQ-260001`, `AIESPO-260001`. Before this each series had picked up its own shape
 * (`RFQ-{YY}-{####}`, `SO-{YY}-{#####}`, `INQ-{YY}{MM}-{####}`), which meant a number told you
 * nothing about whose document it was and the widths disagreed for no reason.
 *
 * Three deliberate exceptions:
 *
 * - **`quotation_local` and `quotation_indent` keep `AIESLQ{YY}{####}` / `AIESIQ{YY}{####}`**, with
 *   no hyphen. They are the company's long-standing convention, they are already on documents sent
 *   to customers, and the company asked explicitly for them to be left alone.
 * - **`account` and `supplier` stay yearless.** They identify a *relationship*, not a dated
 *   document, so their counter must never reset — a customer keeps one code forever rather than
 *   collecting a new one each January. They take the `AIES` prefix and nothing else.
 * - **`controlled_doc` keeps its own shape**, because module 07's ISO document control numbers its
 *   documents by department and type rather than by date.
 *
 * The quotation's `R{n}` revision suffix is appended by module 02 on top of the base number, not
 * part of the counter format.
 */
const NUMBERING_FORMATS: NumberingFormatSeed[] = [
  // specs/01-crm-inquiry.md §2's account code, now prefixed. Still no year segment — see above.
  { documentType: "account", format: "AIESACC-{####}", label: "Account code" },
  // The month segment is gone with the rename: the house template is year and counter, and a
  // month in the middle made two documents raised in the same year look unrelated.
  { documentType: "inquiry", format: "AIESINQ-{YY}{####}", label: "Inquiry" },
  // Left alone at the company's request — already on documents that went to customers.
  // docs/DECISIONS.md #25.
  { documentType: "quotation_local", format: "AIESLQ{YY}{####}", label: "Quotation (local)" },
  {
    documentType: "quotation_indent",
    format: "AIESIQ{YY}{####}",
    label: "Quotation (indent / international)",
  },
  // specs/02-quotation.md §3's supplier price request. Its own series: an RFQ is a document AIES
  // sends to a principal and refers to by number in the follow-up email.
  { documentType: "supplier_rfq", format: "AIESRFQ-{YY}{####}", label: "Supplier RFQ" },
  // specs/03-order-procurement.md §2's supplier directory. Yearless, like `account`.
  { documentType: "supplier", format: "AIESSUP-{####}", label: "Supplier code" },
  { documentType: "sales_order", format: "AIESSO-{YY}{####}", label: "Sales Order" },
  { documentType: "supplier_po", format: "AIESPO-{YY}{####}", label: "Supplier PO" },
  // specs/03-order-procurement.md §6. "GRN" rather than "GR": goods received note is what the
  // warehouse calls the piece of paper, and a document type nobody recognises by its prefix is one
  // people write the wrong number on.
  { documentType: "goods_receipt", format: "AIESGRN-{YY}{####}", label: "Goods Receipt" },
  { documentType: "ticket", format: "AIESTKT-{YY}{####}", label: "Ticket" },
  // specs/04-operations-projects.md §3's `Project.code`. Not in Spec.md §5's table — a project is
  // a container the company refers to by name in conversation, and giving it a number is what lets
  // several tickets say which one they roll up to.
  { documentType: "project", format: "AIESPRJ-{YY}{####}", label: "Project" },
  { documentType: "cash_advance", format: "AIESCA-{YY}{####}", label: "Cash Advance" },
  // specs/04-operations-projects.md §6.1. Not in Spec.md §5's table either, and it needs one for the
  // same reason `project` did: an inspection report is a document the company hands to a customer
  // when the survey changes the scope, and "the one from last Tuesday" is not a reference.
  {
    documentType: "site_inspection",
    format: "AIESSIR-{YY}{####}",
    label: "Site Inspection Report",
  },
  // specs/04-operations-projects.md §9. Not in Spec.md §5's table, and it needs a number for the
  // reason §9 gives: the client's approval is "the release authorisation under clause 8.6, and the
  // best support the company will ever have for the final bill" — a document that gets referenced.
  { documentType: "qa_approval", format: "AIESQA-{YY}{####}", label: "QA Approval" },
  { documentType: "warranty_claim", format: "AIESWC-{YY}{####}", label: "Warranty Claim" },
  {
    documentType: "testing_commissioning",
    format: "AIESTC-{YY}{####}",
    label: "Testing & Commissioning",
  },
  { documentType: "material_request", format: "AIESMR-{YY}{####}", label: "Material Request" },
  { documentType: "methodology", format: "AIESMTH-{YY}{####}", label: "Methodology" },
  { documentType: "delivery_receipt", format: "AIESDR-{YY}{####}", label: "Delivery Receipt" },
  { documentType: "service_report", format: "AIESSR-{YY}{####}", label: "Service Report" },
  { documentType: "billing_statement", format: "AIESBS-{YY}{####}", label: "Billing Statement" },
  { documentType: "service_invoice", format: "AIESSI-{YY}{####}", label: "Service Invoice" },
  { documentType: "calibration_job", format: "AIESCAL-{YY}{####}", label: "Calibration Job" },
  { documentType: "ncr", format: "AIESNCR-{YY}{####}", label: "NCR" },
  {
    documentType: "controlled_doc",
    format: "AIES-{DEPT}-{TYPE}-{###}",
    label: "Controlled Document",
  },
];

async function seedNumberingFormats() {
  for (const f of NUMBERING_FORMATS) {
    await db.numberingFormat.upsert({
      where: { documentType: f.documentType },
      update: { format: f.format, label: f.label },
      create: f,
    });
  }

  // The spec's placeholder format, superseded by the two above. Deleted rather than left inert so
  // nobody allocates against it by reaching for the obvious document type name.
  await db.numberingFormat.deleteMany({ where: { documentType: "quotation" } });

  console.log(`Seeded ${NUMBERING_FORMATS.length} numbering formats.`);
}

/**
 * specs/01-crm-inquiry.md §4's requirements checklists, one per service type.
 *
 * `update` deliberately writes only `label`, never `fields`. §4 says these are "editable in
 * settings", so re-running the seed after somebody has added a question to the installation
 * template must not throw their edit away — which is exactly what a full upsert would do, silently,
 * on the next deploy.
 */
async function seedRequirementTemplates() {
  for (const template of SEED_REQUIREMENT_TEMPLATES) {
    await db.requirementTemplate.upsert({
      where: { serviceType: template.serviceType },
      update: { label: template.label },
      create: {
        serviceType: template.serviceType,
        label: template.label,
        fields: template.fields as unknown as Prisma.InputJsonValue,
      },
    });
  }

  console.log(`Seeded ${SEED_REQUIREMENT_TEMPLATES.length} requirements templates.`);
}

/**
 * specs/02-quotation.md §6's workflow — one step, no conditions, routed by the `quotation.approve`
 * rule above.
 *
 * The definition lives in the module, not here: `ensureQuotationApprovalWorkflow` is the same
 * function the submit path calls, so a fresh database and a database that gains the feature later
 * cannot end up with two different workflows under one name.
 */
async function seedQuotationApprovalWorkflow() {
  const { ensureQuotationApprovalWorkflow } =
    await import("../src/server/core/quotation/approval-service");
  const workflow = await ensureQuotationApprovalWorkflow();
  console.log(`Quotation approval workflow ready (${workflow.id}).`);
}

/**
 * specs/04-operations-projects.md §15's eleven checklists.
 *
 * **Creates, never updates.** A published checklist version is the procedure a response cites as the
 * one it followed, so rewriting its `sections` on the next deploy would silently change what
 * somebody signed. The seed provides a version 1 where nothing exists under that key and then leaves
 * the company's checklists alone forever — revisions happen in the app, which creates a new version
 * rather than editing the old one.
 *
 * Published as `active` rather than `draft`: an empty Checklists screen on day one teaches people the
 * feature is not ready, and these are the stages §15 names by hand.
 */
async function seedChecklists() {
  let created = 0;

  for (const checklist of SEED_CHECKLISTS) {
    const existing = await db.checklistTemplate.findFirst({
      where: { key: checklist.key },
      select: { id: true },
    });
    if (existing) continue;

    await db.checklistTemplate.create({
      data: {
        key: checklist.key,
        version: 1,
        name: checklist.name,
        stage: checklist.stage,
        description: checklist.description,
        sections: checklist.sections as unknown as Prisma.InputJsonValue,
        status: "active",
        publishedAt: new Date(),
      },
    });
    created += 1;
  }

  console.log(
    created > 0
      ? `Seeded ${created} checklist templates.`
      : `Checklist templates already present — left untouched (${SEED_CHECKLISTS.length} keys).`,
  );
}

async function main() {
  await seedRolesAndPermissions();
  await seedUsers();
  await seedApprovalRules();
  await seedQuotationApprovalWorkflow();
  await seedNumberingFormats();
  await seedRequirementTemplates();
  await seedChecklists();
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void db.$disconnect();
  });
