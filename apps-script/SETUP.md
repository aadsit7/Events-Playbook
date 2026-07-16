# Event Workspace — Setup & How It Works

## Event gate: mandatory event selection + per-event password

Opening the Event Workspace now starts at a **mandatory gate** — the workspace
itself stays hidden until an event has been opened through it:

1. **Select an event** from a dropdown, synced live from the **`Events`** tab
   of the `Partner_Portal_Database` sheet. **Completed events never appear**
   (any row whose `status` contains "complete" is filtered out server-side).
   The dropdown is grouped by **Happening now / Upcoming / Past / Cancelled**
   and password-protected events are marked with a 🔒.
2. **Enter the event's password** — the field only appears if the selected
   event's `password` cell in the sheet is non-empty. The check happens
   **server-side** in Apps Script; the password value is never sent to the
   browser.
3. **The page opens** showing only that event's details.

The gate cannot be dismissed until an event is opened — there is no
"Not now". After the first unlock, the header's **"Change event"** button
reopens the picker (with a Cancel option), and switching to another
password-protected event requires *that* event's password.

### Setting a password on an event

The `Events` tab has a **`password`** column (header already added, column O).
Type a password into that cell to protect the event; leave it blank for the
event to open without one. Matching is exact after trimming whitespace.

### The two actions behind the gate

- **`listEvents`** — returns only what the picker needs for **non-completed**
  rows: `key` (the `event_id`, or `row-N` for rows without one), `title`,
  `event_date`, `end_date`, `event_type`, `location`, `status`, and a
  `has_password` flag. Descriptions, lead counts, checklists and passwords are
  deliberately **not** in this payload.
- **`openEvent`** — takes `{ eventKey, password }`, verifies the password
  against the sheet, refuses completed events even when addressed directly,
  and only then returns the full row (minus the password). Error codes:
  `bad_password`, `not_found`, `completed`.

Opening an event prepopulates the workspace **verbatim from the sheet** —
nothing is inferred or invented:

| Sheet column | Where it lands |
| --- | --- |
| `title` | workspace header title |
| `event_type` | type badge + the Playbook event-type selector (non-preset types like *Roundtable* / *Campaign* are added verbatim) |
| `status` | status badge (color-coded: upcoming/in-progress, cancelled) |
| `event_date` / `end_date` | header date range, the Playbook's event anchor, and every lead-up (−28/−14/−7/−1 days) and follow-up (+1/+7/+30–90 days) timeline date |
| `location` | header location + event anchor |
| `description` | short summary line under the header |
| `password` | gate only — never displayed, never sent to the browser |

Accuracy rules: dates are parsed only from the two formats the sheet actually
uses (`M/D/YYYY` text and real date cells, which the script serializes as
`yyyy-MM-dd`); an unparseable date renders blank rather than guessed. If the
backend is unreachable or not yet redeployed, the gate explains why and offers
a retry.

> ⚠️ **Redeploy required:** `listEvents` and `openEvent` only behave as
> described once you update the Apps Script project with this repo's `Code.gs`
> and publish a **new version** of the existing web-app deployment (same steps
> as section 2 below). Until then the gate will report *"Unknown action"*.

> 🔐 **Security note:** the gate keeps event details out of the *page* until
> the password is verified, and the password itself never leaves the server.
> It is access gating for a shared workspace link, not hardened auth — anyone
> with edit access to the sheet can read the `password` column.

Nothing is written back to the sheet by this feature — both actions are
read-only.

---

# AI Lead Categorization — Setup & How It Works

This adds AI lead categorization to the Event Workspace (`index.html`). The
analysis **runs automatically the moment an Excel/CSV target list is uploaded**,
and an **"Analyze with AI"** button re-runs it on demand. Both send the contact
list to the Partner Portal web script, which asks a **SaaS demand-generation
expert persona** to classify each lead. The feature is fully **additive** — if
the backend is unreachable, the app keeps working exactly as before (the local
title heuristic still fills the ICP role), so nothing is broken while you set
this up.

---

## What the AI does

**Every row and every column of the uploaded file is analyzed.** The parser
reads every worksheet in the workbook (keeping the one with the most data
rows), auto-detects the real header row even when title/blank rows sit above
it, and carries **all** columns through — the four mapped fields (name,
company, title, email) plus everything else (Department, Job Level, Job
Function, Industry, …) in an `extra` object per lead. There is no row cap:
the whole list is classified in batches of 20, and a failed batch is retried
before its rows are counted as unprocessed.

For every contact it returns three things, judged from the job title first,
with role/level/function/department columns as corroborating signal (accuracy
over completeness — if neither gives clear signal it comes back as `Unknown`,
never a guess):

| Field | Values | Feeds |
| --- | --- | --- |
| **ICP buyer role** | Decision Maker · Champion · Influencer · Unknown | the **ICP role** column + the **Buyer role** filter on the Contacts tab |
| **Seniority tier** | C-Suite · VP · Director · Manager · Individual | the **By seniority** donut on the Overview tab |
| **Normalized company** | re-cased/cleaned name (never invented) | the **Company** column + Top companies chart |

These categories are the **exact** labels `index.html` already uses, so results
slot straight into the existing UI. The role definitions match the app's `ICP`
map: C-Suite/VP → Decision Maker, Director/Manager → Champion, Individual →
Influencer — with the model free to deviate when a title clearly warrants it.

The Anthropic API key **stays server-side** in the Apps Script project. This
page never sees it.

---

## How it "leverages the LLM already in the sheet"

The `Partner_Portal_Database` sheet already contains a **`Custom_Prompts`** tab
holding your "Randy" personas, and the Apps Script already calls Claude with the
`ANTHROPIC_API_KEY` from Script Properties. This feature reuses both:

- A new persona, **`Event Lead Categorizer`**, lives in `Custom_Prompts` (below).
- The web script's new `categorizeLeads` action reads that persona by label and
  runs it — identical pattern to the existing document-analysis flow.
- If the `Custom_Prompts` row is missing, an **embedded copy** of the persona in
  `Code.gs` is used instead, so the action can never hard-fail.

---

## Install (3 steps)

### 1. Update the web script

1. Open the Apps Script project bound to the sheet (**Extensions → Apps Script**).
2. Replace the script with **`apps-script/Code.gs`** from this repo. It is your
   existing script **unchanged**, plus the new `categorizeLeads`, `listEvents`
   and `openEvent` actions — all six original actions (`uploadFile`, `listFiles`,
   `deleteFile`, `analyzeDocument`, `updateDescription`, `getConfig`) are
   byte-for-byte the same.
3. Confirm `ANTHROPIC_API_KEY` still exists under
   **Project Settings → Script properties**.

### 2. Redeploy as a web app with **"Anyone"** access

Update the **existing** deployment so the URL doesn't change:
**Deploy → Manage deployments → ✏️ → Version: New version**
- **Execute as:** Me
- **Who has access:** **Anyone**

> ✅ **Verified live on 2026-07-16:** the `/exec` URL in `index.html` was probed
> anonymously — the endpoint answers, and the new `categorizeLeads` action
> responds correctly (old code would reply *"Unknown action"*). A 3-lead
> end-to-end test returned accurate classifications, including `Unknown` for a
> blank title instead of a guess.

### 3. Point the page at your deployment

Already done — `CONFIG.webAppUrl` near the top of the script in `index.html` is
set to the live `/exec` URL. If the deployment URL ever changes, update it
there:

```js
var CONFIG={
  webAppUrl:'https://script.google.com/macros/s/XXXXXXXX/exec'  // <-- your /exec URL
};
```

Then just **upload a target list** — AI analysis starts automatically and
contacts are classified in batches of 20 with a live progress count. The
**✨ Analyze with AI** button re-runs the analysis on the current list whenever
you want.

---

## Add the persona to `Custom_Prompts` (recommended, optional)

Append **one row** to the `Custom_Prompts` tab so the persona is tunable without
editing code. This is additive — it does not modify any existing row.

> ⚠️ **Already added this row before?** Update its `instructions` cell to the
> block below. The sheet copy **overrides** the embedded default, and the old
> text told the model to judge *only* from the job title — it would ignore the
> extra columns the page now sends.

| Column | Value |
| --- | --- |
| `prompt_id` | any unique id, e.g. `event-lead-categorizer` |
| `label` | `Event Lead Categorizer`  ← must match exactly |
| `icon` | 🎯 |
| `instructions` | *(paste the persona text — the block below)* |
| `created_at` | today's date |

Persona text to paste into `instructions`:

```
Role
You are an accuracy-obsessed SaaS marketing demand-generation expert and lead analyst working an event target list for a B2B go-to-market team. Your single, overriding objective is factual accuracy. Speed, completeness, and polish are all subordinate to accuracy. An incomplete classification that is fully accurate is a success. A complete classification with one guessed or fabricated detail is a failure.

Task
For each lead you receive (name, company, job title, email, plus an optional "extra" object carrying every other column from the uploaded file — e.g. Department, Job Level, Job Function, Seniority, Industry), determine three things and nothing more:
1. icp_role  — the lead's role in the B2B buying group, judged primarily from the job title, corroborated by any "extra" columns that explicitly describe the person's role, level, function or department.
2. seniority_tier — the lead's organizational seniority, judged the same way: job title first, role/level/function/department columns in "extra" as supporting signal.
3. normalized_company — the company name cleaned for consistent display. Formatting only. Never invent or change the company's identity.

icp_role — choose EXACTLY one of these four values:
- "Decision Maker" — holds budget authority or final sign-off. Executive and senior leadership: C-level (CIO, CISO, CTO, CEO, CFO, COO, Chief*), President, Owner, Founder, Partner, and VP/SVP/EVP. These people can say yes and fund it.
- "Champion" — an internal owner/driver who advances the initiative and influences the decision from the inside, but usually needs sign-off from above. Function/team leaders: Director, Senior Director, Head of (team), Manager, Team Lead, Supervisor.
- "Influencer" — an individual contributor or practitioner who evaluates, uses, or recommends the product but does not own the decision: Engineer, Administrator, Analyst, Architect, Specialist, Coordinator, Consultant, and similar non-management roles.
- "Unknown" — the title is blank, a placeholder ("-", "—", "N/A", "TBD"), or genuinely ambiguous, AND no "extra" column explicitly describing role/level/function resolves it. Use this rather than guessing.

seniority_tier — choose EXACTLY one of these five values (these are the only allowed strings):
- "C-Suite" — Chief*, CxO (CIO/CISO/CTO/CEO/CFO/COO), President, Owner, Founder, Partner.
- "VP" — VP, SVP, EVP, Vice President, Head of (department-wide).
- "Director" — Director, Senior/Sr. Director, Head of (a team).
- "Manager" — Manager, Team Lead, Lead, Supervisor.
- "Individual" — Engineer, Administrator, Analyst, Architect, Specialist, Coordinator, Consultant, and any other non-management individual-contributor role.
- If the title is missing or ambiguous, do not force a tier: use "Individual" only when there is at least weak signal, and reflect the uncertainty by setting icp_role to "Unknown" and confidence to "low".

Accuracy rules (non-negotiable):
- Judge role and seniority from the job-title text first. When the title is blank, a placeholder, or ambiguous, you MAY use "extra" columns that explicitly describe the person's role, level, function or department (e.g. "Job Level", "Seniority", "Department", "Job Function", "Management Level") to classify. Do NOT infer role or seniority from the company name, the email address, the person's name, or unrelated extra columns (industry, city, revenue, phone, notes, …).
- If neither the title nor a role-describing extra column gives clear signal, return icp_role "Unknown" and confidence "low". Never guess to look complete.
- normalized_company: fix ONLY capitalization, stray spacing, and obvious legal-suffix casing (e.g. "acme corp" → "Acme Corp", "INSIGHT ENTERPRISES" → "Insight Enterprises"). Do NOT expand abbreviations you are unsure about, invent a longer name, merge two companies, or change the identity. If company is blank or a placeholder, return an empty string "".
- Never invent titles, roles, seniority, or company facts that are not supported by the input.
- confidence reflects how clearly the title maps to the role/tier: "high", "medium", or "low".

Output format:
Return ONLY a JSON array — no prose, no explanation, no markdown code fences. One object per input lead, in the SAME order as the input, echoing the given "index" exactly. Each object has EXACTLY these fields:
[
  {
    "index": <the index value from the input, echoed unchanged>,
    "icp_role": "Decision Maker" | "Champion" | "Influencer" | "Unknown",
    "seniority_tier": "C-Suite" | "VP" | "Director" | "Manager" | "Individual",
    "normalized_company": "<cleaned company name, or empty string>",
    "confidence": "high" | "medium" | "low",
    "rationale": "<one short phrase citing the title signal, e.g. 'CISO = C-level budget owner'>"
  }
]
```

---

## Request / response contract

**Request** (the page sends batches of ~20; `Content-Type: text/plain` avoids a
CORS preflight Apps Script can't answer):

```json
{
  "action": "categorizeLeads",
  "leads": [
    { "index": "u0", "name": "Jane Doe", "company": "acme corp", "title": "VP of IT",
      "email": "jane@acme.com",
      "extra": { "Department": "Information Technology", "Job Level": "VP-Level", "Industry": "Retail" } }
  ]
}
```

`extra` carries every column of the uploaded file that isn't one of the four
mapped fields (values capped at 200 chars, max 20 columns per lead, blanks
omitted). Leads with no extra columns simply omit the key.

```json
```

**Response:**

```json
{
  "ok": true,
  "results": [
    { "index": "u0", "icp_role": "Decision Maker", "seniority_tier": "VP",
      "normalized_company": "Acme Corp", "confidence": "high",
      "rationale": "VP = senior budget owner" }
  ]
}
```

The client matches results back to contacts by `index`, so order/omissions are
safe. Unrecognized values are ignored rather than applied.

---

## Safety notes

- **Non-destructive.** No existing tab, row, action, or UI behavior is changed.
  The AI only writes to in-memory fields on the preview page (nothing is saved).
- **Graceful failure.** No URL / wrong URL / network error / non-`ok` response →
  a toast, and the app continues on the local heuristic.
- **Key stays server-side.** Classification happens inside Apps Script; the page
  never receives the Anthropic key.
- **Batched, no row cap.** The entire list is analyzed 20 leads per request
  (sequentially, so the browser and script are never flooded), with one retry
  per failed batch. The final toast reports exactly how many rows were
  categorized and how many, if any, could not be processed.
- **Upload supersedes.** Uploading a new file while an analysis is still running
  cancels the old run at its next batch (run token) — stale responses are
  discarded, so results can never land on the wrong list.
- **Auto-run only on real uploads.** The demo data shown on first page load is
  never sent to the AI; only files the user uploads trigger the automatic
  analysis.
