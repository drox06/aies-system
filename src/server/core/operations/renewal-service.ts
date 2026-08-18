import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { createStandaloneTicketService } from "./ticket-service";
import { MAINTENANCE_CONTRACT_ENTITY_TYPE } from "./timesheet-rules";
import {
  PM_TICKET_LEAD_DAYS,
  RENEWAL_REASON_LABELS,
  dueContractRenewals,
  dueEquipmentRenewals,
  plannedVisitDates,
  sortLeads,
  visitsToRaise,
  type RenewalLead,
} from "./renewal-rules";

/**
 * specs/04-operations-projects.md §16's maintenance contracts and the renewal loop.
 *
 * §16 calls the loop "where the recurring revenue in this business lives", and the thing that makes
 * it real rather than a report is that it runs whether or not anybody remembers to look. Two nightly
 * jobs:
 *
 * **Visits become tickets** ahead of schedule, so a contract the company sold does not quietly go
 * unserved and then get renewed on a promise nobody kept.
 *
 * **Renewals become leads**, emitted for module 01 rather than written into its tables — the same
 * boundary every other cross-module link in module 04 keeps. Module 01 owns what a lead is; this
 * module owns knowing when one is due.
 *
 * Both raise each thing **once**. A sweep that re-raises the same contract for ninety consecutive
 * nights teaches sales to filter the alert, and then the ninety-first — a real lapse — is filtered
 * too. Same reasoning as #83's unsigned delivery receipt.
 */

// ---- contracts -------------------------------------------------------------------------------------

export interface ContractInput {
  accountId: string;
  siteId?: string | null;
  startDate: Date;
  endDate: Date;
  visitsPerYear: number;
  equipmentIds?: string[];
  contractValue?: number;
  salesOrderId?: string | null;
}

export async function createContractService(actor: ActorMeta, input: ContractInput) {
  if (!(input.endDate > input.startDate)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A contract has to end after it starts.",
    });
  }
  if (input.visitsPerYear < 1) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A maintenance contract owing no visits is not a maintenance contract.",
    });
  }

  const number = await allocateNumber("maintenance_contract");

  return db.$transaction(async (tx) => {
    const contract = await tx.maintenanceContract.create({
      data: {
        number,
        accountId: input.accountId,
        siteId: input.siteId ?? null,
        startDate: input.startDate,
        endDate: input.endDate,
        visitsPerYear: input.visitsPerYear,
        equipmentIds: input.equipmentIds ?? [],
        contractValue: input.contractValue ?? 0,
        salesOrderId: input.salesOrderId ?? null,
        status: "draft",
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "created",
      entityType: MAINTENANCE_CONTRACT_ENTITY_TYPE,
      entityId: contract.id,
      summary: `${number}: ${input.visitsPerYear} visits a year covering ${(input.equipmentIds ?? []).length} item(s).`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return contract;
  });
}

/** Starting the contract is what makes it generate work. Until then it is a proposal. */
export async function activateContractService(actor: ActorMeta, input: { contractId: string }) {
  const contract = await db.maintenanceContract.findFirst({
    where: { id: input.contractId, deletedAt: null },
  });
  if (!contract) throw new TRPCError({ code: "NOT_FOUND", message: "No such contract." });
  if (contract.status !== "draft") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `That contract is already ${contract.status}.`,
    });
  }
  if (contract.equipmentIds.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Nothing is covered. A contract with no equipment on it generates visits against nothing " +
        "and renews into the same.",
    });
  }

  return db.maintenanceContract.update({
    where: { id: contract.id },
    data: { status: "active", version: { increment: 1 } },
  });
}

export async function listContractsService(filter: { accountId?: string; status?: string } = {}) {
  const rows = await db.maintenanceContract.findMany({
    where: {
      deletedAt: null,
      ...(filter.accountId ? { accountId: filter.accountId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: { endDate: "asc" },
    include: { account: { select: { id: true, code: true, name: true } } },
    take: 200,
  });

  return rows.map((row) => ({
    ...row,
    plannedVisits: plannedVisitDates(row),
  }));
}

export async function getContractService(contractId: string) {
  const contract = await db.maintenanceContract.findFirst({
    where: { id: contractId, deletedAt: null },
    include: { account: { select: { id: true, code: true, name: true } } },
  });
  if (!contract) return null;

  const equipment = contract.equipmentIds.length
    ? await db.equipment.findMany({
        where: { id: { in: contract.equipmentIds }, deletedAt: null },
        select: {
          id: true,
          description: true,
          tagNumber: true,
          serialNumber: true,
          nextPMDueAt: true,
          calibrationDueAt: true,
        },
      })
    : [];

  const tickets = await db.ticket.findMany({
    where: { deletedAt: null, subType: "preventive", accountId: contract.accountId },
    select: { id: true, number: true, requiredByDate: true, status: true },
    orderBy: { requiredByDate: "asc" },
  });

  return {
    ...contract,
    equipment,
    plannedVisits: plannedVisitDates(contract),
    tickets,
  };
}

// ---- the renewal loop ------------------------------------------------------------------------------

/**
 * Everything due, as leads, without raising anything.
 *
 * The screen and the sweep share this so a person browsing sees exactly what the nightly job will
 * act on — a dashboard that disagrees with the job behind it is worse than no dashboard.
 */
export async function dueRenewalsService(now: Date = new Date()): Promise<RenewalLead[]> {
  const [contracts, equipment] = await Promise.all([
    db.maintenanceContract.findMany({
      where: { deletedAt: null, status: "active" },
      select: {
        id: true,
        number: true,
        accountId: true,
        endDate: true,
        status: true,
        renewalFlaggedAt: true,
      },
    }),
    db.equipment.findMany({
      where: { deletedAt: null, status: "active" },
      select: {
        id: true,
        accountId: true,
        description: true,
        tagNumber: true,
        serialNumber: true,
        status: true,
        warrantyEnd: true,
        calibrationDueAt: true,
        nextPMDueAt: true,
      },
    }),
  ]);

  return sortLeads([
    ...dueContractRenewals(contracts, now),
    ...dueEquipmentRenewals(equipment, now),
  ]);
}

/**
 * §16's renewal loop, nightly.
 *
 * Emits `renewal.due` per lead for module 01 to turn into whatever it decides a lead is. Contracts
 * are stamped `renewalFlaggedAt` so they are raised once; equipment is not, because its three
 * reasons are driven by dates that move when the work is done — servicing an item sets a new
 * `nextPMDueAt`, which is the natural "handled" signal and needs no flag of its own.
 */
export async function sweepRenewalsService(now: Date = new Date()) {
  const leads = await dueRenewalsService(now);
  if (leads.length === 0) return { raised: 0, contracts: 0 };

  let contracts = 0;

  await db.$transaction(async (tx) => {
    for (const lead of leads) {
      await emit(
        tx,
        "renewal.due",
        {
          reason: lead.reason,
          reasonLabel: RENEWAL_REASON_LABELS[lead.reason],
          entityType: lead.entityType,
          entityId: lead.entityId,
          accountId: lead.accountId,
          label: lead.label,
          dueAt: lead.dueAt,
          daysUntilDue: lead.daysUntilDue,
          // Carried so the person who picks this up weeks later has the argument, not just the date.
          pitch: lead.pitch,
        },
        {},
      );

      if (lead.entityType === "MaintenanceContract") {
        await tx.maintenanceContract.update({
          where: { id: lead.entityId },
          data: { renewalFlaggedAt: now },
        });
        contracts += 1;
      }
    }
  });

  return { raised: leads.length, contracts };
}

/**
 * §16: "PM contracts auto-generate `after_sales` tickets N days ahead of schedule."
 *
 * The ticket is `after_sales` / `preventive`, which is what §3's subtype list already calls this
 * work — so a PM visit lands in the same queue, with the same gates, as every other job. Inventing a
 * separate lane for contract work would mean §8's mobilisation checks apply to some site visits and
 * not others.
 */
export async function sweepPmTicketsService(now: Date = new Date()) {
  const contracts = await db.maintenanceContract.findMany({
    where: { deletedAt: null, status: "active" },
    select: {
      id: true,
      number: true,
      accountId: true,
      siteId: true,
      startDate: true,
      endDate: true,
      visitsPerYear: true,
      equipmentIds: true,
    },
  });

  let raised = 0;

  for (const contract of contracts) {
    const planned = plannedVisitDates(contract);

    // What already exists, so a visit is not raised twice. Matched on the date the ticket is due
    // rather than on a marker, because the date is the fact both sides agree on.
    const existing = await db.ticket.findMany({
      where: {
        deletedAt: null,
        accountId: contract.accountId,
        subType: "preventive",
        requiredByDate: { not: null },
      },
      select: { requiredByDate: true },
    });

    const due = visitsToRaise(
      planned,
      existing.flatMap((ticket) => (ticket.requiredByDate ? [ticket.requiredByDate] : [])),
      now,
    );

    for (const visitDate of due) {
      const ticket = await createStandaloneTicketService(
        { actorId: "system", actorLabel: `System (${contract.number})` },
        {
          accountId: contract.accountId,
          siteId: contract.siteId,
          type: "after_sales",
          subType: "preventive",
          title: `Preventive maintenance — ${contract.number}`,
          scopeOfWork:
            `Scheduled preventive maintenance visit under ${contract.number}, covering ` +
            `${contract.equipmentIds.length} item(s). Use the preventive maintenance checklist.`,
          justification: `Raised automatically ${PM_TICKET_LEAD_DAYS} days before the planned visit.`,
          requiredByDate: visitDate,
        },
      );

      await db.$transaction(async (tx) => {
        await emit(
          tx,
          "pm.due",
          {
            contractId: contract.id,
            contractNumber: contract.number,
            ticketId: ticket.id,
            accountId: contract.accountId,
            visitDate,
          },
          {},
        );
      });

      raised += 1;
    }
  }

  return { raised };
}

/** Re-exported so a caller does not have to reach into Prisma's namespace. */
export type { Prisma };
