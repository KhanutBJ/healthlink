/**
 * registry.js: Health-unit registry lookup for duplicate detection.
 *
 * The admin list is a server-side DataTable (3,000+ rows), so the visible page
 * only ever holds 10 records. Duplicate detection needs the whole set, which we
 * pull through the content script so the request carries the page's session.
 */
const Registry = (() => {
  'use strict';

  let _cache = null;
  let _loadedAt = 0;
  const TTL_MS = 10 * 60 * 1000;

  function normName(s) {
    return String(s || '')
      .replace(/\s+/g, '')
      .replace(/[()._/\\\u2013\u2014-]/g, '')
      .toLowerCase();
  }

  /**
   * Names shared by many units are placeholders ("เอกชน", "คลินิกเอกชน"), not
   * duplicates. Flagging all 118 of them would bury the real hits, so any name
   * used by >= this many units is treated as generic.
   */
  const GENERIC_THRESHOLD = 10;

  async function loadAll(force = false) {
    if (!force && _cache && _cache.length > 0 && Date.now() - _loadedAt < TTL_MS) {
      return _cache;
    }

    if (!force) {
      const stored = await new Promise((resolve) => {
        chrome.storage.local.get(['registry_cache', 'registry_loaded_at'], (res) => {
          if (res.registry_cache?.length > 0 && Date.now() - (res.registry_loaded_at || 0) < TTL_MS) {
            resolve(res.registry_cache);
          } else {
            resolve(null);
          }
        });
      });
      if (stored && stored.length > 0) {
        _cache = stored;
        _loadedAt = Date.now();
        return _cache;
      }
    }

    let records = await new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs?.[0]) return resolve([]);
        chrome.tabs.sendMessage(tabs[0].id, { type: 'FETCH_REGISTRY' }, (resp) => {
          if (chrome.runtime.lastError) return resolve([]);
          resolve(resp?.records || []);
        });
      });
    });

    if (!records || records.length === 0) {
      records = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'FETCH_REGISTRY' }, (resp) => {
          if (chrome.runtime.lastError) return resolve([]);
          resolve(resp?.records || []);
        });
      });
    }

    if (records && records.length > 0) {
      _cache = records;
      _loadedAt = Date.now();
      chrome.storage.local.set({ registry_cache: records, registry_loaded_at: _loadedAt });
      return _cache;
    }

    const oldStored = await new Promise((resolve) => {
      chrome.storage.local.get(['registry_cache'], (res) => resolve(res.registry_cache || []));
    });

    if (oldStored && oldStored.length > 0) {
      _cache = oldStored;
      return _cache;
    }

    return records || [];
  }

  function genericNames(all) {
    const counts = new Map();
    for (const r of all) {
      const k = normName(r.name);
      if (!k) continue;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const generic = new Set();
    for (const [k, n] of counts) if (n >= GENERIC_THRESHOLD) generic.add(k);
    return generic;
  }

  /**
   * Find other registrations that look like the same facility.
   * Returns { strong[], weak[], generic:boolean }
   * strong: same หน่วยบริการ code, or same name + same owner
   * weak : same name only (worth a look, not proof)
   */
  function normCode(c) {
    const s = String(c || '').trim();
    if (!s) return '';
    const digits = s.replace(/\D/g, '');
    return digits ? digits.replace(/^0+/, '') : s.toLowerCase();
  }

  function findDuplicates(current, all) {
    const out = { strong: [], weak: [], generic: false, checked: all.length };
    if (!all.length) return out;

    const generic = genericNames(all);
    const myName = normName(current.healthUnitName);
    const myCode = normCode(current.hcode || current.healthUnitHCode);
    const myOwner = normName(current.authorityInfo?.name || '');
    const myId = String(current.huId || '');

    out.generic = generic.has(myName);

    for (const r of all) {
      if (String(r.id) === myId) continue;

      const rCode = normCode(r.code);
      const sameCode = myCode && rCode && rCode === myCode;
      const sameName = myName && normName(r.name) === myName;
      const sameOwner = myOwner && normName(r.owner) === myOwner;

      if (sameCode) {
        out.strong.push({ ...r, why: 'รหัสหน่วยบริการซ้ำ' });
      } else if (sameName && sameOwner && !out.generic) {
        out.strong.push({ ...r, why: 'ชื่อและเจ้าของซ้ำ' });
      } else if (sameName && !out.generic) {
        out.weak.push({ ...r, why: 'ชื่อซ้ำ' });
      }
    }
    return out;
  }

  /**
   * Sweep the WHOLE registry for duplicate clusters in one pass, rather than
   * asking "is this one entry a duplicate?" per record. Used by Automate All.
   */
  function allDuplicateClusters(all) {
    const generic = genericNames(all);
    const byCode = new Map();
    const byNameOwner = new Map();
    const byName = new Map();

    for (const r of all) {
      const n = normName(r.name);
      const o = normName(r.owner);
      const c = normCode(r.code);
      if (c) {
        if (!byCode.has(c)) byCode.set(c, []);
        byCode.get(c).push(r);
      }
      if (n && !generic.has(n)) {
        if (!byName.has(n)) byName.set(n, []);
        byName.get(n).push(r);
        if (o) {
          const k = `${n}|${o}`;
          if (!byNameOwner.has(k)) byNameOwner.set(k, []);
          byNameOwner.get(k).push(r);
        }
      }
    }

    const clusters = [];
    const seen = new Set();
    const keyOf = (list) =>
      list
        .map((r) => r.id)
        .sort()
        .join(',');

    for (const [code, list] of byCode) {
      if (list.length < 2) continue;
      clusters.push({ kind: 'code', severity: 'strong', label: `รหัสซ้ำ ${code}`, members: list });
      seen.add(keyOf(list));
    }
    for (const [, list] of byNameOwner) {
      if (list.length < 2 || seen.has(keyOf(list))) continue;
      clusters.push({
        kind: 'name+owner',
        severity: 'strong',
        label: `ชื่อ+เจ้าของซ้ำ: ${list[0].name}`,
        members: list,
      });
      seen.add(keyOf(list));
    }
    for (const [, list] of byName) {
      if (list.length < 2 || seen.has(keyOf(list))) continue;
      clusters.push({ kind: 'name', severity: 'weak', label: `ชื่อซ้ำ: ${list[0].name}`, members: list });
    }

    const strong = clusters.filter((c) => c.severity === 'strong');
    return {
      clusters,
      strong,
      weak: clusters.filter((c) => c.severity === 'weak'),
      genericNames: [...generic],
      totalScanned: all.length,
      flaggedIds: new Set(strong.flatMap((c) => c.members.map((m) => String(m.id)))),
    };
  }

  /** How many other units share this owner: a high count is worth a look. */
  function ownerFootprint(all, ownerName, selfId) {
    const o = normName(ownerName);
    if (!o) return [];
    return all.filter((r) => normName(r.owner) === o && String(r.id) !== String(selfId));
  }

  /**
   * Audit every entry in the registry at once.
   *
   * These are the checks that can be answered from the list data alone, so they
   * cover all ~3,000 records in seconds without opening a single page. The
   * per-entry deep checks (agreements, ID checksums, document contents) still
   * need a page visit and are run separately on a bounded subset.
   */
  function auditAll(all, opts = {}) {
    const slaLimit = opts.slaLimit || 15;
    const ownerLimit = opts.ownerLimit || 5;

    const sweep = allDuplicateClusters(all);
    const generic = new Set(sweep.genericNames);

    const weakIds = new Set(sweep.weak.flatMap((c) => c.members.map((m) => String(m.id))));
    const ownerCounts = new Map();
    for (const r of all) {
      const o = normName(r.owner);
      if (o) ownerCounts.set(o, (ownerCounts.get(o) || 0) + 1);
    }

    const audited = all.map((r) => {
      const flags = [];
      const id = String(r.id);

      if (sweep.flaggedIds.has(id)) flags.push({ level: 'fail', text: 'ซ้ำชัดเจน (รหัส/ชื่อ+เจ้าของ)' });
      else if (weakIds.has(id)) flags.push({ level: 'warn', text: 'ชื่อซ้ำกับรายการอื่น' });

      if (!r.code) flags.push({ level: 'fail', text: 'ไม่มีรหัสหน่วยบริการ' });
      if (generic.has(normName(r.name)))
        flags.push({ level: 'warn', text: 'ชื่อทั่วไป ตรวจซ้ำด้วยชื่อไม่ได้' });

      const oc = ownerCounts.get(normName(r.owner)) || 0;
      if (oc >= ownerLimit) flags.push({ level: 'warn', text: `เจ้าของยื่น ${oc} คำร้อง` });

      if (r.sla >= slaLimit) flags.push({ level: 'warn', text: `ค้าง ${r.sla} วัน` });

      return { ...r, flags };
    });

    return {
      sweep,
      audited,
      flagged: audited.filter((a) => a.flags.length),
      failed: audited.filter((a) => a.flags.some((f) => f.level === 'fail')),
      totalScanned: all.length,
    };
  }

  return { loadAll, findDuplicates, allDuplicateClusters, ownerFootprint, auditAll, normName };
})();

if (typeof window !== 'undefined') window.Registry = Registry;
