/**
 * sidepanel.js: Side Panel Controller (OCR version, no API key)
 */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const DOM = {
    connectionBar: $('#connection-bar'),
    connectionText: $('#connection-text'),
    emptyState: $('#empty-state'),
    regCard: $('#reg-card'),
    regStatusBadge: $('#reg-status-badge'),
    infoHcode: $('#info-hcode'),
    infoName: $('#info-name'),
    infoType: $('#info-type'),
    infoAuthority: $('#info-authority'),
    infoAdmin: $('#info-admin'),
    infoEmail: $('#info-email'),
    rulesCard: $('#rules-card'),
    rulesCount: $('#rules-count'),
    rulesList: $('#rules-list'),
    aiCard: $('#ai-card'),
    btnRunAi: $('#btn-run-ai'),
    btnCheckAll: $('#btn-check-all'),
    aiStatus: $('#ai-status'),
    aiProgressBar: $('#ai-progress-bar'),
    aiStatusText: $('#ai-status-text'),
    aiResults: $('#ai-results'),
    comparisonCard: $('#comparison-card'),
    comparisonBody: $('#comparison-body'),
    triageCard: $('#triage-card'),
    triageBody: $('#triage-body'),
    summaryCard: $('#summary-card'),
    summaryBody: $('#summary-body'),
    autoScanToggle: $('#auto-scan-toggle'),
    extractMode: $('#extract-mode'),
    mapCard: $('#map-card'),
    mapBadge: $('#map-badge'),
    mapBody: $('#map-body'),
    apiKeyInput: $('#gemini-api-key'),
    modelInput: $('#gemini-model'),
    btnSaveSettings: $('#btn-save-settings'),
    settingsStatus: $('#settings-status'),
  };

  function initSettings() {
    if (!DOM.btnSaveSettings) return;
    chrome.storage.local.get(['geminiApiKey', 'geminiModel', 'autoScan', 'extractMode'], (data) => {
      autoScan = data.autoScan !== false;
      if (DOM.autoScanToggle) DOM.autoScanToggle.checked = autoScan;
      if (DOM.extractMode) DOM.extractMode.value = data.extractMode || 'parser';
      if (data.geminiApiKey) DOM.apiKeyInput.value = data.geminiApiKey;
      if (data.geminiModel) DOM.modelInput.value = data.geminiModel;
    });
    if (DOM.extractMode) {
      DOM.extractMode.onchange = () => {
        chrome.storage.local.set({ extractMode: DOM.extractMode.value });
      };
    }

    if (DOM.autoScanToggle) {
      DOM.autoScanToggle.onchange = () => {
        autoScan = DOM.autoScanToggle.checked;
        chrome.storage.local.set({ autoScan });
      };
    }

    DOM.btnSaveSettings.onclick = () => {
      chrome.storage.local.set(
        {
          geminiApiKey: DOM.apiKeyInput.value.trim(),
          geminiModel: DOM.modelInput.value.trim(),
          autoScan: DOM.autoScanToggle ? DOM.autoScanToggle.checked : true,
          extractMode: DOM.extractMode ? DOM.extractMode.value : 'parser',
        },
        () => {
          DOM.settingsStatus.textContent = 'บันทึกแล้ว ';
          setTimeout(() => {
            DOM.settingsStatus.textContent = '';
          }, 2500);
        },
      );
    };
  }

  // While a bulk run is in progress the checker only reports; it must not
  // tick checkboxes on 100s of records it is paging through.
  let bulkMode = false;
  let autoScan = true;
  let lastScannedId = null;

  function init() {
    initSettings();

    DOM.btnRunAi.onclick = () => {
      DOM.aiResults.innerHTML = '';
      Agent.runAIAnalysis();
    };

    if (DOM.btnCheckAll) {
      DOM.btnCheckAll.onclick = () => {
        // This ticks the reviewer's compliance boxes by hand, with no
        // verification behind it, so it asks before acting.
        const ok = confirm(
          'ติ๊ก Checklist ทุกข้อในหน้านี้?\n\n' +
            'เป็นการติ๊กด้วยตนเอง ระบบไม่ได้ตรวจสอบเอกสารให้\n' +
            'คุณเป็นผู้รับผิดชอบผลการตรวจนี้',
        );
        if (!ok) return;
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, { type: 'CHECK_ALL_CHECKLIST' }, (r) => {
              if (!chrome.runtime.lastError && r?.success) {
                console.log('[HL] Auto-checked checklist items:', r.count);
              }
            });
          }
        });
      };
    }

    Agent.on('status', (d) =>
      setStatus(
        {
          analyzing: 'checking',
          'ai-analyzing': 'checking',
          'rules-complete': 'connected',
          complete: 'connected',
          error: 'waiting',
        }[d.status] || 'connected',
        d.message,
      ),
    );
    Agent.on('progress', (d) => {
      DOM.aiStatus.classList.remove('hidden');
      DOM.aiProgressBar.style.width = d.progress + '%';
      DOM.aiStatusText.textContent = d.message;
      if (d.progress >= 100) setTimeout(() => DOM.aiStatus.classList.add('hidden'), 1500);
    });
    Agent.on('rules-complete', (d) => renderRules(d.results));
    Agent.on('ai-result', (d) => appendOCR(d.index, d.result));
    Agent.on('comparisons', (d) => renderComparisons(d.comparisons));
    Agent.on('matching-map', (d) => renderMatchingMap(d.map));
    Agent.on('item-verdicts', (d) => {
      if (bulkMode) return;
      const v = d.verdicts?.verified?.length || 0;
      const pend = d.verdicts?.pending?.length || 0;
      if (v || pend) {
        setStatus('connected', `มีหลักฐานรองรับ ${v} ข้อ, ต้องตรวจเอง ${pend} ข้อ`);
      }
    });
    Agent.on('ai-triage-result', (d) => renderTriage(d.triage));
    Agent.on('summary', (d) => {
      renderSummary(d.summary);

      // The checker reports; it never ticks the reviewer's checkboxes.
      // Use the "ติ๊กเลือกทั้งหมด" button to tick them by hand.
      if (bulkMode) {
        setStatus('connected', 'โหมดตรวจรวม');
        return;
      }
      const ev = d.summary?.docEvidence || 0;
      setStatus('connected', `ตรวจเสร็จ: มีหลักฐานจากเอกสาร ${ev} รายการ`);
    });
    Agent.on('error', (d) =>
      appendItem(DOM.aiResults, {
        status: 'fail',
        title: 'Error',
        detail: `<span class="mismatch">${d.message}</span>`,
      }),
    );

    function renderTriage(triage) {
      DOM.triageCard.classList.remove('hidden');
      if (triage.error) {
        DOM.triageBody.innerHTML = `<span style="color:var(--fail)"> AI Error: ${triage.error}</span>`;
      } else {
        let html = (triage.text || '').replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
        html = html.replace(/\n\* /g, '<br> ');
        if (html.startsWith('* ')) html = ' ' + html.substring(2);
        html = html.replace(/\n/g, '<br>');
        DOM.triageBody.innerHTML = html;
      }
    }

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'MODAL_DATA' || msg.type === 'CHECKLIST_DATA') onRegistration(msg.registration);
      if (msg.type === 'START_BULK_AUTOMATION') startBulkRPA(msg.urls);
    });

    let bulkQueue = [];
    let bulkResults = [];
    let bulkDupSweep = null;
    let bulkAudit = null;

    async function startBulkRPA(urls) {
      try {
        bulkMode = true;
        bulkQueue = urls;
        bulkResults = [];
        DOM.aiResults.innerHTML =
          '<div style="padding:10px;text-align:center;color:var(--primary)"> เริ่มระบบ Automate (ทั้งหมด ' +
          urls.length +
          ' รายการ)</div>';

        // Duplicate detection is a property of the whole registry, not of one
        // record, so sweep all entries once up front instead of re-deriving it
        // on every visit. This also covers entries outside the pending queue.
        DOM.aiResults.innerHTML +=
          '<div style="padding:6px;font-size:15px;"> กำลังตรวจสถานพยาบาลซ้ำทั้งระบบ...</div>';
        try {
          const allUnits = await Registry.loadAll(true);
          bulkAudit = Registry.auditAll(allUnits);
          bulkDupSweep = bulkAudit.sweep;
          renderFullAudit(bulkAudit);
        } catch (e) {
          bulkAudit = null;
          bulkDupSweep = null;
          DOM.aiResults.innerHTML += `<div style="color:var(--warn);font-size:17px;padding:6px;">ตรวจทั้งระบบไม่สำเร็จ: ${e.message}</div>`;
        }

        for (let i = 0; i < bulkQueue.length; i++) {
          const url = bulkQueue[i];
          DOM.aiResults.innerHTML += `<div style="margin-top:10px;font-size:15px;">กำลังประมวลผลคิวที่ ${i + 1}/${bulkQueue.length}: ${url}</div>`;

          // 1. Navigate active tab to checklist URL
          await new Promise((resolve) => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              if (tabs[0]) chrome.tabs.update(tabs[0].id, { url }, () => resolve());
              else resolve();
            });
          });

          // 2. Wait for CHECKLIST_DATA from content.js (wait up to 5 seconds)
          await new Promise((resolve) => {
            let timeout;
            const handler = (m) => {
              if (m.type === 'CHECKLIST_DATA') {
                clearTimeout(timeout);
                chrome.runtime.onMessage.removeListener(handler);
                resolve();
              }
            };
            chrome.runtime.onMessage.addListener(handler);
            timeout = setTimeout(() => {
              chrome.runtime.onMessage.removeListener(handler);
              resolve(); // timeout fallback
            }, 8000); // 8 second timeout to allow page load
          });

          // 3. Rule + duplicate checks already ran on CHECKLIST_DATA above.
          // OCR is intentionally skipped here: it costs ~30s per entry and the
          // flags that matter at this scale (duplicates, missing agreements,
          // bad IDs, missing documents) do not depend on it. Open a flagged
          // entry and press สแกนเอกสาร to OCR that one.
          await new Promise((r) => setTimeout(r, 150));

          // 4. Record result
          const st = Agent.getState();
          const huId = String(st.registration?.huId || (url.match(/\/checklist\/(\d+)/) || [])[1] || '');
          const inGlobalDup = bulkDupSweep?.flaggedIds?.has(huId);
          const unreadable = (st.aiResults || []).filter((r) => r.status === 'error').length;

          bulkResults.push({
            url,
            hcode: st.registration?.hcode || 'Unknown',
            name: st.registration?.healthUnitName || '-',
            triage: st.aiTriage?.text || '',
            status: st.summary?.verdict || 'unknown',
            docEvidence: st.summary?.docEvidence || 0,
            flags: [
              // Every failing AND warning check is surfaced: nothing is dropped
              // silently just because it is not a hard failure.
              ...(st.ruleResults || []).filter((r) => r.status === 'fail').map((r) => ` ${r.title}`),
              ...(st.ruleResults || []).filter((r) => r.status === 'warn').map((r) => ` ${r.title}`),
              ...(inGlobalDup ? [' อยู่ในกลุ่มซ้ำ (ตรวจทั้งระบบ)'] : []),
              ...(unreadable ? [` อ่านเอกสารไม่ได้ ${unreadable} ฉบับ`] : []),
            ],
          });

          // short delay before next
          await new Promise((resolve) => setTimeout(resolve, 400));
        }

        // FINISHED: every entry has been checked at registry level and the
        // requested subset deep checked. Open the final report last.
        showBulkReport();
        if (bulkAudit) openFullReport(bulkAudit, bulkResults);
      } catch (err) {
        DOM.aiResults.innerHTML += `<div style="color:red;padding:10px;">RPA Error: ${err.message}</div>`;
      } finally {
        bulkMode = false;
      }
    }

    /**
     * The side panel is too narrow for ~1,000 flagged rows, so the full audit
     * also opens as its own page. It is built locally and opened from a blob,
     * so nothing is uploaded anywhere.
     */
    function openFullReport(audit, deepResults = []) {
      const esc = (t) =>
        String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
      const origin = location.origin.startsWith('chrome-extension')
        ? 'https://hosregis.healthlink.go.th'
        : location.origin;
      const sweep = audit.sweep;
      const now = new Date().toLocaleString('th-TH');

      const rows = [...audit.flagged].sort(
        (a, b) =>
          (a.flags.some((f) => f.level === 'fail') ? 0 : 1) -
            (b.flags.some((f) => f.level === 'fail') ? 0 : 1) || b.flags.length - a.flags.length,
      );

      const clusterHtml = (list, colour) =>
        list
          .map(
            (c) => `<div class="cluster"><div class="clabel" style="color:${colour}">${esc(c.label)}</div>
              <div>${c.members.map((m) => `<a href="${origin}/admin/checklist/${esc(m.id)}" target="_blank">${esc(m.code || m.id)}</a> <span class="muted">${esc(m.name).slice(0, 28)} / ${esc(m.status)}</span>`).join(' &nbsp;&nbsp; ')}</div></div>`,
          )
          .join('');

      const html = `<!doctype html><html lang="th"><head><meta charset="utf-8">
<title>รายงานตรวจสอบคำร้อง HealthLink</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
 body{font-family:'IBM Plex Sans Thai',system-ui,sans-serif;margin:0;padding:32px;background:#0d1117;color:#e6edf3;font-size:16px;line-height:1.7}
 h1{font-size:26px;margin:0 0 6px} h2{font-size:20px;margin:32px 0 10px;border-bottom:1px solid #30363d;padding-bottom:6px}
 .muted{color:#8b949e} a{color:#58a6ff;text-decoration:none} a:hover{text-decoration:underline}
 .cards{display:flex;gap:14px;flex-wrap:wrap;margin:18px 0}
 .c{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px 18px;min-width:130px}
 .c .n{font-size:30px;font-weight:700} .c .l{font-size:14px;color:#8b949e}
 table{width:100%;border-collapse:collapse;font-size:15px} th{text-align:left;padding:10px;border-bottom:2px solid #30363d;position:sticky;top:0;background:#0d1117}
 td{padding:10px;border-bottom:1px solid #21262d;vertical-align:top}
 .fail{color:#f85149} .warn{color:#d29922} .pass{color:#3fb950}
 .cluster{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px 14px;margin-bottom:8px}
 .clabel{font-weight:600;margin-bottom:4px}
 .note{background:#161b22;border-left:4px solid #58a6ff;padding:12px 16px;border-radius:6px;margin:18px 0;font-size:15px}
</style></head><body>
<h1>รายงานตรวจสอบคำร้อง HealthLink</h1>
<div class="muted">สร้างเมื่อ ${esc(now)}</div>
<div class="cards">
 <div class="c"><div class="n">${audit.totalScanned.toLocaleString()}</div><div class="l">ตรวจทั้งหมด</div></div>
 <div class="c"><div class="n fail">${audit.failed.length}</div><div class="l">ต้องแก้ไข</div></div>
 <div class="c"><div class="n warn">${audit.flagged.length - audit.failed.length}</div><div class="l">ต้อง review</div></div>
 <div class="c"><div class="n pass">${(audit.totalScanned - audit.flagged.length).toLocaleString()}</div><div class="l">ไม่พบ flag</div></div>
 <div class="c"><div class="n fail">${sweep.strong.length}</div><div class="l">กลุ่มซ้ำชัดเจน</div></div>
 <div class="c"><div class="n warn">${sweep.weak.length}</div><div class="l">กลุ่มชื่อคล้าย</div></div>
</div>

<h2>สถานพยาบาลซ้ำชัดเจน (${sweep.strong.length} กลุ่ม)</h2>
${clusterHtml(sweep.strong, '#f85149') || '<div class="muted">ไม่พบ</div>'}

<h2>ชื่อคล้ายกัน ควรตรวจด้วยตนเอง (${sweep.weak.length} กลุ่ม)</h2>
${clusterHtml(sweep.weak.slice(0, 60), '#d29922') || '<div class="muted">ไม่พบ</div>'}
${sweep.weak.length > 60 ? `<div class="muted">แสดง 60 จาก ${sweep.weak.length} กลุ่ม</div>` : ''}

${
  deepResults.length
    ? `<h2>ตรวจละเอียดรายคำร้อง (${deepResults.length})</h2>
<table><thead><tr><th>รหัส</th><th>หน่วยบริการ</th><th>ผล</th><th>flag</th></tr></thead><tbody>
${deepResults
  .map(
    (r) => `<tr>
  <td><a href="${esc(r.url)}" target="_blank"><b>${esc(r.hcode)}</b></a></td>
  <td>${esc(r.name)}</td>
  <td class="${r.status === 'fail' ? 'fail' : r.flags.length ? 'warn' : 'pass'}">${
    r.status === 'fail' ? 'ไม่ผ่าน' : r.flags.length ? 'ต้อง review' : 'ไม่พบ flag'
  }</td>
  <td>${r.flags.map((f) => `<div>${esc(f)}</div>`).join('') || '<span class="muted">ไม่มี</span>'}</td>
</tr>`,
  )
  .join('')}
</tbody></table>`
    : ''
}

<h2>รายการที่ติด flagทั้งหมด (${rows.length})</h2>
<table><thead><tr><th>รหัส</th><th>หน่วยบริการ</th><th>สถานะ</th><th>flag</th></tr></thead><tbody>
${rows
  .map(
    (r) => `<tr>
  <td><a href="${origin}/admin/checklist/${esc(r.id)}" target="_blank"><b>${esc(r.code || '-')}</b></a>
      <div class="muted" style="font-size:13px">id ${esc(r.id)}</div></td>
  <td>${esc(r.name)}</td>
  <td class="muted">${esc(r.status)}</td>
  <td>${r.flags.map((f) => `<div class="${f.level}">${f.level === 'fail' ? '!' : '?'} ${esc(f.text)}</div>`).join('')}</td>
</tr>`,
  )
  .join('')}
</tbody></table>
</body></html>`;

      try {
        const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        chrome.tabs.create({ url });
      } catch (e) {
        console.warn('[HL] could not open full report:', e.message);
      }
    }

    function renderFullAudit(audit) {
      DOM.triageCard.classList.remove('hidden');
      const esc = (t) =>
        String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
      const sweep = audit.sweep;

      let html =
        '<h3 style="color:var(--primary);margin-bottom:6px;font-size:20px;">ตรวจทุกคำร้องในระบบ</h3>';
      html += `<p style="font-size:17px;color:var(--text-muted);margin-bottom:12px;line-height:1.6;">
 ตรวจครบ <b>${audit.totalScanned.toLocaleString()}</b> รายการ<br>
 ต้องแก้ไข <b style="color:var(--fail)">${audit.failed.length}</b> รายการ,
 ต้อง review <b style="color:var(--warn)">${audit.flagged.length - audit.failed.length}</b> รายการ,
 ไม่พบ flag <b>${(audit.totalScanned - audit.flagged.length).toLocaleString()}</b> รายการ<br>
 กลุ่มซ้ำ: ชัดเจน <b style="color:var(--fail)">${sweep.strong.length}</b>,
 ชื่อคล้าย <b style="color:var(--warn)">${sweep.weak.length}</b>
 </p>`;

      const rank = (a) => (a.flags.some((f) => f.level === 'fail') ? 0 : 1);
      const rows = [...audit.flagged].sort((x, y) => rank(x) - rank(y) || y.flags.length - x.flags.length);
      const shown = rows.slice(0, 300);

      html +=
        '<table style="width:100%;font-size:16px;border-collapse:collapse;">' +
        '<tr><th style="text-align:left;border-bottom:1px solid #444;padding:6px;">รหัส</th>' +
        '<th style="text-align:left;border-bottom:1px solid #444;padding:6px;">หน่วยบริการ</th>' +
        '<th style="text-align:left;border-bottom:1px solid #444;padding:6px;">flag</th></tr>';

      for (const r of shown) {
        const flags = r.flags
          .map(
            (f) =>
              `<span style="color:${f.level === 'fail' ? 'var(--fail)' : 'var(--warn)'}">${f.level === 'fail' ? '!' : '?'} ${esc(f.text)}</span>`,
          )
          .join('<br>');
        html += `<tr>
 <td style="border-bottom:1px solid #333;padding:6px;vertical-align:top;white-space:nowrap;">
 <a href="${esc(location.origin)}/admin/checklist/${esc(r.id)}" target="_blank" style="color:var(--primary)">${esc(r.code || r.id)}</a>
 </td>
 <td style="border-bottom:1px solid #333;padding:6px;vertical-align:top;">${esc(r.name).slice(0, 30)}<br>
 <span style="opacity:.65;font-size:15px;">${esc(r.status)}</span></td>
 <td style="border-bottom:1px solid #333;padding:6px;vertical-align:top;">${flags}</td>
 </tr>`;
      }
      html += '</table>';
      if (rows.length > shown.length) {
        html += `<p style="font-size:16px;opacity:.7;padding:6px 0;">แสดง ${shown.length} จาก ${rows.length} รายการที่ติด flag</p>`;
      }

      DOM.triageBody.innerHTML = html;
    }

    function showBulkReport() {
      DOM.triageCard.classList.remove('hidden');
      const esc = (t) =>
        String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

      const flagged = bulkResults.filter((r) => r.flags.length || r.status === 'fail');
      const clean = bulkResults.length - flagged.length;

      const sweepHtml = bulkAudit
        ? `<div style="border:1px solid #333;border-radius:6px;padding:10px;margin-bottom:12px;font-size:16px;line-height:1.6;">
 ตรวจระดับทะเบียนครบ <b>${bulkAudit.totalScanned.toLocaleString()}</b> รายการ
 (ติด flag <b style="color:var(--warn)">${bulkAudit.flagged.length}</b>)<br>
 ตรวจละเอียดรายคำร้อง <b>${bulkResults.length}</b> รายการ
 </div>`
        : '';

      let html =
        '<h3 style="color:var(--primary);margin-bottom:6px;font-size:20px;">รายงานตรวจละเอียด</h3>' +
        sweepHtml;
      html += `<p style="font-size:15px;color:var(--text-muted);margin-bottom:12px;">
 ตรวจ ${bulkResults.length} รายการ: ต้อง review ${flagged.length} รายการ, ไม่พบ flag ${clean} รายการ<br>
 </p>`;

      html +=
        '<table style="width:100%;font-size:14px;border-collapse:collapse;">' +
        '<tr><th style="text-align:left;border-bottom:1px solid #444;padding:4px;">รหัส</th>' +
        '<th style="text-align:left;border-bottom:1px solid #444;padding:4px;">หน่วยบริการ</th>' +
        '<th style="text-align:left;border-bottom:1px solid #444;padding:4px;">ผล</th>' +
        '<th style="text-align:left;border-bottom:1px solid #444;padding:4px;">flag ที่ต้อง review</th></tr>';

      const order = { fail: 0, warn: 1, pass: 2 };
      [...bulkResults]
        .sort((x, y) => (order[x.status] ?? 3) - (order[y.status] ?? 3))
        .forEach((r) => {
          // Bulk is a fast pass, so 'pass' here means "no flags from the form
          // and registry checks": not that the documents were verified.
          const badge = r.status === 'fail' ? ' ไม่ผ่าน' : r.flags.length ? ' ต้อง review' : ' ไม่พบ flag';
          const flags = r.flags.length
            ? r.flags.map((f) => `<span style="color:var(--fail)"> ${esc(f)}</span>`).join('<br>')
            : '<span style="opacity:.6">-</span>';
          html += `<tr>
 <td style="border-bottom:1px solid #333;padding:4px;vertical-align:top;"><a href="${esc(r.url)}" target="_blank" style="color:var(--primary)">${esc(r.hcode)}</a></td>
 <td style="border-bottom:1px solid #333;padding:4px;vertical-align:top;">${esc(r.name).slice(0, 28)}</td>
 <td style="border-bottom:1px solid #333;padding:4px;vertical-align:top;white-space:nowrap;">${badge}</td>
 <td style="border-bottom:1px solid #333;padding:4px;vertical-align:top;">${flags}</td>
 </tr>`;
        });

      html += '</table>';
      DOM.triageBody.innerHTML = html;
    }

    // Request data on load
    const refreshActiveTab = () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs?.[0]) return;
        chrome.tabs.sendMessage(tabs[0].id, { type: 'REQUEST_CHECKLIST_DATA' }, (r) => {
          if (!chrome.runtime.lastError && r?.data) onRegistration(r.data);
        });
      });
    };

    refreshActiveTab();

    chrome.tabs.onActivated.addListener(() => {
      refreshActiveTab();
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete' && tab.active) {
        refreshActiveTab();
      }
    });

    setStatus('waiting', 'รอการเชื่อมต่อกับหน้า Admin...');
  }

  function onRegistration(reg) {
    if (!reg) return;
    setStatus('connected', 'เชื่อมต่อแล้ว: พบข้อมูลคำร้อง');
    DOM.emptyState.classList.add('hidden');
    DOM.regCard.classList.remove('hidden');
    DOM.rulesCard.classList.remove('hidden');
    DOM.aiCard.classList.remove('hidden');
    DOM.infoHcode.textContent = reg.hcode || reg.healthUnitHCode || '-';
    DOM.infoName.textContent = reg.healthUnitName || '-';
    DOM.infoType.textContent = reg.healthUnitType || '-';
    DOM.infoAuthority.textContent = reg.authorityInfo?.name || '-';
    DOM.infoAdmin.textContent = reg.adminInfo?.name || '-';
    DOM.infoEmail.textContent = reg.email || reg.adminInfo?.email || reg.authorityInfo?.email || '-';
    Agent.startVerification(reg);

    // Auto press "สแกนเอกสาร" so the reviewer does not have to. Skipped during
    // a bulk run, and skipped for a registration already scanned this session.
    if (!bulkMode && autoScan && reg.huId && lastScannedId !== reg.huId) {
      lastScannedId = reg.huId;
      setTimeout(() => {
        DOM.aiResults.innerHTML = '';
        Agent.runAIAnalysis();
      }, 400);
    }
  }

  function setStatus(status, text) {
    DOM.connectionBar.className = 'connection-bar status-' + status;
    DOM.connectionText.textContent = text;
  }

  const ICONS = { pass: '', fail: '', warn: '!', info: 'i', pending: '…' };

  function renderRules(results) {
    const pass = results.filter((r) => r.status === 'pass').length;
    DOM.rulesCount.textContent = `${pass}/${results.length}`;
    DOM.rulesCount.className = 'badge ' + (pass === results.length ? 'badge-pass' : 'badge-warn');
    DOM.rulesList.innerHTML = '';
    results.forEach((r) => appendItem(DOM.rulesList, r));
    DOM.regStatusBadge.textContent = results.some((r) => r.status === 'fail') ? 'มีปัญหา' : 'พื้นฐานผ่าน';
    DOM.regStatusBadge.className =
      'badge ' + (results.some((r) => r.status === 'fail') ? 'badge-fail' : 'badge-pass');
  }

  function appendItem(container, r) {
    const div = document.createElement('div');
    div.className = 'check-item';
    div.innerHTML = `
 <div class="check-icon ${r.status}">${ICONS[r.status] || '?'}</div>
 <div class="check-content">
 <div class="check-title">${r.title || ''}</div>
 <div class="check-detail">${r.detail || ''}</div>
 </div>`;
    container.appendChild(div);
  }

  function appendOCR(index, result) {
    let rawStatus = result.status;
    let hasParsed = result.parsed && Object.keys(result.parsed).length > 0;
    let hasText = result.ocrText && result.ocrText.trim().length > 0;

    let s = rawStatus === 'error' ? 'fail' : hasParsed ? 'pass' : hasText ? 'warn' : 'fail';

    const div = document.createElement('div');
    div.className = 'check-item doc-card';
    div.style.display = 'flex';
    div.style.gap = '12px';
    div.style.alignItems = 'flex-start';

    // Thumbnail side (Left)
    let thumbHtml = `<div class="check-icon ${s}" style="margin:0">${ICONS[s] || '?'}</div>`;
    if (result.fileType && result.fileType.includes('image') && result.fileData) {
      thumbHtml = `
 <div style="position:relative">
 <img src="data:${result.fileType};base64,${result.fileData}" style="width:120px;max-height:160px;object-fit:contain;border:1px solid #444;border-radius:6px;background:#000;">
 <div class="check-icon ${s}" style="position:absolute;top:-8px;right:-8px;margin:0;transform:scale(0.8);background:var(--bg)">${ICONS[s] || '?'}</div>
 </div>`;
    }

    // Content side (Right)
    let contentHtml = `<div class="check-title" style="margin-bottom:8px;"> ${result.document?.text || result.document?.url?.split('/').pop() || '#' + (index + 1)}</div>`;

    if (result.error) {
      contentHtml += `<div class="check-detail"><span class="mismatch"> AI Error: ${result.error}</span></div>`;
    } else {
      let parts = [];
      if (result.method) parts.push(`วิธี: <span class="highlight">${result.method}</span>`);
      if (result.extractor) parts.push(`ดึงข้อมูล: <span class="highlight">${result.extractor}</span>`);
      if (result.aiError) parts.push(`<span style="color:var(--warn)">AI ล้มเหลว ใช้ parser แทน</span>`);
      if (result.ocrConfidence != null) parts.push(`ความมั่นใจ: ${Math.round(result.ocrConfidence)}%`);

      contentHtml += `<div style="font-size:16px;color:var(--text-muted);margin-bottom:8px;">${parts.join(' ')}</div>`;

      if (hasParsed) {
        let fieldsHtml = '<div style="margin-bottom:12px;">';
        for (const [k, v] of Object.entries(result.parsed)) {
          let val = Array.isArray(v) ? v.join(', ') : v;
          if (val)
            fieldsHtml += `<div style="margin-bottom:4px;"><span style="color:#aaa">${k}:</span> <span>${val}</span></div>`;
        }
        fieldsHtml += '</div>';
        contentHtml += fieldsHtml;
      } else if (hasText) {
        contentHtml += `<div class="check-detail" style="margin-bottom:12px;"><span style="color:var(--warn)"> อ่านข้อความสำเร็จ (${result.ocrText.length} ตัวอักษร): ดูข้อความดิบด้านล่าง</span></div>`;
      } else {
        contentHtml += `<div class="check-detail" style="margin-bottom:12px;"><span class="mismatch"> ไม่สามารถอ่านข้อความจากเอกสารนี้ได้</span></div>`;
      }

      if (hasText) {
        contentHtml += `
 <details>
 <summary style="cursor:pointer;color:var(--primary);font-size:16px;user-select:none;"> ดูข้อความดิบจาก OCR (${result.ocrText.length} ตัวอักษร)</summary>
 <pre style="white-space:pre-wrap;font-size:15px;color:var(--text);margin-top:6px;background:#1a1a2e;padding:12px;border-radius:4px;border:1px solid #333;max-height:200px;overflow-y:auto;">${result.ocrText}</pre>
 </details>`;
      }
    }

    div.innerHTML = `
 <div style="flex-shrink:0;">${thumbHtml}</div>
 <div style="flex-grow:1;min-width:0;">${contentHtml}</div>
 `;

    DOM.aiResults.appendChild(div);
  }

  function renderMatchingMap(map) {
    if (!map) return;
    DOM.mapCard.classList.remove('hidden');
    const esc = (t) =>
      String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

    DOM.mapBadge.textContent = `${map.matched}/${map.rows.length}`;
    DOM.mapBadge.className =
      'badge ' +
      (map.mismatched ? 'badge-fail' : map.manual || map.uncovered.length ? 'badge-warn' : 'badge-pass');

    const STYLE = {
      match: { bg: 'rgba(34,197,94,.12)', bd: 'var(--pass)', tag: 'ตรงกัน' },
      mismatch: { bg: 'rgba(239,68,68,.12)', bd: 'var(--fail)', tag: 'ไม่ตรง' },
      manual: { bg: 'rgba(245,158,11,.12)', bd: 'var(--warn)', tag: 'ตรวจเอง' },
    };

    let html = `<div style="font-size:14px;color:var(--text-muted);margin-bottom:12px;line-height:1.7">
      อ่านเอกสารได้ ${map.documentsRead}/${map.documentsTotal} ฉบับ 
      ตรงกัน <b style="color:var(--pass)">${map.matched}</b> 
      ไม่ตรง <b style="color:var(--fail)">${map.mismatched}</b> 
      ต้องตรวจเอง <b style="color:var(--warn)">${map.manual + map.uncovered.length}</b>
    </div>`;

    for (const r of map.rows) {
      const st = STYLE[r.verdict];
      html += `<div style="background:${st.bg};border-left:4px solid ${st.bd};border-radius:6px;padding:10px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:8px">
          <b style="font-size:15px">${esc(r.field)}</b>
          <span style="color:${st.bd};font-size:14px;white-space:nowrap">${st.tag}</span>
        </div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:14px;line-height:1.6">
          <span style="opacity:.7">ฟอร์ม</span><span>${esc(r.formValue)}</span>
          <span style="opacity:.7">เอกสาร</span><span>${esc(r.docValue)}</span>
          <span style="opacity:.7">ที่มา</span><span style="opacity:.8">${esc(r.source)}</span>
        </div>
        ${r.note ? `<div style="margin-top:6px;font-size:13px;color:${st.bd}">${esc(r.note)}</div>` : ''}
      </div>`;
    }

    if (map.uncovered.length) {
      html += `<div style="background:rgba(245,158,11,.10);border-left:4px solid var(--warn);border-radius:6px;padding:10px">
        <b style="font-size:15px;color:var(--warn)">ไม่มีหลักฐานจากเอกสาร (${map.uncovered.length} ข้อ)</b>
        <div style="font-size:14px;margin-top:6px;line-height:1.7">
          ${map.uncovered.map((u) => ` ${esc(u.label)} <span style="opacity:.65">(${esc(u.document || '')})</span>`).join('<br>')}
        </div>
      </div>`;
    }

    DOM.mapBody.innerHTML = html;
  }

  function renderComparisons(comparisons) {
    if (!comparisons.length) return;
    DOM.comparisonCard.classList.remove('hidden');
    DOM.comparisonBody.innerHTML = comparisons
      .map(
        (c) => `
 <div class="comparison-row">
 <div class="comparison-cell label">${c.field}: ${c.source}</div>
 <div class="comparison-cell source-form ${c.match ? 'match' : 'mismatch'}"><span class="cell-label"> ฟอร์ม</span>${c.formValue}</div>
 <div class="comparison-cell ${c.match ? 'match' : 'mismatch'}"><span class="cell-label"> เอกสาร</span>${c.documentValue}</div>
 ${c.note ? `<div class="comparison-cell label" style="font-size:14px;color:${c.match ? 'var(--pass)' : 'var(--fail)'}">${c.match ? '' : ''} ${c.note}</div>` : ''}
 </div>`,
      )
      .join('');
  }

  function renderSummary(summary) {
    DOM.summaryCard.classList.remove('hidden');
    DOM.summaryBody.innerHTML = `
 <div class="summary-stats">
 <div class="summary-stat pass"><span class="stat-num">${summary.pass}</span><span class="stat-label">ผ่าน</span></div>
 <div class="summary-stat fail"><span class="stat-num">${summary.fail}</span><span class="stat-label">ไม่ผ่าน</span></div>
 <div class="summary-stat warn"><span class="stat-num">${summary.warn}</span><span class="stat-label">ตรวจสอบ</span></div>
 </div>
 <div class="summary-verdict ${summary.verdict}">${summary.message}</div>`;
  }

  init();
})();
