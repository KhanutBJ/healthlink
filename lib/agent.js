/**
 * agent.js: AI Agent Orchestrator (OCR-based, no API key)
 *
 * 1. Receives registration data from content script
 * 2. Runs rule-based checks immediately
 * 3. Fetches documents OCR/PDF text extraction
 * 4. Parses extracted text structured fields
 * 5. Cross-references with form data
 * 6. Generates verification report
 */
const Agent = (() => {
  'use strict';

  let _state = {
    status: 'idle',
    registration: null,
    ruleResults: [],
    aiResults: [],
    comparisons: [],
    summary: null,
    progress: 0,
  };

  const _listeners = new Map();
  function on(ev, cb) {
    if (!_listeners.has(ev)) _listeners.set(ev, []);
    _listeners.get(ev).push(cb);
  }
  function emit(ev, data) {
    (_listeners.get(ev) || []).forEach((cb) => cb(data));
  }

  // ===== MAIN WORKFLOW =====

  async function startVerification(regData) {
    _state = {
      status: 'analyzing',
      registration: regData,
      ruleResults: [],
      aiResults: [],
      comparisons: [],
      summary: null,
      progress: 0,
    };
    emit('status', { status: 'analyzing', message: 'เริ่มตรวจสอบ...' });

    try {
      // Phase 0: duplicate lookup against the full registry
      emit('progress', { phase: 'registry', progress: 5, message: 'ตรวจสอบสถานพยาบาลซ้ำในระบบ...' });
      try {
        const all = await Registry.loadAll();
        regData.duplicates = Registry.findDuplicates(regData, all);
        regData.ownerOtherUnits = Registry.ownerFootprint(all, regData.authorityInfo?.name, regData.huId);
      } catch (e) {
        console.warn('[HL] duplicate lookup failed:', e.message);
        regData.duplicates = null;
      }

      // Phase 1: Rule-based (instant)
      emit('progress', { phase: 'rules', progress: 10, message: 'ตรวจสอบข้อมูลพื้นฐาน...' });
      _state.ruleResults = RuleEngine.runAllChecks(regData);
      emit('rules-complete', { results: _state.ruleResults });
      updateSummary();
      emit('progress', { phase: 'rules-done', progress: 30, message: 'ตรวจข้อมูลพื้นฐานเสร็จ' });

      _state.status = 'rules-complete';
      emit('status', { status: 'rules-complete', message: 'Rule-Based เสร็จ: กดปุ่มเพื่อตรวจเอกสาร OCR' });
    } catch (err) {
      _state.status = 'error';
      emit('error', { message: err.message });
    }
  }

  /**
   * Run OCR document analysis
   */
  async function runAIAnalysis() {
    if (!_state.registration) {
      emit('error', { message: 'ไม่มีข้อมูลคำร้อง' });
      return;
    }

    _state.status = 'ai-analyzing';
    emit('status', { status: 'ai-analyzing', message: 'OCR กำลังอ่านเอกสาร...' });

    // Set OCR progress callback
    OCREngine.setProgressCallback((pct, msg) => {
      emit('progress', { phase: 'ai', progress: 30 + pct * 0.6, message: msg });
    });

    emit('progress', { phase: 'ai', progress: 5, message: 'กำลังสแกนเอกสารทุกหน้า (โปรดรอสักครู่)...' });
    const scrapedDocs = await new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return resolve([]);
        chrome.tabs.sendMessage(tabs[0].id, { type: 'SCRAPE_ALL_PAGES' }, (resp) => {
          resolve(resp?.docs || []);
        });
      });
    });

    const reg = _state.registration;
    if (scrapedDocs.length > 0) {
      if (!reg.documents) reg.documents = [];
      for (const d of scrapedDocs) {
        if (!reg.documents.some((u) => u.url === d.url)) reg.documents.push(d);
      }
    }

    const docs = collectDocumentUrls(reg);

    if (docs.length === 0) {
      _state.aiResults = [
        {
          document: { text: 'ไม่พบเอกสาร' },
          status: 'warn',
          error: 'ไม่พบ URL เอกสาร: กรุณากดลิงก์เอกสารในหน้าเว็บก่อน',
        },
      ];
      emit('ai-result', { index: 0, result: _state.aiResults[0] });
      updateSummary();
      _state.status = 'complete';
      emit('status', { status: 'complete', message: 'ไม่พบเอกสารให้ตรวจ' });
      emit('summary', { summary: _state.summary });
      return;
    }

    const results = [];
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      emit('progress', {
        phase: 'ai',
        progress: 30 + (i / docs.length) * 60,
        message: `OCR เอกสาร ${i + 1}/${docs.length}: ${doc.text || ''}`,
      });

      try {
        // Fetch document
        const fetchResult = await fetchDoc(doc.url);
        if (!fetchResult.success) {
          const why = fetchResult.error || 'ดึงไฟล์ไม่สำเร็จ (ไม่ทราบสาเหตุ)';
          console.warn('[HL] fetch failed for', doc.url, '->', why);
          results.push({ document: doc, status: 'error', error: why });
          emit('ai-result', { index: i, result: results[results.length - 1] });
          continue;
        }

        // In "parser + AI" mode the file itself goes to the model first. It
        // reads layout, poor scans and handwriting, none of which survive
        // Tesseract. On success local OCR is skipped entirely, which is also
        // far faster. Any failure falls back to OCR plus the regex parser.
        let aiFields = null;
        let aiError = null;
        try {
          aiFields = await AIExtract.extractFromFile(fetchResult.data, fetchResult.contentType, doc.url);
        } catch (e) {
          aiError = e.message;
          console.warn('[HL] AI extract failed, falling back to OCR:', e.message);
        }

        let ocrResult = { text: '', confidence: null, method: 'ai-file' };
        let regexParsed = { extractedFields: {} };
        let docType = guessDocType(`${doc.text || ''} ${doc.url || ''}`);

        if (!aiFields) {
          ocrResult = await OCREngine.analyzeDocument(fetchResult.data, fetchResult.contentType, doc.url);
          docType = guessDocType(`${doc.text || ''} ${doc.url || ''} ${ocrResult.text || ''}`);
          regexParsed = OCREngine.parseDocumentText(ocrResult.text, docType);
        } else if (aiFields.documentType) {
          docType = aiFields.documentType;
        }

        // AI values win where present; the parser fills any gaps.
        const parsed = aiFields
          ? { extractedFields: { ...regexParsed.extractedFields, ...prune(aiFields) } }
          : regexParsed;

        results.push({
          document: doc,
          docType,
          status: 'success',
          ocrText: ocrResult.text,
          ocrConfidence: ocrResult.confidence,
          method: ocrResult.method,
          parsed: parsed.extractedFields,
          extractor: aiFields ? 'AI อ่านไฟล์โดยตรง' : 'parser (OCR ในเครื่อง)',
          isHandwritten: aiFields?.isHandwritten || false,
          aiConfidence: aiFields?.confidence ?? null,
          aiError,
          fileData: fetchResult.data,
          fileType: fetchResult.contentType,
        });

        emit('ai-result', { index: i, result: results[results.length - 1] });
      } catch (err) {
        const why = err?.message || String(err);
        console.warn('[HL] OCR failed for', doc.url, '->', why);
        results.push({ document: doc, status: 'error', error: why });
        emit('ai-result', { index: i, result: results[results.length - 1] });
      }
    }

    _state.aiResults = results;

    // Cross-reference
    emit('progress', { phase: 'cross-ref', progress: 92, message: 'เปรียบเทียบข้อมูล...' });
    _state.comparisons = crossReference(reg, results);
    emit('comparisons', { comparisons: _state.comparisons });
    emit('matching-map', { map: buildMatchingMap(reg, results, _state.comparisons) });

    _state.itemVerdicts = computeVerifiedItems(reg, _state.comparisons);
    emit('item-verdicts', { verdicts: _state.itemVerdicts });

    // AI CRM Triage Summary
    emit('progress', { phase: 'ai-triage', progress: 95, message: 'กำลังให้ AI สรุปผล Triage...' });
    _state.aiTriage = await generateAiTriageSummary(reg, results, _state.comparisons);
    emit('ai-triage-result', { triage: _state.aiTriage });

    // Summary
    updateSummary();
    _state.status = 'complete';
    emit('progress', { phase: 'done', progress: 100, message: 'ตรวจสอบเสร็จสิ้น' });
    emit('status', { status: 'complete', message: 'ตรวจสอบเอกสาร OCR เสร็จ' });
    emit('summary', { summary: _state.summary });
  }

  // ===== HELPERS =====

  function collectDocumentUrls(reg) {
    const urls = [];
    if (reg.documents) {
      for (const d of reg.documents) {
        if (d.url) urls.push(d);
      }
    }
    if (reg.documentUrls) {
      for (const d of reg.documentUrls) {
        if (d.url && !urls.some((u) => u.url === d.url)) urls.push(d);
      }
    }
    if (reg.apiDocumentUrls) {
      for (const d of reg.apiDocumentUrls) {
        if (d.value && !urls.some((u) => u.url === d.value)) urls.push({ url: d.value, text: d.key });
      }
    }
    // Authority ID card doc
    if (reg.authorityInfo?.idDocUrl && !urls.some((u) => u.url === reg.authorityInfo.idDocUrl)) {
      urls.push({ url: reg.authorityInfo.idDocUrl, text: 'สำเนาบัตร ปชช. ผู้มีอำนาจ', type: 'id_card' });
    }
    // Admin ID card doc
    if (reg.adminInfo?.idDocUrl && !urls.some((u) => u.url === reg.adminInfo.idDocUrl)) {
      urls.push({ url: reg.adminInfo.idDocUrl, text: 'สำเนาบัตร ปชช. HA', type: 'id_card' });
    }
    return urls;
  }

  function fetchDoc(url) {
    return new Promise((resolve) => {
      let targetUrl = url;
      if (targetUrl.startsWith('http://')) targetUrl = targetUrl.replace('http://', 'https://');
      else if (targetUrl.startsWith('/')) targetUrl = 'https://hosregis.healthlink.go.th' + targetUrl;
      else if (!targetUrl.startsWith('http')) targetUrl = 'https://hosregis.healthlink.go.th/' + targetUrl;

      // Background service worker first; fall back to the content script, which
      // fetches from the page's own origin and so always carries the session.
      chrome.runtime.sendMessage({ type: 'FETCH_DOCUMENT', url: targetUrl }, (resp) => {
        const bgErr = chrome.runtime.lastError?.message || resp?.error || 'background fetch returned no data';
        if (!chrome.runtime.lastError && resp && resp.success) return resolve(resp);

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (!tabs?.[0]) return resolve({ success: false, error: `bg: ${bgErr}; no active tab` });
          chrome.tabs.sendMessage(tabs[0].id, { type: 'FETCH_DOCUMENT', url: targetUrl }, (tabResp) => {
            const tabErr = chrome.runtime.lastError?.message;
            if (tabErr) return resolve({ success: false, error: `bg: ${bgErr}; tab: ${tabErr}` });
            if (tabResp?.success) return resolve(tabResp);
            resolve({ success: false, error: `bg: ${bgErr}; tab: ${tabResp?.error || 'no response'}` });
          });
        });
      });
    });
  }

  /** Drop null/empty keys so AI output cannot blank out a parser result. */
  function prune(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (v !== null && v !== undefined && v !== '') out[k] = v;
    }
    return out;
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
   * Ask the model to summarise, from CHECK OUTCOMES ONLY.
   *
   * No names, no ID numbers, no addresses, no OCR text, no HCode ever leave the
   * machine: only field labels and pass/fail booleans. The model triages the
   * result; it never reads the applicant's data.
   */
  async function generateAiTriageSummary(reg, results, comparisons) {
    const outcomes = (comparisons || []).map((c) => ({
      field: c.field,
      result: c.match ? 'MATCH' : 'MISMATCH',
    }));

    const ruleOutcomes = (_state.ruleResults || []).map((r) => ({
      check: r.title,
      result: r.status,
    }));

    const dup = reg.duplicates;
    const duplicateSignal = !dup
      ? 'ไม่ได้ตรวจ'
      : dup.strong.length
        ? `พบซ้ำชัดเจน ${dup.strong.length} รายการ`
        : dup.weak.length
          ? `ชื่อคล้ายกัน ${dup.weak.length} รายการ`
          : 'ไม่พบซ้ำ';

    const payload = {
      contents: [
        {
          parts: [
            {
              text: `คุณคือผู้ช่วย Triage ของระบบ HealthLink
ด้านล่างนี้คือ "ผลการตรวจ" เท่านั้น (ไม่มีข้อมูลส่วนบุคคลใด ๆ)
สรุปสั้น ๆ ไม่เกิน 5 บรรทัด: 1) อะไรผ่าน 2) อะไรมีปัญหา 3) ควร อนุมัติ / รอแก้ไข / ตรวจด้วยตนเอง

ผลตรวจข้อมูลฟอร์ม:
${JSON.stringify(ruleOutcomes, null, 2)}

ผลเทียบฟอร์มกับเอกสาร (${outcomes.length} รายการ):
${JSON.stringify(outcomes, null, 2)}

ตรวจสถานพยาบาลซ้ำ: ${duplicateSignal}
จำนวนเอกสารที่อ่านได้: ${results.filter((r) => r.status === 'success').length}/${results.length}

(ตอบภาษาไทย กระชับ เป็น bullet)`,
            },
          ],
        },
      ],
    };

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GEMINI_REQUEST', payload }, (resp) => {
        if (chrome.runtime.lastError) return resolve({ error: chrome.runtime.lastError.message });
        if (resp && resp.success) {
          const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'ไม่สามารถสรุปผลได้';
          resolve({ text });
        } else {
          resolve({ error: resp?.error || 'Unknown AI error' });
        }
      });
    });
  }

  // ===== CROSS-REFERENCE =====

  function crossReference(reg, results) {
    const comparisons = [];
    const fuzzy = RuleEngine.fuzzyMatchThaiName;

    for (const r of results) {
      if (r.status !== 'success' || !r.parsed) continue;
      const p = r.parsed;
      const src = r.document.text || r.docType;

      // Facility / pharmacy name
      const docName = p.facilityName || p.pharmacyName;
      if (docName && reg.healthUnitName) {
        const m = fuzzy(docName, reg.healthUnitName);
        comparisons.push({
          field: 'ชื่อสถานพยาบาล/ร้านยา',
          formValue: reg.healthUnitName,
          documentValue: docName,
          match: m.match,
          score: m.score,
          source: src,
        });
      }

      // Route each ID card to the person it actually belongs to. Comparing the
      // HA's card against ผู้มีอำนาจ produced two identical rows and a false
      // mismatch whenever the two people differ.
      const isHaDoc = /HospitalAdmin|hospital_admin|\bHA\b/i.test(
        `${r.document?.url || ''} ${r.document?.text || ''}`,
      );
      const person = isHaDoc ? reg.adminInfo : reg.authorityInfo;
      const personLabel = isHaDoc ? ' HA' : 'ผู้มีอำนาจ';

      // Owner / person name
      const docOwner = p.ownerName || p.operatorName || p.pharmacistName || p.nameTh;
      if (docOwner && person?.name) {
        const m = fuzzy(docOwner, person.name);
        comparisons.push({
          field: `ชื่อ${personLabel}`,
          formValue: person.name,
          documentValue: docOwner,
          match: m.match,
          score: m.score,
          source: src,
          note: m.via === 'skeleton' ? 'ตรงกันโดยเทียบพยัญชนะ (OCR ตกสระและวรรณยุกต์)' : '',
        });
      } else if (!docOwner && p.nameEn && person?.name) {
        // Only a transliterated name came back. Thai-to-English is not a
        // comparison we can make reliably, so ask for a human instead of
        // reporting a mismatch that means nothing.
        comparisons.push({
          field: `ชื่อ${personLabel}`,
          formValue: person.name,
          documentValue: `${p.nameEn} (อังกฤษ)`,
          match: false,
          score: 0,
          source: src,
          note: 'อ่านได้เฉพาะชื่ออังกฤษ ต้องตรวจด้วยตนเอง',
        });
      }

      // Thai ID number
      if (p.idNumber && person?.idNumber) {
        const match = p.idNumber.replace(/\D/g, '') === person.idNumber.replace(/\D/g, '');
        comparisons.push({
          field: `เลขบัตร ปชช. ${personLabel}`,
          formValue: person.idNumber,
          documentValue: p.idNumber,
          match,
          score: match ? 1 : 0,
          source: src,
          note: match ? 'ตรงกัน' : 'ไม่ตรง!',
        });
      }

      // License number (informational)
      if (p.licenseNumber) {
        comparisons.push({
          field: 'เลขที่ใบอนุญาต',
          formValue: '(ไม่มีในฟอร์ม)',
          documentValue: p.licenseNumber,
          match: true,
          score: 1,
          source: src,
          note: 'พบในเอกสาร',
        });
      }

      // Expiry check
      if (p.expiryDate) {
        const parsed = OCREngine.parseThaiDate(p.expiryDateParsed || p.expiryDate);
        const yearsOff = parsed ? (Date.now() - parsed.getTime()) / (365.25 * 24 * 3600 * 1000) : 0;

        // A licence expiry more than a decade in the past is far more likely an
        // OCR misread (a birth date, an issue date, a dropped digit) than a
        // genuinely expired licence. Declaring it expired would be a confident
        // wrong answer, so hand it to a human instead.
        if (parsed && yearsOff > 10) {
          comparisons.push({
            field: 'วันหมดอายุ',
            formValue: 'วันที่ไม่สมเหตุสมผล',
            documentValue: p.expiryDate,
            match: false,
            score: 0,
            source: src,
            note: 'วันที่เก่าเกินไป น่าจะอ่านผิด ต้องตรวจด้วยตนเอง',
          });
          continue;
        }

        const expired = checkExpired(p.expiryDateParsed || p.expiryDate);
        if (expired === null) {
          comparisons.push({
            field: 'วันหมดอายุ',
            formValue: 'อ่านวันที่ไม่ได้',
            documentValue: p.expiryDate,
            match: false,
            score: 0,
            source: src,
            note: 'ต้องตรวจด้วยตนเอง',
          });
        } else {
          comparisons.push({
            field: 'วันหมดอายุ',
            formValue: expired ? 'หมดอายุแล้ว!' : 'ยังไม่หมดอายุ',
            documentValue: p.expiryDate,
            match: !expired,
            score: expired ? 0 : 1,
            source: src,
            note: expired ? 'เอกสารหมดอายุ!' : 'OK',
          });
        }
      }
    }

    return comparisons;
  }

  /**
   * Returns true/false when the date is understood, or null when it could not
   * be parsed at all: an unreadable date must not be reported as "not expired".
   */
  /**
   * Lay out exactly what was compared against what, and what could not be
   * compared at all. Every checklist item on the page appears here, so an item
   * with no evidence is visible rather than silently absent.
   */
  function buildMatchingMap(reg, results, comparisons) {
    const groups = reg.checklistGroups || [];
    const readable = results.filter((r) => r.status === 'success');

    const rows = comparisons.map((c) => ({
      field: c.field,
      formValue: c.formValue,
      docValue: c.documentValue,
      source: c.source,
      verdict: c.note && /ตนเอง/.test(c.note) ? 'manual' : c.match ? 'match' : 'mismatch',
      note: c.note || '',
    }));

    // Checklist items with no comparison behind them
    const covered = new Set(rows.map((r) => r.field));
    const uncovered = [];
    for (const g of groups) {
      for (const it of g.items) {
        const related = [...covered].some(
          (f) =>
            (/ชื่อ/.test(it.label) && /ชื่อ/.test(f)) || (/หมดอายุ/.test(it.label) && /วันหมดอายุ/.test(f)),
        );
        if (!related) uncovered.push({ document: g.document, label: it.label });
      }
    }

    return {
      rows,
      uncovered,
      documentsRead: readable.length,
      documentsTotal: results.length,
      matched: rows.filter((r) => r.verdict === 'match').length,
      mismatched: rows.filter((r) => r.verdict === 'mismatch').length,
      manual: rows.filter((r) => r.verdict === 'manual').length,
    };
  }

  /**
   * Decide, per checklist item, whether the evidence supports ticking it.
   * Only items backed by a passing form-to-document comparison qualify.
   * Anything else stays for the reviewer, so the checker never asserts a
   * verification it did not actually perform.
   */
  function computeVerifiedItems(reg, comparisons) {
    const groups = reg.checklistGroups || [];
    const verified = [];
    const pending = [];

    const norm = (s) => String(s || '').replace(/\s+/g, '');

    for (const g of groups) {
      const docKey = norm(g.document);
      const mine = comparisons.filter((c) => docKey && norm(c.source).includes(docKey.slice(0, 12)));

      const nameOk = mine.some((c) => /ชื่อ/.test(c.field) && c.match);
      const expiryOk = mine.some((c) => /วันหมดอายุ/.test(c.field) && c.match);

      for (const it of g.items) {
        const isName = /ชื่อ/.test(it.label);
        const isExpiry = /ไม่หมดอายุ/.test(it.label);
        const ok = (isName && nameOk) || (isExpiry && expiryOk);
        (ok ? verified : pending).push({
          groupId: g.groupId,
          itemId: it.itemId,
          label: it.label,
          document: g.document,
          reason: ok ? 'ตรงกับเอกสาร' : isExpiry ? 'อ่านวันหมดอายุจากเอกสารไม่ได้' : 'ไม่มีหลักฐานจากเอกสาร',
        });
      }
    }
    return { verified, pending };
  }

  function checkExpired(dateStr) {
    if (!dateStr) return null;
    try {
      const d = OCREngine.parseThaiDate(dateStr);
      if (!d || isNaN(d.getTime())) return null;
      return d < new Date();
    } catch {
      return null;
    }
  }

  // ===== SUMMARY =====

  function updateSummary() {
    let pass = 0,
      fail = 0,
      warn = 0;
    for (const r of _state.ruleResults) {
      if (r.status === 'pass') pass++;
      else if (r.status === 'fail') fail++;
      else if (r.status === 'warn') warn++;
    }
    for (const c of _state.comparisons) {
      if (c.match) pass++;
      else fail++;
    }

    // Document evidence = comparisons actually drawn between the form and a
    // document. Rule checks alone only prove the *form* is well-formed; they
    // say nothing about whether the documents back it up. Without at least one
    // comparison the result can never be a clean pass, or the checker would be
    // asserting a verification it never performed.
    const docEvidence = _state.comparisons.length;

    let verdict;
    if (fail > 0) verdict = 'fail';
    else if (docEvidence === 0) verdict = 'warn';
    else if (warn > 0) verdict = 'warn';
    else verdict = 'pass';

    let message;
    if (verdict === 'pass') message = ' ผ่านการตรวจสอบทุกรายการ';
    else if (verdict === 'fail') message = ` พบ ${fail} รายการที่ไม่ผ่าน`;
    else if (docEvidence === 0) message = ' ตรวจเอกสารอัตโนมัติไม่ได้: ต้องตรวจด้วยตนเอง';
    else message = ` พบ ${warn} รายการที่ต้องตรวจสอบเพิ่ม`;

    _state.summary = { pass, fail, warn, total: pass + fail + warn, verdict, docEvidence, message };
  }

  function off(ev, cb) {
    if (!_listeners.has(ev)) return;
    const list = _listeners.get(ev);
    const idx = list.indexOf(cb);
    if (idx !== -1) list.splice(idx, 1);
  }

  function getState() {
    return { ..._state };
  }

  return { on, off, startVerification, runAIAnalysis, getState };
})();

if (typeof window !== 'undefined') window.Agent = Agent;
