import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Which tRPC procedures nothing on a screen ever calls.
 *
 * ## Why this exists
 *
 * Four times in one module the platform has shipped a service that was written, tested, correct and
 * **unreachable** — §11's warranty cost, §6's cost rates and expenses, §7's bill recording, and then
 * the whole of §3: raising a statement, issuing it, recording a payment, clearing a cheque. Every one
 * was found by a person trying to do the thing and discovering there was no button.
 * docs/DECISIONS.md #128, #131, #133, #135.
 *
 * ## Why a report rather than a test
 *
 * #133 considered a guard that failed the build on an unreached mutation and rejected it: a procedure
 * with no caller is a **legitimate** state halfway through a session, and a check that fires
 * constantly during normal work is one people learn to skip. That reasoning still holds.
 *
 * A report is different. It makes no judgement and blocks nothing — it answers a question, and the
 * question is the one that has had to be asked by hand four times: *who calls this, and from where?*
 * Run it at a module's review gate, before claiming anything is finished.
 *
 * ## What it cannot tell you
 *
 * That a **reachable** procedure is reachable by the right person, or that the screen calling it is
 * any good. A caller is the floor, not the ceiling. It also matches on text, so a procedure invoked
 * through a computed name would read as unreached — none are today, and if that changes this will
 * over-report rather than under-report, which is the safe direction.
 *
 *   npx tsx scripts/unreached-mutations.ts
 *   npx tsx scripts/unreached-mutations.ts --router finance
 */

const ROUTER_DIR = "src/server/api/routers";
const UI_DIRS = ["src/app", "src/components"];

/** Every .ts/.tsx file under a directory, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path));
    } else if (path.endsWith(".ts") || path.endsWith(".tsx")) {
      out.push(path);
    }
  }
  return out;
}

function main() {
  const only = process.argv.includes("--router")
    ? process.argv[process.argv.indexOf("--router") + 1]
    : null;

  const uiSource = UI_DIRS.flatMap((dir) => walk(dir))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");

  let unreached = 0;
  let total = 0;

  for (const file of readdirSync(ROUTER_DIR).filter((name) => name.endsWith(".ts"))) {
    const router = file.replace(/\.ts$/, "");
    if (only && router !== only) continue;

    const source = readFileSync(join(ROUTER_DIR, file), "utf8");
    /*
      Procedure names, from their declaration at one level of indentation inside the router object.

      Deliberately crude. A parser would be more precise and would also be a thing to maintain; this
      has to be trustworthy at a glance, because its whole value is that somebody believes it at a
      review gate.
    */
    const names = [...source.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9_]*):\s*p\(/gm)].map((m) => m[1]!);
    if (names.length === 0) continue;

    const missing = names.filter((name) => !uiSource.includes(`${router}.${name}.`));
    total += names.length;
    unreached += missing.length;

    if (missing.length > 0) {
      console.log(`\n${router} — ${missing.length} of ${names.length} unreached`);
      for (const name of missing) console.log(`  ${router}.${name}`);
    }
  }

  console.log("");
  if (unreached === 0) {
    console.log(`Every one of the ${total} procedures checked is called from a screen.`);
  } else {
    console.log(
      `${unreached} of ${total} procedures are not called from any screen.\n` +
        `Some of those are legitimate — a cron handler, something half-built, a procedure another\n` +
        `service calls. The question to ask of each is: who is supposed to do this, and where would\n` +
        `they go?`,
    );
  }
}

main();
