import { db } from "@/lib/db";
import type { AuthedUser } from "@/server/core/rbac/types";
import { listMyApprovalInbox } from "@/server/core/approvals/service";

/**
 * What needs *this* person, across every module.
 *
 * Home was a module 00 scaffold until 2026-08-17 — it showed the signed-in user their own permission
 * count and a checklist of infrastructure. The first screen everybody sees every day, telling them
 * nothing about their work.
 *
 * ## Why not redirect to My day instead
 *
 * My day is module 01 §6 and it is **CRM-only**: overdue follow-ups, silent quotations, inspections
 * assigned to you. It serves EA and EM well. It gives DJ, PD and a technician almost nothing, so
 * redirecting Home there would send half the company to a page about somebody else's job. My day
 * stays exactly as it is; this sits above it and links to it.
 *
 * ## Two rules the tiles obey
 *
 * **A tile the person cannot act on is absent, not zero.** Permissions decide which tiles exist at
 * all. Someone without `quotation.approve` does not see an approvals tile reading 0 — they see no
 * such tile, because a count of a queue you cannot open is noise dressed as information.
 *
 * **Zero is stated, not hidden.** Where the tile *does* apply and there is nothing waiting, it says
 * so. This is the distinction that runs through the whole platform — an answered "nothing" and an
 * unasked question must not look the same — and on a landing page it is the difference between "I am
 * up to date" and "this panel is broken".
 *
 * Every tile is one indexed count. It is a landing page: it must be fast, and no tile is worth a
 * query that makes it slow.
 */

export interface HomeTile {
  key: string;
  label: string;
  /** What the number means when it is not zero. */
  detail: string;
  /** Said when the count is zero, so being up to date reads as an answer. */
  clear: string;
  count: number;
  href: string;
}

export interface HomeSummary {
  tiles: HomeTile[];
  /** True when every tile that applies to this person is at zero. */
  allClear: boolean;
  /** How many tiles were withheld because the person holds no permission for them. */
  hiddenForPermissions: number;
}

const TILE_COUNT = 8;

export async function homeSummaryService(user: AuthedUser): Promise<HomeSummary> {
  const has = (key: string) => user.permissions.has(key);
  const tiles: HomeTile[] = [];

  // ---- module 00: the generic approval inbox -----------------------------------------------------
  //
  // Reuses `listMyApprovalInbox` rather than re-deriving eligibility. Approver eligibility involves
  // role resolution and the working-hours fallback; a second implementation here would drift from the
  // engine and the tile would eventually disagree with the page it links to.
  const inbox = await listMyApprovalInbox(user);
  tiles.push({
    key: "approvals",
    label: "Approvals",
    detail: "waiting on your decision",
    clear: "Nothing waiting on your decision.",
    count: inbox.length,
    href: "/approvals",
  });

  // ---- module 02: the quotation approval queue ---------------------------------------------------
  if (has("quotation.approve")) {
    tiles.push({
      key: "quotationApprovals",
      label: "Quotations for approval",
      detail: "submitted and undecided",
      clear: "No quotations are waiting.",
      count: await db.quotation.count({
        where: { deletedAt: null, status: "pending_approval" },
      }),
      href: "/quotations/approvals",
    });
  }

  // ---- module 04: your own field work -----------------------------------------------------------
  if (has("ticket.view")) {
    const mine = {
      deletedAt: null,
      status: { notIn: ["completed", "cancelled"] },
      OR: [{ assignedLeadId: user.id }, { assignedUserIds: { has: user.id } }],
    };

    tiles.push({
      key: "myTickets",
      label: "Your open jobs",
      detail: "assigned to you and not finished",
      clear: "No open jobs assigned to you.",
      count: await db.ticket.count({ where: mine }),
      href: "/tickets",
    });

    // The gates from §5 and §7, as the crew experiences them: a job that cannot mobilise.
    tiles.push({
      key: "blockedTickets",
      label: "Jobs held at a gate",
      detail: "waiting on a cash advance or materials",
      clear: "No jobs held at a gate.",
      count: await db.ticket.count({
        where: { ...mine, status: { in: ["cash_advance_pending", "material_pending"] } },
      }),
      href: "/tickets",
    });
  }

  // ---- module 04 §6.1: surveys you have to write up ----------------------------------------------
  if (has("ticket.execute")) {
    tiles.push({
      key: "openInspections",
      label: "Site surveys open",
      detail: "scheduled or in progress",
      clear: "No surveys outstanding.",
      count: await db.siteInspection.count({
        where: { deletedAt: null, status: { in: ["scheduled", "in_progress"] } },
      }),
      href: "/inspections",
    });
  }

  // ---- module 04 §5: liquidations finance has to check -------------------------------------------
  if (has("cash_advance.review_liquidation")) {
    tiles.push({
      key: "liquidations",
      label: "Liquidations to check",
      detail: "receipts submitted, awaiting settlement",
      clear: "No liquidations waiting on finance.",
      count: await db.cashAdvance.count({
        where: { deletedAt: null, status: "pending_settlement" },
      }),
      href: "/cash-advances",
    });
  }

  // ---- module 04 §11: claims nobody has answered -------------------------------------------------
  if (has("warranty.determine")) {
    tiles.push({
      key: "warrantyClaims",
      label: "Warranty claims open",
      detail: "nobody has said yet whether the customer pays",
      clear: "No unanswered warranty claims.",
      count: await db.warrantyClaim.count({ where: { deletedAt: null, status: "open" } }),
      href: "/warranty",
    });
  }

  // ---- module 04 §12: projects that could close but have not -------------------------------------
  if (has("project.view")) {
    tiles.push({
      key: "closeOut",
      label: "Projects awaiting close-out",
      detail: "work finished, handover not signed",
      clear: "No projects waiting to close.",
      count: await db.project.count({
        where: {
          deletedAt: null,
          status: { notIn: ["closed", "cancelled"] },
          OR: [{ closeOut: null }, { closeOut: { status: { not: "approved" } } }],
        },
      }),
      href: "/projects",
    });
  }

  return {
    tiles,
    allClear: tiles.every((tile) => tile.count === 0),
    hiddenForPermissions: TILE_COUNT - tiles.length,
  };
}
