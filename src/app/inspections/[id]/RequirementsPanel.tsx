"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/layout";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { answerKey, type RequirementField } from "@/server/core/crm/requirements";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import type { InquiryDetail } from "@/app/crm/inquiries/[id]/types";

/**
 * §4's requirements capture and its completeness indicator — moved here from the inquiry page
 * (2026-09-02, the company's own instruction): *"before acknowledgement: remove the 'Requirements'
 * table and display it in the site inspection. this should be filled up during site inspection."*
 *
 * Still the inquiry's own data — `Inquiry.requirements`, saved through `crm.updateInquiry` exactly
 * as before, and still what `evaluating → quoting`'s completeness gate reads — only where it is
 * filled in changed. The surveyor is the one standing in front of the customer asking these
 * questions; the sales desk isn't.
 *
 * §4 states the purpose bluntly: "The single most valuable thing this module does is stop the 'what
 * exactly did they ask for?' round-trip that currently happens over chat." So the unanswered
 * required questions are listed by name rather than reduced to a count — a bar reading "6 of 9"
 * tells you that you are stuck without telling you what to go and ask.
 */
export function RequirementsPanel({ inquiry }: { inquiry: InquiryDetail }) {
  const utils = trpc.useUtils();
  const [answers, setAnswers] = useState<Record<string, unknown>>(
    (inquiry.requirements ?? {}) as Record<string, unknown>,
  );
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  useEffect(() => {
    setAnswers((inquiry.requirements ?? {}) as Record<string, unknown>);
  }, [inquiry.requirements]);

  const save = trpc.crm.updateInquiry.useMutation({
    onSuccess: () => void utils.crm.getInquiry.invalidate({ inquiryId: inquiry.id }),
  });
  const override = trpc.crm.overrideRequirements.useMutation({
    onSuccess: () => void utils.crm.getInquiry.invalidate({ inquiryId: inquiry.id }),
  });

  const { completeness, templates } = inquiry;

  if (templates.length === 0) {
    return (
      <Card className="p-4">
        <h2 className="text-sm font-semibold">Requirements</h2>
        <p className="mt-1 text-sm text-text-muted">
          No checklist applies yet. Give at least one line item a service type and its questions
          appear here.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Requirements</h2>
        {completeness.complete ? (
          <StatusBadge tone="approved">Complete</StatusBadge>
        ) : completeness.overrideReason ? (
          <StatusBadge tone="pending">Overridden</StatusBadge>
        ) : (
          <StatusBadge tone="pending">
            {completeness.requiredAnswered} of {completeness.requiredTotal} required answered
          </StatusBadge>
        )}
      </div>

      {!completeness.complete && !completeness.overrideReason && (
        <div className="mt-2 rounded border border-border bg-surface-2 p-2 text-xs">
          <p className="font-medium">Still needed before this can go to quotation:</p>
          <ul className="mt-1 list-inside list-disc">
            {completeness.missing.map((item) => (
              <li key={`${item.serviceType}.${item.key}`}>
                {item.label} <span className="text-text-muted">({item.serviceType})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {completeness.overrideReason && (
        <p className="mt-2 rounded border border-border bg-surface-2 p-2 text-xs">
          <span className="font-medium">Checklist overridden:</span> {completeness.overrideReason}
        </p>
      )}

      <div className="mt-3 space-y-4">
        {templates.map((template) => (
          <fieldset key={template.serviceType} className="space-y-2">
            <legend className="text-xs font-medium text-text-muted uppercase">
              {template.label}
            </legend>
            {template.fields
              .filter((field) => {
                /*
                  A follow-up question appears when it is reached, and not before.

                  "Specify what is being supplied" is only a question once somebody has chosen
                  "Others" from the category list. Rendering it always would put an empty box under
                  every enquiry, and an empty box beside a filled-in dropdown reads as something the
                  engineer forgot rather than something that does not apply.

                  The same rule scores the gate — see `askWhen` in requirements.ts — so a hidden
                  question can never appear in the missing list.
                */
                if (!field.askWhen) return true;
                const trigger = answers[answerKey(template.serviceType, field.askWhen.key)];
                return String(trigger ?? "") === field.askWhen.equals;
              })
              .map((field) => (
                <FieldInput
                  key={field.key}
                  serviceType={template.serviceType}
                  field={field}
                  value={answers[answerKey(template.serviceType, field.key)]}
                  onChange={(value) =>
                    setAnswers((current) => ({
                      ...current,
                      [answerKey(template.serviceType, field.key)]: value,
                    }))
                  }
                />
              ))}
          </fieldset>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={save.isPending}
          onClick={async () => {
            try {
              await save.mutateAsync({ inquiryId: inquiry.id, requirements: answers });
              toastSuccess("Requirements saved.");
            } catch (error) {
              toastError(error);
            }
          }}
        >
          {save.isPending ? "Saving…" : "Save answers"}
        </Button>
        {!completeness.complete && !completeness.overrideReason && (
          <Button variant="ghost" size="sm" onClick={() => setOverrideOpen((v) => !v)}>
            Override the checklist
          </Button>
        )}
      </div>

      {overrideOpen && (
        <div className="mt-3 rounded border border-border p-3">
          <Label htmlFor="override-reason">
            Why is this being quoted with questions unanswered?
          </Label>
          <Textarea
            id="override-reason"
            rows={2}
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
            placeholder="Recorded against your name on the inquiry and in the audit log."
          />
          <Button
            size="sm"
            className="mt-2"
            disabled={override.isPending || overrideReason.trim().length < 10}
            onClick={async () => {
              try {
                await override.mutateAsync({ inquiryId: inquiry.id, reason: overrideReason });
                toastSuccess("Override recorded.");
                setOverrideOpen(false);
                setOverrideReason("");
              } catch (error) {
                toastError(error);
              }
            }}
          >
            Record override
          </Button>
        </div>
      )}
    </Card>
  );
}

function FieldInput({
  serviceType,
  field,
  value,
  onChange,
}: {
  serviceType: string;
  field: RequirementField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = `req-${serviceType}-${field.key}`;
  const label = (
    <Label htmlFor={id}>
      {field.label}
      {field.required && <span className="text-danger"> *</span>}
    </Label>
  );

  return (
    <div>
      {label}
      {field.type === "select" ? (
        <Select id={id} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          <option value="">Not answered</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      ) : field.type === "boolean" ? (
        <Select
          id={id}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "true")}
        >
          <option value="">Not answered</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </Select>
      ) : (
        <Input
          id={id}
          type={field.type === "number" ? "number" : "text"}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.help && <p className="mt-0.5 text-xs text-text-muted">{field.help}</p>}
    </div>
  );
}
