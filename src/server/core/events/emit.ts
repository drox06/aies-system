import type { Prisma } from "@prisma/client";

export interface EmitMeta {
  actorId?: string | null;
  requestId?: string | null;
}

// specs/00-foundation.md §6: "Event names are snake_case, entity.verb_past_tense."
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export function isValidEventName(event: string): boolean {
  return EVENT_NAME_PATTERN.test(event);
}

/**
 * Transactional outbox write (Spec.md §6) — must run in the same `tx` as the business change it
 * accompanies, or the outbox guarantee (never lost, never double-emitted) doesn't hold. Event
 * *ownership* collisions (two modules claiming the same event) are validated statically at boot
 * by src/server/core/module-registry.ts against each module's declared `emits[]`; this only
 * checks the naming convention, not which module is allowed to send it.
 */
export async function emit(
  tx: Prisma.TransactionClient,
  event: string,
  payload: unknown,
  meta: EmitMeta = {},
): Promise<void> {
  if (!isValidEventName(event)) {
    throw new Error(
      `Event name "${event}" doesn't match the snake_case "entity.verb_past_tense" convention.`,
    );
  }

  await tx.eventOutbox.create({
    data: {
      event,
      payload: payload as Prisma.InputJsonValue,
      actorId: meta.actorId ?? null,
      requestId: meta.requestId ?? null,
    },
  });
}
