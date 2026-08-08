export type JobHandler = (
  payload: unknown,
  meta: { attempt: number; jobId: string },
) => Promise<void> | void;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(queue: string, handler: JobHandler): void {
  if (handlers.has(queue)) {
    throw new Error(`A handler is already registered for queue "${queue}".`);
  }
  handlers.set(queue, handler);
}

export function getJobHandler(queue: string): JobHandler | undefined {
  return handlers.get(queue);
}

/** Test-only: clears the registry between test files. */
export function __resetJobHandlersForTests(): void {
  handlers.clear();
}
