import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PARTS } from "./walkthrough-content";

/**
 * The same walkthrough as a page, for reading on a phone while operating the platform.
 *
 * The PDF is for a desk and a printer. This is for somebody standing up with one hand on the
 * screen — which is a different document with the same words, so both are generated from
 * `walkthrough-content.ts` rather than written twice.
 */

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const totalSteps = PARTS.reduce((sum, part) => sum + part.steps.length, 0);

const html = `<title>Inquiry to Payment</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    --ink: #0f1b2a;
    --muted: #5a6b7d;
    --heading: #012076;
    --link: #003999;
    --rule: #ee010c;
    --ground: #f6f8fb;
    --surface: #ffffff;
    --surface-2: #eef2f7;
    --border: #dce3eb;
    --chip: #012076;
    --chip-ink: #ffffff;
  }

  /* System setting: only prefers-color-scheme separates the two, and an explicit light choice wins. */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ink: #e6ecf5;
      --muted: #93a3b8;
      --heading: #a8bcff;
      --link: #8fa8ff;
      --rule: #ff5a62;
      --ground: #0b1220;
      --surface: #121c2e;
      --surface-2: #18253b;
      --border: #24334a;
      --chip: #2a3d63;
      --chip-ink: #e6ecf5;
    }
  }

  :root[data-theme="dark"] {
    --ink: #e6ecf5;
    --muted: #93a3b8;
    --heading: #a8bcff;
    --link: #8fa8ff;
    --rule: #ff5a62;
    --ground: #0b1220;
    --surface: #121c2e;
    --surface-2: #18253b;
    --border: #24334a;
    --chip: #2a3d63;
    --chip-ink: #e6ecf5;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 15px;
    line-height: 1.55;
    -webkit-text-size-adjust: 100%;
  }

  .wrap { max-width: 40rem; margin: 0 auto; padding: 0 1rem 4rem; }

  header.top {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--ground);
    border-bottom: 1px solid var(--border);
    padding: 0.75rem 0 0.5rem;
  }
  header.top h1 {
    margin: 0;
    font-size: 1.05rem;
    letter-spacing: -0.01em;
    color: var(--heading);
    text-wrap: balance;
  }
  header.top p { margin: 0.15rem 0 0.5rem; font-size: 0.8rem; color: var(--muted); }

  /* The part index scrolls sideways on a phone rather than wrapping into five lines. */
  nav.parts { display: flex; gap: 0.4rem; overflow-x: auto; padding-bottom: 0.15rem; }
  nav.parts::-webkit-scrollbar { display: none; }
  nav.parts a {
    flex: 0 0 auto;
    font-size: 0.75rem;
    text-decoration: none;
    color: var(--link);
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: 999px;
    padding: 0.2rem 0.6rem;
    white-space: nowrap;
  }

  section.intro { margin-top: 1rem; }
  section.intro h2 { font-size: 0.95rem; color: var(--heading); margin: 1rem 0 0.25rem; }
  section.intro p { margin: 0.25rem 0; font-size: 0.9rem; }

  h2.part {
    margin: 2rem 0 0;
    font-size: 1rem;
    color: var(--heading);
    letter-spacing: -0.01em;
    scroll-margin-top: 5.5rem;
    text-wrap: balance;
  }
  .part-rule { height: 2px; background: var(--rule); margin: 0.4rem 0 0.5rem; }
  p.part-intro { margin: 0 0 1rem; font-size: 0.85rem; color: var(--muted); }

  article.step {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.6rem;
    padding: 0.85rem 0.9rem;
    margin-bottom: 0.75rem;
  }
  .step-head { display: flex; gap: 0.6rem; align-items: baseline; }
  .n {
    flex: 0 0 auto;
    background: var(--chip);
    color: var(--chip-ink);
    border-radius: 0.35rem;
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
    padding: 0.1rem 0.4rem;
    font-weight: 600;
  }
  .what { font-weight: 600; font-size: 0.95rem; }
  .who { margin: 0.3rem 0 0; font-size: 0.78rem; color: var(--muted); }

  .where {
    margin: 0.6rem 0 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem;
    background: var(--surface-2);
    border-left: 2px solid var(--link);
    border-radius: 0 0.3rem 0.3rem 0;
    padding: 0.35rem 0.5rem;
    overflow-wrap: anywhere;
  }

  h3 {
    margin: 0.75rem 0 0.2rem;
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  ul { margin: 0; padding-left: 1.1rem; }
  li { margin: 0.15rem 0; font-size: 0.88rem; }

  .expect { background: var(--surface-2); border-radius: 0.4rem; padding: 0.5rem 0.6rem; margin-top: 0.3rem; }
  .expect h3 { margin-top: 0; }

  .note {
    margin-top: 0.7rem;
    font-size: 0.82rem;
    border-left: 2px solid var(--rule);
    padding: 0.3rem 0 0.3rem 0.6rem;
    color: var(--muted);
  }

  footer { margin-top: 2.5rem; font-size: 0.78rem; color: var(--muted); }
</style>

<div class="wrap">
  <header class="top">
    <h1>From an enquiry to the money in the bank</h1>
    <p>${totalSteps} steps · AIES Operations Platform</p>
    <nav class="parts">
      ${PARTS.map(
        (part, index) =>
          `<a href="#${slug(part.title)}">${escape(part.title.replace(/^Part \d+ — /, `${index + 1}. `))}</a>`,
      ).join("\n      ")}
    </nav>
  </header>

  <section class="intro">
    <h2>Before you start</h2>
    <p>
      The platform is at <a href="https://aies-system.vercel.app">aies-system.vercel.app</a>. Sign in
      with your own account. The walkthrough moves between four people on purpose, because the gates
      are the point and a gate you can walk through yourself is not a gate.
    </p>
    <p>
      First sign-in on an account that has not been used asks you to change the password, then to set
      up an authenticator app. Neither can be skipped. <strong>Keep the recovery codes you are
      shown</strong> — there is no administrator who can reset an authenticator for you, and that is
      deliberate.
    </p>

    <h2>How to read a step</h2>
    <p>
      Each step names who does it, where to go, what to do there, and what should happen. If what
      happens is not what the step says, stop and note the step number and what you saw. That is the
      finding — not a fault to work around.
    </p>

    <h2>A note on refusals</h2>
    <p>
      Several steps will refuse. A quotation with no cost will not be submitted; a job with no client
      approval will not mobilise; a final statement will not be raised for work that is unfinished.
      Every refusal names what is missing and whose it is. Those are the controls the platform was
      built for — the walkthrough is as much about checking they hold as it is about the happy path.
    </p>
  </section>

  ${PARTS.map(
    (part) => `
  <h2 class="part" id="${slug(part.title)}">${escape(part.title)}</h2>
  <div class="part-rule"></div>
  <p class="part-intro">${escape(part.intro)}</p>
  ${part.steps
    .map(
      (step) => `
  <article class="step">
    <div class="step-head">
      <span class="n">${step.n}</span>
      <span class="what">${escape(step.what)}</span>
    </div>
    <p class="who">${escape(step.who)}</p>
    <p class="where">${escape(step.where)}</p>
    <h3>What to do</h3>
    <ul>${step.doThis.map((line) => `<li>${escape(line)}</li>`).join("")}</ul>
    <div class="expect">
      <h3>What should happen</h3>
      <ul>${step.expect.map((line) => `<li>${escape(line)}</li>`).join("")}</ul>
    </div>
    ${step.note ? `<p class="note">${escape(step.note)}</p>` : ""}
  </article>`,
    )
    .join("")}`,
  ).join("\n")}

  <footer>
    Generated ${new Date().toISOString().slice(0, 10)} from the platform&rsquo;s own navigation and
    document numbering. The same content is in the printable PDF.
  </footer>
</div>
`;

const out = "docs/walkthrough-end-to-end.html";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html, "utf8");
console.log(`Wrote ${out} — ${PARTS.length} parts, ${totalSteps} steps, ${html.length} bytes.`);
