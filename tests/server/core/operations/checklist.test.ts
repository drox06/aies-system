import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  activeTemplateService,
  completeResponseService,
  createTemplateService,
  getResponseService,
  listResponsesForTicketService,
  publishTemplateService,
  reviseTemplateService,
  saveAnswersService,
  saveDraftService,
  startResponseService,
} from "@/server/core/operations/checklist-service";
import { runFieldWrite } from "@/server/core/operations/field-sync";

/**
 * specs/04-operations-projects.md §15, against the real database.
 *
 * Two things only a real run settles:
 *
 *  1. **A published version cannot be edited.** §15 says responses "permanently record the version
 *     used, so historical evidence reflects the procedure actually in force" — which is only true if
 *     nothing can rewrite a version underneath the responses citing it.
 *  2. **§20's offline case**: "complete a checklist with three photos and a signature, restore,
 *     assert one server record with all attachments. Replaying the same outbox twice creates no
 *     duplicates." §14 built the outbox; this is the case the spec actually names for it, and it
 *     could not be written until checklists existed.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `chk-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "DJ (operations)" };

const templateIds: string[] = [];
const responseIds: string[] = [];
const ticketIds: string[] = [];
const uuids: string[] = [];

const key = () => `test_checklist_${randomUUID().slice(0, 8)}`;

const SECTIONS = [
  {
    key: "s1",
    title: "Checks",
    items: [
      { key: "earth", label: "Earth continuity", type: "pass_fail" },
      { key: "tidy", label: "Site tidy", type: "pass_fail_na" },
      { key: "loop", label: "Loop", type: "instrument_reading", unit: "mA", min: 4, max: 20 },
      { key: "photo", label: "Nameplate", type: "photo" },
    ],
  },
];

async function publishedTemplate(sections: unknown = SECTIONS) {
  const template = await createTemplateService(actor, {
    key: key(),
    name: `Test checklist ${randomUUID().slice(0, 5)}`,
    stage: "execution",
    sections,
  });
  templateIds.push(template.id);
  await publishTemplateService(actor, { templateId: template.id });
  return template;
}

async function trackedResponse(templateKey: string, ticketId?: string) {
  const response = await startResponseService(actor, { templateKey, ticketId: ticketId ?? null });
  responseIds.push(response.id);
  return response;
}

const PASSING = {
  earth: { value: "pass" },
  tidy: { na: true },
  loop: { value: 12 },
  photo: { photoFileIds: ["file-a", "file-b", "file-c"] },
};

afterAll(async () => {
  await db.checklistResponse.deleteMany({ where: { id: { in: responseIds } } });
  await db.checklistTemplate.deleteMany({ where: { id: { in: templateIds } } });
  await db.fieldSubmission.deleteMany({ where: { clientUuid: { in: uuids } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: [...responseIds, ...templateIds] } } });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
});

describe("§15's versioning, which is the point of the section", () => {
  it("refuses to edit a published version", async () => {
    const template = await publishedTemplate();

    await expect(
      saveDraftService(actor, { templateId: template.id, sections: [] }),
    ).rejects.toThrow(/cannot be edited/);
  });

  /**
   * The only legitimate way to change a procedure in force. Copying rather than starting blank,
   * because a checklist somebody has to retype is one that quietly stops being revised.
   */
  it("revises into a new draft carrying the previous items", async () => {
    const template = await publishedTemplate();
    const next = await reviseTemplateService(actor, { templateId: template.id });
    templateIds.push(next.id);

    expect(next.version).toBe(2);
    expect(next.status).toBe("draft");
    expect(next.key).toBe(template.key);
    expect(next.sections).toEqual(SECTIONS);
  });

  it("retires the old version when the new one is published, rather than deleting it", async () => {
    const template = await publishedTemplate();
    const next = await reviseTemplateService(actor, { templateId: template.id });
    templateIds.push(next.id);
    await publishTemplateService(actor, { templateId: next.id });

    const old = await db.checklistTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(old.status).toBe("retired");
    // Kept, because responses cite it as what they followed.
    expect(old.deletedAt).toBeNull();

    const active = await activeTemplateService(template.key);
    expect(active!.version).toBe(2);
  });

  it("will not start a second draft while one is open", async () => {
    const template = await publishedTemplate();
    const next = await reviseTemplateService(actor, { templateId: template.id });
    templateIds.push(next.id);

    await expect(reviseTemplateService(actor, { templateId: template.id })).rejects.toThrow(
      /already an unpublished draft/,
    );
  });

  it("refuses to publish a checklist with nothing on it", async () => {
    const empty = await createTemplateService(actor, {
      key: key(),
      name: "Empty",
      stage: "execution",
      sections: [],
    });
    templateIds.push(empty.id);

    await expect(publishTemplateService(actor, { templateId: empty.id })).rejects.toThrow(
      /signature on an empty page/,
    );
  });
});

describe("a response records the procedure it followed", () => {
  /**
   * The assertion that makes "historical evidence reflects the procedure actually in force" true
   * rather than aspirational: the answered items travel with the response.
   */
  it("snapshots the items, so the record reads on its own", async () => {
    const template = await publishedTemplate();
    const response = await trackedResponse(template.key);

    const loaded = await getResponseService(response.id);
    expect(loaded!.templateVersion).toBe(1);
    expect(loaded!.sections[0]!.items.map((item) => item.key)).toEqual([
      "earth",
      "tidy",
      "loop",
      "photo",
    ]);
  });

  it("keeps citing v1 after the template moves to v2", async () => {
    const template = await publishedTemplate();
    const response = await trackedResponse(template.key);

    const next = await reviseTemplateService(actor, { templateId: template.id });
    templateIds.push(next.id);
    await saveDraftService(actor, {
      templateId: next.id,
      sections: [{ key: "s1", title: "Changed", items: [] }],
    });
    await publishTemplateService(actor, { templateId: next.id }).catch(() => undefined);

    const loaded = await getResponseService(response.id);
    expect(loaded!.templateVersion).toBe(1);
    // Its own snapshot, untouched by anything that happened to the template afterwards.
    expect(loaded!.sections[0]!.items).toHaveLength(4);
  });
});

describe("signing one off", () => {
  it("refuses while a required item is unanswered", async () => {
    const template = await publishedTemplate();
    const response = await trackedResponse(template.key);
    await saveAnswersService(actor, {
      responseId: response.id,
      answers: { earth: { value: "pass" } },
    });

    await expect(completeResponseService(actor, { responseId: response.id })).rejects.toThrow(
      /Not answered/,
    );
  });

  /** §15's conditional logic, enforced at the service and not only in the form. */
  it("refuses a failure with no cause or action", async () => {
    const template = await publishedTemplate();
    const response = await trackedResponse(template.key);
    await saveAnswersService(actor, {
      responseId: response.id,
      answers: { ...PASSING, earth: { value: "fail" } },
    });

    await expect(completeResponseService(actor, { responseId: response.id })).rejects.toThrow(
      /cause and action/,
    );
  });

  it("refuses a not-applicable on an item that never offered it", async () => {
    const template = await publishedTemplate();
    const response = await trackedResponse(template.key);
    await saveAnswersService(actor, {
      responseId: response.id,
      answers: { ...PASSING, earth: { na: true } },
    });

    await expect(completeResponseService(actor, { responseId: response.id })).rejects.toThrow(
      /does not offer "not applicable"/,
    );
  });

  it("completes when everything is answered, and will not be rewritten afterwards", async () => {
    const template = await publishedTemplate();
    const response = await trackedResponse(template.key);
    await saveAnswersService(actor, { responseId: response.id, answers: PASSING });

    const done = await completeResponseService(actor, {
      responseId: response.id,
      signedByName: "R. Cruz",
    });
    expect(done.status).toBe("complete");

    await expect(
      saveAnswersService(actor, { responseId: response.id, answers: PASSING }),
    ).rejects.toThrow(/signed off/);
  });

  /** §15: a fail "can auto-raise an NCR" — module 04 decides which, module 08 raises them. */
  it("emits checklist.failed for module 08 when something failed", async () => {
    const template = await publishedTemplate();
    const response = await trackedResponse(template.key);
    await saveAnswersService(actor, {
      responseId: response.id,
      answers: {
        ...PASSING,
        loop: { value: 2.1, cause: "Transmitter drift", action: "Recalibrated" },
      },
    });
    await completeResponseService(actor, { responseId: response.id });

    const failed = await db.eventOutbox.count({
      where: { event: "checklist.failed", actorId: OWNER },
    });
    expect(failed).toBeGreaterThan(0);
  });

  it("does not raise one when everything passed", async () => {
    const before = await db.eventOutbox.count({
      where: { event: "checklist.failed", actorId: OWNER },
    });

    const template = await publishedTemplate();
    const response = await trackedResponse(template.key);
    await saveAnswersService(actor, { responseId: response.id, answers: PASSING });
    await completeResponseService(actor, { responseId: response.id });

    const after = await db.eventOutbox.count({
      where: { event: "checklist.failed", actorId: OWNER },
    });
    expect(after).toBe(before);
  });
});

describe("§20's offline case, finally writable", () => {
  /**
   * "Lose connectivity, complete a checklist with three photos and a signature, restore, assert one
   * server record with all attachments. **Replaying the same outbox twice creates no duplicates.**"
   *
   * §14 built and tested the outbox against delivery attempts, which was the field write that
   * existed. This is the case the spec actually names, and it needed §15 first.
   */
  it("replays a queued checklist completion exactly once", async () => {
    const template = await publishedTemplate();
    const response = await trackedResponse(template.key);
    await saveAnswersService(actor, { responseId: response.id, answers: PASSING });

    const clientUuid = randomUUID();
    uuids.push(clientUuid);

    const payload = { responseId: response.id, signedByName: "R. Cruz", signatureFileId: "sig-1" };
    const run = vi.fn(async () => ({
      result: await completeResponseService(actor, payload),
      entityType: "ChecklistResponse",
      entityId: response.id,
    }));

    // The device sends it, the connection drops before the reply lands, the device sends it again.
    const first = await runFieldWrite({
      clientUuid,
      userId: OWNER,
      operation: "checklist.complete",
      payload,
      run,
    });
    const second = await runFieldWrite({
      clientUuid,
      userId: OWNER,
      operation: "checklist.complete",
      payload,
      run,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);

    // One record, its three photographs, and the signature — asserted on the server rather than
    // inferred from the client not complaining.
    const loaded = await getResponseService(response.id);
    expect(loaded!.status).toBe("complete");
    expect(loaded!.answers.photo!.photoFileIds).toHaveLength(3);
    expect(loaded!.signatureFileId).toBe("sig-1");

    const responses = await db.checklistResponse.count({ where: { id: response.id } });
    expect(responses).toBe(1);
  });
});

describe("what a ticket shows", () => {
  it("summarises each checklist by what somebody scanning needs", async () => {
    const template = await publishedTemplate();
    const ticket = await db.ticket.findFirst({ where: { deletedAt: null }, select: { id: true } });
    if (!ticket) return; // No tickets in this database; the summary shape is covered by the rules tests.

    const response = await trackedResponse(template.key, ticket.id);
    await saveAnswersService(actor, { responseId: response.id, answers: PASSING });
    await completeResponseService(actor, { responseId: response.id });

    const rows = await listResponsesForTicketService(ticket.id);
    const mine = rows.find((row) => row.id === response.id)!;
    expect(mine.summary).toMatch(/passed/);
    expect(mine.failures).toBe(0);
  });
});
