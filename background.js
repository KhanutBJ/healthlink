/**
 * HealthLink Document Checker: Background Service Worker
 * Handles side panel lifecycle, message routing, and document fetching.
 */

// Set via the side panel's settings section; never hardcode a key here.
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (tab?.url?.includes('hosregis.healthlink.go.th') && chrome.sidePanel) {
      await chrome.sidePanel.open({ tabId: tab.id });
    }
  } catch (e) {
    console.warn('[HL] sidePanel.open failed:', e.message);
  }
});

// Auto-enable side panel on matching pages
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab?.url?.includes('hosregis.healthlink.go.th/admin')) {
    try {
      if (chrome.sidePanel) {
        await chrome.sidePanel.setOptions({
          tabId,
          path: 'sidepanel.html',
          enabled: true,
        });
      }
    } catch (e) {
      console.warn('[HL] sidePanel.setOptions failed:', e.message);
    }
  }
});

// Message router between content script side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return;

  switch (message.type) {
    case 'MODAL_DATA':
    case 'API_INTERCEPTED':
    case 'DOCUMENT_URLS_FOUND':
    case 'CHECKLIST_DATA':
      // Forward to side panel
      broadcastToSidePanel(message);
      break;

    case 'START_BULK_AUTOMATION':
      try {
        if (chrome.sidePanel && sender?.tab?.id) {
          chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
        }
      } catch {
        /* ignore */
      }
      // Give sidepanel time to open and attach listeners
      setTimeout(() => broadcastToSidePanel(message), 500);
      break;

    case 'FETCH_DOCUMENT':
      fetchDocument(message.url, message.cookies)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message }));
      return true;

    case 'FETCH_REGISTRY':
      fetchRegistryFromBackground()
        .then((records) => sendResponse({ records }))
        .catch((err) => sendResponse({ records: [], error: err.message }));
      return true;

    case 'GEMINI_REQUEST':
      callGeminiAPI(message.payload)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message }));
      return true;

    case 'OPEN_SIDE_PANEL':
      try {
        if (chrome.sidePanel && sender?.tab?.id) {
          chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
        }
      } catch {
        /* ignore */
      }
      break;

    case 'GET_SETTINGS':
      chrome.storage.local.get(['geminiApiKey', 'autoCheck'], (data) => {
        sendResponse(data || {});
      });
      return true;

    case 'SAVE_SETTINGS':
      chrome.storage.local.set(message.settings || {}, () => {
        sendResponse({ success: true });
      });
      return true;
  }
});

/**
 * Broadcast message to side panel
 */
function broadcastToSidePanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

/**
 * Fetch a document from the HealthLink server
 */
async function fetchDocument(url, cookies) {
  try {
    const headers = {};
    if (cookies) headers['Cookie'] = cookies;

    let absoluteUrl = url;
    if (url.startsWith('/')) {
      absoluteUrl = 'https://hosregis.healthlink.go.th' + url;
    }

    const response = await fetch(absoluteUrl, {
      method: 'GET',
      headers,
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const arrayBuffer = await response.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuffer);

    return { success: true, data: base64, contentType, size: arrayBuffer.byteLength };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Call Gemini API for document analysis
 */
async function callGeminiAPI(payload) {
  try {
    // The key is read here and nowhere else: it must never be committed to
    // source or held in the side panel / content script.
    const { geminiApiKey, geminiModel } = await chrome.storage.local.get(['geminiApiKey', 'geminiModel']);
    if (!geminiApiKey) {
      return {
        success: false,
        error: 'ยังไม่ได้ตั้งค่า Gemini API key: กรอกใน Side Panel (ส่วน ตั้งค่า) ก่อนใช้งาน AI Triage',
      };
    }

    const model = geminiModel || DEFAULT_GEMINI_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API ${response.status}: ${errText}`);
    }

    const data = await response.json();
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

const REGISTRY_COLS = [
  'hu_code',
  'hu_name',
  'hu_type_id',
  'create_member_id',
  'create_date',
  'sla',
  'status',
  'status_connect',
  'tool',
];

async function fetchRegistryPageBackground(start, length) {
  const body = new URLSearchParams();
  body.set('draw', '1');
  body.set('start', String(start));
  body.set('length', String(length));
  REGISTRY_COLS.forEach((c, i) => {
    body.set(`columns[${i}][data]`, c);
    body.set(`columns[${i}][name]`, c);
    body.set(`columns[${i}][searchable]`, 'true');
    body.set(`columns[${i}][orderable]`, 'true');
    body.set(`columns[${i}][search][value]`, '');
    body.set(`columns[${i}][search][regex]`, 'false');
  });
  body.set('search[value]', '');
  body.set('search[regex]', 'false');

  const res = await fetch('https://hosregis.healthlink.go.th/admin/health_unit_datatable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
    body,
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
  return res.json();
}

async function fetchRegistryFromBackground() {
  const strip = (v) =>
    String(v == null ? '' : v)
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const first = await fetchRegistryPageBackground(0, 500);
  const total = first.recordsTotal || 0;
  let rows = first.data || [];

  for (let s = rows.length; s < total; s += 500) {
    const next = await fetchRegistryPageBackground(s, 500);
    if (!next.data?.length) break;
    rows = rows.concat(next.data);
  }

  return rows.map((r) => ({
    id: strip(r.hu_id),
    code: strip(r.hu_code),
    name: strip(r.hu_name),
    type: strip(r.hu_type_name),
    status: strip(r.status),
    owner: strip(`${r.member_fname || ''} ${r.member_lname || ''}`),
    sla: parseInt(String(strip(r.sla)).replace(/\D/g, ''), 10) || 0,
  }));
}
