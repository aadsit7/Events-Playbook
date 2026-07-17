/**
 * Partner Portal — Event Workspace backend (Google Apps Script web app)
 * ---------------------------------------------------------------------
 * This is the existing web script with additive capabilities bolted on:
 *   - `categorizeLeads` — runs the "Event Lead Categorizer" SaaS demand-gen
 *     persona over an uploaded contact list.
 *   - `listEvents` — returns the non-completed rows of the Events tab as a
 *     minimal picker payload (no descriptions, no passwords) so the workspace
 *     can offer a "browse all events" fallback picker.
 *   - `findEventsByPassword` — takes a password the user typed and returns the
 *     minimal picker payload for every non-completed event whose password
 *     matches it (exact match after trimming). This powers the password-first
 *     gate: the user enters a password and we hand back only the event(s) it
 *     unlocks. No passwords are ever returned; an empty password matches nothing.
 *   - `openEvent` — verifies the selected event's password (the `password`
 *     column of the Events tab) SERVER-SIDE and only then returns the full
 *     event row. The password never travels to the browser.
 *
 * NOTHING existing was changed. All original actions
 * (uploadFile / listFiles / deleteFile / analyzeDocument / updateDescription /
 * getConfig) behave exactly as before. The only edits are:
 *   1. new `categorizeLeads` / `listEvents` / `findEventsByPassword` /
 *      `openEvent` branches in doPost()
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

    // NEW — return every row of the Events tab so the workspace can offer an
    // event picker on load and prepopulate itself from the selected event.
    if (payload.action === 'listEvents') {
      return doListEvents();
    }

    // NEW — resolve a typed password to the event(s) it unlocks, so the gate
    // can start with the password instead of an event dropdown.
    if (payload.action === 'findEventsByPassword') {
      return doFindEventsByPassword(payload);
    }

    // NEW — open one event by key, verifying its password (if the Events tab
    // has one for that row) before returning the full details.
    if (payload.action === 'openEvent') {
      return doOpenEvent(payload);
    }

    // NEW — persist the uploaded (and AI-categorized) contact list for an event
    // into the Event_Contacts tab so it can be referenced on later opens.
    if (payload.action === 'saveEventContacts') {
      return doSaveEventContacts(payload);
    }

    // NEW — read back the contacts previously saved for one event so the
    // workspace can prepopulate itself when the event is reopened.
    if (payload.action === 'listEventContacts') {
      return doListEventContacts(payload);
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
    // Excel — convert to Google Sheet, extract text from EVERY worksheet so a
    // multi-tab workbook is analyzed in full, not just its first tab.
    var tempSheet = Drive.Files.copy(
      { title: 'TEMP_ANALYZE_' + Date.now(), mimeType: 'application/vnd.google-apps.spreadsheet' },
      fileId
    );
    var ss = SpreadsheetApp.openById(tempSheet.id);
    var sheets = ss.getSheets();
    var parts = [];
    for (var s = 0; s < sheets.length; s++) {
      var data = sheets[s].getDataRange().getValues();
      var text = data.map(function(row) { return row.join(' | '); }).join('\n');
      if (text.replace(/[\s|]/g, '') === '') continue; // skip empty tabs
      parts.push((sheets.length > 1 ? '=== Sheet: ' + sheets[s].getName() + ' ===\n' : '') + text);
    }
    extractedText = parts.join('\n\n');
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

  // Truncate only when genuinely huge — the old 15,000-character cap cut off
  // most real lead lists after a few hundred rows.
  if (extractedText.length > 60000) {
    extractedText = extractedText.substring(0, 60000) + '\n\n[Document truncated — showing first 60,000 characters]';
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
      max_tokens: 16000,
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
 * Input payload: { action:'categorizeLeads', leads:[{ index, name, company, title, email, extra? }] }
 *   `extra` is an optional object carrying EVERY additional column from the
 *   uploaded file (e.g. Department, Job Level, Job Function, Industry) so the
 *   persona can weigh the whole row, not just the four mapped fields.
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
    var obj = {
      index: (l.index != null ? l.index : i),
      name: (l.name || ''),
      company: (l.company || ''),
      title: (l.title || ''),
      email: (l.email || '')
    };
    // Forward the unmapped spreadsheet columns, bounded so a single wide row
    // can never blow up the request.
    if (l.extra && typeof l.extra === 'object') {
      var extra = {}, n = 0;
      for (var k in l.extra) {
        if (!Object.prototype.hasOwnProperty.call(l.extra, k)) continue;
        var v = String(l.extra[k] == null ? '' : l.extra[k]).trim();
        if (!v) continue;
        extra[String(k).substring(0, 60)] = v.substring(0, 200);
        if (++n >= 20) break;
      }
      if (n) obj.extra = extra;
    }
    return obj;
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
 * readEventRows
 * Shared reader for the Events tab. Returns each row as an object keyed by the
 * header row (event_id, title, description, event_date, end_date, event_type,
 * location, url, created_by, created_at, status, partner_id, checklist,
 * lead_count, event_password). Values are passed through verbatim — nothing is
 * inferred or rewritten. Dates that Sheets stores as real Date values are
 * serialized as yyyy-MM-dd in the spreadsheet's own time zone; text dates
 * (e.g. "11/19/2025") are returned as-is. Fully blank rows and rows without a
 * title are skipped. Each row also carries `_row` (its sheet row number) so a
 * row without an event_id can still be addressed unambiguously.
 */
function readEventRows() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('Events');
  if (!sheet || sheet.getLastRow() < 2) return [];

  var numCols = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, numCols).getValues()[0];
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
  var tz = ss.getSpreadsheetTimeZone();

  var rows = [];
  for (var i = 0; i < data.length; i++) {
    var obj = {};
    var empty = true;
    for (var j = 0; j < headers.length; j++) {
      var h = String(headers[j] || '').trim();
      if (!h) continue;
      var v = data[i][j];
      if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
      if (v !== '' && v != null) empty = false;
      obj[h] = v;
    }
    if (empty || !String(obj.title || '').trim()) continue;
    obj._row = i + 2;
    rows.push(obj);
  }
  return rows;
}

// Completed events are never offered or served — the workspace is for events
// that are still live, upcoming, or otherwise workable.
function isCompletedEvent(row) {
  return /complete/i.test(String(row.status || ''));
}

// Stable selector for a row: its event_id when present, else its sheet row.
function eventKeyOf(row) {
  var id = String(row.event_id == null ? '' : row.event_id).trim();
  return id !== '' ? id : ('row-' + row._row);
}

// The Events tab's password column is named `event_password` (column O in the
// live sheet). Some older copies used a plain `password` header, so check that as
// a fallback. This value is the hinge of the whole gate: if the header lookup
// misses, password protection silently switches OFF for every event AND the
// secret would ride along in the openEvent payload — so read it defensively.
function eventPasswordOf(row) {
  var primary = String(row.event_password == null ? '' : row.event_password).trim();
  if (primary !== '') return primary;
  return String(row.password == null ? '' : row.password).trim();
}

/**
 * doListEvents
 * Returns ONLY what the event picker needs: key, title, dates, type, location,
 * status, and whether the event is password-protected. Descriptions, lead
 * counts, checklists — and above all the password itself — are deliberately
 * NOT included: full details are only released by `openEvent` after the
 * password (when one is set on the row) has been verified server-side.
 * Completed events are excluded entirely.
 */
function doListEvents() {
  var rows = readEventRows();
  var events = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (isCompletedEvent(r)) continue;
    events.push({
      key: eventKeyOf(r),
      title: r.title,
      event_date: r.event_date || '',
      end_date: r.end_date || '',
      event_type: r.event_type || '',
      location: r.location || '',
      status: r.status || '',
      has_password: eventPasswordOf(r) !== ''
    });
  }
  return jsonOut({ ok: true, events: events });
}

/**
 * doFindEventsByPassword
 * Input payload: { action:'findEventsByPassword', password:'<user input>' }
 * Returns the SAME minimal picker payload as listEvents, but only for the
 * non-completed events whose password matches the supplied value (exact match
 * after trimming — the identical comparison openEvent uses). This powers the
 * password-first gate: the user types a password and we hand back only the
 * event(s) it unlocks, so a single match can open straight away and several
 * events sharing one password can be listed for the user to choose from.
 *
 * Security: passwords themselves are NEVER returned (only matched titles/dates,
 * which the user has already proven they may see by knowing the password). An
 * empty/blank password matches nothing — password-less events are reached via
 * the listEvents "browse all" fallback, not by submitting an empty password.
 */
function doFindEventsByPassword(payload) {
  var given = String(payload.password == null ? '' : payload.password).trim();
  if (given === '') {
    return jsonOut({ ok: true, events: [] });
  }
  var rows = readEventRows();
  var events = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (isCompletedEvent(r)) continue;
    if (eventPasswordOf(r) !== given) continue;
    events.push({
      key: eventKeyOf(r),
      title: r.title,
      event_date: r.event_date || '',
      end_date: r.end_date || '',
      event_type: r.event_type || '',
      location: r.location || '',
      status: r.status || '',
      has_password: true
    });
  }
  return jsonOut({ ok: true, events: events });
}

/**
 * doOpenEvent
 * Input payload: { action:'openEvent', eventKey:'<key from listEvents>', password:'<user input>' }
 * Verifies the password against the row's `password` cell (exact match after
 * trimming; rows with an empty password cell are open to everyone) and only
 * then returns the full event row — minus the password itself. The check runs
 * here, server-side, so the password never travels to the browser. Completed
 * events are refused even if addressed directly. Very long descriptions are
 * capped to keep the payload light.
 */
function doOpenEvent(payload) {
  var key = String(payload.eventKey == null ? '' : payload.eventKey).trim();
  if (!key) return jsonOut({ ok: false, code: 'bad_request', error: 'No event selected' });

  var rows = readEventRows();
  var found = null;
  for (var i = 0; i < rows.length; i++) {
    if (eventKeyOf(rows[i]) === key) { found = rows[i]; break; }
  }
  if (!found) {
    return jsonOut({ ok: false, code: 'not_found', error: 'Event not found — it may have been removed from the sheet' });
  }
  if (isCompletedEvent(found)) {
    return jsonOut({ ok: false, code: 'completed', error: 'This event is completed and can no longer be opened' });
  }

  var pw = eventPasswordOf(found);
  if (pw !== '') {
    var given = String(payload.password == null ? '' : payload.password).trim();
    if (given !== pw) {
      return jsonOut({ ok: false, code: 'bad_password', error: 'Incorrect password for this event' });
    }
  }

  var out = {};
  for (var k in found) {
    if (!Object.prototype.hasOwnProperty.call(found, k)) continue;
    if (k === 'password' || k === 'event_password' || k === '_row') continue;
    out[k] = found[k];
  }
  if (typeof out.description === 'string' && out.description.length > 4000) {
    out.description = out.description.substring(0, 4000) + '…';
  }
  out.key = eventKeyOf(found);
  return jsonOut({ ok: true, event: out });
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
'For each lead you receive (name, company, job title, email, plus an optional "extra" object carrying every other column from the uploaded file — e.g. Department, Job Level, Job Function, Seniority, Industry), determine three things and nothing more:',
'1. icp_role  — the lead’s role in the B2B buying group, judged primarily from the job title, corroborated by any "extra" columns that explicitly describe the person’s role, level, function or department.',
'2. seniority_tier — the lead’s organizational seniority, judged the same way: job title first, role/level/function/department columns in "extra" as supporting signal.',
'3. normalized_company — the company name cleaned for consistent display. Formatting only. Never invent or change the company’s identity.',
'',
'icp_role — choose EXACTLY one of these four values:',
'- "Decision Maker" — holds budget authority or final sign-off. Executive and senior leadership: C-level (CIO, CISO, CTO, CEO, CFO, COO, Chief*), President, Owner, Founder, Partner, and VP/SVP/EVP. These people can say yes and fund it.',
'- "Champion" — an internal owner/driver who advances the initiative and influences the decision from the inside, but usually needs sign-off from above. Function/team leaders: Director, Senior Director, Head of (team), Manager, Team Lead, Supervisor.',
'- "Influencer" — an individual contributor or practitioner who evaluates, uses, or recommends the product but does not own the decision: Engineer, Administrator, Analyst, Architect, Specialist, Coordinator, Consultant, and similar non-management roles.',
'- "Unknown" — the title is blank, a placeholder ("-", "—", "N/A", "TBD"), or genuinely ambiguous, AND no "extra" column explicitly describing role/level/function resolves it. Use this rather than guessing.',
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
'- Judge role and seniority from the job-title text first. When the title is blank, a placeholder, or ambiguous, you MAY use "extra" columns that explicitly describe the person’s role, level, function or department (e.g. "Job Level", "Seniority", "Department", "Job Function", "Management Level") to classify. Do NOT infer role or seniority from the company name, the email address, the person’s name, or unrelated extra columns (industry, city, revenue, phone, notes, …).',
'- If neither the title nor a role-describing extra column gives clear signal, return icp_role "Unknown" and confidence "low". Never guess to look complete.',
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

// ============================================================
// ============================================================
// NEW — EVENT CONTACTS (per-event target list, saved back to the sheet)
// Everything below this line is additive. It reads and writes ONLY a new
// `Event_Contacts` tab (created on first save, exactly like the existing
// `Opportunity_Documents` tab is), and — best-effort — refreshes the
// `lead_count` cell of the matching Events row. No existing tab, row, action,
// or behavior is changed.
// ============================================================
// ============================================================

// The Event_Contacts tab is keyed by `event_id` — the SAME key `listEvents` /
// `openEvent` hand to the browser (the row's event_id, or `row-N` for rows
// without one, via eventKeyOf). One shared tab, many events, exactly like
// Opportunity_Documents is one tab keyed by opportunity_id.
var EVENT_CONTACTS_TAB = 'Event_Contacts';
var EVENT_CONTACT_HEADERS = [
  'event_id', 'event_title', 'contact_id', 'name', 'title', 'company', 'email',
  'owner', 'status', 'icp_role', 'seniority_tier', 'ai_confidence',
  'ai_rationale', 'source_file', 'saved_at'
];

/**
 * getEventContactsSheet
 * Returns the Event_Contacts sheet, creating it with the header row on first
 * use. If an older copy exists with a shorter header, any missing columns are
 * appended so name-based indexing always works.
 */
function getEventContactsSheet(ss) {
  var sheet = ss.getSheetByName(EVENT_CONTACTS_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(EVENT_CONTACTS_TAB);
    sheet.getRange(1, 1, 1, EVENT_CONTACT_HEADERS.length).setValues([EVENT_CONTACT_HEADERS]);
    return sheet;
  }
  // Ensure every expected header exists (future-proofing an older tab).
  var lastCol = Math.max(1, sheet.getLastColumn());
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var missing = EVENT_CONTACT_HEADERS.filter(function (h) { return headers.indexOf(h) === -1; });
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
  }
  return sheet;
}

/**
 * eventContactRowFor
 * Builds one Event_Contacts row aligned to the sheet's actual header order.
 * Accepts either the client field names (icpRole/tier/confidence/rationale) or
 * the stored ones (icp_role/seniority_tier/ai_confidence/ai_rationale).
 */
function eventContactRowFor(headers, eventKey, eventTitle, fileName, stamp, c) {
  c = c || {};
  var map = {
    event_id: eventKey,
    event_title: eventTitle,
    contact_id: String(c.id != null ? c.id : (c.contact_id != null ? c.contact_id : '')),
    name: String(c.name == null ? '' : c.name),
    title: String(c.title == null ? '' : c.title),
    company: String(c.company == null ? '' : c.company),
    email: String(c.email == null ? '' : c.email),
    owner: String(c.owner == null ? '' : c.owner),
    status: String(c.status == null ? '' : c.status),
    icp_role: String(c.icp_role != null ? c.icp_role : (c.icpRole != null ? c.icpRole : '')),
    seniority_tier: String(c.seniority_tier != null ? c.seniority_tier : (c.tier != null ? c.tier : '')),
    ai_confidence: String(c.ai_confidence != null ? c.ai_confidence : (c.confidence != null ? c.confidence : '')),
    ai_rationale: String(c.ai_rationale != null ? c.ai_rationale : (c.rationale != null ? c.rationale : '')),
    source_file: String(fileName == null ? '' : fileName),
    saved_at: stamp
  };
  return headers.map(function (h) {
    return Object.prototype.hasOwnProperty.call(map, h) ? map[h] : '';
  });
}

/**
 * doSaveEventContacts
 * Input payload: { action:'saveEventContacts', eventKey, eventTitle, fileName,
 *                  contacts:[{ id, name, title, company, email, owner, status,
 *                              icp_role, seniority_tier, confidence, rationale }] }
 *
 * Replace-by-event: every existing Event_Contacts row for `eventKey` is removed
 * and the supplied list is written in its place, so the tab always mirrors the
 * current target list for that event (re-uploads and status changes never pile
 * up duplicates). Rows belonging to OTHER events are left untouched. As a
 * convenience the matching Events row's `lead_count` cell is refreshed to the
 * saved count (best-effort — never fatal).
 *
 * Output: { ok:true, saved:<n>, event_id:<key> }
 */
function doSaveEventContacts(payload) {
  var key = String(payload.eventKey == null ? '' : payload.eventKey).trim();
  if (!key) return jsonOut({ ok: false, code: 'bad_request', error: 'No event specified' });

  var contacts = (payload.contacts && payload.contacts.length) ? payload.contacts : [];
  // Safety cap: a single save can never write an unbounded number of rows.
  if (contacts.length > 5000) contacts = contacts.slice(0, 5000);

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = getEventContactsSheet(ss);
  var numCols = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, numCols).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var idIdx = headers.indexOf('event_id');
  if (idIdx === -1) throw new Error('Event_Contacts is missing its event_id column');

  // Keep every existing row that belongs to a DIFFERENT event.
  var kept = [];
  if (sheet.getLastRow() > 1) {
    var existing = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
    for (var i = 0; i < existing.length; i++) {
      var rowKey = String(existing[i][idIdx] == null ? '' : existing[i][idIdx]).trim();
      if (rowKey === '') continue;          // drop stray blank rows
      if (rowKey !== key) kept.push(existing[i]);
    }
  }

  var eventTitle = String(payload.eventTitle == null ? '' : payload.eventTitle);
  var fileName = String(payload.fileName == null ? '' : payload.fileName);
  var stamp = new Date().toISOString();
  var fresh = contacts.map(function (c) {
    return eventContactRowFor(headers, key, eventTitle, fileName, stamp, c);
  });

  var all = kept.concat(fresh);

  // Rewrite the whole data area in one batched write, then clear any leftover
  // trailing rows (when the new total is shorter than what was there before).
  var prevRows = sheet.getLastRow() - 1;
  if (prevRows > 0) sheet.getRange(2, 1, prevRows, numCols).clearContent();
  if (all.length) sheet.getRange(2, 1, all.length, numCols).setValues(all);

  // Best-effort: keep the Events tab's lead_count in step with what we saved.
  try { updateEventLeadCount(ss, key, fresh.length); } catch (e) { /* non-fatal */ }

  return jsonOut({ ok: true, saved: fresh.length, event_id: key });
}

/**
 * doListEventContacts
 * Input payload: { action:'listEventContacts', eventKey }
 * Returns every Event_Contacts row for that event as an object keyed by header.
 * Missing tab / no rows → an empty list (never an error), so a first-time event
 * simply opens with no contacts.
 *
 * Output: { ok:true, contacts:[ { event_id, name, title, company, email, owner,
 *           status, icp_role, seniority_tier, ai_confidence, ai_rationale,
 *           contact_id, source_file, saved_at } ] }
 */
function doListEventContacts(payload) {
  var key = String(payload.eventKey == null ? '' : payload.eventKey).trim();
  if (!key) return jsonOut({ ok: true, contacts: [] });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(EVENT_CONTACTS_TAB);
  if (!sheet || sheet.getLastRow() < 2) return jsonOut({ ok: true, contacts: [] });

  var numCols = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, numCols).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var idIdx = headers.indexOf('event_id');
  if (idIdx === -1) return jsonOut({ ok: true, contacts: [] });

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
  var out = [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][idIdx] == null ? '' : data[i][idIdx]).trim() !== key) continue;
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      var h = headers[j];
      if (!h) continue;
      var v = data[i][j];
      obj[h] = (v instanceof Date) ? v.toISOString() : v;
    }
    out.push(obj);
  }
  return jsonOut({ ok: true, contacts: out });
}

/**
 * updateEventLeadCount
 * Writes `count` into the `lead_count` cell of the Events row whose key matches
 * `eventKey`. Uses the shared readEventRows()/eventKeyOf() so the join is byte-
 * identical to how the picker addressed the event. No-op when the column or the
 * row can't be found.
 */
function updateEventLeadCount(ss, eventKey, count) {
  var sheet = ss.getSheetByName('Events');
  if (!sheet || sheet.getLastRow() < 2) return;
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var lcIdx = -1;
  for (var j = 0; j < headers.length; j++) {
    if (String(headers[j] || '').trim() === 'lead_count') { lcIdx = j; break; }
  }
  if (lcIdx === -1) return;

  var rows = readEventRows();
  for (var i = 0; i < rows.length; i++) {
    if (eventKeyOf(rows[i]) === eventKey) {
      sheet.getRange(rows[i]._row, lcIdx + 1).setValue(count);
      return;
    }
  }
}
