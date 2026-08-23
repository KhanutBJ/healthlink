/**
 * rules.js: Rule-Based Verification Engine
 *
 * Pure logic / pattern-matching checks: no AI needed.
 * Each rule returns { id, status, title, detail, category }
 */
const RuleEngine = (() => {
  'use strict';

  function runAllChecks(data) {
    // Pick the right check set based on page source
    const checks = data.source === 'checklist' ? runChecklistChecks(data) : runModalChecks(data);
    return checks.filter(Boolean);
  }

  // ===== CHECKLIST PAGE CHECKS =====

  function runChecklistChecks(d) {
    return [
      chk(
        'hcode-present',
        d.hcode || d.healthUnitHCode,
        'มีรหัสหน่วยบริการ (HCode)',
        (v) => `รหัส: <span class="highlight">${v}</span>`,
        'ไม่พบรหัสหน่วยบริการ',
      ),

      chkHCode(d.hcode || d.healthUnitHCode),

      chk('unit-name', d.healthUnitName, 'ชื่อหน่วยบริการ', (v) => `ชื่อ: ${v}`, 'ไม่พบชื่อหน่วยบริการ'),

      chk(
        'unit-type',
        d.healthUnitType,
        'ประเภทหน่วยบริการ',
        (v) => `ประเภท: ${v}`,
        'ไม่พบประเภทหน่วยบริการ',
      ),

      chk('address', d.address, 'ที่อยู่', (v) => `ที่อยู่: ${v}`, 'ไม่พบที่อยู่', 'warn'),

      chk('province', d.province, 'จังหวัด', (v) => `จังหวัด: ${v}`, 'ไม่พบจังหวัด', 'warn'),

      chk(
        'postal-code',
        d.postalCode,
        'รหัสไปรษณีย์',
        (v) =>
          `รหัสไปรษณีย์: <span class="highlight">${v}</span>` +
          (/^\d{5}$/.test(v) ? '' : ': <span class="mismatch">รูปแบบไม่ถูกต้อง</span>'),
        'ไม่พบรหัสไปรษณีย์',
        'warn',
      ),

      chk(
        'phone',
        d.phone,
        'เบอร์โทรศัพท์',
        (v) =>
          `เบอร์: <span class="highlight">${v}</span>` +
          (/^0\d{8,9}$/.test(v.replace(/[-\s]/g, ''))
            ? ' '
            : ': <span class="mismatch">รูปแบบไม่ปกติ</span>'),
        'ไม่พบเบอร์โทรศัพท์',
        'warn',
      ),

      chkEmail('email', d.email, 'อีเมลหน่วยงาน'),

      // ---- Authority checks ----
      chk(
        'authority-name',
        d.authorityInfo?.name,
        'ชื่อผู้มีอำนาจ',
        (v) => `ชื่อ: ${v}`,
        'ไม่พบชื่อผู้มีอำนาจ',
      ),

      chkThaiId('authority-id', d.authorityInfo?.idNumber, 'เลขบัตร ปชช. ผู้มีอำนาจ'),

      chk(
        'authority-id-doc',
        d.authorityInfo?.idDocUrl,
        'เอกสารสำเนาบัตรผู้มีอำนาจ',
        (v) => `พบลิงก์เอกสาร `,
        'ไม่พบลิงก์เอกสารสำเนาบัตร',
      ),

      // ---- Admin (HA) checks ----
      chk(
        'admin-name',
        d.adminInfo?.name,
        'ชื่อ Hospital Admin (HA)',
        (v) => `ชื่อ: ${v}`,
        'ไม่พบชื่อ HA',
        'warn',
      ),

      chkThaiId('admin-id', d.adminInfo?.idNumber, 'เลขบัตร ปชช. HA'),

      // ---- Cross-checks ----
      crossCheckNames(d),

      // ---- Duplicate Health Unit Check ----
      chkDuplicateUnit(d),

      // ---- Documents ----
      chkDocs(d.documents),

      // ---- Applicant declarations (were only checked on the modal path) ----
      chkAgreements(d),

      // ---- Every required checklist group must have a document behind it ----
      chkDocumentCoverage(d),

      // ---- Same owner across multiple registrations ----
      chkOwnerFootprint(d),

      // ---- This entry's own checklist shape ----
      chkAdaptiveChecklist(d),

      // ---- Checklist items from right panel ----
      chkChecklistItems(d.checklist),
    ];
  }

  // ===== MODAL PAGE CHECKS =====

  function runModalChecks(d) {
    return [
      chk(
        'hcode-present',
        d.hcode,
        'มีรหัสหน่วยบริการ',
        (v) => `รหัส: <span class="highlight">${v}</span>`,
        'ไม่พบ HCode',
      ),
      chk('unit-name', d.healthUnitName, 'ชื่อหน่วยบริการ', (v) => v, 'ไม่พบชื่อ'),
      chkDuplicateUnit(d),
      chk('admin-name', d.adminInfo?.name, 'ชื่อ Admin', (v) => v, 'ไม่พบ', 'warn'),
      chkEmail('admin-email', d.adminInfo?.email, 'อีเมล Admin'),
      chk('authority-name', d.authorityInfo?.name, 'ชื่อผู้มีอำนาจ', (v) => v, 'ไม่พบ', 'warn'),
      {
        id: 'thai-id-verify',
        status: d.authorityInfo?.verified ? 'pass' : 'fail',
        title: 'ยืนยัน ThaiID',
        detail: d.authorityInfo?.verified ? 'ยืนยันแล้ว' : '<span class="mismatch">ยังไม่ยืนยัน</span>',
        category: 'identity',
      },
      {
        id: 'svc-agree',
        status: d.agreements?.serviceAgreement ? 'pass' : 'fail',
        title: 'Service Agreement',
        detail: d.agreements?.serviceAgreement ? '' : '<span class="mismatch">ยังไม่ยอมรับ</span>',
        category: 'agreement',
      },
      {
        id: 'dp-agree',
        status: d.agreements?.dataProcessing ? 'pass' : 'fail',
        title: 'Data Processing Addendum',
        detail: d.agreements?.dataProcessing ? '' : '<span class="mismatch">ยังไม่ยอมรับ</span>',
        category: 'agreement',
      },
      {
        id: 'ds-agree',
        status: d.agreements?.dataSharing ? 'pass' : 'fail',
        title: 'Data Sharing Addendum',
        detail: d.agreements?.dataSharing ? '' : '<span class="mismatch">ยังไม่ยอมรับ</span>',
        category: 'agreement',
      },
      chkDocs(d.documents || []),
    ];
  }

  // ===== HELPER BUILDERS =====

  function chk(id, value, title, passFn, failMsg, failStatus = 'fail') {
    const has = value && String(value).trim().length > 0;
    return {
      id,
      status: has ? 'pass' : failStatus,
      title,
      detail: has ? passFn(value) : failMsg,
      category: 'basic',
    };
  }

  function chkFormat(id, value, title, patterns) {
    if (!value) return null;
    const ok = patterns.some((p) => p.test(value));
    return {
      id,
      status: ok ? 'pass' : 'warn',
      title,
      detail: ok
        ? `<span class="highlight">${value}</span>: รูปแบบถูกต้อง`
        : `<span class="highlight">${value}</span>: รูปแบบไม่ปกติ`,
      category: 'format',
    };
  }

  function chkDuplicateUnit(d) {
    const dup = d.duplicates;
    if (!dup) {
      return {
        id: 'duplicate-unit',
        title: 'ตรวจสอบสถานพยาบาลซ้ำ',
        status: 'info',
        detail: 'ดึงรายชื่อหน่วยบริการไม่สำเร็จ: ยังไม่ได้ตรวจ',
        category: 'basic',
      };
    }

    const fmt = (list) =>
      list
        .slice(0, 8)
        .map((r) => ` [${r.why}] ${r.name} (${r.code || 'ไม่มีรหัส'}): id ${r.id}, ${r.status}`)
        .join('<br>') + (list.length > 8 ? `<br>… อีก ${list.length - 8} รายการ` : '');

    if (dup.strong.length) {
      return {
        id: 'duplicate-unit',
        title: `สถานพยาบาลซ้ำ (${dup.strong.length})`,
        status: 'fail',
        detail: `<span class="mismatch"> พบรายการซ้ำชัดเจน</span><br>${fmt(dup.strong)}`,
        category: 'basic',
      };
    }
    if (dup.weak.length) {
      return {
        id: 'duplicate-unit',
        title: `ชื่อคล้ายกัน (${dup.weak.length})`,
        status: 'warn',
        detail: ` ชื่อตรงกันแต่คนละเจ้าของ/รหัส: ควรตรวจด้วยตนเอง<br>${fmt(dup.weak)}`,
        category: 'basic',
      };
    }
    if (dup.generic) {
      return {
        id: 'duplicate-unit',
        title: 'ตรวจสอบสถานพยาบาลซ้ำ',
        status: 'warn',
        detail: 'ชื่อหน่วยบริการเป็นชื่อทั่วไป (เช่น "เอกชน"): ตรวจซ้ำด้วยชื่อไม่ได้',
        category: 'basic',
      };
    }
    return {
      id: 'duplicate-unit',
      title: 'ตรวจสอบสถานพยาบาลซ้ำ',
      status: 'pass',
      detail: ` ไม่พบซ้ำ (เทียบกับ ${dup.checked.toLocaleString()} รายการ)`,
      category: 'basic',
    };
  }

  /**
   * Report this entry's own checklist, and say plainly which items the tool
   * can decide automatically and which a human still has to judge.
   * Item sets differ per unit type, so this is driven by the page.
   */
  function chkAdaptiveChecklist(d) {
    const groups = d.checklistGroups;
    if (!groups || !groups.length) return null;

    const AUTO = [
      { rx: /ตรงกับ\s*LOI/i, needs: 'ocr-name' },
      { rx: /ไม่หมดอายุ/i, needs: 'ocr-expiry' },
    ];

    let total = 0,
      autoable = 0;
    const lines = groups
      .map((g) => {
        const items = g.items
          .map((it) => {
            total++;
            const rule = AUTO.find((a) => a.rx.test(it.label));
            const can = !!rule;
            if (can) autoable++;
            return (
              `&nbsp;&nbsp;${it.checked ? '' : ''} ${it.label} ` +
              (can
                ? '<span style="opacity:.7">(ตรวจอัตโนมัติได้ถ้า OCR อ่านออก)</span>'
                : '<span class="mismatch">(ต้องตรวจเอง)</span>')
            );
          })
          .join('<br>');
        return `<b>${g.document || 'เอกสาร ' + g.groupId}</b><br>${items}`;
      })
      .join('<br>');

    return {
      id: 'adaptive-checklist',
      title: `รายการตรวจของคำร้องนี้ (${groups.length} เอกสาร / ${total} ข้อ)`,
      status: 'info',
      detail: `${lines}<br><br>ตรวจอัตโนมัติได้สูงสุด ${autoable}/${total} ข้อ`,
      category: 'checklist',
    };
  }

  function chkAgreements(d) {
    const a = d.agreements;
    if (!a) return null;
    const required = [
      ['Service Agreement', a.serviceAgreement],
      ['Data Processing Addendum', a.dataProcessing],
      ['Data Sharing Addendum', a.dataSharing],
      ['ยอมรับเงื่อนไขการให้บริการ', a.termsAccepted],
    ];
    const known = required.filter(([, v]) => v !== null && v !== undefined);
    if (!known.length) {
      return {
        id: 'agreements',
        title: 'การยอมรับข้อตกลง',
        status: 'info',
        detail: 'ไม่พบช่องยอมรับข้อตกลงในหน้านี้',
        category: 'agreement',
      };
    }
    const missing = known.filter(([, v]) => !v);
    return {
      id: 'agreements',
      title: `การยอมรับข้อตกลง (${known.length - missing.length}/${known.length})`,
      status: missing.length ? 'fail' : 'pass',
      detail: known.map(([n, v]) => `${v ? '' : '<span class="mismatch"></span>'} ${n}`).join('<br>'),
      category: 'agreement',
    };
  }

  function chkDocumentCoverage(d) {
    const groups = d.checklistGroups || [];
    const docs = d.documents || [];
    if (!groups.length) return null;
    const missing = groups.length - Math.min(groups.length, docs.length);
    return {
      id: 'doc-coverage',
      title: `เอกสารครบตามรายการ (${Math.min(groups.length, docs.length)}/${groups.length})`,
      status: missing > 0 ? 'fail' : 'pass',
      detail:
        missing > 0
          ? `<span class="mismatch"> ต้องมีเอกสาร ${groups.length} ฉบับ แต่พบ ${docs.length} ฉบับ</span>`
          : ` พบเอกสารครบ ${docs.length} ฉบับตามรายการตรวจ`,
      category: 'document',
    };
  }

  function chkOwnerFootprint(d) {
    const others = d.ownerOtherUnits;
    if (!others) return null;
    if (!others.length) {
      return {
        id: 'owner-footprint',
        title: 'เจ้าของยื่นคำร้องอื่น',
        status: 'pass',
        detail: ' ไม่พบคำร้องอื่นของเจ้าของรายนี้',
        category: 'cross',
      };
    }
    const list = others
      .slice(0, 6)
      .map((r) => ` ${r.name} (${r.code || 'ไม่มีรหัส'}): ${r.status}`)
      .join('<br>');
    return {
      id: 'owner-footprint',
      title: `เจ้าของมีคำร้องอื่น (${others.length})`,
      status: others.length >= 5 ? 'warn' : 'info',
      detail: `${list}${others.length > 6 ? `<br>… อีก ${others.length - 6} รายการ` : ''}`,
      category: 'cross',
    };
  }

  /**
   * HCode rules derived from all 3,032 codes in the live registry:
   * 9 chars : 3,022 (canonical) shapes 999999999, AA9999999, 99A999999
   * 8 chars : 9, 5 chars : 1 (non standard)
   * Matching is case insensitive because 22 real codes are lowercase "ca..."
   * and the previous [A-Z0-9] pattern flagged them purely for being lowercase.
   */
  function chkHCode(code) {
    if (!code) return null;
    const c = String(code).trim();
    const mk = (status, detail) => ({
      id: 'hcode-format',
      title: 'รูปแบบ HCode',
      status,
      detail,
      category: 'format',
    });

    if (/^[A-Z]+$/i.test(c))
      return mk('fail', `<span class="mismatch">${c} ไม่มีตัวเลข น่าจะเป็นข้อมูลทดสอบ</span>`);
    if (/^TEST/i.test(c))
      return mk('fail', `<span class="mismatch">${c} ขึ้นต้นด้วย TEST น่าจะเป็นข้อมูลทดสอบ</span>`);
    if (/^[A-Z0-9]{9}$/i.test(c))
      return mk('pass', `<span class="highlight">${c}</span> รูปแบบมาตรฐาน 9 หลัก`);
    return mk('warn', `<span class="highlight">${c}</span> ยาว ${c.length} หลัก ไม่ใช่ 9 หลักมาตรฐาน`);
  }

  function chkEmail(id, email, title) {
    if (!email) return { id, status: 'warn', title, detail: 'ไม่พบอีเมล', category: 'basic' };
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    return {
      id,
      status: ok ? 'pass' : 'fail',
      title,
      detail: ok ? `${email} ` : `${email}: <span class="mismatch">รูปแบบไม่ถูกต้อง</span>`,
      category: 'format',
    };
  }

  function chkThaiId(id, idNum, title) {
    if (!idNum) return { id, status: 'warn', title, detail: 'ไม่พบเลขบัตร', category: 'identity' };
    const result = validateThaiId(idNum);
    return {
      id,
      title,
      status: result.valid ? 'pass' : 'fail',
      detail: `<span class="highlight">${idNum}</span>: ${result.reason}`,
      category: 'identity',
    };
  }

  function chkDocs(docs) {
    const n = (docs || []).length;
    return {
      id: 'doc-links',
      title: `เอกสารที่พบ (${n} ไฟล์)`,
      status: n > 0 ? 'pass' : 'warn',
      detail:
        n > 0
          ? docs.map((d) => ` ${d.text || d.url}`).join('<br>')
          : 'ไม่พบลิงก์เอกสาร: อาจต้องคลิก "ตรวจเอกสาร"',
      category: 'document',
    };
  }

  function chkChecklistItems(items) {
    if (!items || items.length === 0) return null;
    // Only real checkboxes count. The document headings are not checklist items
    // and listing them made the card show 13 rows under a 0/9 heading.
    const fromPanel = items.filter((i) => i.fromPanel);
    if (!fromPanel.length) return null;
    const checked = fromPanel.filter((i) => i.checked).length;
    return {
      id: 'checklist-panel',
      title: `ความคืบหน้า Checklist (${checked}/${fromPanel.length})`,
      status: checked === fromPanel.length ? 'pass' : 'warn',
      detail:
        checked === fromPanel.length
          ? 'ติ๊กครบทุกข้อแล้ว'
          : `ยังไม่ได้ติ๊ก ${fromPanel.length - checked} ข้อ (ดูรายละเอียดในการ์ด "รายการตรวจของคำร้องนี้")`,
      category: 'checklist',
    };
  }

  function crossCheckNames(d) {
    const authName = d.authorityInfo?.name;
    const adminName = d.adminInfo?.name;
    if (!authName && !adminName) return null;
    if (!authName || !adminName)
      return {
        id: 'cross-names',
        status: 'info',
        title: 'เปรียบเทียบชื่อ',
        detail: 'มีข้อมูลชื่อไม่ครบ ไม่สามารถเปรียบเทียบ',
        category: 'cross',
      };

    const match = fuzzyMatchThaiName(authName, adminName);
    return {
      id: 'cross-names',
      title: 'ผู้มีอำนาจ vs HA',
      status: 'info',
      detail: match.match
        ? `เป็นคนเดียวกัน (${Math.round(match.score * 100)}%): ${authName}`
        : `คนละคน:<br>ผู้มีอำนาจ: ${authName}<br>HA: ${adminName}`,
      category: 'cross',
    };
  }

  // ===== UTILITIES =====

  function validateThaiId(id) {
    if (!id) return { valid: false, reason: 'ไม่มีเลขบัตร' };
    const cleaned = id.replace(/[^0-9]/g, '');
    if (cleaned.length !== 13) return { valid: false, reason: `ต้อง 13 หลัก (พบ ${cleaned.length})` };
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += parseInt(cleaned[i]) * (13 - i);
    const check = (11 - (sum % 11)) % 10;
    const ok = check === parseInt(cleaned[12]);
    return { valid: ok, reason: ok ? 'Checksum ถูกต้อง ' : 'Checksum ไม่ถูกต้อง ', cleaned };
  }

  function fuzzyMatchThaiName(a, b) {
    if (!a || !b) return { match: false, score: 0 };
    const norm = (n) =>
      n
        .replace(/^(นาย|นาง|นางสาว|Mr\.|Mrs\.|Ms\.|Dr\.)\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    const na = norm(a),
      nb = norm(b);
    if (na === nb) return { match: true, score: 1 };
    if (na.includes(nb) || nb.includes(na)) return { match: true, score: 0.9 };

    // Consonant skeleton comparison. Thai OCR splits every glyph and loses
    // vowels and tone marks, and it misreads the title, so compare consonants
    // only with the title removed. Verified on a real card where
    // "สุดารัตน์ ฉัตรธรรมนารถ" OCRs to a string that reduces to the same
    // skeleton and previously reported a false mismatch.
    if (typeof OCREngine !== 'undefined' && OCREngine.thaiSkeleton) {
      const strip = (n) => String(n).replace(/^(นางสาว|นาง|นาย)\s*/, '');
      const sa = OCREngine.thaiSkeleton(strip(a));
      const sb = OCREngine.thaiSkeleton(strip(b));
      if (sa.length >= 4 && sb.length >= 4 && (sa === sb || sa.includes(sb) || sb.includes(sa))) {
        return { match: true, score: 0.85, via: 'skeleton' };
      }
    }

    const pa = na.split(' ').filter(Boolean),
      pb = nb.split(' ').filter(Boolean);
    let c = 0;
    for (const x of pa) {
      if (pb.some((y) => x === y || x.includes(y) || y.includes(x))) c++;
    }
    const s = c / Math.max(pa.length, pb.length);
    return { match: s >= 0.5, score: s };
  }

  return { runAllChecks, validateThaiId, fuzzyMatchThaiName };
})();

if (typeof window !== 'undefined') window.RuleEngine = RuleEngine;
