# Confirmed Decisions

Answers given by AIES on 08 Aug 2026. These are **decisions, not defaults** — Claude Code must
implement them as written and must not "helpfully" revert to a more generic pattern.

| # | Question | Confirmed answer |
|---|---|---|
| 1 | Accounting package | **None.** Platform is the operational system of record; exports to the accountant. |
| 2 | VAT / documents | **VAT-registered.** Service Invoice issued **upon payment** — on DP, progress bill, or final. Some customers withhold EWT and issue 2307; some don't. Per-account flag. |
| 3 | Saleable inventory | None. Drop-ship per PO, project-allocated. Consumables/tools/instruments tracked by custody only. |
| 4 | Users | 5 named people (§ below). System must support adding personnel later. |
| 5 | ISO 8.3 design | Applies; light design-control records. |
| 6 | Warranty diamond | **Rectification** routing. Confirmed. |
| 7 | Cash advance requester | One person requests for the whole crew — assigned **team leader** or the **operations manager**. |
| 8 | Cash advance approver | **Vice President.** Released by bank transfer, or petty cash for small amounts. |
| 9 | Liquidation deadline | 3 working days, **extendable indefinitely with VP approval**. |
| 10 | Methodology approval | **Client approves first.** Always. Blocking. |
| 11 | QA approval | **The client inspects and approves.** Operations Manager records the outcome as a toggle and uploads the client's documentation as evidence. |
| 12 | Site inspection | Both pre-quotation (sales-requested) and post-PO (new project) are real. |
| 13 | Delivery | Own vehicle, **or courier for bulk / large items**. |
| 14 | After sales | Covers both scheduled PM contract visits and reactive calls. |
| 15 | Payment terms | **VP maintains them.** Seed the defaults for convenience. |
| 16 | Quotation approval | **VP approves all quotations.** No value threshold. |
| 17 | Margin floor | Configurable, no seeded value. |
| 18 | FX | USD/EUR, manual rate, configurable buffer. |
| 19 | Supplier RFQ | **Emailed manually by a person.** System holds a user-maintained supplier directory and records the RFQ and the response. No automated send. |
| 20 | Credit limit | Warn, don't block. |
| 21 | ISO status | **Not certified.** Aligning processes to be certification-ready. |
| 22 | Calibration | **Outsourced** to an ISO/IEC 17025 accredited laboratory (e.g. Philippine Geoanalytics Calibration and Measurement Laboratory Corporation). AIES does not operate its own accredited lab. |
| 23 | Retention | 10 years for accounting records. |
| 24 | Email ingest | **Removed from scope for now.** |
| 25 | Website form webhook | **Removed from scope for now.** |
| 26 | Access | **Local network AND open internet.** |
| 27 | Hosting | NAS RAM **not upgraded** (2 GB). → **Deploy to Vercel + Supabase via GitHub.** NAS becomes backup and archive. See `Spec.md` §7. |
| 28 | Technician devices | Mixed Android/iOS, personal, PWA. |
| 29 | AI extraction of RFQs | Off. Manual entry. |
| 30 | SMS notifications | **Removed from scope.** |
| 31 | Brand colours | **Confirmed from the supplied logo file.** Navy `#012076` / blue `#003999` / brand red `#EE010C` / orange accent `#FD5E13`. Full token set and contrast checks in `Spec.md` §6.2. Logo master at `brand/aies-logo-source.jpg`. |
| 32 | Company details | **Manual input** in system settings. Do not hard-code. |
| 33 | Data migration | Master data + open quotations + active projects only. |
| 34 | Rollout | Sales first, then operations, then finance. |

## The five users

| Initials | Role key | Responsibilities |
|---|---|---|
| EA | `president` | Sees and controls everything |
| KJ | `vice_president` | Quotations, pricing, expenses. **Approves all quotations, cash advances, and payment terms.** |
| PD | `admin_manager` | Customer accreditation, inquiring prices from principal suppliers, admin tasks, government requirements |
| DJ | `operations_manager` | Technical and operational activity: installation, commissioning, service. Records client QA outcomes. |
| EM | `marketing_manager` | Acquiring new products and principal suppliers, social media, customer relations |

Seed `technician`, `sales`, `finance_officer`, and `viewer` roles as well — unassigned, ready for
future hires. **Cost and margin visibility is restricted to `president` and `vice_president`.**

| 35 | Approval fallback | **EA (President) is the automatic fallback approver** for everything the VP approves. Automatic — no nomination step. `Spec.md` §4.4. |

## Still open

- **Registered company details** (legal name, address, TIN, landline) — entered manually at setup.
- **Calibration laboratory details** — name, accreditation number, scope, certificate expiry.
- **EWT rate per customer** where any customer deviates from 2%.
- **Petty cash fund size and custodian.**
