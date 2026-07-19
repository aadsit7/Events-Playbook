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
   event's `event_password` cell in the sheet is non-empty. The check happens
   **server-side** in Apps Script; the password value is never sent to the
   browser.
3. **The page opens** showing only that event's details.

The gate cannot be dismissed until an event is opened — there is no
"Not now". After the first unlock, the header's **"Change event"** button
reopens the picker (with a Cancel option), and switching to another
password-protected event requires *that* event's password.

### Setting a password on an event

The `Events` tab has an **`event_password`** column (column O). Type a password
into that cell to protect the event; leave it blank for the event to open
without one. Matching is exact after trimming whitespace. (An older `password`
header is still honored as a fallback, but the live sheet uses `event_password`.)

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
| `event_date` / `end_date` | header date range, the Playbook's event anchor and days-to-event countdown, and the Event Day stage's timing label |
| `location` | header location + event anchor |
| `description` | short summary line under the header |
| `event_password` | gate only — never displayed, never sent to the browser |

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
> with edit access to the sheet can read the `event_password` column.

The gate itself is read-only — `listEvents` and `openEvent` never write. The
contact list you upload for the event, however, **is** saved back to the sheet;
that is the next section.

---

# Event Contacts — saving the target list back to the sheet

## The methodology (what happens, and why)

The playbook is **event-first and stateless about contacts**. On open it holds
**no contact data of its own** — only what it can correlate from the event's own
row in the `Events` tab (title, type, status, dates, location, description).
The demo list you see before an event is opened is cleared the moment a real
event is selected.

Contacts enter the playbook **one event at a time**, and they are **persisted
per event** so they can be referenced later:

1. **Open an event** → the workspace loads with only *that* event's saved
   contacts (via `listEventContacts`). A brand-new event simply opens empty.
2. **Upload a CSV/Excel target list** → it's parsed, AI-categorized (buyer role,
   seniority, cleaned company), and **automatically saved** to the sheet.
3. **Saved to a dedicated `Event_Contacts` tab**, keyed by the event, via
   `saveEventContacts`. A **"Save to sheet"** button also lets you re-save on
   demand — e.g. after toggling *Meeting booked* / *Not interested*.
4. **Reopen the event any time** (this session or a future one) → the saved
   contacts load straight back in.

### Where the contacts are stored

A new tab, **`Event_Contacts`**, is **created automatically on first save** —
exactly the way the existing `Opportunity_Documents` tab is created on the first
file upload. You never have to add it by hand, and nothing else in the workbook
is touched. Its columns:

| Column | Meaning |
| --- | --- |
| `event_id` | **Join key** — the event's `event_id` (or `row-N` for a row without one). The *same* key the picker/`openEvent` already use, so contacts always attach to the right event. |
| `event_title` | The event's title, for human readability in the sheet. |
| `contact_id` | Stable id for the contact within the event. |
| `name` · `title` · `company` · `email` · `owner` | The contact's mapped fields. |
| `status` | `none` · `meeting` · `declined` (the outreach status you toggle in the UI). |
| `icp_role` | AI buyer role: Decision Maker · Champion · Influencer · Unknown. |
| `seniority_tier` | AI seniority: C-Suite · VP · Director · Manager · Individual. |
| `ai_confidence` · `ai_rationale` | The AI's confidence and one-line reasoning. |
| `source_file` | The uploaded file the list came from. |
| `saved_at` | ISO timestamp of the save. |

### Save semantics — **replace, keyed by event**

Saving an event's contacts **replaces every existing `Event_Contacts` row for
that event** with the current list, then writes it in one batched update. Rows
belonging to **other** events are never touched. This means:

- Re-uploading or re-saving the same event **never accumulates duplicates** —
  the tab always mirrors the current target list for that event.
- Status changes and re-categorizations are captured on the next save.
- The **`lead_count`** cell of the matching `Events` row is refreshed to the
  saved count as a convenience (best-effort; a failure here never blocks the
  save, and no other Events column is modified).

### The two new actions

- **`saveEventContacts`** — `{ eventKey, eventTitle, fileName, contacts:[…] }` →
  writes/replaces that event's rows. Returns `{ ok, saved, event_id }`.
- **`listEventContacts`** — `{ eventKey }` → returns that event's saved contacts
  as row objects (empty list, never an error, when there are none). Returns
  `{ ok, contacts:[…] }`.

Both live in `Code.gs` below the fenced *EVENT CONTACTS* section and are purely
additive — every original action is unchanged.

> ⚠️ **Redeploy required:** like `listEvents`/`openEvent`, these actions only
> work once you update the Apps Script project with this repo's `Code.gs` and
> publish a **new version** of the existing web-app deployment (Section 2
> below). Until then, uploading still categorizes contacts locally but the save
> will report *"Unknown action"* and the list won't persist.

> 🔐 **Note:** contacts are written with the deployment's *Execute as: Me*
> identity, so anyone using the shared workspace link can save/read the target
> list for any event they can open. This is the same trust model as the rest of
> the workspace — it's a shared partner tool, not per-user auth.

---

# Event Playbook — saving the 7-stage playbook back to the sheet

The Playbook tab is a **7-stage partner playbook** (Event → Audience →
Messaging → Drive Attendance → Event Day → Follow-Up → Results). Each stage
has three activities. **Stage completion is fully automatic** — a stage is
complete the moment all three of its activities are checked; there is no
exit-criteria block or Confirm Stage Complete button. Checked activities
carry a **completion-date stamp** (the date of the description note that
evidenced them — see the *AI auto-check* section below — or the day they
were checked by hand); unchecked activities show no date and there is no
due-date picker. Everything you change — activity checkboxes, owner tags
(Recast / Partner / Both), and the per-stage **Descriptions** notes — is
persisted **per event**, with a 1.5-second debounce after each change, and
loaded straight back the next time the event is opened. The demo event never
writes to the sheet.

### Where the playbook is stored

A new tab, **`Event_Playbook`**, is **created automatically on first save** —
same pattern as `Event_Contacts`. It holds, per event: **one row per activity**,
plus **one `gate` row** and **one `note` row** per stage. Its columns:

| Column | Meaning |
| --- | --- |
| `event_id` | **Join key** — the same `event_id` / `row-N` key the picker, `openEvent` and `Event_Contacts` use. |
| `event_title` | The event's title, for human readability. |
| `stage_key` | `setup` · `audience` · `messaging` · `drive` · `eventday` · `followup` · `results`. |
| `row_type` | `activity` · `gate` · `note`. |
| `act_index` | Position of the activity within its stage (activity rows only). |
| `text` · `owner` · `due_date` · `done` | The activity's label, owner (`recast`/`partner`/`both`), **completion date** (`yyyy-MM-dd`, set when the activity is checked) and TRUE/FALSE done flag. The `gate` row's `done` flag is now **derived** (TRUE when all of the stage's activities are checked) — it is still written so the tab keeps its shape, but the page ignores it on load. |
| `note_text` | The stage's team note (note rows only). |
| `saved_at` | Timestamp of the save. |

Save semantics are **replace, keyed by event** — exactly like `Event_Contacts`:
every existing `Event_Playbook` row for the event is removed and the current
state written in its place, so re-saves never accumulate duplicates and rows
for other events are never touched.

### The playbook actions

- **`savePlaybook`** — `{ eventKey, eventTitle, stages:[{ key, gate, note,
  acts:[{x,o,dt,d}] }] }` → replaces that event's rows (`gate` is the derived
  all-activities-checked flag; `dt` is the completion date). Returns
  `{ ok, saved }`.
- **`loadPlaybook`** — `{ eventKey }` → returns
  `{ ok, stages:{ <stage_key>:{ gate, note, acts:[{i,x,o,dt,d}] } } }` (an
  empty `stages` object when nothing is saved — the page falls back to the
  template defaults, all unchecked).
- **`analyzePlaybookNotes`** — the AI auto-check, documented in its own
  section below.

### AI auto-check — saved notes automatically check off activities

Whenever an event is opened (and again right after a stage note is saved),
the page calls **`analyzePlaybookNotes`** with the event key and the current
activity list:

```json
{ "action": "analyzePlaybookNotes", "eventKey": "evt_…",
  "stages": [{ "key": "setup", "name": "Event",
               "acts": [{ "i": 0, "x": "Confirm date, format, topic, and speakers", "d": false }, …] }, …] }
```

Server-side, the action gathers **every saved description note** for the
event — the Events row's own `description` cell (including the
`⸻ Team Notes ⸻` mirror) plus every dated `Event_Descriptions` row (the rows
**Save note** appends, and any the portal added, flattened from HTML to plain
text) — and asks Claude (`claude-sonnet-5`) which activities those notes show
as **already completed**. It returns:

```json
{ "ok": true, "checks": [{ "stage": "setup", "i": 0, "date": "2026-06-29" }], "notes": 3 }
```

The page then checks those boxes, stamps each with the returned date (the
evidencing note's date, or today when unknown), and persists through the
normal `savePlaybook` flow. Accuracy rules, enforced in the prompt **and**
validated after parsing:

- An activity is marked **only when a note clearly states it actually
  happened** — planning, scheduling, or assigning an owner is not completion;
  when in doubt the model must leave it unchecked.
- The analysis **only ever checks boxes** — it never unchecks anything, and
  activities that are already checked (`"d": true`) are excluded from the
  question entirely, so nothing the user did is ever overridden.
- Every returned `{stage, i}` pair is validated against the stages the client
  sent; unknown keys/indexes are dropped, and malformed dates are blanked.
- **No notes → no AI call**: an event with no saved descriptions returns
  `checks: []` immediately.
- Read-only and best-effort: the action writes nothing, the demo event never
  triggers it, and a failure leaves the playbook exactly as loaded (checking
  stays manual until the next analysis).

### Notes → event description sync

Stage notes are the team's running description of the event. On every save
they are also mirrored into the matching **`Events` row's `description` cell**,
below a `⸻ Team Notes ⸻` marker:

```
<original description, preserved verbatim>

⸻ Team Notes ⸻
[Event] Kickoff call booked.
[Drive Attendance] Registration push moved to Thursday.
```

Everything **at/after the marker is replaced** on each save; the original
description above it is **never touched**. Clearing every note removes the
marker section entirely. The sync is best-effort — a failure there can never
break a playbook save. On open, the description is treated as a rendered
mirror only: the marker section is **never** read back into stage notes
(those hydrate solely from `Event_Playbook` rows).

> ⚠️ **Redeploy required:** like the other actions, `savePlaybook`,
> `loadPlaybook` and `analyzePlaybookNotes` only work once you update the
> Apps Script project with this repo's `Code.gs` and publish a **new
> version** of the existing web-app deployment (Section 2 below). Until then
> the playbook still renders and works locally, but saves will report
> *"Unknown action"*, nothing persists, and the notes analysis silently
> skips (checking stays manual).

---

# AI Lead Categorization — Setup & How It Works

This adds AI lead categorization to the Event Workspace (`index.html`). The
analysis **runs automatically the moment an Excel/CSV target list is uploaded**,
and an **"Analyze with AI"** button starts it on demand for a list that hasn't
been analyzed yet (once a list is analyzed, the button is hidden). Both send the contact
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
   existing script **unchanged**, plus the new `categorizeLeads`, `listEvents`,
   `openEvent`, `saveEventContacts` and `listEventContacts` actions — all six
   original actions (`uploadFile`, `listFiles`, `deleteFile`, `analyzeDocument`,
   `updateDescription`, `getConfig`) are byte-for-byte the same.
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
contacts are classified in batches of 20 with a live progress count. If a list
hasn't been analyzed yet, the **✨ Analyze with AI** button starts the analysis
on demand (it disappears once the list is analyzed).

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

- **Non-destructive to existing data.** No existing tab, row, action, or UI
  behavior is changed. The AI classification itself writes only to in-memory
  fields on the page; persistence is handled separately by the *Event Contacts*
  feature above, which writes only to the new `Event_Contacts` tab (plus the
  `lead_count` cell of the matching `Events` row).
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

---

# Playbook stage notes — "Save note" → Event_Descriptions sync

Each stage card on the **Playbook** tab has a *Descriptions* box with its
own **Save note** button and a **microphone button** (top-right corner of the
text box) for voice-to-text: click it, speak, and the dictated words are
appended to the note (Web Speech API — Chrome/Edge; other browsers get a
clear "not supported" message). Typing or dictating still auto-saves the note
into the `Event_Playbook` tab (debounced, exactly as before) and mirrors it
into the Events row's `description` cell under the `⸻ Team Notes ⸻` marker.
Clicking **Save note** additionally publishes the note to the portal:

1. The full playbook state is persisted first (`savePlaybook`), so the sheet
   and the note row can never disagree.
2. The **`saveStageNote`** action appends **one new row to the
   `Event_Descriptions` tab** — the same tab that powers the dated
   *Descriptions* list in the portal's Edit Event modal — so the note surfaces
   there automatically.
3. The **AI auto-check re-runs** (`analyzePlaybookNotes`, see the Playbook
   section above): if the note you just saved describes completed work, the
   matching activities are checked off — with the note's date — right away.

**Request:**

```json
{ "action": "saveStageNote", "eventKey": "evt_…", "eventTitle": "…",
  "stageKey": "setup", "stageName": "Event", "note": "…" }
```

**Row written** (columns matched by header name, like every other writer):

| Column | Value |
| --- | --- |
| `description_id` | generated `dsc_…` id |
| `event_id` | the Events row's own `event_id` (resolved server-side via the same key join as `openEvent`; falls back to the key for `row-N` events) |
| `title` | the Events row's own `title` |
| `description_date` | today, `yyyy-MM-dd`, in the spreadsheet's time zone |
| `description_text` | HTML in a fixed shape — **stage title first** (`<p><strong><Stage></strong></p>`), **then the note** (escaped; blank lines become paragraphs, single newlines `<br>`), **then the save date** (`<p><em>July 19, 2026</em></p>`, spreadsheet time zone) — matching the rich-text format the portal's other descriptions use |
| `created_at` | ISO timestamp |

**Safety:**

- **Duplicate-proof.** If an identical description already exists for the
  event (double-click, resave of an unchanged note the same day), no row is
  written and the UI reports *"Already in this event's descriptions"*. The
  save date is part of the text, so resaving the same note on a later day
  correctly adds a new dated entry.
- **Empty notes are refused** server-side (`empty_note`), and unknown event
  keys return `not_found`.
- **Non-destructive.** The action only ever *appends* to `Event_Descriptions`
  (creating the tab with the exact portal headers if it were missing). No
  existing row, tab, or action is modified.
- **Demo event never writes.** The Save button tells you notes aren't synced
  when the demo event (or an unconfigured backend) is active.

> ⚠️ **Redeploy required:** like every new action, `saveStageNote` only works
> after updating the Apps Script project with this repo's `Code.gs` and
> publishing a **new version** of the web-app deployment. Until then the
> button reports *"Unknown action: saveStageNote"*.
