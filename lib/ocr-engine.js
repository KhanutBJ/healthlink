/**
 * ocr-engine.js: Local OCR Engine using Tesseract.js + PDF.js
 *
 * 100% free, no API key required.
 * - Tesseract.js for image OCR (Thai + English)
 * - PDF.js for extracting text from PDF documents
 */
const OCREngine = (() => {
  'use strict';

  let _tesseractWorker = null;
  let _isInitialized = false;
  let _initPromise = null;
  let _onProgress = null;

  function setProgressCallback(fn) {
    _onProgress = fn;
  }

  function progress(pct, msg) {
    if (_onProgress) _onProgress(pct, msg);
  }

  /**
   * Initialize Tesseract worker (lazy: called once on first OCR)
   */
  async function initTesseract() {
    if (_isInitialized) return;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
      progress(5, 'กำลังโหลด Tesseract OCR engine...');

      const Tess = window.Tesseract;
      if (!Tess) throw new Error('Tesseract.js not loaded: check sidepanel.html script tags');

      _tesseractWorker = await Tess.createWorker('tha+eng', 1, {
        workerPath: chrome.runtime.getURL('lib/tesseract/worker.min.js'),
        corePath: chrome.runtime.getURL('lib/tesseract/tesseract-core-simd-lstm.wasm.js'),
        langPath: 'https://tessdata.projectnaptha.com/4.0.0',
        // Tesseract defaults to wrapping the worker in a Blob URL. A blob
        // worker cannot importScripts() a chrome-extension:// file, which fails
        // as "NetworkError ... importScripts ... failed to load". Loading the
        // worker straight from the extension URL keeps it same-origin.
        workerBlobURL: false,
        logger: (m) => {
          if (m.status === 'recognizing text') {
            progress(20 + Math.round(m.progress * 60), `OCR: ${Math.round(m.progress * 100)}%`);
          }
        },
      });

      _isInitialized = true;
      progress(15, 'Tesseract OCR พร้อมใช้งาน');
    })();

    return _initPromise;
  }

  /**
   * OCR an image (from URL, base64, Blob, or ImageData)
   * @returns {{ text, confidence, lines[] }}
   */
  async function ocrImage(imageSource) {
    await initTesseract();
    progress(20, 'กำลัง OCR รูปภาพ...');

    const result = await _tesseractWorker.recognize(imageSource);

    const lines = result.data.lines
      .map((l) => ({
        text: l.text.trim(),
        confidence: l.confidence,
        bbox: l.bbox,
      }))
      .filter((l) => l.text.length > 0);

    progress(85, 'OCR เสร็จ: กำลังวิเคราะห์ข้อความ...');

    return {
      // Tesseract returns Thai one glyph at a time ("ว ั น / เ ว ล า").
      // Rejoin it so the raw text panel is readable and every downstream
      // regex sees whole words.
      text: deSpaceThai(result.data.text),
      confidence: result.data.confidence,
      lines,
    };
  }

  /**
   * Extract text from a PDF (uses PDF.js text layer, no OCR needed for digital PDFs)
   * @param {ArrayBuffer|Uint8Array} pdfData
   * @returns {{ text, pages[] }}
   */
  async function extractPdfText(pdfData) {
    progress(20, 'กำลังอ่าน PDF...');

    const pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) throw new Error('PDF.js not loaded');

    // Set worker path
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdfjs/pdf.worker.min.js');

    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    const pages = [];
    let fullText = '';

    for (let i = 1; i <= pdf.numPages; i++) {
      progress(20 + Math.round((i / pdf.numPages) * 50), `อ่านหน้า ${i}/${pdf.numPages}...`);

      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => item.str).join(' ');
      pages.push({ pageNum: i, text: pageText });
      fullText += pageText + '\n';
    }

    progress(75, 'อ่าน PDF เสร็จ');

    // If PDF has very little text, it's likely a scanned image: need OCR
    const isScannedPdf = fullText.trim().length < 20;

    return {
      text: fullText.trim(),
      pages,
      numPages: pdf.numPages,
      isScannedPdf,
    };
  }

  /**
   * OCR a scanned PDF (render each page to canvas, then OCR)
   * @param {ArrayBuffer|Uint8Array} pdfData
   */
  async function ocrPdf(pdfData) {
    progress(10, 'กำลังเตรียม OCR สำหรับ PDF...');

    const pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) throw new Error('PDF.js not loaded');

    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdfjs/pdf.worker.min.js');

    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    await initTesseract();

    let fullText = '';
    const pages = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      progress(15 + Math.round((i / pdf.numPages) * 70), `OCR หน้า ${i}/${pdf.numPages}...`);

      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2.0 }); // Higher scale = better OCR
      const canvas = new OffscreenCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext('2d');

      // Fill with white background to prevent transparent background issues with Tesseract
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport, background: 'white' }).promise;

      // Convert canvas to data URL for Tesseract to prevent ArrayBuffer detachment
      const dataUrl = await new Promise((resolve) => {
        // OffscreenCanvas doesn't have toDataURL, so we use convertToBlob then FileReader
        canvas.convertToBlob({ type: 'image/png' }).then((blob) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
      });

      const result = await _tesseractWorker.recognize(dataUrl);

      pages.push({
        pageNum: i,
        text: result.data.text,
        confidence: result.data.confidence,
      });
      fullText += result.data.text + '\n';
    }

    progress(90, 'OCR PDF เสร็จ');

    return { text: deSpaceThai(fullText.trim()), pages, numPages: pdf.numPages };
  }

  /**
   * Smart analyze: detect file type and use the right extraction method
   * @param {string} base64Data
   * @param {string} mimeType
   * @param {string} url
   * @returns {{ text, confidence?, method, isScannedPdf? }}
   */
  async function analyzeDocument(base64Data, mimeType = '', url = '') {
    const isPdf = mimeType.includes('pdf') || url.match(/\.pdf(\?|$)/i);
    const isImage = mimeType.includes('image') || url.match(/\.(jpg|jpeg|png|gif|bmp|webp)(\?|$)/i);

    if (isImage) {
      let type = mimeType.includes('image')
        ? mimeType
        : url.match(/\.png(\?|$)/i)
          ? 'image/png'
          : 'image/jpeg';
      const dataUrl = `data:${type};base64,${base64Data}`;
      const ocrResult = await ocrImage(dataUrl);
      return { ...ocrResult, method: 'ocr-image' };
    }

    if (isPdf) {
      const binaryStr = atob(base64Data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

      const pdfBytes1 = new Uint8Array(bytes.buffer.slice(0));
      const pdfResult = await extractPdfText(pdfBytes1);

      if (pdfResult.isScannedPdf) {
        progress(15, 'PDF เป็นภาพสแกน: ใช้ OCR...');
        const pdfBytes2 = new Uint8Array(bytes.buffer.slice(0));
        const ocrResult = await ocrPdf(pdfBytes2);
        return { ...ocrResult, method: 'ocr-pdf' };
      }

      return { ...pdfResult, method: 'pdf-text', confidence: 95 };
    }

    // Fallback image OCR
    try {
      const dataUrl = `data:image/jpeg;base64,${base64Data}`;
      const ocrResult = await ocrImage(dataUrl);
      if (ocrResult.text && ocrResult.text.trim().length > 0) {
        return { ...ocrResult, method: 'ocr-fallback' };
      }
    } catch (e) {
      /* ignore */
    }

    // Text fallback
    try {
      const decodedText = atob(base64Data);
      if (decodedText && decodedText.trim().length > 0) {
        return { text: decodedText, confidence: 70, method: 'raw-text' };
      }
    } catch {
      /* ignore */
    }

    throw new Error(`ไม่สามารถอ่านข้อมูลจากไฟล์ (${mimeType || url})`);
  }

  // =====================================================================
  // TEXT NORMALISATION
  // Thai OCR fails in a small number of predictable ways. Handling them once
  // here is what keeps the field extractors below simple.
  // =====================================================================

  const THAI_RANGE = '฀-๿';
  const THAI_MARKS = /[ัำ-ฺ็-๎]/g;

  const THAI_DIGITS = {
    '๐': '0',
    '๑': '1',
    '๒': '2',
    '๓': '3',
    '๔': '4',
    '๕': '5',
    '๖': '6',
    '๗': '7',
    '๘': '8',
    '๙': '9',
  };

  const THAI_MONTHS = {
    มกราคม: 1,
    กุมภาพันธ์: 2,
    มีนาคม: 3,
    เมษายน: 4,
    พฤษภาคม: 5,
    มิถุนายน: 6,
    กรกฎาคม: 7,
    สิงหาคม: 8,
    กันยายน: 9,
    ตุลาคม: 10,
    พฤศจิกายน: 11,
    ธันวาคม: 12,
    'ม.ค.': 1,
    'ก.พ.': 2,
    'มี.ค.': 3,
    'เม.ย.': 4,
    'พ.ค.': 5,
    'มิ.ย.': 6,
    'ก.ค.': 7,
    'ส.ค.': 8,
    'ก.ย.': 9,
    'ต.ค.': 10,
    'พ.ย.': 11,
    'ธ.ค.': 12,
  };

  /** Tesseract emits Thai one glyph at a time. Rejoin runs split by spaces. */
  function deSpaceThai(text) {
    return String(text || '').replace(new RegExp(`([${THAI_RANGE}])[ \t]+(?=[${THAI_RANGE}])`, 'g'), '$1');
  }

  /** Consonant skeleton: OCR loses vowels and tone marks constantly. */
  function thaiSkeleton(text) {
    return deSpaceThai(text)
      .replace(THAI_MARKS, '')
      .replace(new RegExp(`[^${THAI_RANGE}]`, 'g'), '');
  }

  /** Thai numerals never match \d, so normalise before any numeric regex. */
  function normalizeThaiDigits(text) {
    return String(text || '').replace(/[๐-๙]/g, (d) => THAI_DIGITS[d] || d);
  }

  /** Full pipeline applied before any field extraction. */
  function normalizeOcrText(text) {
    return deSpaceThai(normalizeThaiDigits(text))
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[“”„]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/[ \t]{2,}/g, ' ');
  }

  // =====================================================================
  // BOILERPLATE AND JUNK REJECTION
  // Every Thai licence carries a statutory penalty notice containing the same
  // words as the real fields. A wrong value is worse than no value, because it
  // becomes a confident false mismatch, so weak candidates are dropped.
  // =====================================================================

  const BOILERPLATE = [
    'ประกอบกิจการสถานพยาบาล',
    'ดำเนินการสถานพยาบาล',
    'ดําเนินการสถานพยาบาล',
    'ต้องระวางโทษ',
    'จำคุก',
    'จําคุก',
    'ริบบรรดาสิ่ง',
    'ศาลจะสั่ง',
    'พระราชบัญญัติ',
    'และที่แก้ไขเพิ่มเติม',
    'ที่ไม่รับผู้ป่วยไว้ค้างคืน',
    'ที่รับผู้ป่วยไว้ค้างคืน',
    'ที่ใช้ในการ',
    'ด้วยก็ได้',
    'ไม่ได้รับอนุญาต',
    'มาตรา',
    'เป็นการ',
    'แสนบาท',
    'ผู้อนุญาต',
    'ให้ไว้ ณ วันที่',
    'ออกให้เพื่อ',
  ];

  const GENERIC_TERMS =
    /^(สถานพยาบาล|คลินิก|โรงพยาบาล|ร้านยา|ดําเนินการ|ดำเนินการ|ประกอบกิจการ|ผู้ป่วย|ประเภท|เลขที่|ชื่อ)$/;

  function isBoilerplate(s) {
    return BOILERPLATE.some((b) => String(s).includes(b));
  }

  function isJunkValue(s, opts = {}) {
    const { minThaiRatio = 0.5, minLen = 4, maxLen = 90 } = opts;
    if (!s) return true;
    const v = String(s).trim();
    if (v.length < minLen || v.length > maxLen) return true;
    if (/[=|><"\\]/.test(v)) return true;
    if (isBoilerplate(v)) return true;
    if (GENERIC_TERMS.test(v)) return true;
    const thai = (v.match(new RegExp(`[${THAI_RANGE}]`, 'g')) || []).length;
    if (minThaiRatio > 0 && thai / v.length < minThaiRatio) return true;
    return false;
  }

  /** OCR runs the surrounding label into the value. Peel those off. */
  function cleanFacilityName(v) {
    return (
      String(v || '')
        .replace(/^.*?(?:สถานพยาบาลชื่อ|ชื่อสถานพยาบาล|ลักษณะสถานพยาบาล|ณสถานพยาบาล|ชื่อสถานประกอบการ)/, '')
        .replace(/^ชื่อ/, '')
        // Terminators that follow the name on these licences. "ประเภท" appears
        // both as "ประเภทที่..." and bare "ประเภทไม่รับ...", so cut on either.
        .replace(
          /(?:จํานวนเตียง|จำนวนเตียง|ประเภท|ตั้งอยู่|ที่ตั้ง|เลขที่|ผู้รับอนุญาต|ผู้ดำเนินการ|ผู้ดําเนินการ).*$/,
          '',
        )
        .replace(/^[\s:.,ๆ]+|[\s:.,ๆ]+$/g, '')
        .trim()
    );
  }

  function cleanPersonName(v) {
    return String(v || '')
      .replace(/^.*?(?:ชื่อตัวและชื่อสกุล|ชื่อสกุล|ชื่อตัว|ชื่อ)\s*/, '')
      .replace(/(?:เกิดวันที่|วันออกบัตร|วันบัตรหมดอายุ|ที่อยู่|Name).*$/, '')
      .replace(new RegExp(`[^${THAI_RANGE} ]`, 'g'), '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // =====================================================================
  // LABEL DICTIONARY
  // Thai licences vary by province and year, so each field lists every label
  // spelling seen, including the misspellings OCR reliably produces.
  // =====================================================================

  const LABELS = {
    facilityName: [
      'ชื่อสถานพยาบาล',
      'สถานพยาบาลชื่อ',
      'ชื่อคลินิก',
      'ชื่อสถานประกอบการ',
      'ชื่อร้าน',
      'ชื่อร้านยา',
    ],
    ownerName: ['ผู้รับอนุญาต', 'ผู้รับใบอนุญาต', 'ผู้ได้รับอนุญาต', 'เจ้าของกิจการ', 'ผู้ประกอบกิจการ'],
    operatorName: ['ผู้ดำเนินการ', 'ผู้ดําเนินการ', 'ผู้ประกอบวิชาชีพ', 'ผู้ดำเนินการสถานพยาบาล'],
    pharmacistName: ['เภสัชกร', 'ผู้มีหน้าที่ปฏิบัติการ'],
    licenseNumber: ['ใบอนุญาตเลขที่', 'เลขที่ใบอนุญาต', 'ใบอนุญาตที่', 'เลขที่', 'License No', 'No'],
    expiry: [
      'วันหมดอายุ',
      'หมดอายุ',
      'ใช้ได้ถึง',
      'สิ้นสุด',
      'ถึงวันที่',
      'สิ้นอายุ',
      'วันสิ้นอายุ',
      'วันบัตรหมดอายุ',
    ],
    issue: ['ให้ไว้ ณ วันที่', 'ออกให้ ณ วันที่', 'วันออกบัตร', 'วันที่ออก'],
    address: ['ตั้งอยู่', 'ที่ตั้ง', 'ที่อยู่', 'สถานที่ตั้ง'],
    personName: ['ชื่อตัวและชื่อสกุล', 'ชื่อตัวและชื่อสกล', 'ชื่อสกุล', 'ชื่อตัว', 'ชื่อ-สกุล', 'ชื่อ'],
    idNumber: [
      'เลขประจำตัวประชาชน',
      'เลขประจําตัวประชาชน',
      'หมายเลขบัตรประจำตัวประชาชน',
      'เลขบัตรประชาชน',
      'Identification Number',
    ],
    facilityType: ['ประเภท', 'ลักษณะ'],
  };

  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * Find the value following any spelling of a label.
   * Returns { value, label } or null.
   */
  function findLabelled(text, labels, maxLen = 70) {
    const alt = labels.map(esc).join('|');
    const rx = new RegExp(`(?:${alt})\\s*[:\\s.]*([^\\n]{2,${maxLen}})`, 'i');
    const m = text.match(rx);
    return m ? { value: m[1].trim(), label: m[0].slice(0, 24) } : null;
  }

  // =====================================================================
  // VALUE PARSERS AND VALIDATORS
  // =====================================================================

  /** Accepts ISO, d/m/y, Thai month names, and 2-digit Buddhist years. */
  function parseThaiDate(str) {
    const t = normalizeThaiDigits(deSpaceThai(str));

    const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return mkDate(+iso[1], +iso[2], +iso[3]);

    let m = t.match(/(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{2,4})/);
    if (m) return mkDate(yearOf(m[3]), +m[2], +m[1]);

    const months = Object.keys(THAI_MONTHS).map(esc).join('|');
    m = t.match(new RegExp(`(\\d{1,2})\\s*(${months})\\s*(?:พ\\.?ศ\\.?)?\\s*(\\d{2,4})`));
    if (m) return mkDate(yearOf(m[3]), THAI_MONTHS[m[2]], +m[1]);

    // "วันที่ 31 เดือน ธันวาคม พ.ศ. 2568"
    m = t.match(new RegExp(`วันที่\\s*(\\d{1,2})\\s*เดือน\\s*(${months})\\s*(?:พ\\.?ศ\\.?)?\\s*(\\d{2,4})`));
    if (m) return mkDate(yearOf(m[3]), THAI_MONTHS[m[2]], +m[1]);

    return null;
  }

  function yearOf(raw) {
    let y = parseInt(raw, 10);
    // A two-digit year on a Thai document is a Buddhist year in the 25xx
    // century ("68" is 2568, not 2468). The old rule produced 1925.
    if (raw.length === 2) y += 2500;
    if (y > 2400) y -= 543;
    return y;
  }

  function mkDate(y, mo, d) {
    if (!y || !mo || !d || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, mo - 1, d);
    return isNaN(dt.getTime()) ? null : dt;
  }

  function isoOf(d) {
    return d
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      : null;
  }

  /** Thai national ID checksum, used to reject OCR misreads. */
  function validThaiId(id) {
    const c = String(id || '').replace(/\D/g, '');
    if (c.length !== 13) return false;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += parseInt(c[i], 10) * (13 - i);
    return (11 - (sum % 11)) % 10 === parseInt(c[12], 10);
  }

  /** Pull a 13-digit ID out of noisy text, preferring one that checksums. */
  function extractThaiId(text) {
    const t = normalizeThaiDigits(text)
      .replace(/[Oo]/g, '0')
      .replace(/[lI]/g, '1')
      .replace(/[sS]/g, '5')
      .replace(/B/g, '8')
      .replace(/[zZ]/g, '2');

    const candidates = [];
    const grouped = t.match(/(\d)[\s-]*(\d{4})[\s-]*(\d{5})[\s-]*(\d{2})[\s-]*(\d)(?!\d)/);
    if (grouped) candidates.push(grouped.slice(1).join(''));
    for (const m of t.matchAll(/(?<!\d)(\d{13})(?!\d)/g)) candidates.push(m[1]);
    for (const line of deSpaceThai(t).split('\n')) {
      if (LABELS.idNumber.some((l) => line.includes(l))) {
        const digits = line.replace(/\D/g, '');
        if (digits.length === 13) candidates.push(digits);
      }
    }
    return candidates.find(validThaiId) || candidates[0] || null;
  }

  /** Pick an expiry: prefer one next to an expiry label, else the latest date. */
  function extractExpiry(text) {
    const months = Object.keys(THAI_MONTHS).map(esc).join('|');
    const datePat = `\\d{1,2}\\s*(?:${months})\\s*(?:พ\\.?ศ\\.?)?\\s*\\d{2,4}|\\d{1,2}\\s*[\\/.\\-]\\s*\\d{1,2}\\s*[\\/.\\-]\\s*\\d{2,4}`;

    const labelled = text.match(
      new RegExp(`(?:${LABELS.expiry.map(esc).join('|')})[^\\n]{0,20}?(${datePat})`, 'i'),
    );
    if (labelled) {
      const d = parseThaiDate(labelled[1]);
      if (d) return { raw: labelled[1].trim(), date: d, method: 'labelled' };
    }
    const all = [...text.matchAll(new RegExp(`(${datePat})`, 'g'))]
      .map((m) => ({ raw: m[1].trim(), date: parseThaiDate(m[1]) }))
      .filter((x) => x.date);
    if (!all.length) return null;
    const latest = all.reduce((a, b) => (b.date > a.date ? b : a));
    return { ...latest, method: 'latest-date' };
  }

  // =====================================================================
  // DOCUMENT PARSERS
  // =====================================================================

  function parseDocumentText(text, docType) {
    const t = normalizeOcrText(text || '');
    const byType = {
      id_card: parseIdCard,
      pharmacy_license: parsePharmacyLicense,
      license_sp7: parseLicense,
      license_sp19: parseLicenseSp19,
    };
    const fn = byType[docType] || parseGeneral;
    return { documentType: docType, rawText: text, extractedFields: fn(t) };
  }

  function parseIdCard(text) {
    const fields = {};

    const id = extractThaiId(text);
    if (id) {
      fields.idNumber = id;
      fields.idNumberValid = validThaiId(id);
    }

    const labelled = findLabelled(text, LABELS.personName, 60);
    const nameTh =
      cleanPersonName(labelled ? labelled.value : '') ||
      cleanPersonName((text.match(new RegExp(`((?:นางสาว|นาง|นาย)[${THAI_RANGE}]{2,40})`)) || [])[1] || '');
    if (nameTh && nameTh.length >= 4 && !isBoilerplate(nameTh)) {
      fields.nameTh = nameTh;
      fields.nameThSkeleton = thaiSkeleton(nameTh);
      fields.name = nameTh;
    }

    const en = text.match(/Name\s*[:\s]*((?:Mr\.|Mrs\.|Ms\.)?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*)/);
    if (en) fields.nameEn = en[1].replace(/\s+/g, ' ').trim();

    const exp = extractExpiry(text);
    if (exp) {
      fields.expiryDate = exp.raw;
      fields.expiryDateParsed = isoOf(exp.date);
    }

    const addr = findLabelled(text, LABELS.address, 110);
    if (addr && !isJunkValue(addr.value, { minThaiRatio: 0.3 })) fields.address = addr.value;

    return fields;
  }

  /** Shared สพ.7 / สพ.19 / ขย.5 licence extraction. */
  function parseLicense(text) {
    const fields = {};

    const lic = findLabelled(text, LABELS.licenseNumber, 30);
    if (lic) {
      const v = lic.value.match(/[ก-ฮA-Z0-9\/\-]{2,}\d+/i);
      if (v) fields.licenseNumber = v[0].trim();
    }

    const named = findLabelled(text, LABELS.facilityName, 80);
    if (named) {
      const cleaned = cleanFacilityName(named.value);
      if (!isJunkValue(cleaned)) fields.facilityName = cleaned;
    }
    if (!fields.facilityName) {
      for (const m of text.matchAll(
        /([^\s\n]{0,30}(?:สหคลินิก|คลินิก|โรงพยาบาล|ร้านยา|ศูนย์)[^\n]{0,40})/g,
      )) {
        const cand = cleanFacilityName(m[1]);
        const distinctive = cand.replace(/(สหคลินิก|คลินิก|โรงพยาบาล|สถานพยาบาล|ร้านยา|ศูนย์)/g, '').trim();
        if (!isJunkValue(cand) && distinctive.length >= 3) {
          fields.facilityName = cand;
          break;
        }
      }
    }

    for (const [key, labels] of [
      ['ownerName', LABELS.ownerName],
      ['operatorName', LABELS.operatorName],
      ['pharmacistName', LABELS.pharmacistName],
    ]) {
      const hit = findLabelled(text, labels, 55);
      if (!hit) continue;
      // Require an actual title. Without one this is a sentence that merely
      // contains the label, not a person, and must be dropped rather than
      // guessed at.
      const m = hit.value.match(new RegExp(`(?:นางสาว|นาง|นาย)[${THAI_RANGE}\\s]{2,45}`));
      if (!m) continue;
      const v = m[0].replace(/\s+/g, ' ').trim();
      if (!isJunkValue(v)) fields[key] = v;
    }

    const addr = findLabelled(text, LABELS.address, 120);
    if (addr && !isJunkValue(addr.value, { minThaiRatio: 0.3 })) fields.address = addr.value;

    const type = findLabelled(text, LABELS.facilityType, 60);
    if (type && !isJunkValue(type.value)) fields.facilityType = type.value;

    const exp = extractExpiry(text);
    if (exp) {
      fields.expiryDate = exp.raw;
      fields.expiryDateParsed = isoOf(exp.date);
      fields.expiryMethod = exp.method;
    }

    return fields;
  }

  function parseLicenseSp19(text) {
    const fields = parseLicense(text);
    if (!fields.ownerName && fields.operatorName) fields.ownerName = fields.operatorName;
    return fields;
  }

  function parsePharmacyLicense(text) {
    const fields = parseLicense(text);
    if (fields.facilityName) fields.pharmacyName = fields.facilityName;
    return fields;
  }

  function parseGeneral(text) {
    const fields = {};
    const id = extractThaiId(text);
    if (id && validThaiId(id)) fields.idNumbers = [id];

    const names = text.match(new RegExp(`(?:นางสาว|นาง|นาย)\\s*[${THAI_RANGE}]+\\s+[${THAI_RANGE}]+`, 'g'));
    if (names) fields.namesFound = [...new Set(names)].slice(0, 5);

    const orgs = text.match(/(?:โรงพยาบาล|คลินิก|ร้านยา|สถานพยาบาล|ศูนย์)\s*\S+/g);
    if (orgs) fields.organizationsFound = [...new Set(orgs)].filter((o) => !isBoilerplate(o)).slice(0, 5);

    const exp = extractExpiry(text);
    if (exp) fields.datesFound = [exp.raw];

    if (!Object.keys(fields).length && text.trim()) {
      fields.textExcerpt = text.trim().slice(0, 120).replace(/\s+/g, ' ');
    }
    return fields;
  }

  async function terminate() {
    if (_tesseractWorker) {
      await _tesseractWorker.terminate();
      _tesseractWorker = null;
      _isInitialized = false;
      _initPromise = null;
    }
  }

  return {
    setProgressCallback,
    deSpaceThai,
    thaiSkeleton,
    normalizeThaiDigits,
    normalizeOcrText,
    validThaiId,
    extractThaiId,
    extractExpiry,
    parseThaiDate,
    ocrImage,
    extractPdfText,
    ocrPdf,
    analyzeDocument,
    parseDocumentText,
    terminate,
  };
})();

if (typeof window !== 'undefined') window.OCREngine = OCREngine;
