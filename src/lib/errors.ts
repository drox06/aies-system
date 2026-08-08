import { TRPCClientError } from "@trpc/client";
import { toast } from "sonner";

/**
 * specs/00-foundation.md §8: "typed tRPC errors → toast; unexpected errors → error boundary with a
 * request ID the user can quote to an admin."
 *
 * Everything a mutation can reject with lands here so the wording is decided once. Expected
 * refusals get a plain sentence; genuinely unexpected failures also get the request id, because
 * that is the only thing that makes a user's report actionable.
 */

/** Wording for the refusals the server raises deliberately. Anything not listed is treated as a
 *  bug rather than paraphrased into something reassuring. */
const MESSAGES: Record<string, string> = {
  UNAUTHORIZED: "Your session has expired. Please sign in again.",
  FORBIDDEN: "You do not have permission to do that.",
  TOO_MANY_REQUESTS: "Too many requests. Please wait a moment and try again.",
  NOT_FOUND: "That record no longer exists.",
  CONFLICT: "Someone else changed this record. Reload and try again.",
  TIMEOUT: "That took too long. Please try again.",
};

export interface ParsedError {
  message: string;
  requestId: string | null;
  /** True when this was not a deliberate refusal — the caller may want to escalate the display. */
  unexpected: boolean;
}

export function parseError(error: unknown): ParsedError {
  if (error instanceof TRPCClientError) {
    const data = error.data as { code?: string; requestId?: string | null } | undefined;
    const code = data?.code;
    const requestId = data?.requestId ?? null;

    if (code === "BAD_REQUEST") {
      // Zod/validation messages are written for this specific field and are more useful than
      // anything generic could be.
      return { message: error.message, requestId, unexpected: false };
    }
    if (code && code in MESSAGES) {
      return { message: MESSAGES[code]!, requestId, unexpected: false };
    }
    // A service-layer `throw new Error("Only the author can edit this comment.")` surfaces here.
    // Those are written for the user, so they are shown as-is.
    return {
      message: error.message || "Something went wrong.",
      requestId,
      unexpected: code === "INTERNAL_SERVER_ERROR",
    };
  }

  if (error instanceof Error) {
    return { message: error.message || "Something went wrong.", requestId: null, unexpected: true };
  }
  return { message: "Something went wrong.", requestId: null, unexpected: true };
}

/** Drop-in `onError` for a tRPC mutation. */
export function toastError(error: unknown): void {
  const { message, requestId, unexpected } = parseError(error);
  toast.error(message, {
    description: unexpected && requestId ? `Reference: ${shortRequestId(requestId)}` : undefined,
    duration: unexpected ? 10_000 : 5_000,
  });
}

export function toastSuccess(message: string): void {
  toast.success(message);
}

/** A full uuid is not something anyone will read aloud accurately. The first block is enough to
 *  find the line in a log and short enough to quote over the phone. */
export function shortRequestId(requestId: string): string {
  return requestId.split("-")[0]?.toUpperCase() ?? requestId;
}
