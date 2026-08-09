// Seed data grows module by module (docs/DECISIONS-CONFIRMED.md is authoritative for the people
// and role data below). Uses its own PrismaClient rather than src/lib/db.ts's singleton — that
// one has dev-mode globalThis caching meant for the Next.js request lifecycle, which a one-shot
// script doesn't need.
import { hash } from "@node-rs/argon2";
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
  { key: "marketing_manager", name: "Marketing Manager" },
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
// CONFIRMED.md #35). Default windows: cash advances 4 working hours, everything else 24 — see
// src/server/core/rbac/approval-fallback.ts for why "working hours" means wall-clock hours today.
const APPROVAL_RULES: ApprovalRuleSeed[] = [
  { key: "quotation.approve", label: "Quotation approval", escalateAfterHours: 24 },
  { key: "cash_advance.approve", label: "Cash advance approval", escalateAfterHours: 4 },
  {
    key: "cash_advance.approve_extension",
    label: "Cash advance liquidation extension approval",
    escalateAfterHours: 24,
  },
  { key: "payment_terms.approve", label: "Payment terms change approval", escalateAfterHours: 24 },
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
  for (const roleKey of DEMO_ROLE_KEYS) {
    await seedUser(`demo-${roleKey}@aies.local`, `Demo ${roleKey}`, roleKey, true);
  }

  console.log(
    `Seeded ${NAMED_USERS.length} named users and ${DEMO_ROLE_KEYS.length} demo users. ` +
      `Default password: "${SEED_DEFAULT_PASSWORD}" (mustChangePassword is set; TOTP enrollment ` +
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

// Spec.md §5. Quotation's `R{n}` revision suffix is appended by the quotation module (02) on top
// of this base number, not part of the counter format itself.
const NUMBERING_FORMATS: NumberingFormatSeed[] = [
  // specs/01-crm-inquiry.md §2: "New accounts get a code from the numbering service: ACC-{####}."
  // No year segment, unlike the document types below — an account code is a permanent identifier
  // for a customer relationship, not a dated document, so the counter never resets.
  { documentType: "account", format: "ACC-{####}", label: "Account code" },
  { documentType: "inquiry", format: "INQ-{YY}{MM}-{####}", label: "Inquiry" },
  // The company's own convention, replacing Spec.md §5's QTN-{YY}{MM}-{####} placeholder. Two
  // independent series so a local quote and an indent quote never share a counter; each restarts
  // in January because the scope key comes from the format's own {YY}. docs/DECISIONS.md #25.
  { documentType: "quotation_local", format: "AIESLQ{YY}{####}", label: "Quotation (local)" },
  {
    documentType: "quotation_indent",
    format: "AIESIQ{YY}{####}",
    label: "Quotation (indent / international)",
  },
  { documentType: "sales_order", format: "SO-{YY}-{#####}", label: "Sales Order" },
  { documentType: "supplier_po", format: "PO-{YY}-{#####}", label: "Supplier PO" },
  { documentType: "ticket", format: "TKT-{YY}-{#####}", label: "Ticket" },
  { documentType: "cash_advance", format: "CA-{YY}-{#####}", label: "Cash Advance" },
  { documentType: "material_request", format: "MR-{YY}-{#####}", label: "Material Request" },
  { documentType: "methodology", format: "MTH-{YY}-{###}", label: "Methodology" },
  { documentType: "delivery_receipt", format: "DR-{YY}-{#####}", label: "Delivery Receipt" },
  { documentType: "service_report", format: "SR-{YY}-{#####}", label: "Service Report" },
  { documentType: "billing_statement", format: "BS-{YY}-{#####}", label: "Billing Statement" },
  { documentType: "service_invoice", format: "SI-{YY}-{#####}", label: "Service Invoice" },
  { documentType: "calibration_job", format: "CAL-{YY}-{####}", label: "Calibration Job" },
  { documentType: "ncr", format: "NCR-{YY}-{###}", label: "NCR" },
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

async function main() {
  await seedRolesAndPermissions();
  await seedUsers();
  await seedApprovalRules();
  await seedNumberingFormats();
  await seedRequirementTemplates();
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void db.$disconnect();
  });
