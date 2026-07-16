/**
 * Partner Portal — Event Workspace backend (Google Apps Script web app)
 * ---------------------------------------------------------------------
 * This is the existing web script with ONE additive capability bolted on:
 * a new `categorizeLeads` action that runs the "Event Lead Categorizer"
 * SaaS demand-gen persona over an uploaded contact list.
 *
 * NOTHING existing was changed. All original actions
 * (uploadFile / listFiles / deleteFile / analyzeDocument / updateDescription /
 * getConfig) behave exactly as before. The only edits are:
 *   1. a new `if (payload.action === 'categorizeLeads')` branch in doPost()
 *   2. the new functions at the bottom of this file (clearly fenced)
 *
 * Deploy: Extensions > Apps Script > Deploy > New deployment > Web app
 *   - Execute as:      Me
 *   - Who has access:  Anyone            <-- REQUIRED so the browser page can call it
 * Then copy the /exec URL into CONFIG.webAppUrl in index.html.
 */

var SHEET_ID = '18Yhe3Yiq9_eI7kBxtFOzdu6Pb0_VUx730TYjq1xPjzI';
var DRIVE_FOLDER_ID = '1Jl86IHpClRaIFqM-RUQn-gzcCqYV9XTA';
var ANTHROPIC_API_KEY = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

    if (payload.action === 'uploadFile') {
      return doUploadFile(payload);
    }

    if (payload.action === 'listFiles') {
      return doListFiles(payload.opportunityId);
    }

    if (payload.action === 'deleteFile') {
      return doDeleteFile(payload.docId);
    }

    if (payload.action === 'analyzeDocument') {
      return doAnalyzeDocument(payload.docId, payload.driveUrl);
    }

    if (payload.action === 'updateDescription') {
      return handleUpdateDescription(payload);
    }

    // NEW — classify an uploaded lead list with the SaaS demand-gen persona.
    if (payload.action === 'categorizeLeads') {
      return doCategorizeLeads(payload);
    }

    if (payload.action === 'getConfig') {
      return doGetConfig();
    }

    throw new Error('Unknown action: ' + payload.action);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================
// GET CONFIG — Return the Anthropic key so the portal can read it
// automatically instead of pasting it into the Setup page.
// ============================================================

function doGetConfig() {
  return ContentService.createTextOutput(JSON.stringify({
    ok: true,
    anthropicApiKey: ANTHROPIC_API_KEY
  })).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// FILE UPLOAD
// ============================================================

function doUploadFile(payload) {
  var rootFolder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  var customerName = payload.customerName || 'Uncategorized';
  var customerFolders = rootFolder.getFoldersByName(customerName);
  var customerFolder = customerFolders.hasNext() ? customerFolders.next() : rootFolder.createFolder(customerName);

  var fileData = Utilities.base64Decode(payload.fileData);
  var blob = Utilities.newBlob(fileData, payload.mimeType, payload.fileName);
  var file = customerFolder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('Opportunity_Documents');
  if (!sheet) {
    sheet = ss.insertSheet('Opportunity_Documents');
    sheet.getRange(1, 1, 1, 8).setValues([['doc_id', 'opportunity_id', 'customer_name', 'file_name', 'mime_type', 'drive_url', 'date_added', 'analyzed']]);
  }

  var docId = 'DOC' + Date.now();
  sheet.appendRow([docId, payload.opportunityId, customerName, payload.fileName, payload.mimeType, file.getUrl(), new Date().toISOString().slice(0, 10), 'FALSE']);

  return ContentService.createTextOutput(JSON.stringify({ ok: true, doc_id: docId, url: file.getUrl(), name: payload.fileName }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// LIST FILES
// ============================================================

function doListFiles(opportunityId) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('Opportunity_Documents');
  if (!sheet) return ContentService.createTextOutput(JSON.stringify({ ok: true, files: [] })).setMimeType(ContentService.MimeType.JSON);

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return ContentService.createTextOutput(JSON.stringify({ ok: true, files: [] })).setMimeType(ContentService.MimeType.JSON);

  var numCols = sheet.getLastColumn();
  var data = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  var headers = sheet.getRange(1, 1, 1, numCols).getValues()[0];

  var files = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][1] == opportunityId) {
      var obj = {};
      for (var j = 0; j < headers.length; j++) obj[headers[j]] = data[i][j];
      files.push(obj);
    }
  }
  return ContentService.createTextOutput(JSON.stringify({ ok: true, files: files })).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// DELETE FILE
// ============================================================

function doDeleteFile(docId) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('Opportunity_Documents');
  if (!sheet) throw new Error('No documents tab found');

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] == docId) {
      sheet.deleteRow(i + 2);
      return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
    }
  }
  throw new Error('Document not found: ' + docId);
}

// ============================================================
// ANALYZE DOCUMENT — Extract text from Drive file, send to Claude
// ============================================================

function doAnalyzeDocument(docId, driveUrl) {
  // Extract file ID from the Drive URL
  var fileId = extractFileId(driveUrl);
  if (!fileId) throw new Error('Could not extract file ID from URL: ' + driveUrl);

  var file = DriveApp.getFileById(fileId);
  var mimeType = file.getMimeType();
  var fileName = file.getName();
  var extractedText = '';

  // Extract text based on file type
  if (mimeType === 'application/pdf') {
    // Convert PDF to Google Doc (uses Google's built-in OCR), extract text, delete temp doc
    var tempDoc = Drive.Files.copy(
      { title: 'TEMP_ANALYZE_' + Date.now(), mimeType: 'application/vnd.google-apps.document' },
      fileId,
      { ocr: true, ocrLanguage: 'en' }
    );
    var doc = DocumentApp.openById(tempDoc.id);
    extractedText = doc.getBody().getText();
    DriveApp.getFileById(tempDoc.id).setTrashed(true);
  } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
             mimeType === 'application/msword') {
    // Word docs — convert to Google Doc, extract text
    var tempDoc = Drive.Files.copy(
      { title: 'TEMP_ANALYZE_' + Date.now(), mimeType: 'application/vnd.google-apps.document' },
      fileId
    );
    var doc = DocumentApp.openById(tempDoc.id);
    extractedText = doc.getBody().getText();
    DriveApp.getFileById(tempDoc.id).setTrashed(true);
  } else if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
             mimeType === 'application/vnd.ms-excel') {
    // Excel — convert to Google Sheet, extract text from first sheet
    var tempSheet = Drive.Files.copy(
      { title: 'TEMP_ANALYZE_' + Date.now(), mimeType: 'application/vnd.google-apps.spreadsheet' },
      fileId
    );
    var ss = SpreadsheetApp.openById(tempSheet.id);
    var sheet = ss.getSheets()[0];
    var data = sheet.getDataRange().getValues();
    extractedText = data.map(function(row) { return row.join(' | '); }).join('\n');
    DriveApp.getFileById(tempSheet.id).setTrashed(true);
  } else if (mimeType === 'text/plain') {
    extractedText = file.getBlob().getDataAsString();
  } else {
    // Try to get as text
    try {
      extractedText = file.getBlob().getDataAsString();
    } catch (e) {
      throw new Error('Cannot extract text from file type: ' + mimeType);
    }
  }

  if (!extractedText || extractedText.trim().length < 20) {
    throw new Error('Could not extract meaningful text from this document');
  }

  // Truncate if very long
  if (extractedText.length > 15000) {
    extractedText = extractedText.substring(0, 15000) + '\n\n[Document truncated — showing first 15,000 characters]';
  }

  // Send to Claude to format as a clean, structured description
  var prompt = 'You are a document formatting assistant. I have extracted text from a business document called "' + fileName + '". ' +
    'Your job is to format this text as clean, well-structured HTML that preserves the original layout and content as closely as possible.\n\n' +
    'RULES:\n' +
    '- Preserve the original text content exactly — do not summarize, shorten, or rewrite anything\n' +
    '- Use proper HTML formatting: <h3> for main section headers, <h4> for sub-headers, <p> for paragraphs\n' +
    '- Use <ul><li> for bullet points and <ol><li> for numbered lists\n' +
    '- Use <strong> for bold text and <em> for italic text\n' +
    '- Use <table> for any tabular data\n' +
    '- Use <a href="..."> for any URLs or email addresses found in the text\n' +
    '- Do NOT add any commentary, summary, or analysis — just format the existing text\n' +
    '- Do NOT wrap the output in markdown code fences or backticks\n' +
    '- Output ONLY the HTML content, nothing else\n' +
    '- If the document has a clear title or date, make that the first <h3>\n' +
    '- Preserve section structure: if the document has sections like "Key Takeaways", "People", "Next Steps", keep those as headers\n\n' +
    '=== EXTRACTED TEXT ===\n\n' +
    extractedText;

  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    }),
    muteHttpExceptions: true
  });

  var result = JSON.parse(response.getContentText());
  var formattedHtml = '';

  // Extract text from Claude response
  if (result.content && Array.isArray(result.content)) {
    for (var i = 0; i < result.content.length; i++) {
      if (result.content[i].type === 'text') {
        formattedHtml += result.content[i].text;
      }
    }
  }

  if (!formattedHtml) {
    throw new Error('Claude did not return formatted text');
  }

  // Strip any markdown fences if present
  formattedHtml = formattedHtml.replace(/```html\s*/gi, '').replace(/```\s*/g, '').trim();

  // Mark document as analyzed in the sheet
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('Opportunity_Documents');
  if (sheet) {
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var analyzedIdx = headers.indexOf('analyzed');

    // Add 'analyzed' column if it doesn't exist
    if (analyzedIdx === -1) {
      var newCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, newCol).setValue('analyzed');
      analyzedIdx = newCol - 1;
    }

    for (var j = 0; j < data.length; j++) {
      if (data[j][0] == docId) {
        sheet.getRange(j + 2, analyzedIdx + 1).setValue('TRUE');
        break;
      }
    }
  }

  return ContentService.createTextOutput(JSON.stringify({
    ok: true,
    html: formattedHtml,
    fileName: fileName
  })).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// UPDATE DESCRIPTION — Overwrite description text + set category
// Used by the Standardize button (Describe Intelligence V1)
// ============================================================

function handleUpdateDescription(payload) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('Opportunity_Descriptions');
  if (!sheet) throw new Error('Opportunity_Descriptions tab not found');

  var data = sheet.getDataRange().getValues();
  var header = data[0];
  var idCol = header.indexOf('description_id');
  var textCol = header.indexOf('description_text');
  var categoryCol = header.indexOf('category');

  if (idCol === -1) throw new Error('Column "description_id" not found in Opportunity_Descriptions');
  if (textCol === -1) throw new Error('Column "description_text" not found in Opportunity_Descriptions');
  if (categoryCol === -1) throw new Error('Column "category" not found in Opportunity_Descriptions — add it as the next empty column');

  for (var i = 1; i < data.length; i++) {
    if (data[i][idCol] === payload.descriptionId) {
      sheet.getRange(i + 1, textCol + 1).setValue(payload.standardizedText);
      sheet.getRange(i + 1, categoryCol + 1).setValue(payload.category);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, descriptionId: payload.descriptionId }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'description not found: ' + payload.descriptionId }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// UTILITY — Extract file ID from Google Drive URL
// ============================================================

function extractFileId(url) {
  // Handle various Google Drive URL formats
  var patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/,
    /open\?id=([a-zA-Z0-9_-]+)/
  ];
  for (var i = 0; i < patterns.length; i++) {
    var match = url.match(patterns[i]);
    if (match) return match[1];
  }
  return null;
}

// ============================================================
// ============================================================
// NEW — LEAD CATEGORIZATION (SaaS demand-gen persona)
// Everything below this line is additive. It does not touch any
// existing tab, action, or behavior.
// ============================================================
// ============================================================

// The persona is stored in the Custom_Prompts tab under this label so it can be
// tuned without editing code. If the row is missing, the embedded default below
// is used, so the action always works.
var CATEGORIZER_LABEL = 'Event Lead Categorizer';

/**
 * doCategorizeLeads
 * Input payload: { action:'categorizeLeads', leads:[{ index, name, company, title, email }] }
 * Output JSON:   { ok:true, results:[{ index, icp_role, seniority_tier, normalized_company, confidence, rationale }] }
 *
 * The client sends the list in small batches (~20). This function classifies one
 * batch per call and echoes each lead's `index` back so the client can match
 * results to rows regardless of order.
 */
function doCategorizeLeads(payload) {
  var leads = payload.leads || [];
  if (!leads.length) return jsonOut({ ok: true, results: [] });

  // Safety cap so a single request can never blow the model context / timeout.
  if (leads.length > 60) leads = leads.slice(0, 60);

  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in this project’s Script Properties');

  var instructions = getCategorizerInstructions();

  var leadJson = JSON.stringify(leads.map(function (l, i) {
    return {
      index: (l.index != null ? l.index : i),
      name: (l.name || ''),
      company: (l.company || ''),
      title: (l.title || ''),
      email: (l.email || '')
    };
  }));

  var prompt = instructions +
    '\n\n=== LEADS TO CATEGORIZE (JSON) ===\n' + leadJson +
    '\n\nReturn ONLY the JSON array described above — one object per lead, in the same order, ' +
    'echoing each "index" value exactly as given. No prose, no markdown code fences.';

  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    }),
    muteHttpExceptions: true
  });

  var result = JSON.parse(response.getContentText());
  if (result && result.error) throw new Error('Anthropic API error: ' + result.error.message);

  var text = '';
  if (result.content && Array.isArray(result.content)) {
    for (var i = 0; i < result.content.length; i++) {
      if (result.content[i].type === 'text') text += result.content[i].text;
    }
  }
  if (!text) throw new Error('Categorizer returned no output');

  text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  var results;
  try {
    var parsed = JSON.parse(text);
    results = Array.isArray(parsed) ? parsed : (parsed.results || []);
  } catch (e) {
    // tolerate stray prose around the array
    var m = text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('Could not parse categorizer output as JSON');
    results = JSON.parse(m[0]);
  }

  return jsonOut({ ok: true, results: results });
}

/**
 * getCategorizerInstructions
 * Loads the persona from the Custom_Prompts tab (label = CATEGORIZER_LABEL),
 * cached for 5 minutes. Falls back to the embedded default if the row is
 * missing or the sheet can't be read — so the feature never hard-fails.
 */
function getCategorizerInstructions() {
  try {
    var cached = CacheService.getScriptCache().get('categorizer_instructions');
    if (cached) return cached;
  } catch (e) { /* cache unavailable — continue */ }

  var instructions = DEFAULT_CATEGORIZER_INSTRUCTIONS;
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName('Custom_Prompts');
    if (sheet && sheet.getLastRow() > 1) {
      var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var labelIdx = headers.indexOf('label');
      var instrIdx = headers.indexOf('instructions');
      if (labelIdx !== -1 && instrIdx !== -1) {
        for (var i = 0; i < data.length; i++) {
          if (String(data[i][labelIdx]).trim().toLowerCase() === CATEGORIZER_LABEL.toLowerCase() &&
              String(data[i][instrIdx]).trim().length > 40) {
            instructions = String(data[i][instrIdx]);
            break;
          }
        }
      }
    }
  } catch (e) { /* fall back to embedded default */ }

  try { CacheService.getScriptCache().put('categorizer_instructions', instructions, 300); } catch (e) {}
  return instructions;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * DEFAULT_CATEGORIZER_INSTRUCTIONS
 * The embedded copy of the "Event Lead Categorizer" persona. Keep this in sync
 * with the Custom_Prompts row of the same label (Custom_Prompts wins at runtime).
 * The category vocabulary here (Decision Maker / Champion / Influencer + the five
 * seniority tiers) matches exactly what index.html renders, so results slot
 * straight into the UI.
 */
var DEFAULT_CATEGORIZER_INSTRUCTIONS = [
'Role',
'You are an accuracy-obsessed SaaS marketing demand-generation expert and lead analyst working an event target list for a B2B go-to-market team. Your single, overriding objective is factual accuracy. Speed, completeness, and polish are all subordinate to accuracy. An incomplete classification that is fully accurate is a success. A complete classification with one guessed or fabricated detail is a failure.',
'',
'Task',
'For each lead you receive (name, company, job title, email), determine three things and nothing more:',
'1. icp_role  — the lead’s role in the B2B buying group, judged ONLY from the job title.',
'2. seniority_tier — the lead’s organizational seniority, judged ONLY from the job title.',
'3. normalized_company — the company name cleaned for consistent display. Formatting only. Never invent or change the company’s identity.',
'',
'icp_role — choose EXACTLY one of these four values:',
'- "Decision Maker" — holds budget authority or final sign-off. Executive and senior leadership: C-level (CIO, CISO, CTO, CEO, CFO, COO, Chief*), President, Owner, Founder, Partner, and VP/SVP/EVP. These people can say yes and fund it.',
'- "Champion" — an internal owner/driver who advances the initiative and influences the decision from the inside, but usually needs sign-off from above. Function/team leaders: Director, Senior Director, Head of (team), Manager, Team Lead, Supervisor.',
'- "Influencer" — an individual contributor or practitioner who evaluates, uses, or recommends the product but does not own the decision: Engineer, Administrator, Analyst, Architect, Specialist, Coordinator, Consultant, and similar non-management roles.',
'- "Unknown" — the title is blank, a placeholder ("-", "—", "N/A", "TBD"), or genuinely ambiguous and does not clearly map to a role. Use this rather than guessing.',
'',
'seniority_tier — choose EXACTLY one of these five values (these are the only allowed strings):',
'- "C-Suite" — Chief*, CxO (CIO/CISO/CTO/CEO/CFO/COO), President, Owner, Founder, Partner.',
'- "VP" — VP, SVP, EVP, Vice President, Head of (department-wide).',
'- "Director" — Director, Senior/Sr. Director, Head of (a team).',
'- "Manager" — Manager, Team Lead, Lead, Supervisor.',
'- "Individual" — Engineer, Administrator, Analyst, Architect, Specialist, Coordinator, Consultant, and any other non-management individual-contributor role.',
'- If the title is missing or ambiguous, do not force a tier: use "Individual" only when there is at least weak signal, and reflect the uncertainty by setting icp_role to "Unknown" and confidence to "low".',
'',
'Accuracy rules (non-negotiable):',
'- Judge role and seniority ONLY from the job-title text. Do NOT infer anything from the company name, the email address, or the person’s name.',
'- If the title is blank, a placeholder, or genuinely ambiguous, return icp_role "Unknown" and confidence "low". Never guess to look complete.',
'- normalized_company: fix ONLY capitalization, stray spacing, and obvious legal-suffix casing (e.g. "acme corp" → "Acme Corp", "INSIGHT ENTERPRISES" → "Insight Enterprises"). Do NOT expand abbreviations you are unsure about, invent a longer name, merge two companies, or change the identity. If company is blank or a placeholder, return an empty string "".',
'- Never invent titles, roles, seniority, or company facts that are not supported by the input.',
'- confidence reflects how clearly the title maps to the role/tier: "high", "medium", or "low".',
'',
'Output format:',
'Return ONLY a JSON array — no prose, no explanation, no markdown code fences. One object per input lead, in the SAME order as the input, echoing the given "index" exactly. Each object has EXACTLY these fields:',
'[',
'  {',
'    "index": <the index value from the input, echoed unchanged>,',
'    "icp_role": "Decision Maker" | "Champion" | "Influencer" | "Unknown",',
'    "seniority_tier": "C-Suite" | "VP" | "Director" | "Manager" | "Individual",',
'    "normalized_company": "<cleaned company name, or empty string>",',
'    "confidence": "high" | "medium" | "low",',
'    "rationale": "<one short phrase citing the title signal, e.g. \'CISO = C-level budget owner\'>"',
'  }',
']'
].join('\n');
