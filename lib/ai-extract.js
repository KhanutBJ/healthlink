/**
 * ai-extract.js - Optional AI extraction, reading the document file directly.
 *
 * In "parser + AI" mode the original file (PDF or image) is uploaded to the
 * Gemini API and the model reads it. This is what makes layout, poor scans and
 * handwriting workable, none of which survive Tesseract.
 *
 * It also means the document leaves the machine, including national ID cards,
 * so the mode is off by default and chosen explicitly by the reviewer.
 *
 * Any failure falls back to local OCR plus the regex parser.
 */
const AIExtract = (() => {
  'use strict';

  const MODES = { PARSER: 'parser', PARSER_AI: 'parser+ai' };

  // Formats the API accepts inline. Anything else goes down the OCR path.
  const SUPPORTED = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/heic'];

  async function mode() {
    const s = await chrome.storage.local.get(['extractMode']);
    return s.extractMode === MODES.PARSER_AI ? MODES.PARSER_AI : MODES.PARSER;
  }

  function mimeFor(contentType, url) {
    const ct = String(contentType || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (SUPPORTED.includes(ct)) return ct === 'image/jpg' ? 'image/jpeg' : ct;
    if (/\.pdf(\?|$)/i.test(url || '')) return 'application/pdf';
    if (/\.png(\?|$)/i.test(url || '')) return 'image/png';
    if (/\.(jpe?g)(\?|$)/i.test(url || '')) return 'image/jpeg';
    return null;
  }

  const PROMPT = `อ่านเอกสารราชการไทยฉบับนี้ทั้งฉบับ รวมถึงลายมือเขียนและตราประทับ
แล้วตอบกลับเป็น JSON เท่านั้น ห้ามมีข้อความอื่นนอก JSON

{
  "documentType": "license_sp7 | license_sp19 | id_card | pharmacy_license | other",
  "facilityName": "ชื่อสถานพยาบาล หรือ null",
  "ownerName": "ชื่อผู้รับอนุญาต หรือ null",
  "operatorName": "ชื่อผู้ดำเนินการ หรือ null",
  "personName": "ชื่อบุคคลบนบัตรประชาชน (ภาษาไทย) หรือ null",
  "idNumber": "เลขบัตรประชาชน 13 หลัก ไม่มีเว้นวรรค หรือ null",
  "licenseNumber": "เลขที่ใบอนุญาต หรือ null",
  "issueDate": "YYYY-MM-DD หรือ null",
  "expiryDate": "YYYY-MM-DD หรือ null",
  "address": "ที่อยู่ หรือ null",
  "isHandwritten": true หรือ false,
  "confidence": ตัวเลข 0.0 ถึง 1.0
}

กฎสำคัญ:
- แปลงปี พ.ศ. เป็น ค.ศ. (ลบ 543) ในทุกวันที่
- ถ้าอ่านไม่ออกหรือไม่แน่ใจ ให้ใส่ null ห้ามเดา
- ห้ามนำข้อความกฎหมายท้ายเอกสาร (มาตรา 55, บทลงโทษ, ต้องระวางโทษ, ริบบรรดาสิ่ง) มาเป็นชื่อ
- ชื่อสถานพยาบาลตอบเฉพาะชื่อ ไม่เอา "ประเภท" หรือ "จำนวนเตียง" ต่อท้าย`;

  /**
   * Send the document file itself to the model.
   * @param {string} base64 raw base64 of the file, no data: prefix
   * @param {string} contentType
   * @param {string} url used only to infer a mime type
   * @returns {Promise<object|null>} normalised fields, or null when not enabled
   */
  async function extractFromFile(base64, contentType, url) {
    if ((await mode()) !== MODES.PARSER_AI) return null;
    if (!base64) return null;

    const mime = mimeFor(contentType, url);
    if (!mime) throw new Error(`ชนิดไฟล์ไม่รองรับ (${contentType || 'unknown'})`);

    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: 'GEMINI_REQUEST',
          payload: {
            contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: base64 } }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 900 },
          },
        },
        (r) => resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r),
      );
    });

    if (!resp?.success) throw new Error(resp?.error || 'AI request failed');

    const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) throw new Error('โมเดลไม่ได้ตอบเป็น JSON');

    const p = JSON.parse(json[0]);
    const id = p.idNumber ? String(p.idNumber).replace(/\D/g, '') : null;

    // Same shape the regex parsers produce, so the comparison pipeline does not
    // care which extractor supplied a value.
    return {
      documentType: p.documentType || null,
      facilityName: p.facilityName || null,
      ownerName: p.ownerName || p.operatorName || null,
      operatorName: p.operatorName || null,
      nameTh: p.personName || null,
      name: p.personName || null,
      idNumber: id || null,
      idNumberValid: id ? OCREngine.validThaiId(id) : null,
      licenseNumber: p.licenseNumber || null,
      expiryDate: p.expiryDate || null,
      expiryDateParsed: p.expiryDate || null,
      address: p.address || null,
      isHandwritten: p.isHandwritten === true,
      confidence: typeof p.confidence === 'number' ? p.confidence : null,
      _via: 'ai-file',
    };
  }

  return { extractFromFile, mode, mimeFor, MODES };
})();

if (typeof window !== 'undefined') window.AIExtract = AIExtract;
