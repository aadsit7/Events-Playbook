# AI Lead Categorization — Setup & How It Works

This adds an optional **"Analyze with AI"** button to the Event Workspace
(`index.html`). It sends the uploaded contact list to the Partner Portal web
script, which asks a **SaaS demand-generation expert persona** to classify each
lead. The feature is fully **additive** — if the backend is unreachable, the app
keeps working exactly as before (the local title heuristic still fills the ICP
role), so nothing is broken while you set this up.

---

## What the AI does

For every contact it returns three things, judged **only** from the job title
(accuracy over completeness — a blank/ambiguous title comes back as `Unknown`,
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
   existing script **unchanged**, plus one new `categorizeLeads` action — all six
   original actions (`uploadFile`, `listFiles`, `deleteFile`, `analyzeDocument`,
   `updateDescription`, `getConfig`) are byte-for-byte the same.
3. Confirm `ANTHROPIC_API_KEY` still exists under
   **Project Settings → Script properties**.

### 2. Redeploy as a web app with **"Anyone"** access

> ⚠️ **Verified on 2026-07-16:** a probe of the `/exec` URL currently in
> `index.html` returned Google's *"Page Not Found"* page for an anonymous
> request. That means the browser page cannot call it yet. To fix it, create a
> deployment reachable without a Google login:

**Deploy → New deployment → Web app**
- **Execute as:** Me
- **Who has access:** **Anyone**

Copy the resulting `/exec` URL.

### 3. Point the page at your deployment

In `index.html`, set the URL near the top of the script:

```js
var CONFIG={
  webAppUrl:'https://script.google.com/macros/s/XXXXXXXX/exec'  // <-- your /exec URL
};
```

Then upload a target list and click **✨ Analyze with AI**. Contacts are
classified in batches of 20 with a live progress count.

---

## Add the persona to `Custom_Prompts` (recommended, optional)

Append **one row** to the `Custom_Prompts` tab so the persona is tunable without
editing code. This is additive — it does not modify any existing row.

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
For each lead you receive (name, company, job title, email), determine three things and nothing more:
1. icp_role  — the lead's role in the B2B buying group, judged ONLY from the job title.
2. seniority_tier — the lead's organizational seniority, judged ONLY from the job title.
3. normalized_company — the company name cleaned for consistent display. Formatting only. Never invent or change the company's identity.

icp_role — choose EXACTLY one of these four values:
- "Decision Maker" — holds budget authority or final sign-off. Executive and senior leadership: C-level (CIO, CISO, CTO, CEO, CFO, COO, Chief*), President, Owner, Founder, Partner, and VP/SVP/EVP. These people can say yes and fund it.
- "Champion" — an internal owner/driver who advances the initiative and influences the decision from the inside, but usually needs sign-off from above. Function/team leaders: Director, Senior Director, Head of (team), Manager, Team Lead, Supervisor.
- "Influencer" — an individual contributor or practitioner who evaluates, uses, or recommends the product but does not own the decision: Engineer, Administrator, Analyst, Architect, Specialist, Coordinator, Consultant, and similar non-management roles.
- "Unknown" — the title is blank, a placeholder ("-", "—", "N/A", "TBD"), or genuinely ambiguous and does not clearly map to a role. Use this rather than guessing.

seniority_tier — choose EXACTLY one of these five values (these are the only allowed strings):
- "C-Suite" — Chief*, CxO (CIO/CISO/CTO/CEO/CFO/COO), President, Owner, Founder, Partner.
- "VP" — VP, SVP, EVP, Vice President, Head of (department-wide).
- "Director" — Director, Senior/Sr. Director, Head of (a team).
- "Manager" — Manager, Team Lead, Lead, Supervisor.
- "Individual" — Engineer, Administrator, Analyst, Architect, Specialist, Coordinator, Consultant, and any other non-management individual-contributor role.
- If the title is missing or ambiguous, do not force a tier: use "Individual" only when there is at least weak signal, and reflect the uncertainty by setting icp_role to "Unknown" and confidence to "low".

Accuracy rules (non-negotiable):
- Judge role and seniority ONLY from the job-title text. Do NOT infer anything from the company name, the email address, or the person's name.
- If the title is blank, a placeholder, or genuinely ambiguous, return icp_role "Unknown" and confidence "low". Never guess to look complete.
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
    { "index": "u0", "name": "Jane Doe", "company": "acme corp", "title": "VP of IT", "email": "jane@acme.com" }
  ]
}
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
- **Batch + cap.** Up to `AI_MAX` (400) contacts per run, 20 per request, so a
  huge upload can't hang the browser or the script.
