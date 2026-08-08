import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import * as zxcvbnCommonPackage from "@zxcvbn-ts/language-common";
import * as zxcvbnEnPackage from "@zxcvbn-ts/language-en";

let zxcvbnInstance: ZxcvbnFactory | undefined;

function getZxcvbn(): ZxcvbnFactory {
  zxcvbnInstance ??= new ZxcvbnFactory({
    dictionary: {
      ...zxcvbnCommonPackage.dictionary,
      ...zxcvbnEnPackage.dictionary,
    },
    graphs: zxcvbnCommonPackage.adjacencyGraphs,
    translations: zxcvbnEnPackage.translations,
  });
  return zxcvbnInstance;
}

export const MIN_PASSWORD_LENGTH = 12;
export const MIN_ZXCVBN_SCORE = 3;

export interface PasswordCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * specs/00-foundation.md §4.1: "12 char minimum, breach-list check via zxcvbn score >= 3, no
 * forced rotation." `userInputs` should include things like the account's email/name so zxcvbn
 * penalizes passwords built from them.
 */
export function checkPasswordPolicy(
  password: string,
  userInputs: readonly string[] = [],
): PasswordCheckResult {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }

  const result = getZxcvbn().check(password, [...userInputs]);
  if (result.score < MIN_ZXCVBN_SCORE) {
    const feedback = result.feedback.warning || "Password is too easy to guess.";
    return { ok: false, reason: feedback };
  }

  return { ok: true };
}
