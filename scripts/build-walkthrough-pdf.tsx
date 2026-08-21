/*
  React in scope explicitly — see src/server/core/finance/pdf/render.tsx for why. This file is run
  directly by tsx, outside Next's compiler, and would otherwise fail with "React is not defined" at
  render time rather than at compile time.
*/
import React from "react";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Document, Page, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { PDF_COLORS, pdfStyles } from "../src/server/core/quotation/pdf/theme";
import { getCompanyDetails } from "../src/server/core/company";
import { PARTS, type Step } from "./walkthrough-content";

const COMPANY = getCompanyDetails();

/**
 * The end-to-end walkthrough, as a printable document.
 *
 * ## Why this is generated rather than written by hand
 *
 * Every route and screen name in it comes from the same manifests the sidebar is built from, so a
 * screen that gets renamed or moved makes this document wrong in a way somebody will notice the next
 * time they run it — rather than a Word file that quietly rots in a shared folder.
 *
 * ## Who it is for
 *
 * Somebody sitting in front of the platform with a job to walk through, one screen at a time. Each
 * step says **who** does it, **where** to go, **what to do**, and **what should happen** — because a
 * step that says only "approve the quotation" is the kind of instruction that reads fine and cannot
 * be followed.
 */

function StepBlock({ step }: { step: Step }) {
  return (
    <View
      wrap={false}
      style={{
        marginBottom: 12,
        paddingLeft: 10,
        borderLeftWidth: 2,
        borderLeftColor: PDF_COLORS.surface2,
      }}
    >
      <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 10, color: PDF_COLORS.navy800 }}>
        {step.n}. {step.what}
      </Text>
      <Text style={{ fontSize: 8, color: PDF_COLORS.textMuted, marginTop: 2 }}>{step.who}</Text>
      <Text style={{ fontSize: 8.5, marginTop: 4 }}>
        <Text style={{ fontFamily: "Helvetica-Bold" }}>Where: </Text>
        {step.where}
      </Text>

      <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 8.5, marginTop: 5 }}>What to do</Text>
      {step.doThis.map((line, index) => (
        <Text key={index} style={{ fontSize: 8.5, marginLeft: 8 }}>
          • {line}
        </Text>
      ))}

      <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 8.5, marginTop: 5 }}>
        What should happen
      </Text>
      {step.expect.map((line, index) => (
        <Text key={index} style={{ fontSize: 8.5, marginLeft: 8 }}>
          • {line}
        </Text>
      ))}

      {step.note && (
        <Text
          style={{
            fontSize: 8,
            marginTop: 5,
            padding: 5,
            backgroundColor: PDF_COLORS.surface2,
            color: PDF_COLORS.text,
          }}
        >
          {step.note}
        </Text>
      )}
    </View>
  );
}

function WalkthroughDocument() {
  return (
    <Document title="AIES Operations Platform — end-to-end walkthrough">
      <Page size="A4" style={pdfStyles.page}>
        <View style={pdfStyles.headerRow}>
          <View>
            <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 18, color: PDF_COLORS.navy800 }}>
              End-to-end walkthrough
            </Text>
            <Text style={{ fontSize: 10, color: PDF_COLORS.textMuted, marginTop: 2 }}>
              From an enquiry arriving to the money in the bank
            </Text>
          </View>
          <View style={pdfStyles.companyBlock}>
            <Text style={pdfStyles.companyName}>{COMPANY.name}</Text>
            {COMPANY.addressLines.map((line) => (
              <Text key={line}>{line}</Text>
            ))}
          </View>
        </View>
        <View style={pdfStyles.headerRule} />

        <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 11, color: PDF_COLORS.navy800 }}>
          Before you start
        </Text>
        <Text style={{ fontSize: 9, marginTop: 4 }}>
          The platform is at aies-system.vercel.app. Sign in with your own account — the walkthrough
          moves between four people on purpose, because the gates are the point and a gate you can
          walk through yourself is not a gate.
        </Text>
        <Text style={{ fontSize: 9, marginTop: 6 }}>
          First sign-in for an account that has not been used: you will be asked to change the
          password, and then to set up an authenticator app. Both are required and neither can be
          skipped. Keep the recovery codes you are shown — there is no administrator who can reset
          an authenticator for you, and that is deliberate.
        </Text>

        <Text
          style={{
            fontFamily: "Helvetica-Bold",
            fontSize: 11,
            color: PDF_COLORS.navy800,
            marginTop: 12,
          }}
        >
          How to read a step
        </Text>
        <Text style={{ fontSize: 9, marginTop: 4 }}>
          Each step names who does it, where to go, what to do there, and what should happen. If
          what happens is not what the step says, stop and write down which step and what you saw.
          That is the finding — not a fault to work around.
        </Text>

        <Text
          style={{
            fontFamily: "Helvetica-Bold",
            fontSize: 11,
            color: PDF_COLORS.navy800,
            marginTop: 12,
          }}
        >
          A note on refusals
        </Text>
        <Text style={{ fontSize: 9, marginTop: 4 }}>
          Several steps below will refuse to do what you ask. A quotation with no cost will not be
          submitted; a job with no client approval will not mobilise; a final statement will not be
          raised for work that is unfinished. Every refusal names what is missing and whose it is.
          Those are the controls the platform was built for — the walkthrough is as much about
          checking they hold as it is about the happy path.
        </Text>

        <Text style={{ fontSize: 8, color: PDF_COLORS.textMuted, marginTop: 16 }}>
          Generated {new Date().toISOString().slice(0, 10)} from the platform&rsquo;s own navigation
          and document numbering.
        </Text>
      </Page>

      {PARTS.map((part) => (
        <Page key={part.title} size="A4" style={pdfStyles.page}>
          <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 13, color: PDF_COLORS.navy800 }}>
            {part.title}
          </Text>
          <View
            style={{ height: 2, backgroundColor: PDF_COLORS.red500, marginTop: 6, marginBottom: 8 }}
          />
          <Text style={{ fontSize: 9, marginBottom: 10, color: PDF_COLORS.textMuted }}>
            {part.intro}
          </Text>

          {part.steps.map((step) => (
            <StepBlock key={step.n} step={step} />
          ))}

          <Text
            fixed
            style={{
              position: "absolute",
              bottom: 24,
              left: 40,
              right: 40,
              fontSize: 7.5,
              color: PDF_COLORS.textMuted,
              textAlign: "center",
            }}
            render={({ pageNumber, totalPages }) =>
              `AIES Operations Platform — end-to-end walkthrough · page ${pageNumber} of ${totalPages}`
            }
          />
        </Page>
      ))}
    </Document>
  );
}

async function main() {
  const out = "docs/WALKTHROUGH-END-TO-END.pdf";
  const buffer = await renderToBuffer(<WalkthroughDocument />);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buffer);
  const steps = PARTS.reduce((total, part) => total + part.steps.length, 0);
  console.log(`Wrote ${out} — ${PARTS.length} parts, ${steps} steps, ${buffer.length} bytes.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
