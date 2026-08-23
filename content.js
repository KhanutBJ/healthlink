/**
 * content.js: Content script for hosregis.healthlink.go.th/admin/*
 *
 * Handles TWO page types:
 * 1. /admin/health_unit : Table list with modal popups
 * 2. /admin/checklist/:id: Document review page (3-column layout)
 *
 * Responsibilities:
 * Extract registration + form data from the DOM
 * Find document file URLs (links to PDFs / images)
 * Relay intercepted API responses to the side panel
 * Provide a floating status indicator
 */
(() => {
  'use strict';

  // ===================== STATE =====================
  let currentData = null;
  let interceptedApi = [];
  let isModalOpen = false;

  // ===================== INIT =====================
  function init() {
    console.log('[HL] content script loaded on', location.pathname);

    window.addEventListener('message', onPageMessage);
    chrome.runtime.onMessage.addListener(onExtensionMessage);
    addIndicator();

    if (isChecklistPage()) {
      // Checklist page: extract immediately once DOM settles
      waitForElement('.container-fluid, [class*="checklist"], form', () => {
        setTimeout(extractChecklistPage, 800);
      });
    } else {
      // Health-unit list page: observe for modal open
      observeModal();
    }
  }

  function isChecklistPage() {
    return /\/admin\/checklist\/\d+/.test(location.pathname);
  }

  // ===================== CHECKLIST PAGE =====================

  function extractChecklistPage() {
    const body = document.body;
    const text = body.innerText || '';

    const data = {
      source: 'checklist',
      url: location.href,
      raw: text.substring(0, 5000),

      // ---- Header info ----
      hcode: extractText(body, /รหัสหน่วยบริการ[:\s]*([\w\d]+)/),
      requestType: extractText(body, /ประเภทการสมัคร[:\s]*(.+)/),

      // ---- ข้อมูลหน่วยบริการ (left form) ----
      healthUnitType:
        getSelectValue('ประเภท\nหน่วย\nบริการ') ||
        getSelectValue('ประเภทหน่วยบริการ') ||
        getInputNear('ประเภท'),
      healthUnitName:
        getInputNear('ชื่อหน่วยงาน') ||
        getInputNear('ชื่อสถานพยาบาล') ||
        extractText(body, /ชื่อหน่วยงาน\/ชื่อสถาน\s*พยาบาล[:\s]*(.+)/),
      healthUnitHCode:
        getInputNear('รหัสหน่วย\nงานบริการ\nสุขภาพ') ||
        getInputNear('รหัสหน่วยงานบริการสุขภาพ') ||
        extractText(body, /รหัสหน่วย\s*งานบริการ\s*สุขภาพ[:\s]*([\w\d]+)/),
      address: getInputNear('ที่อยู่'),
      province: getSelectValue('จังหวัด'),
      district: getSelectValue('อำเภอ'),
      subdistrict: getSelectValue('ตำบล') || getSelectValue('แขวง'),
      postalCode: getInputNear('รหัสไปรษณีย์') || getInputNear('ไปรษณีย์'),
      phone: getInputNear('เบอร์โทรศัพท์') || getInputNear('โทรศัพท์'),
      email: getInputNear('อีเมลหน่วยงาน') || getInputNear('อีเมล'),

      // ---- ผู้มีอำนาจ ----
      authorityInfo: extractAuthorityInfo(),

      // ---- Hospital Admin (HA) ----
      adminInfo: extractAdminInfo(),

      // ---- Documents ----
      documents: extractDocumentLinks(),
      documentUrls: [],

      // ---- Checklist items (from right panel) ----
      checklist: extractChecklistItems(),

      // ---- Review status ----
      reviewStatus: getRadioValue('ผลการตรวจ'),

      // ---- This entry's own checklist shape ----
      // Which items exist varies by unit type (a ร้านยา has ขย.5, a clinic has
      // สพ.7/สพ.19, HA count differs), so checks are driven by what is on the
      // page rather than a fixed list.
      huId: (location.pathname.match(/\/checklist\/(\d+)/) || [])[1] || null,
      checklistGroups: extractChecklistGroups(),

      // ---- The applicant's own declarations ----
      // These are NOT reviewer checklist items and are never auto-ticked, but
      // they must be accepted for the application to be valid: the checklist
      // page was not verifying them at all.
      agreements: extractAgreements(),
    };

    // Fallback: extract from visible text patterns
    if (!data.hcode) data.hcode = extractText(body, /รหัสหน่วยบริการ[:\s]*([\dA-Z]+)/);
    if (!data.hcode) data.hcode = data.healthUnitHCode;

    // Extract unit name from the page title / h2
    if (!data.healthUnitName) {
      const h2 = document.querySelector('h2, h3');
      if (h2) {
        const m = h2.textContent.match(/Check\s*List\s*:\s*(.+)/i);
        if (m) data.healthUnitName = m[1].trim();
      }
    }

    currentData = data;
    console.log('[HL] Checklist data extracted', data);
    sendToBackground('CHECKLIST_DATA', { registration: data });
    updateIndicator('active');
  }

  const HEADING_SEL = 'h1, h2, h3, h4, h5, h6';

  /**
   * Return the run of elements, in document order, from the heading matching
   * `startRx` up to (not including) the next heading matching any of `stopRxs`.
   *
   * The owner (ประเภท) and HA sections are siblings inside one flat
   * `div.row.disabledForm`, so there is no wrapping container to scope to
   * document-order slicing is what separates them.
   */
  function sectionScope(startRx, stopRxs) {
    const all = [...document.querySelectorAll('*')];
    const startIdx = all.findIndex((el) => el.matches(HEADING_SEL) && startRx.test(el.textContent.trim()));
    if (startIdx === -1) return null;

    let endIdx = all.length;
    for (let i = startIdx + 1; i < all.length; i++) {
      const el = all[i];
      if (el.matches(HEADING_SEL) && stopRxs.some((rx) => rx.test(el.textContent.trim()))) {
        endIdx = i;
        break;
      }
    }
    return all.slice(startIdx, endIdx);
  }

  function extractPersonInSection(startRx, stopRxs) {
    const info = {
      prefix: null,
      firstName: null,
      lastName: null,
      name: null,
      idNumber: null,
      phone: null,
      email: null,
      idDocUrl: null,
    };
    const scope = sectionScope(startRx, stopRxs);
    if (!scope) return info;

    function findVal(labelText) {
      const label = scope.find(
        (el) =>
          el.matches('label, span, div, p, td, th') &&
          el.textContent.trim().startsWith(labelText) &&
          el.textContent.trim().length < labelText.length + 20,
      );
      if (!label) return null;
      const input = findNearestInput(label);
      if (!input) return null;
      return input.tagName === 'SELECT'
        ? input.options[input.selectedIndex]?.text || input.value
        : input.value;
    }

    info.prefix = findVal('คำนำหน้า');
    info.firstName = findVal('ชื่อ:');
    info.lastName = findVal('นามสกุล:');
    info.idNumber = findVal('หมายเลขบัตรประจำตัวประชาชน') || findVal('เลขบัตรประชาชน');
    info.phone = findVal('เบอร์โทรศัพท์');
    info.email = findVal('อีเมล:');

    if (info.firstName || info.lastName) {
      info.name = [info.prefix, info.firstName, info.lastName].filter(Boolean).join(' ');
    }

    // The ID-card link is a fancybox anchor: href is "javascript:;" and the real
    // file lives in data-src.
    const link = scope.find(
      (el) =>
        el.tagName === 'A' && (el.getAttribute('data-src') || '').match(/\.(pdf|jpg|jpeg|png|gif)(\?|$)/i),
    );
    if (link) info.idDocUrl = absoluteUrl(link.getAttribute('data-src'));

    return info;
  }

  const HA_HEADING = /ข้อมูลสร้างบัญชีการใช้งานระบบ Hospital Administrator/;
  const DOCS_HEADING = /^เอกสารแนบ$/;
  const CHECKLIST_HEADING = /^รายการตรวจสอบ$/;

  function extractAuthorityInfo() {
    // The owner / ผู้มีอำนาจ block is headed by a bare "ประเภท" heading
    // (บุคคลธรรมดา / นิติบุคคล) and runs until the HA section.
    return extractPersonInSection(/^ประเภท$/, [HA_HEADING, DOCS_HEADING, CHECKLIST_HEADING]);
  }

  function extractAdminInfo() {
    return extractPersonInSection(HA_HEADING, [DOCS_HEADING, CHECKLIST_HEADING]);
  }

  function absoluteUrl(href) {
    if (!href) return null;
    try {
      return new URL(href, location.origin).href;
    } catch {
      return null;
    }
  }

  /**
   * Collect every document on the page.
   *
   * All four checklist documents are present in the DOM at once as fancybox
   * anchors (`href="javascript:;"` + `data-src="https://.../files/..."`), so
   * there is no need to click through the ถัดไป steps to reach them.
   */
  function extractDocumentLinks() {
    const docs = [];
    const FILE_RX = /\.(pdf|jpg|jpeg|png|gif|doc|docx)(\?|$)/i;

    function push(href, text) {
      const url = absoluteUrl(href);
      if (!url || url.startsWith('javascript:') || url.endsWith('#')) return;
      if (docs.some((d) => d.url === url)) return;
      docs.push({ url, text: text || url.split('/').pop(), type: guessDocType(`${text || ''} ${url}`) });
    }

    document.querySelectorAll('a, button').forEach((el) => {
      const text = el.textContent.trim();

      // Lightbox links keep the real file in data-src.
      const dataSrc = el.getAttribute('data-src');
      if (dataSrc && FILE_RX.test(dataSrc)) {
        push(dataSrc, text);
        return;
      }

      let href = el.getAttribute('href');
      const onclick = el.getAttribute('onclick');

      if (!href || href.startsWith('javascript:') || href === '#') {
        if (!onclick) return;
        const match =
          onclick.match(/['"]([^'"]+\.(pdf|jpg|jpeg|png|gif|doc|docx))['"]/i) ||
          onclick.match(/window\.open\(['"]([^'"]+)['"]/i) ||
          onclick.match(/downloadFile\(['"]([^'"]+)['"]/i);
        if (match) href = match[1];
        else {
          const backupMatch = onclick.match(/['"]([^'"]+\/[^'"]+)['"]/i);
          if (backupMatch) href = backupMatch[1];
          else return;
        }
      } else {
        href = el.href;
      }

      const isExplicitFile = FILE_RX.test(href);
      if (text === '' && !isExplicitFile) return;

      if (
        text.includes('เอกสาร') ||
        text.includes('สำเนา') ||
        isExplicitFile ||
        href.includes('/upload') ||
        href.includes('/file') ||
        href.includes('/document') ||
        href.includes('/storage')
      ) {
        push(href, text);
      }
    });

    // Inline viewers (the step pane renders the current document in an iframe).
    document.querySelectorAll('iframe[src], embed[src], object[data]').forEach((el) => {
      const src = el.getAttribute('src') || el.getAttribute('data');
      if (src && FILE_RX.test(src)) push(src, '');
    });

    return docs;
  }

  /**
   * Kept for message-compatibility with the side panel.
   *
   * This used to click กลับ/ถัดไป to walk all four steps. It no longer does:
   * on this page each click advances *two* steps (13, 31), so step 2 (สพ.19)
   * was never visited and its document was never scanned. Every document is
   * reachable from the DOM directly, so no navigation is needed: and the
   * reviewer is no longer left parked on a different step than they started on.
   */
  async function scrapeAllChecklistPages() {
    return extractDocumentLinks();
  }

  /**
   * Read the reviewer checklist exactly as this entry renders it:
   * one group per required document, each with its own verification items.
   */
  function extractAgreements() {
    const out = { serviceAgreement: null, dataProcessing: null, dataSharing: null, termsAccepted: null };
    document.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      if ((cb.name || '').startsWith('check_detail')) return;
      const label = (cb.closest('label') || cb.parentElement)?.textContent || '';
      if (/Service Agreement/i.test(label)) out.serviceAgreement = cb.checked;
      else if (/Data Processing/i.test(label)) out.dataProcessing = cb.checked;
      else if (/Data Sharing/i.test(label)) out.dataSharing = cb.checked;
      else if (/ยอมรับเงื่อนไข/.test(label)) out.termsAccepted = cb.checked;
    });
    return out;
  }

  function extractChecklistGroups() {
    const groups = new Map();
    document.querySelectorAll('input[type="checkbox"][name^="check_detail"]').forEach((cb) => {
      const m = cb.name.match(/check_detail\[(\d+)\]\[(\d+)\]/);
      if (!m) return;
      const [, groupId, itemId] = m;
      const label = (cb.closest('label') || cb.parentElement)?.textContent.trim().replace(/\s+/g, ' ') || '';
      if (!groups.has(groupId)) groups.set(groupId, { groupId, items: [] });
      groups.get(groupId).items.push({ itemId, label, checked: cb.checked });
    });

    // Pair each group with its step heading (รายการตรวจสอบ N / M : <document>)
    const titles = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .map((h) => h.textContent.trim().replace(/\s+/g, ' '))
      .filter((t) => /^รายการตรวจสอบ\s*\d+\s*\/\s*\d+\s*:/.test(t))
      .map((t) => t.replace(/^รายการตรวจสอบ\s*\d+\s*\/\s*\d+\s*:\s*/, ''));

    return [...groups.values()].map((g, i) => ({ ...g, document: titles[i] || null }));
  }

  function extractChecklistItems() {
    const items = [];

    // Items from the header list (รายการตรวจสอบ 1, 2, 3...)
    const headerItems = document.body.innerText.matchAll(/รายการตรวจสอบ\s*(\d+)\s*:\s*(.+?)(?=\n|$)/g);
    for (const m of headerItems) {
      items.push({ number: parseInt(m[1]), name: m[2].trim() });
    }

    // Checkbox checklist items from the right panel.
    // Scoped to check_detail[...] to match what the checker is allowed to tick
    // the applicant's agreement boxes are not reviewer checklist items.
    const checkboxes = document.querySelectorAll('input[type="checkbox"][name^="check_detail"]');
    checkboxes.forEach((cb) => {
      const label = cb.closest('label') || cb.parentElement;
      if (label) {
        const text = label.textContent.trim();
        if (text.length > 5 && !text.includes('เลือก')) {
          items.push({ name: text, checked: cb.checked, fromPanel: true });
        }
      }
    });

    return items;
  }

  // ===================== HEALTH UNIT LIST PAGE =====================

  function observeModal() {
    const observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) checkForModal(node);
        }
        if (mut.type === 'attributes' && mut.target.nodeType === Node.ELEMENT_NODE) {
          checkForModal(mut.target);
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
    setInterval(checkModalState, 1200);
  }

  function checkForModal(node) {
    const selectors = [
      '.modal.show',
      '.modal.in',
      '[role="dialog"]',
      '.modal[style*="display: block"]',
      '.modal[style*="display:block"]',
    ];
    for (const sel of selectors) {
      let modal = null;
      try {
        modal = node.matches?.(sel) ? node : node.querySelector?.(sel);
      } catch {
        continue;
      }
      if (modal) {
        onModalOpen(modal);
        return;
      }
    }
  }

  function checkModalState() {
    const modals = document.querySelectorAll(
      '.modal.show, .modal.in, [role="dialog"], .modal[style*="display: block"]',
    );
    const visible = [...modals].some((m) => {
      const s = getComputedStyle(m);
      return s.display !== 'none' && s.visibility !== 'hidden';
    });
    if (visible && !isModalOpen) onModalOpen(modals[0]);
    else if (!visible && isModalOpen) {
      isModalOpen = false;
      updateIndicator('idle');
    }
  }

  function onModalOpen(modal) {
    isModalOpen = true;
    setTimeout(() => {
      const data = extractModalData(modal);
      if (data) {
        currentData = data;
        sendToBackground('MODAL_DATA', { registration: data });
        updateIndicator('active');
      }
    }, 500);
  }

  function extractModalData(modal) {
    const text = modal.innerText || '';
    const data = {
      source: 'modal',
      raw: text.substring(0, 3000),
      hcode: null,
      healthUnitName: null,
      healthUnitType: null,
      adminInfo: { name: null, email: null },
      authorityInfo: { name: null, email: null, verified: false, verificationDate: null },
      agreements: { serviceAgreement: false, dataProcessing: false, dataSharing: false },
      checklist: [],
      connectionStatus: null,
      documents: [],
      documentUrls: [],
    };

    // From the active table row
    const row = document.querySelector('table tbody tr.hl-active-row');
    if (row) {
      const cells = row.querySelectorAll('td');
      if (cells[0]) data.hcode = cells[0].textContent.trim();
      if (cells[1]) data.healthUnitName = cells[1].textContent.trim();
      if (cells[2]) data.healthUnitType = cells[2].textContent.trim();
    }

    // Parse modal text
    const nameMatch = text.match(/ชื่อ\s*Admin[:\s]*(.+?)(?:\n|อีเมล)/s);
    if (nameMatch) data.adminInfo.name = nameMatch[1].trim();
    const emailMatch = text.match(/อีเมล[:\s]*([^\n\s]+@[^\n\s]+)/);
    if (emailMatch) data.adminInfo.email = emailMatch[1].trim();

    const authSection = text.match(/ข้อมูลผู้มีอำนาจ([\s\S]*?)(?:รายการตรวจสอบ|สถานะ|$)/);
    if (authSection) {
      const at = authSection[1];
      const an = at.match(/ชื่อ[:\s]*(.+?)(?:\n|อีเมล)/s);
      if (an) data.authorityInfo.name = an[1].trim();
      const ae = at.match(/อีเมล[:\s]*([^\n\s]+@[^\n\s]+)/);
      if (ae) data.authorityInfo.email = ae[1].trim();
      data.authorityInfo.verified = /ยืนยันตัวตนแล้ว/.test(at);
    }

    // Agreements: check for green icons
    const greenChecks = modal.querySelectorAll('.text-success, .fa-check-circle, .bi-check-circle');
    data.agreements.serviceAgreement = greenChecks.length >= 1 || /Service Agreement/.test(text);
    data.agreements.dataProcessing = greenChecks.length >= 2 || /Data Processing/.test(text);
    data.agreements.dataSharing = greenChecks.length >= 3 || /Data Sharing/.test(text);

    // Checklist
    for (const m of text.matchAll(/รายการตรวจสอบ\s*(\d+)\s*:\s*(.+?)(?=\n|รายการ|สถานะ|$)/g)) {
      data.checklist.push({ number: parseInt(m[1]), name: m[2].trim(), checked: true });
    }

    // Document URLs
    modal.querySelectorAll('a').forEach((a) => {
      let href = a.getAttribute('href');
      let onclick = a.getAttribute('onclick');

      if (!href || href.startsWith('javascript:') || href === '#') {
        if (onclick) {
          const match =
            onclick.match(/['"]([^'"]+\.(pdf|jpg|jpeg|png|gif|doc|docx))['"]/i) ||
            onclick.match(/window\.open\(['"]([^'"]+)['"]/i) ||
            onclick.match(/downloadFile\(['"]([^'"]+)['"]/i);
          if (match) href = match[1];
          else {
            const backupMatch = onclick.match(/['"]([^'"]+\/[^'"]+)['"]/i);
            if (backupMatch) href = backupMatch[1];
          }
        }
      } else {
        href = a.href;
      }

      if (
        href &&
        (href.includes('checklist') ||
          href.includes('document') ||
          href.includes('file') ||
          href.includes('upload'))
      ) {
        data.documentUrls.push({ url: href, text: a.textContent.trim() });
      }
    });

    // "ตรวจเอกสาร" button link
    modal.querySelectorAll('button, a').forEach((btn) => {
      let href = btn.getAttribute('href') === '#' ? null : btn.href;
      if (btn.textContent?.trim().includes('ตรวจเอกสาร') && href) {
        data.documentUrls.push({ url: btn.href, text: 'ตรวจเอกสาร', type: 'review_page' });
      }
    });

    return data;
  }

  // ===================== HELPERS =====================

  function extractText(el, regex) {
    const m = (el.innerText || el.textContent || '').match(regex);
    return m ? m[1].trim() : null;
  }

  function getInputNear(labelText) {
    const labels = [...document.querySelectorAll('label, span, div, td, th, p')];
    const label = labels.find((el) => {
      const t = el.textContent.replace(/\s+/g, '').trim();
      const search = labelText.replace(/\s+/g, '');
      return t.includes(search) && t.length < search.length + 20;
    });
    if (!label) return null;
    const input = findNearestInput(label);
    return input?.value || null;
  }

  function getSelectValue(labelText) {
    const search = labelText.replace(/\s+/g, '');
    const labels = [...document.querySelectorAll('label, span, div, td, th, p')];
    // The length bound matters: without it this matches an enclosing container
    // whose textContent merely *contains* the label, and we then return that
    // container's first <select> (e.g. จังหวัด resolving to service_unit_type).
    const label = labels.find((el) => {
      const t = el.textContent.replace(/\s+/g, '').trim();
      return t.includes(search) && t.length < search.length + 20;
    });
    if (!label) return null;
    const container = label.closest('div[class*="col"], div[class*="form"], td') || label.parentElement;
    const select = container?.querySelector('select');
    if (select) return select.options[select.selectedIndex]?.text || select.value;
    return null;
  }

  function getRadioValue(labelText) {
    const radios = [...document.querySelectorAll('input[type="radio"]:checked')];
    for (const r of radios) {
      const label = r.closest('label') || r.parentElement;
      const section = r.closest('div[class*="col"], div[class*="card"], fieldset');
      if (section?.textContent?.includes(labelText) || label?.textContent?.includes(labelText)) {
        return label?.textContent?.trim() || r.value;
      }
    }
    return null;
  }

  function findNearestInput(labelEl) {
    // Try: sibling, parent's sibling, nearest container
    const container =
      labelEl.closest('div[class*="col"], div[class*="form-group"], div[class*="row"], td') ||
      labelEl.parentElement;
    if (container) {
      const input = container.querySelector(
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select, textarea',
      );
      if (input) return input;
    }
    // Next sibling
    let sib = labelEl.nextElementSibling;
    while (sib) {
      if (sib.matches?.('input, select, textarea')) return sib;
      const inner = sib.querySelector?.('input, select, textarea');
      if (inner) return inner;
      sib = sib.nextElementSibling;
    }
    return null;
  }

  function waitForElement(selector, callback, maxWait = 5000) {
    const el = document.querySelector(selector);
    if (el) {
      callback(el);
      return;
    }
    const start = Date.now();
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el || Date.now() - start > maxWait) {
        observer.disconnect();
        callback(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      callback(null);
    }, maxWait);
  }

  function guessDocType(text) {
    const t = (text || '').toLowerCase();
    if (t.includes('ขย.5') || t.includes('ขย5') || t.includes('ขายยา') || t.includes('pharmacy'))
      return 'pharmacy_license';
    if (
      t.includes('สพ.7') ||
      t.includes('สพ7') ||
      t.includes('กิจการ') ||
      t.includes('sp7') ||
      t.includes('sp_7')
    )
      return 'license_sp7';
    if (
      t.includes('สพ.19') ||
      t.includes('สพ19') ||
      t.includes('ดำเนินการ') ||
      t.includes('sp19') ||
      t.includes('sp_19')
    )
      return 'license_sp19';
    if (
      t.includes('บัตร') ||
      t.includes('ประชาชน') ||
      t.includes('id_card') ||
      t.includes('idcard') ||
      t.includes('director') ||
      t.includes('admin')
    )
      return 'id_card';
    return 'general';
  }

  /**
   * Tick the reviewer's compliance checkboxes.
   *
   * IMPORTANT: scoped to `check_detail[...]` only. It must never touch the
   * applicant's own declarations (Service Agreement / DPA / DSA /
   * ยอมรับเงื่อนไข) or unrelated UI switches: those represent what the
   * applicant asserted, not what the reviewer verified.
   */
  function checkAllChecklistItems() {
    const checkboxes = document.querySelectorAll('input[type="checkbox"][name^="check_detail"]');
    let checkedCount = 0;
    checkboxes.forEach((cb) => {
      if (!cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        cb.dispatchEvent(new Event('click', { bubbles: true }));
        checkedCount++;
      }
    });
    console.log(`[HL] Ticked ${checkedCount} compliance checkbox(es) (check_detail only).`);
    return checkedCount;
  }

  // ===================== MESSAGING =====================

  function onPageMessage(event) {
    if (event.source !== window || event.data?.source !== 'HEALTHLINK_INTERCEPTOR') return;
    const { type, data } = event.data;
    if (type === 'API_RESPONSE') {
      interceptedApi.push(data);
      chrome.runtime.sendMessage({ type: 'API_INTERCEPTED', payload: data }).catch(() => {});
      extractDocUrlsFromApi(data);
    }
  }

  function onExtensionMessage(message, sender, sendResponse) {
    if (!message?.type) return;

    switch (message.type) {
      case 'CHECK_ALL_CHECKLIST':
        const checkedCount = checkAllChecklistItems();
        if (isChecklistPage()) extractChecklistPage();
        sendResponse({ success: true, count: checkedCount });
        return false;

      case 'REQUEST_MODAL_DATA':
      case 'REQUEST_CHECKLIST_DATA':
        if (!currentData && isChecklistPage()) extractChecklistPage();
        sendResponse({ data: currentData, apiData: interceptedApi });
        return false;

      case 'FETCH_REGISTRY':
        fetchRegistry()
          .then((records) => sendResponse({ records }))
          .catch((err) => sendResponse({ records: [], error: err.message }));
        return true;

      case 'FETCH_DOCUMENT':
        // Fallback path used by agent.js when the background fetch fails.
        // Runs in the page's origin, so session cookies ride along.
        fetch(message.url, { credentials: 'include' })
          .then(async (res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            const buf = await res.arrayBuffer();
            let binary = '';
            const bytes = new Uint8Array(buf);
            for (let i = 0; i < bytes.length; i += 8192) {
              binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length)));
            }
            sendResponse({
              success: true,
              data: btoa(binary),
              contentType: res.headers.get('content-type') || '',
              size: buf.byteLength,
            });
          })
          .catch((err) => sendResponse({ success: false, error: err.message }));
        return true;

      case 'REQUEST_PAGE_COOKIES':
        sendResponse({ cookies: document.cookie });
        return false;

      case 'SCRAPE_ALL_PAGES':
        scrapeAllChecklistPages()
          .then((docs) => sendResponse({ docs }))
          .catch((err) => sendResponse({ docs: [], error: err.message }));
        return true; // Keep channel open for async scrapeAllChecklistPages

      case 'CLICK_CHECK_DOCS':
        document.querySelectorAll('button, a').forEach((b) => {
          if (b.textContent?.trim().includes('ตรวจเอกสาร')) b.click();
        });
        sendResponse({ success: true });
        return false;

      case 'RE_EXTRACT':
        if (isChecklistPage()) extractChecklistPage();
        sendResponse({ success: true });
        return false;
    }
  }

  function sendToBackground(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
    } catch (e) {
      if (e.message.includes('Extension context invalidated')) {
        console.warn('Extension updated. Reloading page to restore connection...');
        // Only reload if we aren't in the middle of scraping to prevent infinite reload loops
        if (!document.title.includes('Reloading')) {
          window.location.reload();
        }
      }
    }
  }

  /**
   * Pull the full health-unit list from the DataTables endpoint.
   * Runs in the page so the admin session cookie is applied automatically.
   */
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

  async function fetchRegistryPage(start, length) {
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

    const res = await fetch('/admin/health_unit_datatable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body,
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
    return res.json();
  }

  async function fetchRegistry() {
    const strip = (v) =>
      String(v == null ? '' : v)
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const first = await fetchRegistryPage(0, 500);
    const total = first.recordsTotal || 0;
    let rows = first.data || [];

    for (let s = rows.length; s < total; s += 500) {
      const next = await fetchRegistryPage(s, 500);
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
      createDate: strip(r.create_date),
    }));
  }

  function extractDocUrlsFromApi(apiData) {
    if (!apiData?.body || typeof apiData.body !== 'object') return;
    const urls = [];
    (function search(obj) {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v.length > 5) {
          const isFile =
            v.match(/\.(pdf|jpg|jpeg|png)$/i) ||
            v.includes('/storage/') ||
            v.includes('/files/') ||
            v.includes('upload');
          if (isFile) {
            urls.push({ key: k, value: v });
          }
        } else if (typeof v === 'object') {
          search(v);
        }
      }
    })(apiData.body);
    if (urls.length && currentData) {
      currentData.apiDocumentUrls = urls;
      sendToBackground('DOCUMENT_URLS_FOUND', { urls });
    }
  }

  // ===================== UI =====================

  function addIndicator() {
    const el = document.createElement('div');
    el.id = 'hl-checker-indicator';
    el.innerHTML = '<div class="hl-indicator-dot"></div><span class="hl-indicator-text">AI Checker</span>';
    document.body.appendChild(el);

    if (!isChecklistPage()) {
      const btn = document.createElement('button');
      btn.id = 'hl-bulk-automate-btn';
      btn.innerHTML = ' Automate All (AI CRM)';
      btn.style.cssText =
        'position:fixed;bottom:20px;right:150px;z-index:99999;background:var(--primary, #007bff);color:white;border:none;padding:8px 16px;border-radius:20px;box-shadow:0 4px 6px rgba(0,0,0,0.1);cursor:pointer;font-weight:bold;font-family:sans-serif;';
      btn.onclick = startBulkAutomation;
      document.body.appendChild(btn);
    }
  }

  async function startBulkAutomation() {
    // The list is server-side paginated, so the DOM only ever holds one page.
    // Pull the whole set and select everything still awaiting document review.
    let pending = [];
    try {
      const all = await fetchRegistry();
      pending = all.filter((r) => r.status.includes('รออนุมัติเอกสาร'));
    } catch (e) {
      console.warn('[HL] registry fetch failed, falling back to visible rows:', e.message);
      pending = [...document.querySelectorAll('table tbody tr')]
        .filter((r) => r.textContent.includes('รออนุมัติเอกสาร'))
        .map((r) => ({ id: r.querySelector('button[data-id]')?.getAttribute('data-id') }))
        .filter((r) => r.id);
    }

    const urls = pending.filter((r) => r.id).map((r) => `${location.origin}/admin/checklist/${r.id}`);

    if (urls.length === 0) {
      alert('ไม่พบรายการที่ "รออนุมัติเอกสาร"');
      return;
    }

    // Deep-checking every pending entry means one page load + 4 OCR passes each
    // (~30s), so the full queue would run for many hours. The registry-wide
    // duplicate sweep needs no page visits and always runs over everything.
    const answer = prompt(
      `พบรายการรอตรวจสอบ ${urls.length} รายการ\n\n` +
        ' ตรวจซ้ำทั้งระบบ: ทำกับทุกรายการเสมอ (เร็ว)\n' +
        ` ตรวจรายคำร้อง: ประมาณ 3-5 วินาที/รายการ (ทั้งหมด ~${Math.round((urls.length * 4) / 60)} นาที)\n\n` +
        'ระบบจะตั้ง flag รอ review\n\n' +
        'จะตรวจรายคำร้องกี่รายการ? (0 = ตรวจซ้ำทั้งระบบอย่างเดียว)',
      '25',
    );
    if (answer === null) return;

    const limit = Math.max(0, Math.min(parseInt(answer, 10) || 0, urls.length));
    sendToBackground('START_BULK_AUTOMATION', { urls: urls.slice(0, limit) });
    alert('เริ่มตรวจสอบแล้ว: ดูผลและflag ที่ต้อง review ใน Side Panel');
  }

  function updateIndicator(status) {
    const dot = document.querySelector('.hl-indicator-dot');
    if (dot) dot.className = 'hl-indicator-dot hl-status-' + status;
  }

  // Track clicked table rows
  document.addEventListener(
    'click',
    (e) => {
      const row = e.target.closest('table tbody tr');
      if (row) {
        document.querySelectorAll('table tbody tr').forEach((r) => r.classList.remove('hl-active-row'));
        row.classList.add('hl-active-row');
      }
    },
    true,
  );

  // ===================== START =====================
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
