/* =====================================================================
   REVIEW REPORT

   The asset management system's Client Review: the firm's review
   workbook (/review/client-review.xlsx) filled in with one client's
   uploaded data, shown on screen as Excel shows it, typed into, and
   exported as the .xlsx. Its three files — review.js (filling the
   workbook), sheetview.js (drawing it) and reviewpage.js (the page) —
   are below as they were, inside this one scope with the few helpers
   their common.js gave them. What changes is where things are kept:

     · the client's data comes from the uploads in BOSS (rrLoad), every
       version of them, so the Portfolio Journey shows the years;
     · the reviewer's changes are kept per client in DB.reviewEdits;
     · every export is kept as well (DB.reviewReports, the file under
       reviewFile.<id>), and listed under Previous reviews.

   JSZip (vendored from npm at /lib/jszip) is loaded the first time a
   review is opened. The page sits on a full-screen layer, #rrOverlay.
   ===================================================================== */
const ReviewReport = (() => {
const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const fmt = {
  money: (v) => (v === null || v === undefined ? "–" : `${v < 0 ? "-" : ""}₹${inr.format(Math.abs(v))}`),
  pct: (v) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `${v.toFixed(2)}%`),
};
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const xlsxBlob = (buffer) => new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

/* ===== review.js (from the asset management system) ===== */
// Client Review Sheet: fills the Finowise review workbook (templates/client-review.xlsx) with one
// client's data (plus the reviewer's edits) and downloads it. The template keeps every sheet, style, formula, chart and logo
// of the review sheet the team already uses; only its data cells are written here:
//   1                   client name and review date (cover)
//   Portfolio Journey   values by year: MF by platform and type, stocks / PMS / AIF / bonds, SIPs
//   SUMMARY PORTFOLIO   one row per date data was uploaded for
//   DETAILED PORTFOLIO  scheme-wise list, grouped by platform and fund type
// Summary and Freedom Blueprint are formulas over Portfolio Journey, so Excel works them out when
// the file is opened. Other savings (EPF, PPF, property...), personal details and the discussion
// notes are not uploaded anywhere: the RM types them on the Review Report page
// (public/js/reviewpage.js), which also lets them correct the uploaded figures for the report.
//
// The workbook is edited as XML inside the zip (JSZip), because rebuilding it with a spreadsheet
// library would drop the charts and much of the formatting.
const Review = (() => {
  const TEMPLATE_URL = "/review/client-review.xlsx";
  const LOANS = "LAS";
  const MF_TYPES = ["Equity", "Hybrid", "Debt", "Others"];

  // ---- Worksheet XML ---------------------------------------------------------------------
  const colNum = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const colName = (n) => { let s = ""; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
  const splitRef = (ref) => { const m = /^([A-Z]+)(\d+)$/.exec(ref); return [colNum(m[1]), Number(m[2])]; };
  const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const round2 = (n) => Math.round(n * 100) / 100;

  // Excel date serial for an ISO date (YYYY-MM-DD).
  const serial = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
  };

  class Sheet {
    constructor(xml) {
      const m = /<sheetData\s*\/>|<sheetData>([\s\S]*?)<\/sheetData>/.exec(xml);
      this.head = xml.slice(0, m.index);
      this.tail = xml.slice(m.index + m[0].length);
      this.rows = new Map();
      for (const rm of (m[1] || "").matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const r = Number(/\br="(\d+)"/.exec(rm[1])[1]);
        const cells = new Map();
        for (const cm of (rm[2] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          cells.set(splitRef(/\br="([A-Z]+\d+)"/.exec(cm[1])[1])[0], cm[0]);
        }
        this.rows.set(r, { attrs: rm[1].replace(/\s*\b(r|spans)="[^"]*"/g, ""), cells });
      }
    }

    row(r) {
      if (!this.rows.has(r)) this.rows.set(r, { attrs: "", cells: new Map() });
      return this.rows.get(r);
    }

    style(ref) {
      const [c, r] = splitRef(ref);
      const x = this.rows.get(r)?.cells.get(c);
      const m = x && /\bs="(\d+)"/.exec(x.slice(0, x.indexOf(">")));
      return m ? m[1] : null;
    }

    text(ref) {
      const [c, r] = splitRef(ref);
      const x = this.rows.get(r)?.cells.get(c) || "";
      const m = /<t[^>]*>([^<]*)<\/t>/.exec(x);
      return m ? m[1] : null;
    }

    // value: number, string, {f: formula}, or null/"" for an empty cell. The cell keeps its
    // style unless opts.s is given.
    set(ref, value, opts = {}) {
      const [c, r] = splitRef(ref);
      const s = opts.s !== undefined ? opts.s : this.style(ref);
      const sa = s !== null && s !== undefined ? ` s="${s}"` : "";
      let x;
      if (value === null || value === undefined || value === "" || (typeof value === "number" && !Number.isFinite(value))) {
        x = `<c r="${ref}"${sa}/>`;
      } else if (typeof value === "number") {
        x = `<c r="${ref}"${sa}><v>${Math.round(value * 1e4) / 1e4}</v></c>`;
      } else if (typeof value === "object" && value.f) {
        x = `<c r="${ref}"${sa}><f>${xmlEsc(value.f)}</f></c>`;
      } else {
        x = `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(value)}</t></is></c>`;
      }
      this.row(r).cells.set(c, x);
    }

    clear(ref) { if (this.rows.get(splitRef(ref)[1])?.cells.has(splitRef(ref)[0])) this.set(ref, null); }

    clearArea(c1, c2, r1, r2) {
      for (let r = r1; r <= r2; r++) {
        const row = this.rows.get(r);
        if (!row) continue;
        for (const c of [...row.cells.keys()]) if (c >= colNum(c1) && c <= colNum(c2)) this.set(`${colName(c)}${r}`, null);
      }
    }

    // Style of every cell in a row, by column number.
    rowStyles(r) {
      const out = new Map();
      for (const [c] of this.rows.get(r)?.cells || []) out.set(c, this.style(`${colName(c)}${r}`));
      return out;
    }

    rowAttrs(r) { return this.rows.get(r)?.attrs || ""; }

    deleteRowsFrom(r1) { for (const r of [...this.rows.keys()]) if (r >= r1) this.rows.delete(r); }

    // Start row r afresh: no cells, the given row attributes, and an empty styled cell for each
    // entry of styles (so borders and fills carry across the row).
    blankRow(r, attrs, styles) {
      this.rows.set(r, { attrs, cells: new Map() });
      for (const [c, s] of styles) this.set(`${colName(c)}${r}`, null, { s });
    }

    setMerges(refs) {
      const xml = refs.length ? `<mergeCells count="${refs.length}">${refs.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
      if (/<mergeCells\b[\s\S]*?<\/mergeCells>/.test(this.tail)) this.tail = this.tail.replace(/<mergeCells\b[\s\S]*?<\/mergeCells>/, xml);
      else this.tail = xml + this.tail;
    }

    toXml() {
      const rows = [...this.rows.entries()].sort((a, b) => a[0] - b[0]).map(([r, { attrs, cells }]) => {
        const cs = [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x).join("");
        return cs ? `<row r="${r}"${attrs}>${cs}</row>` : `<row r="${r}"${attrs}/>`;
      }).join("");
      const last = Math.max(1, ...this.rows.keys());
      const head = this.head.replace(/<dimension ref="[^"]*"\/>/, (d) => d.replace(/:[A-Z]+\d+"/, (x) => x.replace(/\d+"$/, `${last}"`)));
      return `${head}<sheetData>${rows}</sheetData>${this.tail}`;
    }
  }

  // Sheet name -> path inside the zip.
  async function sheetPaths(zip) {
    const wb = await zip.file("xl/workbook.xml").async("string");
    const rels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
    const target = {};
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /Id="([^"]+)"/.exec(m[0])[1], t = /Target="([^"]+)"/.exec(m[0])[1];
      target[id] = t.startsWith("/") ? t.slice(1) : `xl/${t}`;
    }
    const out = {};
    for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
      const name = /name="([^"]+)"/.exec(m[0])[1].replace(/&amp;/g, "&");
      out[name] = target[/r:id="([^"]+)"/.exec(m[0])[1]];
    }
    return out;
  }

  // ---- Classifying holdings --------------------------------------------------------------
  const lower = (s) => String(s || "").toLowerCase();

  function mfType(name, category) {
    const t = `${lower(category)} ${lower(name)}`;
    if (/gold|silver|commodit/.test(t)) return "Others";
    if (/hybrid|balanced|dynamic asset|multi[\s-]*asset|asset allocat|arbitrage|equity savings|retirement|children/.test(t)) return "Hybrid";
    if (/liquid|overnight|money market|\bdebt\b|bond|gilt|duration|credit risk|banking (&|and) psu|psu debt|floater|floating|\bincome\b|treasury|dynamic term|fixed maturity|\bfmp\b|target maturity|savings fund|ultra short|low duration|corporate|g-?sec|constant maturity|accrual/.test(t)) return "Debt";
    return "Equity";
  }

  const SUB_TYPES = [
    [/large\s*(&|and)\s*mid/, "Large and Mid Cap"], [/large\s*cap|blue\s*chip|frontline|top 100/, "Large Cap"], [/mid[\s-]*cap|emerging equity/, "Mid Cap"],
    [/small[\s-]*cap/, "Small Cap"], [/flexi[\s-]*cap/, "Flexi Cap"], [/multi[\s-]*cap/, "Multi Cap"], [/focused/, "Focused"],
    [/elss|tax\s*saver/, "ELSS"], [/\bvalue\b|contra/, "Value / Contra"], [/dividend yield/, "Dividend Yield"],
    [/balanced advantage|dynamic asset/, "Bal Adv"], [/multi[\s-]*asset/, "Multi AA"], [/aggressive hybrid|equity hybrid/, "Aggressive Hybrid"],
    [/conservative hybrid/, "Conservative Hybrid"], [/arbitrage/, "Arbitrage"], [/equity savings/, "Equity Savings"],
    [/liquid/, "Liquid"], [/overnight/, "Overnight"], [/money market/, "Money Market"], [/gilt|g-?sec/, "Gilt"],
    [/corporate bond/, "Corporate Bond"], [/banking (&|and) psu/, "Banking & PSU"], [/short (term|duration)/, "Short Duration"],
    [/dynamic (bond|term)/, "Dyn. Bond"], [/ultra short|low duration/, "Ultra Short"], [/credit risk/, "Credit Risk"],
    [/gold/, "Gold Plan"], [/silver/, "Silver"], [/international|global|nasdaq|overseas|\bus\b/, "International"],
    [/index|nifty|sensex|\betf\b/, "Index"], [/sector|thematic|infra|pharma|banking|technology|consumption/, "Sectoral / Thematic"],
    [/fof|fund of fund/, "FOF"],
  ];
  const GENERIC = /^(mutual fund|mf|equity|debt|hybrid|others?|unclassified)$/i;

  function subType(name, category) {
    const cat = String(category || "").trim().replace(/^(equity|debt|hybrid|other|solution oriented)\s*[:\-–]\s*/i, "");
    if (cat && !GENERIC.test(cat)) return cat;
    const n = lower(name);
    const hit = SUB_TYPES.find(([re]) => re.test(n));
    return hit ? hit[1] : "";
  }

  const nameKey = (r) => lower(r.security_name).replace(/[^a-z0-9]+/g, " ").trim();
  const schemeKey = (r) => (r.isin ? `i:${r.isin}` : `n:${nameKey(r)}`);

  // SIP files rarely carry the ISIN that AUM files do. Give every row without one the ISIN another
  // row of the same scheme name has, so SIPs line up with their holdings.
  function shareIsins(rows) {
    const byName = new Map(rows.filter((r) => r.isin).map((r) => [nameKey(r), r.isin]));
    return rows.map((r) => (r.isin || !byName.has(nameKey(r)) ? r : { ...r, isin: byName.get(nameKey(r)) }));
  }

  // ---- Data as of a date -----------------------------------------------------------------
  // The rows of one upload for each platform + category. Now (date null): the latest upload, as
  // the dashboard's current_holdings / current_sips views pick it. As of a date: the upload with
  // the latest data date on or before it.
  // Rows current at a date (or now): per client folio and scheme, the newest upload that lists it,
  // the same rule as the dashboard. A mutual fund folio is one folio whichever platform sends it.
  const folioKey = (r) => [r.product, r.product === "MF" ? "" : r.platform_key, lower(r.identifier || ""),
    (r.isin || "").toUpperCase() || lower(r.security_name || "")].join("|");
  function latestRows(rows, uploads, date) {
    const up = new Map(uploads.map((u) => [u.id, u]));
    const rank = (id) => (date ? `${up.get(id).snapshot_date}|${String(id).padStart(12, "0")}` : String(id).padStart(12, "0"));
    const best = new Map();
    for (const r of rows) {
      const u = up.get(r.upload_id);
      if (!u || (date && u.snapshot_date > date)) continue;
      const k = folioKey(r);
      if (!best.has(k) || rank(r.upload_id) > rank(best.get(k))) best.set(k, r.upload_id);
    }
    const kept = rows.filter((r) => r.level !== "summary" && best.get(folioKey(r)) === r.upload_id);
    // An investor total stands in only where there is no scheme-wise detail for that platform.
    const detailed = new Set(kept.map((r) => `${r.platform_key}|${r.product}`));
    const totals = new Map();
    for (const r of rows) {
      const u = up.get(r.upload_id);
      if (r.level !== "summary" || !u || (date && u.snapshot_date > date) || detailed.has(`${r.platform_key}|${r.product}`)) continue;
      const k = `${r.platform_key}|${r.product}`;
      if (!totals.has(k) || rank(r.upload_id) > rank(totals.get(k))) totals.set(k, r.upload_id);
    }
    return kept.concat(rows.filter((r) => r.level === "summary" && totals.get(`${r.platform_key}|${r.product}`) === r.upload_id));
  }

  const PLATFORM = {
    nj: /^nj\b|\bnj wealth/, finowise: /finowise|advisor\s*khoj/, anandRathi: /anand\s*rathi/, freedom: /freedom\s*life\s*x|nflx/,
    motilal: /motilal/, omni: /omni\s*science/, piper: /piper/, phillip: /phil+ip/,
  };
  const is = (name, which) => PLATFORM[which].test(lower(name));

  // Fund type of a row: the reviewer's choice on the review dashboard, else from the category / name.
  const typeOfRow = (r) => r._type || mfType(r.security_name, r.category);

  function emptyMf() {
    const z = () => Object.fromEntries(MF_TYPES.map((t) => [t, 0]));
    return { value: z(), sip: z(), total: 0, sipTotal: 0, invested: 0 };
  }

  // Totals for one point in time.
  function figures(holdings, sips) {
    const own = holdings.filter((h) => h.product !== LOANS);
    const typeOf = new Map();
    const mf = new Map(); // platform name -> emptyMf()
    const add = (map, name) => { if (!map.has(name)) map.set(name, emptyMf()); return map.get(name); };
    for (const h of own.filter((x) => x.product === "MF")) {
      const t = typeOfRow(h);
      typeOf.set(schemeKey(h), t);
      const p = add(mf, h.platform);
      p.value[t] += h.current_value || 0; p.total += h.current_value || 0; p.invested += h.invested || 0;
    }
    const live = sips.filter((s) => s.live && s.product !== LOANS);
    for (const s of live.filter((x) => x.product === "MF")) {
      const t = typeOf.get(schemeKey(s)) || typeOfRow(s);
      const p = add(mf, s.platform);
      p.sip[t] += s.monthly_amount || 0; p.sipTotal += s.monthly_amount || 0;
    }
    // Stocks, PMS, AIF, bonds and other: value and live SIP by row of the Portfolio Journey.
    const other = new Map();
    const bump = (k, field, v) => { const o = other.get(k) || { value: 0, sip: 0 }; o[field] += v || 0; other.set(k, o); };
    const otherRow = (r) => {
      if (r.product === "PMS") return "PMS";
      if (r.product === "AIF") return "AIF";
      if (r.product === "Bonds") return "Bonds";
      if (r.product === "Other") return "Other";
      if (is(r.platform, "motilal")) return "Motilal";
      if (is(r.platform, "omni")) return "Omni";
      if (is(r.platform, "piper")) return "Piper";
      if (is(r.platform, "phillip")) return "Phillip";
      return "Direct";
    };
    for (const h of own.filter((x) => x.product !== "MF")) bump(otherRow(h), "value", h.current_value);
    for (const s of live.filter((x) => x.product !== "MF")) bump(otherRow(s), "sip", s.monthly_amount);
    const stocks = (row) => own.filter((h) => h.product === "Stocks" && is(h.platform, row)).reduce((a, h) => a + (h.current_value || 0), 0);
    return {
      mf, other,
      shares: { motilal: stocks("motilal"), omni: stocks("omni"), piper: stocks("piper"),
        total: own.filter((h) => h.product === "Stocks").reduce((a, h) => a + (h.current_value || 0), 0) },
      value: own.reduce((a, h) => a + (h.current_value || 0), 0),
      invested: own.reduce((a, h) => a + (h.invested || 0), 0),
      sip: live.reduce((a, s) => a + (s.monthly_amount || 0), 0),
    };
  }

  // ---- Filling the sheets ----------------------------------------------------------------
  const YEAR_COLS = Array.from({ length: 15 }, (_, i) => colName(6 + i)); // F..T
  const MF_BLOCKS = [6, 16, 26, 36, 46]; // first row of each MF platform block in Portfolio Journey
  const OTHER_ROWS = { PMS: 71, Motilal: 73, Omni: 75, Piper: 77, Phillip: 79, Direct: 81, Other: 83, AIF: 85, Bonds: 87 };

  // MF platforms in the five blocks: NJ, Finowise, Anand Rathi, then the largest other platform,
  // then all remaining platforms together.
  function mfBlocks(names) {
    const fixed = [names.find((n) => is(n, "nj")), names.find((n) => is(n, "finowise")), names.find((n) => is(n, "anandRathi"))];
    const rest = names.filter((n) => !fixed.includes(n));
    return [fixed[0], fixed[1], fixed[2], rest[0], rest.slice(1)].map((x) => (Array.isArray(x) ? x : x ? [x] : []));
  }

  function fillJourney(sh, years, current, reviewDate, allMf) {
    const startYear = Math.min(Number(reviewDate.slice(0, 4)), ...years.keys());
    sh.set("G2", serial(reviewDate));
    sh.set("F5", startYear);
    sh.set("G5", { f: "F5+1" });
    const blocks = mfBlocks(allMf);
    // Block labels for the 4th and 5th MF platforms.
    [[3, "B36", "D44", "D45", "Direct"], [4, "B46", "D54", "D55", "Other Advisors"]].forEach(([i, b, v, s, dflt]) => {
      const label = blocks[i].length === 1 ? blocks[i][0] : blocks[i].length ? "Other Advisors" : dflt;
      sh.set(b, label); sh.set(v, `${label} MF Portfolio Value`); sh.set(s, `${label} MF Live SIP`);
    });
    const used = new Set(Object.keys(OTHER_ROWS).filter((k) => [...years.values(), current].some((f) => f.other.has(k))));
    if (used.has("Other")) sh.set("B83", "Other Investments");
    if (used.has("AIF")) sh.set("B85", "AIF");
    if (used.has("Bonds")) sh.set("B87", "Bonds");

    YEAR_COLS.forEach((col, i) => {
      const y = startYear + i;
      const f = y === Number(reviewDate.slice(0, 4)) ? current : years.get(y);
      if (!f) return;
      blocks.forEach((names, b) => {
        const r0 = MF_BLOCKS[b];
        const sum = (field, t) => names.reduce((a, n) => a + (f.mf.get(n)?.[field][t] || 0), 0);
        MF_TYPES.forEach((t, k) => {
          sh.set(`${col}${r0 + k}`, sum("value", t) || null);
          sh.set(`${col}${r0 + 4 + k}`, sum("sip", t) || null);
        });
      });
      for (const [k, r] of Object.entries(OTHER_ROWS)) {
        const o = f.other.get(k);
        sh.set(`${col}${r}`, o?.value || null);
        sh.set(`${col}${r + 1}`, o?.sip || null);
      }
    });
    return startYear;
  }

  function fillSummaryPortfolio(sh, name, timeline) {
    const st = { a: sh.style("A37"), b: sh.style("B37"), n: sh.style("C37") };
    const attrs = sh.rowAttrs(37), gap = sh.rowAttrs(36);
    sh.deleteRowsFrom(3);
    // The Finowise MF platform takes the columns the old sheet used for Redvision.
    sh.set("M1", "FINOWISE");
    sh.set("U2", "FINOWISE LIVE SIP");
    sh.set("V2", "TOTAL FINOWISE MF PORTFOLIO VALUE");
    // "FINOWISE TOTAL PORTFOLIO" (AQ:AR) only repeated the grand total's wealth and SIP (BN, BL),
    // so it is left out.
    sh.clearArea("AQ", "AR", 1, 2);
    sh.tail = sh.tail.replace(/<mergeCell ref="AQ1:AR1"\/>/, "");
    sh.tail = sh.tail.replace(/<mergeCells count="\d+"/, `<mergeCells count="${(sh.tail.match(/<mergeCell ref=/g) || []).length}"`);
    const mfCols = (f, which, cols) => {
      const p = [...f.mf.entries()].filter(([n]) => is(n, which)).map(([, v]) => v);
      const g = (field, t) => p.reduce((a, x) => a + x[field][t], 0);
      return cols.map((c, i) => [c, i < 8 ? g(i % 2 ? "sip" : "value", MF_TYPES[i >> 1]) : i === 8
        ? p.reduce((a, x) => a + x.sipTotal, 0) : p.reduce((a, x) => a + x.total, 0)]);
    };
    const span = (from, n) => Array.from({ length: n }, (_, i) => colName(colNum(from) + i));
    timeline.forEach(({ date, f }, i) => {
      const r = 3 + i * 2;
      sh.rows.set(r, { attrs, cells: new Map() });
      if (i) sh.rows.set(r - 1, { attrs: gap, cells: new Map() });
      sh.set(`A${r}`, serial(date), { s: st.a });
      sh.set(`B${r}`, name, { s: st.b });
      const ar = [...f.mf.entries()].filter(([n]) => is(n, "anandRathi")).map(([, v]) => v);
      const cells = [
        ...mfCols(f, "nj", span("C", 10)),
        ...mfCols(f, "finowise", span("M", 10)),
        ...MF_TYPES.map((t, k) => [colName(23 + k), ar.reduce((a, x) => a + x.value[t], 0)]), // W..Z
        ["AA", ar.reduce((a, x) => a + x.sipTotal, 0)], ["AB", ar.reduce((a, x) => a + x.total, 0)],
        ["AC", f.shares.motilal], ["AD", f.shares.omni], ["AE", f.shares.piper], ["AF", f.shares.total],
        ...mfCols(f, "freedom", span("AG", 10)),
        ["BL", f.sip], ["BM", f.invested], ["BN", f.value],
      ];
      for (const [c, v] of cells) sh.set(`${c}${r}`, v || null, { s: st.n });
      sh.set(`BO${r}`, { f: `BN${r}-BM${r}` }, { s: st.n });
    });
  }

  // rupee(styleId, refStyleId): the same cell style with the Live SIP column's ₹ number format.
  function fillDetailed(sh, client, holdings, sips, rupee = (id) => id) {
    // Styles from the template's own rows (see the review sheet this was built from).
    const proto = {
      investor: 3, type: 4, scheme: 6, groupTotal: 15, gap: 16, platformTotal: 34, platformGap: 35,
      header: 36, item: 37, subTotal: 38, subGap: 39, grand: 40,
    };
    const styles = Object.fromEntries(Object.entries(proto).map(([k, r]) => [k, sh.rowStyles(r)]));
    const attrs = Object.fromEntries(Object.entries(proto).map(([k, r]) => [k, sh.rowAttrs(r)]));
    sh.deleteRowsFrom(3);
    sh.set("P2", "New SIP");
    const merges = [];
    const schemeRows = new Map(); // row number -> rowKey of the scheme on it (for the review page)
    const folds = []; // fund-type and platform blocks the review page can fold: {id, head, first, last, total}
    const blocks = []; // one per platform + product, for the review page's cards: {head, total, folds: [id]}
    let r = 3;
    const start = (kind) => { sh.blankRow(r, attrs[kind], styles[kind]); return r++; };
    // Scheme rows show ₹ on invested, current value and total, as on the Live SIP column.
    const RUPEE_COLS = new Set(["D", "G", "J"]);
    const put = (row, kind, values) => {
      for (const [c, v] of Object.entries(values)) {
        const st = styles[kind].get(colNum(c)) ?? null;
        sh.set(`${c}${row}`, v, { s: kind === "scheme" && RUPEE_COLS.has(c) && st !== null ? rupee(st, styles.scheme.get(15)) : st });
      }
    };
    const pct = (gain, inv) => (inv ? round2((gain / inv) * 100) : null);
    // Columns the reviewer fills on the review dashboard: tenure, new SIP, remarks, suggestions.
    const notes = (x) => Object.fromEntries([["N", x._tenure], ["P", x._newSip], ["T", x._remarks], ["U", x._suggest]].filter(([, v]) => v !== undefined && v !== ""));

    const row = start("investor");
    put(row, "investor", { A: "Investor", B: client.name + (client.id ? ` (${client.id})` : "") });
    r++;

    const own = holdings.filter((h) => h.product !== LOANS);
    const live = sips.filter((s) => s.live && s.product !== LOANS);
    const sipBy = new Map();
    for (const s of live) {
      const k = `${s.platform_key}|${s.product}|${schemeKey(s)}`;
      sipBy.set(k, (sipBy.get(k) || 0) + (s.monthly_amount || 0));
    }
    const totals = []; // rows of each platform total, for the grand total

    // Weighted XIRR of a set of rows, by current value.
    const xirrOf = (rows) => {
      const w = rows.filter((x) => Number.isFinite(x.xirr) && x.current_value);
      const v = w.reduce((a, x) => a + x.current_value, 0);
      return v ? round2(w.reduce((a, x) => a + x.xirr * x.current_value, 0) / v) : null;
    };

    // Mutual funds: one block per platform, schemes grouped by fund type.
    const mfPlatforms = [...new Set([...own, ...live].filter((x) => x.product === "MF").map((x) => x.platform_key))];
    for (const pk of mfPlatforms) {
      const hs = own.filter((h) => h.product === "MF" && h.platform_key === pk);
      const pname = (hs[0] || live.find((s) => s.platform_key === pk && s.product === "MF")).platform;
      const block = { head: start("header"), folds: [] };
      put(block.head, "header", { B: `${pname} · Mutual Funds` });
      const groupRows = [];
      const typeOf = new Map(hs.map((h) => [schemeKey(h), typeOfRow(h)]));
      for (const t of MF_TYPES) {
        const items = hs.filter((h) => typeOf.get(schemeKey(h)) === t).sort((a, b) => (b.current_value || 0) - (a.current_value || 0));
        // SIPs into schemes this platform's AUM file does not hold yet.
        const extra = live.filter((s) => s.product === "MF" && s.platform_key === pk && !typeOf.has(schemeKey(s))
          && typeOfRow(s) === t);
        const extraSchemes = [...new Map(extra.map((s) => [schemeKey(s), s])).values()];
        if (!items.length && !extraSchemes.length) continue;
        const head = start("type");
        put(head, "type", { A: "Type", B: t === "Others" ? "OTHERS" : t.toUpperCase() });
        const value = items.reduce((a, h) => a + (h.current_value || 0), 0);
        const first = r;
        let n = 0;
        for (const h of items) {
          const rr = start("scheme");
          schemeRows.set(rr, rowKey(h));
          put(rr, "scheme", {
            A: ++n, B: h.security_name || "", C: h._sub ?? subType(h.security_name, h.category), D: h.invested, E: 0, F: h.quantity,
            G: h.current_value, H: 0, I: 0, J: { f: `SUM(G${rr}:I${rr})` }, K: h.xirr, L: h.return_pct ?? pct((h.current_value || 0) - (h.invested || 0), h.invested),
            M: value ? round2(((h.current_value || 0) / value) * 100) : null, O: sipBy.get(`${pk}|MF|${schemeKey(h)}`) || null, ...notes(h),
          });
        }
        for (const s of extraSchemes) {
          const rr = start("scheme");
          schemeRows.set(rr, rowKey(s));
          put(rr, "scheme", { A: ++n, B: s.security_name || "", C: s._sub ?? subType(s.security_name, null), O: sipBy.get(`${pk}|MF|${schemeKey(s)}`) || null, ...notes(s) });
        }
        const last = r - 1;
        const gt = start("groupTotal");
        folds.push({ id: `${pk}|MF|${t}`, head, first, last, total: gt });
        block.folds.push(`${pk}|MF|${t}`);
        merges.push(`A${gt}:C${gt}`);
        const sum = (c) => ({ f: `SUM(${c}${first}:${c}${last})` });
        const inv = items.reduce((a, h) => a + (h.invested || 0), 0);
        put(gt, "groupTotal", { A: "Grand Total", D: sum("D"), E: sum("E"), F: sum("F"), G: sum("G"), H: sum("H"), I: sum("I"), J: sum("J"),
          K: xirrOf(items), L: pct(value - inv, inv), M: 100, O: sum("O") });
        groupRows.push(gt);
        start("gap");
      }
      const pt = start("platformTotal");
      merges.push(`A${pt}:C${pt}`);
      const sumOf = (c) => ({ f: groupRows.length ? `SUM(${groupRows.map((g) => `${c}${g}`).join(",")})` : "0" });
      const value = hs.reduce((a, h) => a + (h.current_value || 0), 0), inv = hs.reduce((a, h) => a + (h.invested || 0), 0);
      put(pt, "platformTotal", { A: `Grand Total ${pname} Portfolio`, D: sumOf("D"), E: sumOf("E"), F: sumOf("F"), G: sumOf("G"), H: sumOf("H"),
        I: sumOf("I"), J: sumOf("J"), K: xirrOf(hs), L: pct(value - inv, inv), M: 100, O: sumOf("O") });
      totals.push(pt);
      blocks.push({ ...block, total: pt });
      start("platformGap");
    }

    // Stocks, PMS, AIF, bonds and other: one block per platform + category.
    const groups = [...new Set([...own, ...live].filter((x) => x.product !== "MF").map((x) => `${x.platform_key}|${x.product}`))];
    for (const g of groups) {
      const [pk, prod] = g.split("|");
      const hs = own.filter((h) => h.platform_key === pk && h.product === prod).sort((a, b) => (b.current_value || 0) - (a.current_value || 0));
      const pname = (hs[0] || live.find((s) => s.platform_key === pk && s.product === prod)).platform;
      const head = start("header");
      put(head, "header", { B: `${pname} · ${prod}` });
      const first = r;
      let n = 0;
      for (const h of hs) {
        const rr = start("item");
        schemeRows.set(rr, rowKey(h));
        put(rr, "item", { A: ++n, B: h.security_name || "", C: h._sub ?? (h.asset_class || ""), D: h.invested, F: h.quantity, G: h.current_value,
          J: { f: `G${rr}` }, K: h.xirr, L: h.return_pct ?? pct((h.current_value || 0) - (h.invested || 0), h.invested),
          O: sipBy.get(`${pk}|${prod}|${schemeKey(h)}`) || null, ...notes(h) });
      }
      const held = new Set(hs.map(schemeKey));
      for (const s of new Map(live.filter((x) => x.platform_key === pk && x.product === prod && !held.has(schemeKey(x))).map((x) => [schemeKey(x), x])).values()) {
        const rr = start("item");
        schemeRows.set(rr, rowKey(s));
        put(rr, "item", { A: ++n, B: s.security_name || "", O: sipBy.get(`${pk}|${prod}|${schemeKey(s)}`) || null, ...notes(s) });
      }
      const last = r - 1;
      const st = start("subTotal");
      folds.push({ id: `${pk}|${prod}`, head, first, last, total: st });
      blocks.push({ head, total: st, folds: [`${pk}|${prod}`] });
      const sum = (c) => ({ f: last >= first ? `SUM(${c}${first}:${c}${last})` : "0" });
      const value = hs.reduce((a, h) => a + (h.current_value || 0), 0), inv = hs.reduce((a, h) => a + (h.invested || 0), 0);
      put(st, "subTotal", { B: `TOTAL ${pname.toUpperCase()} ${prod.toUpperCase()} PORTFOLIO`, D: sum("D"), E: 0, G: sum("G"), H: 0,
        J: sum("J"), K: xirrOf(hs), L: pct(value - inv, inv), O: sum("O") });
      totals.push(st);
      start("subGap");
    }

    const gr = start("grand");
    const sumOf = (c) => ({ f: totals.length ? `SUM(${totals.map((t) => `${c}${t}`).join(",")})` : "0" });
    const value = own.reduce((a, h) => a + (h.current_value || 0), 0), inv = own.reduce((a, h) => a + (h.invested || 0), 0);
    put(gr, "grand", { B: `TOTAL PORTFOLIO OF ${client.name.toUpperCase()}`, D: sumOf("D"), G: sumOf("G"), J: sumOf("J"),
      K: xirrOf(own), L: pct(value - inv, inv), O: sumOf("O") });

    // Loans against securities are listed for reference only, never added to the total.
    const loans = holdings.filter((h) => h.product === LOANS);
    if (loans.length) {
      r++;
      const lb = { head: start("header"), loans: [] };
      put(lb.head, "header", { B: "Loans against securities (not included in the total above)" });
      for (const l of loans) { lb.loans.push(r); put(start("item"), "item", { B: `${l.platform} · ${l.security_name || "Loan"}`, G: l.current_value }); }
      blocks.push(lb);
    }
    sh.setMerges(merges);
    return { schemeRows, groups: folds, blocks, grand: gr };
  }

  // ---- Reviewer's edits -------------------------------------------------------------------
  // The review dashboard saves edits separately from the uploaded data (which is never changed):
  //   reviewDate, personal {mobile, email, occupation, dob, city, country, rm, years, level},
  //   schemes {rowKey: {excluded, type, subType, invested, quantity, current_value, xirr, sip,
  //            tenure, newSip, remarks, suggestions}},
  //   savings {key: {value, monthly}}, otherLabel, passive {key: amount},
  //   redemption {mf|stocks|other: {value, reason}}, notes.
  const rowKey = (r) => `${r.platform_key}|${r.product}|${schemeKey(r)}`;
  const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
  const NUM_FIELDS = ["invested", "quantity", "current_value", "xirr"];

  function applyEdits(holdings, sips, edits) {
    const sch = (edits && edits.schemes) || {};
    const marks = (e) => ({ _type: e.type || undefined, _sub: e.subType || undefined, _tenure: e.tenure, _newSip: num(e.newSip),
      _remarks: e.remarks, _suggest: e.suggestions });
    // A scheme held in several folios is one line on the dashboard; an edited total is shared
    // between its folios in proportion to what each held (equally when they held nothing).
    const groups = new Map();
    for (const h of holdings) { const k = rowKey(h); groups.set(k, [...(groups.get(k) || []), h]); }
    const share = (h, f, total) => {
      const g = groups.get(rowKey(h));
      if (f === "xirr" || g.length === 1) return total;
      const sum = g.reduce((a, r) => a + (r[f] || 0), 0);
      return sum ? total * ((h[f] || 0) / sum) : total / g.length;
    };
    const hs = [];
    for (const h of holdings) {
      const e = sch[rowKey(h)];
      if (!e) { hs.push(h); continue; }
      if (e.excluded) continue;
      const x = { ...h, ...marks(e) };
      let changed = false;
      for (const f of NUM_FIELDS) if (num(e[f]) !== undefined) { x[f] = share(h, f, num(e[f])); changed = changed || f !== "xirr"; }
      if (changed && x.invested) x.return_pct = round2((((x.current_value || 0) - x.invested) / x.invested) * 100);
      hs.push(x);
    }
    const ss = [];
    const replaced = new Set();
    for (const s of sips) {
      const k = rowKey(s), e = sch[k];
      if (!e) { ss.push(s); continue; }
      if (e.excluded) continue;
      if (num(e.sip) !== undefined && s.live) { replaced.add(k); continue; }
      ss.push({ ...s, ...marks(e) });
    }
    // A changed SIP amount replaces the scheme's live SIPs with one SIP of that amount.
    for (const [k, e] of Object.entries(sch)) {
      if (e.excluded || num(e.sip) === undefined || !num(e.sip)) continue;
      const ref = holdings.find((h) => rowKey(h) === k) || sips.find((s) => rowKey(s) === k);
      if (!ref) continue;
      ss.push({ platform: ref.platform, platform_key: ref.platform_key, product: ref.product, security_name: ref.security_name,
        isin: ref.isin, category: ref.category, monthly_amount: num(e.sip), sip_amount: num(e.sip), live: true, ...marks(e) });
    }
    return { holdings: hs, sips: ss };
  }

  // The client's data now (with edits) and as of each date anything was uploaded for.
  function prepare(data, edits = {}) {
    const rows = shareIsins([...data.holdings.map((r) => ({ ...r, _h: 1 })), ...data.sips]);
    const all = { holdings: rows.filter((r) => r._h), sips: rows.filter((r) => !r._h) };
    const at = (date) => figures(latestRows(all.holdings, data.uploads, date), latestRows(all.sips, data.uploads, date));
    const dates = [...new Set(data.uploads.map((u) => u.snapshot_date).filter(Boolean))].sort();
    const raw = { holdings: latestRows(all.holdings, data.uploads, null), sips: latestRows(all.sips, data.uploads, null) };
    const now = applyEdits(raw.holdings, raw.sips, edits);
    const current = figures(now.holdings, now.sips);
    // The latest date shows today's figures, edits included.
    const timeline = dates.map((date, i) => ({ date, f: i === dates.length - 1 ? current : at(date) }));
    const years = new Map();
    for (const t of timeline) years.set(Number(t.date.slice(0, 4)), t.f); // the last date of each year wins
    const allMf = [...new Set([...all.holdings, ...all.sips].filter((x) => x.product === "MF").map((x) => x.platform))];
    return { raw, now, current, timeline, years, allMf };
  }

  // Rows of Portfolio Journey for other savings (value row, monthly row) and passive income.
  const SAVINGS = [
    ["epf", "Employee Provident Fund (EPF)", 96, 97], ["gratuity", "Gratuity (expected amount)", 98, null],
    ["superannuation", "Superannuation", 100, 101], ["ppf", "Public Provident Fund (PPF)", 102, 103],
    ["fd", "Fixed Deposit (FD)", 104, 105], ["npsSelf", "NPS - Self", 106, 107], ["npsEmployer", "NPS - Employer", 108, 109],
    ["ulip", "ULIP", 110, 111], ["property", "Investment Property", 112, null], ["gold", "Gold as investment", 114, 115],
    ["insurance", "Traditional Insurance Policy", 116, 117], ["other", "Other Investments", 118, 119],
  ];
  const PASSIVE = [
    ["ipr1", "Investment Property 1 (rent)", 131], ["ipr2", "Investment Property 2 (rent)", 132], ["ipr3", "Investment Property 3 (rent)", 133],
    ["eps", "EPS pension", 134], ["superannuation", "Superannuation pension", 135], ["ip1", "Insurance Policy 1 pension", 136],
    ["ip2", "Insurance Policy 2 pension", 137], ["ip3", "Insurance Policy 3 pension", 138], ["dividend", "Average monthly dividend", 139],
    ["other", "Other passive income", 140],
  ];
  const REDEMPTION = [["mf", "Mutual funds", 66, 67], ["stocks", "Stocks", 91, 92], ["other", "Other savings", 122, 123]];
  const LEVELS = ["Level 1", "Level 2", "Level 3", "Level 4", "Level 5", "Level 6"];
  const ISO = /^\d{4}-\d{2}-\d{2}$/;

  function fillEdits(sheets, edits, col) {
    const { journey, blueprint, discussion } = sheets;
    const p = edits.personal || {};
    const txt = (sh, ref, v) => { if (v !== undefined && v !== null && String(v).trim() !== "") sh.set(ref, String(v).trim()); };
    txt(blueprint, "G8", p.mobile); txt(blueprint, "I8", p.email); txt(blueprint, "M8", p.occupation);
    txt(blueprint, "I11", p.city); txt(blueprint, "K11", p.country); txt(blueprint, "M11", p.rm);
    if (ISO.test(p.dob || "")) blueprint.set("C11", serial(p.dob));
    if (num(p.years) !== undefined) blueprint.set("O14", num(p.years));
    if (LEVELS.includes(p.level)) blueprint.set("M160", p.level);
    const sv = edits.savings || {};
    if (edits.otherLabel) journey.set("B118", edits.otherLabel);
    for (const [k, , vr, mr] of SAVINGS) {
      if (num(sv[k]?.value) !== undefined) journey.set(`${col}${vr}`, num(sv[k].value));
      if (mr && num(sv[k]?.monthly) !== undefined) journey.set(`${col}${mr}`, num(sv[k].monthly));
    }
    // The blueprint's property and gold lines are typed in, not linked to the journey.
    if (num(sv.property?.value) !== undefined) blueprint.set("G68", num(sv.property.value));
    if (num(sv.gold?.value) !== undefined) blueprint.set("G70", num(sv.gold.value));
    for (const [k, , r] of PASSIVE) if (num((edits.passive || {})[k]) !== undefined) journey.set(`${col}${r}`, num(edits.passive[k]));
    for (const [k, , vr, rr] of REDEMPTION) {
      const x = (edits.redemption || {})[k] || {};
      if (num(x.value) !== undefined) journey.set(`${col}${vr}`, num(x.value));
      txt(journey, `${col}${rr}`, x.reason);
    }
    const lines = String(edits.notes || "").split(/\r?\n/).filter((l) => l.trim()).slice(0, 38);
    lines.forEach((l, i) => discussion.set(`B${4 + i}`, l));
  }

  // ---- Public ----------------------------------------------------------------------------
  // data: the /api/review response; edits: the reviewer's saved changes. Returns the workbook as an
  // ArrayBuffer (or Node Buffer).
  // Columns of DETAILED PORTFOLIO the review page can change for a scheme, and the field each sets.
  const DETAIL_FIELDS = { C: "subType", D: "invested", F: "quantity", G: "current_value", K: "xirr", N: "tenure", O: "sip", P: "newSip",
    T: "remarks", U: "suggestions" };

  // Cells typed in on the review page: {sheet name: {A1: value}}. Formula cells and the scheme
  // rows of DETAILED PORTFOLIO (which follow the scheme edits instead) are left alone.
  function applyCells(sheets, cells) {
    for (const [name, refs] of Object.entries(cells || {})) {
      const sh = sheets[name];
      if (!sh || name === "DETAILED PORTFOLIO") continue;
      for (const [ref, v] of Object.entries(refs)) {
        const [c, r] = splitRef(ref);
        const x = sh.rows.get(r)?.cells.get(c);
        if (x && x.includes("<f")) continue;
        sh.set(ref, v === null ? "" : v);
      }
    }
  }

  // Adds cell styles to xl/styles.xml: copies of existing ones with another number format.
  async function cellStyles(zip) {
    let xml = await zip.file("xl/styles.xml").async("string");
    const m = /<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/.exec(xml);
    const xfs = [...m[1].matchAll(/<xf\b[^>]*?\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)].map((x) => x[0]);
    const start = xfs.length, made = new Map();
    const fmtOf = (id) => Number((/numFmtId="(\d+)"/.exec(xfs[id] || "") || [0, 0])[1]);
    let rupeeFmt = null;
    return {
      // Style `id` with the number format of style `ref` (the Live SIP column's ₹ format).
      rupee(id, ref) {
        if (rupeeFmt === null) rupeeFmt = fmtOf(Number(ref ?? -1)) || 165;
        const k = `${id}|${rupeeFmt}`;
        if (made.has(k)) return made.get(k);
        let x = xfs[Number(id)];
        if (!x) return id;
        x = x.replace(/\s(numFmtId|applyNumberFormat)="[^"]*"/g, "").replace(/^<xf\b/, `<xf numFmtId="${rupeeFmt}" applyNumberFormat="1"`);
        xfs.push(x);
        made.set(k, String(xfs.length - 1));
        return made.get(k);
      },
      save() {
        if (xfs.length === start) return;
        xml = xml.replace(m[0], `<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>`);
        zip.file("xl/styles.xml", xml);
      },
    };
  }

  // The filled-in workbook as a JSZip, plus which DETAILED PORTFOLIO row holds which scheme.
  async function assemble(data, template, edits = data.edits || {}) {
    const zip = await JSZip.loadAsync(template);
    const paths = await sheetPaths(zip);
    const read = async (name) => new Sheet(await zip.file(paths[name]).async("string"));
    const write = (name, sh) => zip.file(paths[name], sh.toXml());
    const reviewDate = ISO.test(edits.reviewDate || "") ? edits.reviewDate : data.today;
    const client = { name: data.clientName, id: data.clientId };
    const { now, current, timeline, years, allMf } = prepare(data, edits);

    const cover = await read("1");
    cover.set("D17", client.name.toUpperCase());
    cover.set("Q5", serial(reviewDate));
    write("1", cover);

    const journey = await read("Portfolio Journey");
    const startYear = fillJourney(journey, years, current, reviewDate, allMf);

    const summary = await read("SUMMARY PORTFOLIO");
    fillSummaryPortfolio(summary, client.name.toUpperCase(), timeline);
    write("SUMMARY PORTFOLIO", summary);

    const detailed = await read("DETAILED PORTFOLIO");
    const styleBook = await cellStyles(zip);
    const { schemeRows, groups, blocks, grand } = fillDetailed(detailed, client, now.holdings, now.sips, (id, ref) => styleBook.rupee(id, ref));
    styleBook.save();
    write("DETAILED PORTFOLIO", detailed);

    const blueprint = await read("Freedom Blueprint");
    const discussion = await read("Discussion");
    discussion.set("B3", reviewDate.split("-").reverse().join("-"));
    fillEdits({ journey, blueprint, discussion }, edits, colName(6 + Number(reviewDate.slice(0, 4)) - startYear));
    const others = { "1": cover, "Portfolio Journey": journey, "SUMMARY PORTFOLIO": summary, "Freedom Blueprint": blueprint, Discussion: discussion };
    for (const name of Object.keys(edits.cells || {})) {
      if (!others[name] && paths[name] && name !== "DETAILED PORTFOLIO") others[name] = await read(name);
    }
    applyCells(others, edits.cells);
    for (const [name, sh] of Object.entries(others)) write(name, sh);
    return { zip, schemeRows, groups, blocks, grand };
  }

  async function build(data, template, { output = "arraybuffer", edits = data.edits || {} } = {}) {
    const { zip } = await assemble(data, template, edits);
    return zip.generateAsync({ type: output, compression: "DEFLATE" });
  }

  const fileName = (name, iso) => `Review Sheet of ${name.replace(/[\\/:*?"<>|]+/g, " ").trim()} as on ${iso.split("-").reverse().join("-")}.xlsx`;

  let templateCache = null;
  async function template() {
    if (!templateCache) {
      const r = await fetch(typeof APP_VERSION === "string" ? `${TEMPLATE_URL}?v=${APP_VERSION}` : TEMPLATE_URL);
      if (!r.ok) throw new Error("The review sheet template could not be loaded.");
      templateCache = await r.arrayBuffer();
    }
    return templateCache;
  }

  // Build and download the workbook from data already loaded (and the edits on screen).
  async function exportFile(data, edits) {
    const buffer = await build(data, await template(), { edits });
    const date = ISO.test(edits.reviewDate || "") ? edits.reviewDate : data.today;
    const name = fileName(data.clientName, date);
    download(xlsxBlob(buffer), name);
    return { buffer, name, date };
  }

  return { build, assemble, template, DETAIL_FIELDS, exportFile, prepare, figures, rowKey, typeOfRow, fileName, Sheet, mfType, subType, num,
    MF_TYPES, SAVINGS, PASSIVE, REDEMPTION, LEVELS, LOANS };
})();

/* ===== sheetview.js (from the asset management system) ===== */
// Shows an .xlsx workbook in the page the way Excel does: the same sheets, column widths, row
// heights, fonts, fills, borders, merged cells, number formats, pictures and bar charts, with the
// formulas worked out in the browser. Used by the Review Report page (public/js/reviewpage.js) to
// show the client review sheet before it is exported.
//
// Only what the review workbook needs is supported: the usual operators, cell and range
// references across sheets, shared formulas, and the functions in FUNCS below.
const SheetView = (() => {
  const EMU = 9525; // EMUs per pixel
  const HEAD_W = 42, HEAD_H = 20; // row-number column and column-letter row, px
  const MAX_ROWS = 700, MAX_COLS = 120;

  const colNum = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const colName = (n) => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const refOf = (r, c) => `${colName(c)}${r}`;
  const parseRef = (ref) => { const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(ref); return m ? { c: colNum(m[1]), r: Number(m[2]) } : null; };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const parseXml = (s) => new DOMParser().parseFromString(s, "application/xml");
  const kids = (el, name) => (el ? [...el.children].filter((x) => x.localName === name) : []);
  const kid = (el, name) => (el ? [...el.children].find((x) => x.localName === name) : undefined);
  const deep = (el, name) => (el ? [...el.getElementsByTagNameNS("*", name)] : []);
  const attr = (el, name) => (el ? el.getAttribute(name) : null);
  const key = (r, c) => r * 20000 + c;

  // ---- Colours -------------------------------------------------------------------------------
  const INDEXED = ["000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF", "000000", "FFFFFF", "FF0000", "00FF00",
    "0000FF", "FFFF00", "FF00FF", "00FFFF", "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080", "9999FF",
    "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF", "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000",
    "008080", "0000FF", "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99", "3366FF", "33CCCC", "99CC00",
    "FFCC00", "FF9900", "FF6600", "666699", "969696", "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333"];

  function hsl(hex) {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
    }
    return [h, s, l];
  }
  function hex([h, s, l]) {
    const f = (n) => {
      const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
      return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255).toString(16).padStart(2, "0");
    };
    return `${f(0)}${f(8)}${f(4)}`.toUpperCase();
  }
  function tint(c, t) {
    if (!t) return c;
    const [h, s, l] = hsl(c);
    return hex([h, s, t < 0 ? l * (1 + t) : l * (1 - t) + t]);
  }
  // DrawingML lumMod / lumOff.
  function lum(c, mod = 1, off = 0) {
    if (mod === 1 && !off) return c;
    const [h, s, l] = hsl(c);
    return hex([h, s, Math.max(0, Math.min(1, l * mod + off))]);
  }

  // ---- Number formats ------------------------------------------------------------------------
  const BUILTIN = {
    0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
    14: "dd-mm-yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss",
    22: "dd-mm-yyyy h:mm", 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)",
    41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)', 42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
    43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)', 44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
    45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0", 48: "##0.0E+0", 49: "@",
  };
  const COLORS = { red: "#FF0000", blue: "#0000FF", green: "#00A000", black: "#000000", white: "#FFFFFF", yellow: "#FFFF00", magenta: "#FF00FF", cyan: "#00FFFF" };
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  const fromSerial = (n) => new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
  const toSerial = (d) => (d.getTime() - Date.UTC(1899, 11, 30)) / 86400000;

  function sections(code) {
    const out = [];
    let cur = "", q = false, br = false;
    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      if (ch === "\\" && !q) { cur += ch + (code[i + 1] ?? ""); i++; continue; }
      if (ch === '"') q = !q;
      else if (!q && ch === "[") br = true;
      else if (!q && ch === "]") br = false;
      if (ch === ";" && !q && !br) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  // Splits a section into tokens: {lit} for text shown as is, {fill} for the * repeat character,
  // {skip} for _ spacing, and the rest as format characters.
  function lex(sec) {
    const out = [];
    for (let i = 0; i < sec.length; i++) {
      const ch = sec[i];
      if (ch === '"') { const j = sec.indexOf('"', i + 1); out.push({ lit: sec.slice(i + 1, j < 0 ? undefined : j) }); i = j < 0 ? sec.length : j; }
      else if (ch === "\\") { out.push({ lit: sec[i + 1] ?? "" }); i++; }
      else if (ch === "_") { out.push({ lit: " " }); i++; }
      else if (ch === "*") { out.push({ fill: true }); i++; }
      else if (ch === "[") {
        const j = sec.indexOf("]", i);
        const inner = sec.slice(i + 1, j);
        const cur = /^\$([^-\]]*)/.exec(inner);
        if (cur) out.push({ lit: cur[1] });
        else if (COLORS[inner.toLowerCase()]) out.push({ color: COLORS[inner.toLowerCase()] });
        else if (/^(h+|m+|s+)$/i.test(inner)) out.push({ ch: inner.toLowerCase(), elapsed: true });
        i = j;
      } else out.push({ ch });
    }
    return out;
  }

  const isDateFormat = (toks) => toks.some((t) => t.ch && /[dmyhs]/i.test(t.ch)) && !toks.some((t) => t.ch && /[0#?]/.test(t.ch));

  function groupDigits(s, indian) {
    if (!indian) return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    if (s.length <= 3) return s;
    return s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + s.slice(-3);
  }

  function formatNumberPart(v, pattern) {
    const percent = (pattern.match(/%/g) || []).length;
    const p = pattern.replace(/%/g, "");
    const dot = p.indexOf(".");
    const intPat = dot < 0 ? p : p.slice(0, dot), decPat = dot < 0 ? "" : p.slice(dot + 1);
    // Commas after the last digit placeholder scale by 1000.
    const trailing = (/(,+)$/.exec(intPat) || ["", ""])[1].length;
    const ip = intPat.slice(0, intPat.length - trailing);
    let x = Math.abs(v) * 100 ** percent / 1000 ** trailing;
    const decs = (decPat.match(/[0#?]/g) || []).length;
    const minDecs = (decPat.match(/0/g) || []).length;
    let [i, d = ""] = x.toFixed(decs).split(".");
    if (decs > minDecs) d = d.replace(new RegExp(`0{1,${decs - minDecs}}$`), "");
    const minInt = (ip.match(/0/g) || []).length;
    if (i === "0" && !minInt) i = "";
    i = i.padStart(minInt, "0");
    if (ip.includes(",")) i = groupDigits(i, /#,##,##0|,##,/.test(ip));
    const qInt = (ip.match(/\?/g) || []).length;
    if (qInt && i.length < qInt) i = i.padStart(qInt, " ");
    const qDec = (decPat.match(/\?/g) || []).length;
    if (qDec && d.length < decs) d = d.padEnd(decs, " ");
    return (dot >= 0 && (d || decPat.includes("0") || qDec) ? `${i}.${d}` : i) + "%".repeat(percent);
  }

  function formatDate(v, toks) {
    // Serial 0 is Excel's "0 January 1900".
    const d = v < 1 ? new Date(Date.UTC(1900, 0, 0, 0, 0, Math.round(v * 86400))) : fromSerial(v);
    if (v < 1) d.zeroDay = true;
    const hasAmPm = toks.some((t) => t.ch === "A" || t.ch === "a");
    // Join consecutive format characters into runs like "yyyy", "mmm", "dd".
    const runs = [];
    for (const t of toks) {
      if (t.ch && /[dmyhsDMYHS]/.test(t.ch) && runs.length && runs[runs.length - 1].ch && runs[runs.length - 1].ch[0].toLowerCase() === t.ch.toLowerCase()) {
        runs[runs.length - 1].ch += t.ch;
      } else runs.push({ ...t });
    }
    let out = "";
    for (let i = 0; i < runs.length; i++) {
      const t = runs[i];
      if (t.lit !== undefined) { out += t.lit; continue; }
      if (!t.ch) continue;
      const k = t.ch.toLowerCase();
      if (k[0] === "y") { const y = d.zeroDay ? 1900 : d.getUTCFullYear(); out += k.length <= 2 ? String(y).slice(-2) : y; }
      else if (k[0] === "d") out += k.length === 1 ? d.getUTCDate() : k.length === 2 ? String(d.getUTCDate()).padStart(2, "0") : k.length === 3 ? DAYS[d.getUTCDay()].slice(0, 3) : DAYS[d.getUTCDay()];
      else if (k[0] === "m") {
        const prev = runs.slice(0, i).reverse().find((x) => x.ch && /[a-z]/i.test(x.ch));
        const next = runs.slice(i + 1).find((x) => x.ch && /[a-z]/i.test(x.ch));
        const minutes = k.length <= 2 && ((prev && /^h/i.test(prev.ch)) || (next && /^s/i.test(next.ch)));
        if (minutes) out += k.length === 1 ? d.getUTCMinutes() : String(d.getUTCMinutes()).padStart(2, "0");
        else out += k.length === 1 ? d.getUTCMonth() + 1 : k.length === 2 ? String(d.getUTCMonth() + 1).padStart(2, "0") : k.length === 3 ? MONTHS[d.getUTCMonth()].slice(0, 3) : k.length === 5 ? MONTHS[d.getUTCMonth()][0] : MONTHS[d.getUTCMonth()];
      } else if (k[0] === "h") {
        let h = d.getUTCHours();
        if (hasAmPm) h = h % 12 || 12;
        out += k.length === 1 ? h : String(h).padStart(2, "0");
      } else if (k[0] === "s") out += k.length === 1 ? d.getUTCSeconds() : String(d.getUTCSeconds()).padStart(2, "0");
      else if (k === "a" && runs[i + 1]?.ch === "M") { /* AM/PM */
        out += d.getUTCHours() < 12 ? "AM" : "PM";
        i += 4;
      } else out += t.ch;
    }
    return out;
  }

  function general(v) {
    if (typeof v !== "number") return String(v);
    if (Number.isInteger(v) && Math.abs(v) < 1e11) return String(v);
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-9 || a >= 1e11)) return v.toExponential(5).replace(/\.?0+e/, "E").replace("e", "E");
    return String(Number(v.toPrecision(10)));
  }

  // Returns {text, color, left} where left is the part before a * fill (accounting formats put
  // the currency sign at the left edge of the cell).
  function format(v, code) {
    if (v === null || v === undefined) return { text: "" };
    if (typeof v === "boolean") return { text: v ? "TRUE" : "FALSE" };
    if (typeof v === "object" && v.e) return { text: v.e };
    if (!code || /^general$/i.test(code)) return { text: general(v) };
    const secs = sections(code);
    let sec, val = v;
    if (typeof v === "string") {
      sec = secs.length >= 4 ? secs[3] : secs.find((s) => s.includes("@"));
      if (sec === undefined) return { text: v };
    } else if (v > 0 || (v === 0 && secs.length < 3)) sec = secs[0];
    else if (v < 0) { sec = secs.length > 1 ? secs[1] : secs[0]; if (secs.length > 1) val = -v; }
    else sec = secs[2];
    const toks = lex(sec);
    if (/^general$/i.test(toks.filter((t) => t.ch).map((t) => t.ch).join(""))) return { text: general(val) };
    const color = toks.find((t) => t.color)?.color;
    const date = typeof val === "number" && isDateFormat(toks);
    let left = null, out = "";
    if (date) out = formatDate(val, toks);
    else {
      // Literal text, then the run of number characters, then more literal text.
      let pattern = "", done = false;
      for (const t of toks) {
        if (t.fill) { left = out; out = ""; continue; }
        if (t.lit !== undefined) { if (pattern && !done) { out += "\u0000"; done = true; } out += t.lit; continue; }
        if (!t.ch) continue;
        if (t.ch === "@") { out += typeof val === "string" ? val : general(val); continue; }
        if (typeof val === "number" && /[0#?.,%]/.test(t.ch) && !done) { if (!pattern) out += "\u0001"; pattern += t.ch; continue; }
        if (t.ch === "%" && typeof val === "number") { pattern += "%"; continue; }
        if (pattern && !done) { out += "\u0000"; done = true; }
        out += t.ch === " " ? " " : t.ch;
      }
      if (typeof val === "number") {
        const num = pattern ? formatNumberPart(val, pattern) : "";
        const neg = v < 0 && secs.length === 1 ? "-" : "";
        out = out.includes("\u0001") ? out.replace("\u0001", neg + num) : neg + out + num;
        out = out.replace(/\u0000/g, "");
      }
    }
    return { text: out, color, left };
  }

  // ---- Formulas ------------------------------------------------------------------------------
  class XErr { constructor(e) { this.e = e; } }
  const ERR = (e) => { throw new XErr(e); };

  function tokenize(f) {
    const out = [];
    let i = 0;
    while (i < f.length) {
      const rest = f.slice(i);
      const ch = f[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '"') {
        let j = i + 1, s = "";
        while (j < f.length) { if (f[j] === '"') { if (f[j + 1] === '"') { s += '"'; j += 2; continue; } break; } s += f[j++]; }
        out.push({ t: "str", v: s }); i = j + 1; continue;
      }
      let m = /^#(REF!|N\/A|NAME\?|DIV\/0!|VALUE!|NUM!|NULL!)/.exec(rest);
      if (m) { out.push({ t: "err", v: m[0] }); i += m[0].length; continue; }
      const sm = /^(?:'((?:[^']|'')+)'|([A-Za-z_][\w.]*))!/.exec(rest);
      const after = sm ? rest.slice(sm[0].length) : rest;
      const rm = /^(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\$?[A-Z]{1,3}:\$?[A-Z]{1,3}|\$?\d+:\$?\d+)(?![\w(!])/.exec(after);
      if (rm && (sm || !/^\d/.test(rm[1]))) {
        out.push({ t: "ref", sheet: sm ? (sm[1] !== undefined ? sm[1].replace(/''/g, "'") : sm[2]) : null, v: rm[1].replace(/\$/g, "") });
        i += (sm ? sm[0].length : 0) + rm[1].length; continue;
      }
      if (sm && /^#REF!/.test(after)) { out.push({ t: "err", v: "#REF!" }); i += sm[0].length + 5; continue; }
      m = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(rest);
      if (m) { out.push({ t: "num", v: Number(m[0]) }); i += m[0].length; continue; }
      m = /^([A-Za-z_][\w.]*)\s*\(/.exec(rest);
      if (m) { out.push({ t: "fn", v: m[1].toUpperCase().replace(/^_XLFN\./, "") }); i += m[0].length; continue; }
      m = /^[A-Za-z_][\w.]*/.exec(rest);
      if (m) { const u = m[0].toUpperCase(); out.push(u === "TRUE" || u === "FALSE" ? { t: "bool", v: u === "TRUE" } : { t: "name", v: m[0] }); i += m[0].length; continue; }
      m = /^(<>|<=|>=|[-+*/^&=<>%(),:;{}])/.exec(rest);
      if (m) { out.push({ t: "op", v: m[0] }); i += m[0].length; continue; }
      throw new Error(`Cannot read formula: ${f}`);
    }
    return out;
  }

  // Moves the relative references of a shared formula from its first cell to another.
  function shift(f, dr, dc) {
    let out = "", i = 0;
    const re = /(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\w(!])/y;
    while (i < f.length) {
      const ch = f[i];
      if (ch === '"' || ch === "'") {
        const j = f.indexOf(ch, i + 1);
        out += f.slice(i, j < 0 ? undefined : j + 1); i = j < 0 ? f.length : j + 1; continue;
      }
      if (/[A-Z$]/.test(ch) && !/[\w.]/.test(f[i - 1] || "")) {
        re.lastIndex = i;
        const m = re.exec(f);
        if (m) {
          const c = m[1] ? colNum(m[2]) : colNum(m[2]) + dc, r = m[3] ? Number(m[4]) : Number(m[4]) + dr;
          out += `${m[1]}${colName(c)}${m[3]}${r}`; i += m[0].length; continue;
        }
      }
      out += ch; i++;
    }
    return out;
  }

  function parse(f) {
    const toks = tokenize(f);
    let p = 0;
    const peek = () => toks[p], next = () => toks[p++];
    const isOp = (v) => toks[p] && toks[p].t === "op" && toks[p].v === v;
    const bin = (sub, ops) => () => {
      let a = sub();
      while (toks[p] && toks[p].t === "op" && ops.includes(toks[p].v)) { const op = next().v; a = { k: "bin", op, a, b: sub() }; }
      return a;
    };
    const primary = () => {
      const t = next();
      if (!t) throw new Error("Unexpected end of formula");
      if (t.t === "num") return { k: "num", v: t.v };
      if (t.t === "str") return { k: "str", v: t.v };
      if (t.t === "bool") return { k: "bool", v: t.v };
      if (t.t === "err") return { k: "err", v: t.v };
      if (t.t === "name") return { k: "name", v: t.v };
      if (t.t === "ref") {
        let node = { k: "ref", sheet: t.sheet, v: t.v };
        if (isOp(":") && toks[p + 1]?.t === "ref") { next(); node = { k: "ref", sheet: t.sheet, v: `${t.v}:${next().v}` }; }
        return node;
      }
      if (t.t === "fn") {
        const args = [];
        if (isOp(")")) { next(); return { k: "fn", name: t.v, args }; }
        for (;;) {
          if (isOp(",") || isOp(")")) args.push({ k: "missing" }); else args.push(expr());
          const sep = next();
          if (!sep || sep.v === ")") break;
          if (sep.v !== "," && sep.v !== ";") throw new Error("Bad function arguments");
        }
        return { k: "fn", name: t.v, args };
      }
      if (t.t === "op" && t.v === "(") { const e = expr(); next(); return e; }
      if (t.t === "op" && t.v === "{") { // array constant: keep the first value
        const e = expr();
        while (p < toks.length && !(toks[p].t === "op" && toks[p].v === "}")) p++;
        p++;
        return e;
      }
      throw new Error(`Unexpected ${t.v} in formula`);
    };
    const postfix = () => { let a = primary(); while (isOp("%")) { next(); a = { k: "pct", a }; } return a; };
    const unary = () => {
      if (isOp("-")) { next(); return { k: "neg", a: unary() }; }
      if (isOp("+")) { next(); return unary(); }
      return postfix();
    };
    const power = bin(unary, ["^"]);
    const mult = bin(power, ["*", "/"]);
    const add = bin(mult, ["+", "-"]);
    const concat = bin(add, ["&"]);
    const expr = bin(concat, ["=", "<>", "<", ">", "<=", ">="]);
    const tree = expr();
    if (p < toks.length) throw new Error(`Unexpected ${peek().v} in formula`);
    return tree;
  }

  const isRange = (v) => v && typeof v === "object" && v.range;
  const isErr = (v) => v instanceof XErr || (v && typeof v === "object" && v.e);

  function num(v) {
    if (v === null || v === undefined || v === "") return 0;
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (isErr(v)) ERR(v.e);
    // Text that reads as a number counts as one, as in Excel: "1,000", "₹ 500", "7%", "0% ".
    let t = String(v).replace(/[,₹$\s]/g, "");
    let scale = 1;
    if (t.endsWith("%")) { t = t.slice(0, -1); scale = 100; }
    const n = t === "" ? NaN : Number(t);
    return Number.isFinite(n) ? n / scale : ERR("#VALUE!");
  }
  const str = (v) => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : typeof v === "number" ? general(v) : isErr(v) ? ERR(v.e) : String(v));
  const bool = (v) => (typeof v === "string" ? (/^true$/i.test(v) ? true : /^false$/i.test(v) ? false : ERR("#VALUE!")) : num(v) !== 0);

  function compare(a, b) {
    const rank = (v) => (v === null || v === undefined ? -1 : typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
    if (a === null || a === undefined) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
    if (b === null || b === undefined) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (typeof a === "string") { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function datedif(s, e, unit) {
    const a = fromSerial(Math.floor(s)), b = fromSerial(Math.floor(e));
    if (a > b) ERR("#NUM!");
    const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() - (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
    switch (unit.toUpperCase()) {
      case "Y": return Math.floor(months / 12);
      case "M": return months;
      case "D": return Math.floor(e) - Math.floor(s);
      case "YM": return months % 12;
      case "MD": { const d = b.getUTCDate() - a.getUTCDate(); return d >= 0 ? d : new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 0)).getUTCDate() + d; }
      case "YD": { let x = new Date(Date.UTC(b.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())); if (x > b) x = new Date(Date.UTC(b.getUTCFullYear() - 1, a.getUTCMonth(), a.getUTCDate())); return Math.round((b - x) / 86400000); }
      default: return ERR("#NUM!");
    }
  }

  const roundTo = (x, d, mode) => {
    const f = 10 ** d, y = Math.abs(x) * f;
    const r = mode === "up" ? Math.ceil(y - 1e-9) : mode === "down" ? Math.floor(y + 1e-9) : Math.round(y + 1e-9);
    return Math.sign(x) * r / f;
  };

  // Functions get their arguments unevaluated (so IF and IFERROR only work out what they need).
  const FUNCS = {
    SUM: (c, a) => c.nums(a).reduce((x, y) => x + y, 0),
    MIN: (c, a) => { const n = c.nums(a); return n.length ? Math.min(...n) : 0; },
    MAX: (c, a) => { const n = c.nums(a); return n.length ? Math.max(...n) : 0; },
    AVERAGE: (c, a) => { const n = c.nums(a); return n.length ? n.reduce((x, y) => x + y, 0) / n.length : ERR("#DIV/0!"); },
    COUNT: (c, a) => c.nums(a).length,
    COUNTA: (c, a) => a.flatMap((x) => c.flat(c.ev(x))).filter((v) => v !== null && v !== "").length,
    IF: (c, a) => (bool(c.val(a[0])) ? (a[1] ? c.ev(a[1]) : true) : a[2] && a[2].k !== "missing" ? c.ev(a[2]) : false),
    IFERROR: (c, a) => { try { const v = c.val(a[0]); if (isErr(v)) throw v; return v; } catch (e) { if (e instanceof XErr) return c.val(a[1]); throw e; } },
    IFNA: (c, a) => { try { return c.val(a[0]); } catch (e) { if (e instanceof XErr && e.e === "#N/A") return c.val(a[1]); throw e; } },
    AND: (c, a) => a.flatMap((x) => c.flat(c.ev(x))).every((v) => v === null || bool(v)),
    OR: (c, a) => a.flatMap((x) => c.flat(c.ev(x))).some((v) => v !== null && bool(v)),
    NOT: (c, a) => !bool(c.val(a[0])),
    ABS: (c, a) => Math.abs(c.n(a[0])),
    INT: (c, a) => Math.floor(c.n(a[0])),
    MOD: (c, a) => { const x = c.n(a[0]), y = c.n(a[1]); return y ? x - y * Math.floor(x / y) : ERR("#DIV/0!"); },
    ROUND: (c, a) => roundTo(c.n(a[0]), a[1] ? c.n(a[1]) : 0),
    ROUNDUP: (c, a) => roundTo(c.n(a[0]), a[1] ? c.n(a[1]) : 0, "up"),
    ROUNDDOWN: (c, a) => roundTo(c.n(a[0]), a[1] ? c.n(a[1]) : 0, "down"),
    POWER: (c, a) => c.n(a[0]) ** c.n(a[1]),
    TODAY: () => { const d = new Date(); return toSerial(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))); },
    YEAR: (c, a) => fromSerial(c.n(a[0])).getUTCFullYear(),
    MONTH: (c, a) => fromSerial(c.n(a[0])).getUTCMonth() + 1,
    DAY: (c, a) => fromSerial(c.n(a[0])).getUTCDate(),
    DATE: (c, a) => toSerial(new Date(Date.UTC(c.n(a[0]), c.n(a[1]) - 1, c.n(a[2])))),
    DATEDIF: (c, a) => datedif(c.n(a[0]), c.n(a[1]), str(c.val(a[2]))),
    TEXT: (c, a) => { const v = c.val(a[0]); return format(v === null ? 0 : v, str(c.val(a[1]))).text; },
    CONCATENATE: (c, a) => a.map((x) => str(c.val(x))).join(""),
    CONCAT: (c, a) => a.flatMap((x) => c.flat(c.ev(x))).map(str).join(""),
    LEN: (c, a) => str(c.val(a[0])).length,
    UPPER: (c, a) => str(c.val(a[0])).toUpperCase(),
    TRIM: (c, a) => str(c.val(a[0])).trim().replace(/\s+/g, " "),
    FV: (c, a) => {
      const [r, n, pmt, pv = 0, type = 0] = a.map((x) => (x.k === "missing" ? 0 : c.n(x)));
      return r === 0 ? -(pv + pmt * n) : -(pv * (1 + r) ** n + pmt * (1 + r * type) * ((1 + r) ** n - 1) / r);
    },
    PV: (c, a) => {
      const [r, n, pmt, fv = 0, type = 0] = a.map((x) => (x.k === "missing" ? 0 : c.n(x)));
      return r === 0 ? -(fv + pmt * n) : -(fv + pmt * (1 + r * type) * ((1 + r) ** n - 1) / r) / (1 + r) ** n;
    },
    PMT: (c, a) => {
      const [r, n, pv, fv = 0, type = 0] = a.map((x) => (x.k === "missing" ? 0 : c.n(x)));
      if (!n) return ERR("#NUM!");
      return r === 0 ? -(pv + fv) / n : -(r * (fv + pv * (1 + r) ** n)) / ((1 + r * type) * ((1 + r) ** n - 1));
    },
    MATCH: (c, a) => {
      const look = c.val(a[0]);
      const list = c.flat(c.ev(a[1]));
      const type = a[2] && a[2].k !== "missing" ? c.n(a[2]) : 1;
      if (type === 0) {
        const i = list.findIndex((v) => v !== null && compare(v, look) === 0 && typeof v === typeof look);
        return i < 0 ? ERR("#N/A") : i + 1;
      }
      let found = -1;
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (v === null || typeof v !== typeof look) continue;
        const cmp = compare(v, look);
        if (type > 0 ? cmp <= 0 : cmp >= 0) found = i; else break;
      }
      return found < 0 ? ERR("#N/A") : found + 1;
    },
    INDEX: (c, a) => {
      const r = c.ev(a[0]);
      if (!isRange(r)) return r;
      let row = a[1] && a[1].k !== "missing" ? c.n(a[1]) : 0;
      let col = a[2] && a[2].k !== "missing" ? c.n(a[2]) : 0;
      if (a.length < 3 && r.r1 === r.r2) { col = row; row = 1; }
      if (!row && r.r1 === r.r2) row = 1;
      if (!col && r.c1 === r.c2) col = 1;
      if (row < 0 || col < 0 || row > r.r2 - r.r1 + 1 || col > r.c2 - r.c1 + 1) return ERR("#REF!");
      if (!row || !col) return { range: true, sheet: r.sheet, r1: row ? r.r1 + row - 1 : r.r1, r2: row ? r.r1 + row - 1 : r.r2, c1: col ? r.c1 + col - 1 : r.c1, c2: col ? r.c1 + col - 1 : r.c2 };
      return c.cell(r.sheet, r.r1 + row - 1, r.c1 + col - 1);
    },
    VLOOKUP: (c, a) => {
      const look = c.val(a[0]), r = c.ev(a[1]), col = c.n(a[2]);
      const exact = a[3] && a[3].k !== "missing" && !bool(c.val(a[3]));
      let hit = -1;
      for (let row = r.r1; row <= r.r2; row++) {
        const v = c.cell(r.sheet, row, r.c1);
        if (v === null) continue;
        const cmp = compare(v, look);
        if (exact) { if (cmp === 0) { hit = row; break; } } else if (cmp <= 0) hit = row; else break;
      }
      return hit < 0 ? ERR("#N/A") : c.cell(r.sheet, hit, r.c1 + col - 1);
    },
    SUMIF: (c, a) => {
      const r = c.ev(a[0]), crit = c.val(a[1]), s = a[2] ? c.ev(a[2]) : r;
      const test = criteria(crit);
      let t = 0;
      for (let i = 0; i <= r.r2 - r.r1; i++) for (let j = 0; j <= r.c2 - r.c1; j++) {
        if (test(c.cell(r.sheet, r.r1 + i, r.c1 + j))) { const v = c.cell(s.sheet, s.r1 + i, s.c1 + j); if (typeof v === "number") t += v; }
      }
      return t;
    },
    COUNTIF: (c, a) => { const test = criteria(c.val(a[1])); return c.flat(c.ev(a[0])).filter(test).length; },
  };

  function criteria(crit) {
    const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(typeof crit === "string" ? crit : "");
    if (typeof crit !== "string") return (v) => compare(v, crit) === 0;
    const op = m[1] || "=", rhs = m[2] !== "" && Number.isFinite(Number(m[2])) ? Number(m[2]) : m[2];
    return (v) => {
      const cmp = compare(v, rhs);
      return { "=": cmp === 0, "<>": cmp !== 0, "<": cmp < 0, ">": cmp > 0, "<=": cmp <= 0, ">=": cmp >= 0 }[op];
    };
  }

  // Evaluation context for one workbook.
  class Calc {
    constructor(wb) { this.wb = wb; this.memo = new Map(); this.busy = new Set(); this.trees = new Map(); this.here = null; }

    cell(sheetName, r, c) {
      const sh = this.wb.sheet(sheetName);
      if (!sh) return ERR("#REF!");
      const x = sh.cells.get(key(r, c));
      if (!x) return null;
      if (!x.f) return x.v;
      const k = `${sheetName}!${key(r, c)}`;
      if (this.memo.has(k)) { const v = this.memo.get(k); if (isErr(v)) throw new XErr(v.e); return v; }
      if (this.busy.has(k)) return 0; // circular reference
      this.busy.add(k);
      const was = this.here;
      this.here = { sheet: sheetName, r, c };
      let v;
      try {
        if (!this.trees.has(x.f)) this.trees.set(x.f, parse(x.f));
        v = this.val(this.trees.get(x.f));
        if (typeof v === "number" && !Number.isFinite(v)) v = { e: "#NUM!" };
      } catch (e) {
        v = e instanceof XErr ? { e: e.e } : { e: "#NAME?" };
      } finally {
        this.here = was;
        this.busy.delete(k);
      }
      this.memo.set(k, v);
      if (isErr(v)) throw new XErr(v.e);
      return v;
    }

    // Value of a cell for display: errors as {e}.
    value(sheetName, r, c) {
      try { return this.cell(sheetName, r, c); } catch (e) { return e instanceof XErr ? { e: e.e } : { e: "#NAME?" }; }
    }

    range(node) {
      const sheet = node.sheet || this.here.sheet;
      const [a, b = a] = node.v.split(":");
      const sh = this.wb.sheet(sheet);
      if (!sh) ERR("#REF!");
      const end = (s, isStart) => {
        if (/^[A-Z]+$/.test(s)) return { c: colNum(s), r: isStart ? 1 : sh.maxRow };
        if (/^\d+$/.test(s)) return { c: isStart ? 1 : sh.maxCol, r: Number(s) };
        return parseRef(s);
      };
      const p = end(a, true), q = end(b, false);
      return { range: true, sheet, r1: Math.min(p.r, q.r), r2: Math.max(p.r, q.r), c1: Math.min(p.c, q.c), c2: Math.max(p.c, q.c) };
    }

    flat(v) {
      if (!isRange(v)) return [v];
      const out = [];
      for (let r = v.r1; r <= v.r2; r++) for (let c = v.c1; c <= v.c2; c++) out.push(this.cell(v.sheet, r, c));
      return out;
    }

    nums(args) {
      const out = [];
      for (const a of args) {
        if (a.k === "missing") continue;
        const v = this.ev(a);
        if (isRange(v)) { for (const x of this.flat(v)) if (typeof x === "number") out.push(x); else if (isErr(x)) ERR(x.e); }
        else out.push(num(v));
      }
      return out;
    }

    n(node) { return num(this.val(node)); }

    // Scalar value (a range gives the cell in the formula's own row or column).
    val(node) {
      const v = this.ev(node);
      if (!isRange(v)) return v;
      if (v.r1 === v.r2 && v.c1 === v.c2) return this.cell(v.sheet, v.r1, v.c1);
      const h = this.here;
      if (v.c1 === v.c2 && h && h.r >= v.r1 && h.r <= v.r2) return this.cell(v.sheet, h.r, v.c1);
      if (v.r1 === v.r2 && h && h.c >= v.c1 && h.c <= v.c2) return this.cell(v.sheet, v.r1, h.c);
      return ERR("#VALUE!");
    }

    ev(node) {
      switch (node.k) {
        case "num": case "str": case "bool": return node.v;
        case "missing": return null;
        case "err": return ERR(node.v);
        case "name": return ERR("#NAME?");
        case "ref": return this.range(node);
        case "neg": return -this.n(node.a);
        case "pct": return this.n(node.a) / 100;
        case "fn": { const f = FUNCS[node.name]; return f ? f(this, node.args) : ERR("#NAME?"); }
        case "bin": {
          const a = this.val(node.a), b = this.val(node.b);
          switch (node.op) {
            case "+": return num(a) + num(b);
            case "-": return num(a) - num(b);
            case "*": return num(a) * num(b);
            case "/": { const d = num(b); return d === 0 ? ERR("#DIV/0!") : num(a) / d; }
            case "^": return num(a) ** num(b);
            case "&": return str(a) + str(b);
            case "=": return compare(a, b) === 0;
            case "<>": return compare(a, b) !== 0;
            case "<": return compare(a, b) < 0;
            case ">": return compare(a, b) > 0;
            case "<=": return compare(a, b) <= 0;
            case ">=": return compare(a, b) >= 0;
          }
        }
      }
      return ERR("#VALUE!");
    }
  }

  // ---- Reading the workbook -------------------------------------------------------------------
  const resolvePath = (base, target) => {
    if (target.startsWith("/")) return target.slice(1);
    const parts = base.split("/").slice(0, -1);
    for (const p of target.split("/")) { if (p === "..") parts.pop(); else if (p !== ".") parts.push(p); }
    return parts.join("/");
  };
  const relsPath = (p) => p.replace(/([^/]+)$/, "_rels/$1.rels");

  async function readRels(zip, part) {
    const f = zip.file(relsPath(part));
    const out = {};
    if (!f) return out;
    for (const r of deep(parseXml(await f.async("string")), "Relationship")) {
      out[attr(r, "Id")] = { target: attr(r, "TargetMode") === "External" ? attr(r, "Target") : resolvePath(part, attr(r, "Target")), type: attr(r, "Type") };
    }
    return out;
  }

  class Workbook {
    static async load(zip) {
      const wb = new Workbook();
      wb.zip = zip;
      const text = async (p) => (zip.file(p) ? zip.file(p).async("string") : null);
      const book = parseXml(await text("xl/workbook.xml"));
      const rels = await readRels(zip, "xl/workbook.xml");
      wb.activeTab = Number(attr(deep(book, "workbookView")[0], "activeTab") || 0);
      wb.sheets = deep(book, "sheet").map((s) => ({
        name: attr(s, "name"), hidden: !!attr(s, "state") && attr(s, "state") !== "visible",
        path: rels[s.getAttribute("r:id") || s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id")].target,
      }));
      // Theme colours, in the order cell styles number them.
      const themeRel = Object.values(rels).find((r) => /theme$/.test(r.type));
      wb.theme = [];
      if (themeRel) {
        const cs = deep(parseXml(await text(themeRel.target)), "clrScheme")[0];
        const c = (n) => { const e = kid(cs, n); const x = e && e.firstElementChild; return x ? (attr(x, "lastClr") || attr(x, "val") || "000000").toUpperCase() : "000000"; };
        wb.scheme = { dk1: c("dk1"), lt1: c("lt1"), dk2: c("dk2"), lt2: c("lt2"), accent1: c("accent1"), accent2: c("accent2"), accent3: c("accent3"),
          accent4: c("accent4"), accent5: c("accent5"), accent6: c("accent6"), hlink: c("hlink"), folHlink: c("folHlink") };
        const s = wb.scheme;
        wb.theme = [s.lt1, s.dk1, s.lt2, s.dk2, s.accent1, s.accent2, s.accent3, s.accent4, s.accent5, s.accent6, s.hlink, s.folHlink];
        Object.assign(wb.scheme, { tx1: s.dk1, bg1: s.lt1, tx2: s.dk2, bg2: s.lt2 });
      }
      const ssRel = Object.values(rels).find((r) => /sharedStrings$/.test(r.type));
      wb.strings = ssRel && zip.file(ssRel.target)
        ? deep(parseXml(await text(ssRel.target)), "si").map((si) => deep(si, "t").filter((t) => t.parentElement.localName !== "rPh").map((t) => t.textContent).join(""))
        : [];
      const stRel = Object.values(rels).find((r) => /styles$/.test(r.type));
      wb.styles = wb.readStyles(parseXml(await text(stRel.target)));
      wb.xml = {};
      for (const s of wb.sheets) wb.xml[s.name] = await text(s.path);
      wb.parsed = new Map();
      wb.calc = new Calc(wb);
      wb.drawings = {};
      for (const s of wb.sheets.filter((x) => !x.hidden)) wb.drawings[s.name] = await wb.readDrawing(s);
      return wb;
    }

    color(el) {
      if (!el || attr(el, "auto") === "1") return null;
      let c = null;
      if (attr(el, "rgb")) c = attr(el, "rgb").slice(-6).toUpperCase();
      else if (attr(el, "theme") !== null) c = this.theme[Number(attr(el, "theme"))] || null;
      else if (attr(el, "indexed") !== null) { const i = Number(attr(el, "indexed")); c = i === 64 ? "000000" : i === 65 ? "FFFFFF" : INDEXED[i] || null; }
      if (!c) return null;
      return tint(c, Number(attr(el, "tint") || 0));
    }

    readStyles(doc) {
      const fmts = new Map(deep(doc, "numFmt").map((n) => [Number(attr(n, "numFmtId")), attr(n, "formatCode")]));
      const root = doc.documentElement;
      const fonts = kids(kid(root, "fonts"), "font").map((f) => {
        const on = (n) => { const e = kid(f, n); return !!e && attr(e, "val") !== "0" && attr(e, "val") !== "false"; };
        return { b: on("b"), i: on("i"), u: !!kid(f, "u") && attr(kid(f, "u"), "val") !== "none", s: on("strike"),
          sz: Number(attr(kid(f, "sz"), "val") || 11), name: attr(kid(f, "name"), "val") || "Calibri", color: this.color(kid(f, "color")) };
      });
      const fills = kids(kid(root, "fills"), "fill").map((f) => {
        const p = kid(f, "patternFill");
        if (p) {
          const type = attr(p, "patternType");
          if (!type || type === "none") return null;
          return type === "solid" ? this.color(kid(p, "fgColor")) || this.color(kid(p, "bgColor")) : this.color(kid(p, "fgColor")) || this.color(kid(p, "bgColor"));
        }
        const g = kid(f, "gradientFill");
        return g ? this.color(kid(deep(g, "stop")[0], "color")) : null;
      });
      const borders = kids(kid(root, "borders"), "border").map((b) => {
        const side = (n) => { const e = kid(b, n); const st = attr(e, "style"); return st && st !== "none" ? { style: st, color: this.color(kid(e, "color")) || "000000" } : null; };
        return { left: side("left") || side("start"), right: side("right") || side("end"), top: side("top"), bottom: side("bottom") };
      });
      const xfs = kids(kid(root, "cellXfs"), "xf").map((x) => {
        const al = kid(x, "alignment");
        const id = Number(attr(x, "numFmtId") || 0);
        return {
          fmt: fmts.get(id) ?? BUILTIN[id] ?? "General", font: fonts[Number(attr(x, "fontId") || 0)] || fonts[0],
          fill: fills[Number(attr(x, "fillId") || 0)] || null, border: borders[Number(attr(x, "borderId") || 0)] || {},
          h: attr(al, "horizontal") || "general", v: attr(al, "vertical") || "bottom", wrap: attr(al, "wrapText") === "1" || attr(al, "wrapText") === "true",
          indent: Number(attr(al, "indent") || 0), rotate: Number(attr(al, "textRotation") || 0), shrink: attr(al, "shrinkToFit") === "1",
        };
      });
      return { xfs, fonts };
    }

    sheet(name) {
      if (this.parsed.has(name)) return this.parsed.get(name);
      const xmlText = this.xml[name];
      if (!xmlText) return null;
      const sh = this.readSheet(name, parseXml(xmlText));
      this.parsed.set(name, sh);
      return sh;
    }

    readSheet(name, doc) {
      const root = doc.documentElement;
      const fmtPr = kid(root, "sheetFormatPr");
      const sh = {
        name, cols: new Map(), rows: new Map(), cells: new Map(), merges: [],
        defaultW: Number(attr(fmtPr, "defaultColWidth") || (Number(attr(fmtPr, "baseColWidth") || 8) + 0.71)),
        defaultH: Number(attr(fmtPr, "defaultRowHeight") || 15), maxRow: 1, maxCol: 1,
      };
      const view = deep(root, "sheetView")[0];
      sh.grid = attr(view, "showGridLines") !== "0";
      sh.zoom = Number(attr(view, "zoomScale") || 100) / 100;
      for (const c of deep(kid(root, "cols"), "col")) {
        for (let i = Number(attr(c, "min")); i <= Math.min(Number(attr(c, "max")), 300); i++) {
          sh.cols.set(i, { w: attr(c, "width") !== null ? Number(attr(c, "width")) : null, hidden: attr(c, "hidden") === "1", s: attr(c, "style") !== null ? Number(attr(c, "style")) : null });
        }
      }
      const shared = {};
      for (const row of kids(kid(root, "sheetData"), "row")) {
        const r = Number(attr(row, "r"));
        sh.rows.set(r, { ht: attr(row, "ht") !== null ? Number(attr(row, "ht")) : null, hidden: attr(row, "hidden") === "1",
          s: attr(row, "customFormat") === "1" ? Number(attr(row, "s") || 0) : null });
        for (const c of kids(row, "c")) {
          const p = parseRef(attr(c, "r"));
          const t = attr(c, "t");
          const vEl = kid(c, "v"), fEl = kid(c, "f");
          let v = null;
          if (t === "s") v = this.strings[Number(vEl?.textContent)] ?? "";
          else if (t === "inlineStr") v = deep(c, "t").map((x) => x.textContent).join("");
          else if (t === "str") v = vEl ? vEl.textContent : "";
          else if (t === "b") v = vEl ? vEl.textContent === "1" : null;
          else if (t === "e") v = vEl ? { e: vEl.textContent } : null;
          else if (vEl) v = Number(vEl.textContent);
          let f = null;
          if (fEl) {
            const ft = attr(fEl, "t");
            if (ft === "shared") {
              const si = attr(fEl, "si");
              if (fEl.textContent) { shared[si] = { f: fEl.textContent, r: p.r, c: p.c }; f = fEl.textContent; }
              else if (shared[si]) f = shift(shared[si].f, p.r - shared[si].r, p.c - shared[si].c);
            } else f = fEl.textContent || null;
          }
          sh.cells.set(key(p.r, p.c), { r: p.r, c: p.c, s: attr(c, "s") !== null ? Number(attr(c, "s")) : null, v, f });
          if (v !== null || f) { sh.maxRow = Math.max(sh.maxRow, p.r); sh.maxCol = Math.max(sh.maxCol, p.c); }
        }
      }
      for (const m of deep(kid(root, "mergeCells"), "mergeCell")) {
        const [a, b] = attr(m, "ref").split(":").map(parseRef);
        if (a && b) sh.merges.push({ r1: a.r, c1: a.c, r2: b.r, c2: b.c });
      }
      return sh;
    }

    async readDrawing(s) {
      const rels = await readRels(this.zip, s.path);
      const doc = parseXml(this.xml[s.name]);
      const dEl = deep(doc, "drawing")[0];
      if (!dEl) return [];
      const rid = dEl.getAttribute("r:id") || dEl.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
      const path = rels[rid]?.target;
      if (!path || !this.zip.file(path)) return [];
      const drels = await readRels(this.zip, path);
      const dd = parseXml(await this.zip.file(path).async("string"));
      const out = [];
      for (const a of [...dd.documentElement.children]) {
        const pos = (el) => el && { c: Number(deep(el, "col")[0].textContent), co: Number(deep(el, "colOff")[0].textContent) / EMU,
          r: Number(deep(el, "row")[0].textContent), ro: Number(deep(el, "rowOff")[0].textContent) / EMU };
        const ext = kid(a, "ext");
        const item = { from: pos(kid(a, "from")), to: pos(kid(a, "to")),
          w: ext ? Number(attr(ext, "cx")) / EMU : null, h: ext ? Number(attr(ext, "cy")) / EMU : null };
        if (a.localName === "absoluteAnchor") {
          const p = kid(a, "pos");
          item.abs = { x: Number(attr(p, "x")) / EMU, y: Number(attr(p, "y")) / EMU };
        }
        const blip = deep(a, "blip")[0];
        const chart = deep(a, "chart")[0];
        if (blip) {
          const id = blip.getAttribute("r:embed") || blip.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed");
          const media = drels[id]?.target;
          if (!media || !this.zip.file(media)) continue;
          const type = /\.png$/i.test(media) ? "image/png" : /\.gif$/i.test(media) ? "image/gif" : /\.svg$/i.test(media) ? "image/svg+xml" : "image/jpeg";
          item.img = URL.createObjectURL(new Blob([await this.zip.file(media).async("arraybuffer")], { type }));
        } else if (chart) {
          const id = chart.getAttribute("r:id") || chart.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
          const cp = drels[id]?.target;
          if (!cp || !this.zip.file(cp)) continue;
          item.chart = parseXml(await this.zip.file(cp).async("string"));
        } else continue;
        out.push(item);
      }
      return out;
    }

    xf(sh, r, c) {
      const cell = sh.cells.get(key(r, c));
      const s = cell && cell.s !== null ? cell.s : sh.rows.get(r)?.s ?? sh.cols.get(c)?.s ?? 0;
      return { id: s, ...this.styles.xfs[s] };
    }

    value(name, r, c) { return this.calc.value(name, r, c); }
    raw(name, r, c) { return this.sheet(name)?.cells.get(key(r, c)) || null; }
  }

  // ---- Drawing the sheet ---------------------------------------------------------------------
  const colPx = (w) => Math.trunc(((256 * w + Math.trunc(128 / 7)) / 256) * 7);
  const rowPx = (pt) => Math.round((pt * 96) / 72);

  const BORDER = {
    thin: "1px solid", hair: "1px solid", dotted: "1px dotted", dashed: "1px dashed", dashDot: "1px dashed", dashDotDot: "1px dashed",
    medium: "2px solid", mediumDashed: "2px dashed", mediumDashDot: "2px dashed", mediumDashDotDot: "2px dashed", slantDashDot: "2px dashed",
    thick: "3px solid", double: "3px double",
  };
  // Modern look (opts.modern): the sheet's content and colours, drawn like a web dashboard
  // rather than Excel: the app's font, soft grey lines, lighter pastel fills, no grid headings.
  const luma = (hex) => { const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
  const mix = (hex, to, t) => [0, 2, 4].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - t) + parseInt(to.slice(i, i + 2), 16) * t).toString(16).padStart(2, "0")).join("").toUpperCase();
  const softFill = (hex) => (luma(hex) > 0.5 ? mix(hex, "FFFFFF", 0.6) : mix(hex, "1F3864", 0.15));
  const softLine = (hex) => (luma(hex) < 0.35 ? "D3DAE6" : mix(hex, "FFFFFF", 0.3));
  const MODERN_FONT = 'Inter,"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif';
  // In the dashboard look, thin column lines go away and thin row lines turn hairline grey.
  const borderCss = (b, modern, vertical) => {
    if (!b) return null;
    if (!modern) return `${BORDER[b.style] || "1px solid"} #${b.color}`;
    const heavy = /thick|double|medium/.test(b.style);
    if (vertical && !heavy) return "none";
    return heavy ? `2px solid #${softLine(b.color)}` : "1px solid #E7EBF2";
  };

  function fontCss(font, modern) {
    const fam = String(font.name).replace(/["\\]/g, "");
    if (modern) {
      return `font-family:${MODERN_FONT};font-size:${Math.max(8, font.sz - 1)}pt;${font.b ? "font-weight:600;" : ""}${font.i ? "font-style:italic;" : ""}`
        + `${font.u ? "text-decoration:underline;" : ""}${font.color ? `color:#${font.color === "000000" ? "1D2433" : font.color};` : "color:#1D2433;"}`;
    }
    return `font-family:"${fam}",Calibri,Arial,sans-serif;font-size:${font.sz}pt;${font.b ? "font-weight:700;" : ""}${font.i ? "font-style:italic;" : ""}`
      + `${font.u || font.s ? `text-decoration:${font.u ? "underline" : ""} ${font.s ? "line-through" : ""};` : ""}${font.color ? `color:#${font.color};` : ""}`;
  }

  // Lays out a sheet: visible columns and rows with their pixel sizes, and how far the sheet goes.
  // opts.showHidden: show columns and rows the sheet hides; opts.hideRows: rows to leave out;
  // opts.rows / opts.cols: Sets of the only rows / columns to show; opts.colW: {column: min px}.
  function layout(wb, name, opts = {}) {
    const sh = wb.sheet(name);
    let maxR = sh.maxRow, maxC = sh.maxCol;
    for (const x of sh.cells.values()) {
      if (x.s === null) continue;
      const st = wb.styles.xfs[x.s];
      if (st && (st.fill || st.border.left || st.border.right || st.border.top || st.border.bottom)) { maxR = Math.max(maxR, x.r); maxC = Math.max(maxC, x.c); }
    }
    for (const m of sh.merges) { maxR = Math.max(maxR, m.r2); maxC = Math.max(maxC, m.c2); }
    for (const d of wb.drawings[name] || []) if (d.to) { maxR = Math.max(maxR, d.to.r + 1); maxC = Math.max(maxC, d.to.c + 1); }
    maxR = Math.min(maxR + 3, MAX_ROWS);
    maxC = Math.min(maxC + 2, MAX_COLS);
    // Hidden columns are shown (opts.showHidden) only when something is in them.
    const used = new Set();
    for (const x of sh.cells.values()) if ((x.v !== null && x.v !== undefined && x.v !== "") || x.f) used.add(x.c);
    const cols = [], colX = [0];
    for (let c = 1; c <= maxC; c++) {
      const info = sh.cols.get(c);
      const w = (info?.hidden && (!opts.showHidden || !used.has(c))) || (opts.cols && !opts.cols.has(c)) ? 0 : Math.max(colPx(info?.w || sh.defaultW), opts.colW?.[c] || 0);
      if (w) cols.push({ c, w });
      colX[c] = colX[c - 1] + w;
    }
    const rows = [], rowY = [0];
    for (let r = 1; r <= maxR; r++) {
      const info = sh.rows.get(r);
      const h = (info?.hidden && !opts.showHidden) || opts.hideRows?.has(r) || (opts.rows && !opts.rows.has(r)) ? 0 : rowPx(info?.ht || sh.defaultH);
      if (h) rows.push({ r, h });
      rowY[r] = rowY[r - 1] + h;
    }
    return { sh, cols, rows, colX, rowY, maxR, maxC };
  }

  // HTML for one sheet. opts: {zoom, showHidden, hideRows, isEdited(r, c), isEditable(r, c),
  // decorate(r, c) -> {cls, before} to add a class and HTML before a cell's text, text(r, c) -> text
  // to show instead of the cell's, rows, cols, colW (see layout)}.
  function render(wb, name, host, opts = {}) {
    const L = layout(wb, name, opts);
    const modern = !!opts.modern;
    const HW = modern ? 0 : HEAD_W, HH = modern ? 0 : HEAD_H;
    const bcss = (b, vertical) => borderCss(b, modern, vertical);
    const { sh, cols, rows } = L;
    const visibleCol = new Set(cols.map((x) => x.c)), visibleRow = new Set(rows.map((x) => x.r));
    const covered = new Set(), mergeAt = new Map();
    for (const m of sh.merges) {
      mergeAt.set(key(m.r1, m.c1), m);
      for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) covered.add(key(r, c));
    }
    const mergeOf = (r, c) => { for (const m of sh.merges) if (r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) return m; return null; };
    const xfAt = (r, c) => { const m = mergeOf(r, c); return wb.xf(sh, m ? m.r1 : r, m ? m.c1 : c); };
    const fillAt = (r, c) => (r < 1 || c < 1 ? null : xfAt(r, c).fill);
    const own = (r, c, side) => wb.xf(sh, r, c).border[side];
    const edge = (r, c, side) => {
      const opp = { right: ["left", 0, 1], bottom: ["top", 1, 0], left: ["right", 0, -1], top: ["bottom", -1, 0] }[side];
      return own(r, c, side) || (r + opp[1] >= 1 && c + opp[2] >= 1 ? own(r + opp[1], c + opp[2], opp[0]) : null);
    };
    const grid = (a, b) => (sh.grid && !a && !b && !modern ? "1px solid #e1e3e6" : "none");
    const width = cols.reduce((a, x) => a + x.w, 0) + HW;
    const empty = (r, c) => { const x = sh.cells.get(key(r, c)); return !x || ((x.v === null || x.v === "") && !x.f); };

    let html = `<table class="xl-grid${modern ? " xl-modern" : ""}" style="width:${width}px"><colgroup>${modern ? "" : `<col style="width:${HEAD_W}px">`}${cols.map((x) => `<col style="width:${x.w}px">`).join("")}</colgroup>`;
    html += modern ? "<tbody>" : `<thead><tr><th class="xl-corner"></th>${cols.map((x) => `<th class="xl-ch" data-c="${x.c}">${colName(x.c)}</th>`).join("")}</tr></thead><tbody>`;
    const firstCol = cols[0]?.c, firstRow = rows[0]?.r;
    for (const { r, h } of rows) {
      html += `<tr style="height:${h}px">${modern ? "" : `<th class="xl-rh" data-r="${r}">${r}</th>`}`;
      for (const { c } of cols) {
        if (covered.has(key(r, c))) continue;
        const m = mergeAt.get(key(r, c));
        let cs = 1, rs = 1, hgt = h, r2 = r, c2 = c;
        if (m) {
          r2 = m.r2; c2 = m.c2;
          cs = 0; for (let x = m.c1; x <= m.c2; x++) if (visibleCol.has(x)) cs++;
          rs = 0; hgt = 0; for (let y = m.r1; y <= m.r2; y++) if (visibleRow.has(y)) { rs++; hgt += L.rowY[y] - L.rowY[y - 1]; }
          if (!cs || !rs) continue;
        }
        const st = wb.xf(sh, r, c);
        const v = wb.value(name, r, c);
        const over = opts.text ? opts.text(r, c) : undefined;
        const fmt = over !== undefined ? { text: over } : format(v, st.fmt);
        const fill = st.fill;
        const right = bcss(edge(r, c2, "right"), true) || grid(fill, fillAt(r, c2 + 1));
        const bottom = bcss(edge(r2, c, "bottom")) || grid(fill, fillAt(r2 + 1, c));
        let style = `border-right:${right};border-bottom:${bottom};`;
        if (c === firstCol) style += `border-left:${bcss(own(r, c, "left"), true) || "none"};`;
        if (r === firstRow) style += `border-top:${bcss(own(r, c, "top")) || "none"};`;
        if (fill) style += `background:#${modern ? softFill(fill) : fill};`;
        if (fmt.color) style += `color:${fmt.color};`;
        let hAlign = st.h;
        if (hAlign === "general") hAlign = typeof v === "number" ? "right" : typeof v === "boolean" || (v && v.e) ? "center" : "left";
        if (hAlign === "centerContinuous" || hAlign === "distributed") hAlign = "center";
        if (hAlign === "fill" || hAlign === "justify") hAlign = "left";
        const vAlign = { top: "flex-start", center: "center", bottom: "flex-end", justify: "center", distributed: "center" }[st.v] || "flex-end";
        // Text runs into empty cells on its right, as in Excel.
        let spill = false;
        if (!st.wrap && typeof v === "string" && v && !m && hAlign !== "right") spill = empty(r, c + 1);
        const cls = [`xl-x${st.id}`];
        const deco = opts.decorate ? opts.decorate(r, c) : null;
        if (deco?.cls) cls.push(deco.cls);
        if (opts.isEdited && opts.isEdited(r, c)) cls.push("xl-edited");
        if (opts.isEditable && !opts.isEditable(r, c)) cls.push("xl-ro");
        const span = `${cs > 1 ? ` colspan="${cs}"` : ""}${rs > 1 ? ` rowspan="${rs}"` : ""}`;
        const content = fmt.left !== null && fmt.left !== undefined
          ? `<span class="xl-l">${esc(fmt.left)}</span><span>${esc(fmt.text)}</span>`
          : esc(fmt.text);
        const inner = `display:flex;align-items:${vAlign};justify-content:${fmt.left != null ? "space-between" : hAlign === "center" ? "center" : hAlign === "right" ? "flex-end" : "flex-start"};`
          + `text-align:${hAlign};height:${hgt - 1}px;${st.indent ? `padding-${hAlign === "right" ? "right" : "left"}:${st.indent * 9}px;` : ""}`
          + `${st.wrap ? "white-space:pre-wrap;" : ""}${spill ? "overflow:visible;" : ""}${st.rotate === 90 || st.rotate === 180 ? "writing-mode:vertical-rl;transform:rotate(180deg);" : st.rotate === 255 ? "writing-mode:vertical-rl;" : ""}`;
        const tip = modern && typeof v === "string" && v.length > 12 && !spill && !st.wrap ? ` title="${esc(v)}"` : "";
        html += `<td class="${cls.join(" ")}" data-r="${r}" data-c="${c}"${span}${tip} style="${style}"><div class="xl-c" style="${inner}">${deco?.before || ""}${content}</div></td>`;
      }
      html += "</tr>";
    }
    html += "</tbody></table>";

    // Pictures and charts over the cells.
    const colGone = (c) => L.colX[c] === L.colX[c - 1], rowGone = (r) => L.rowY[r] === L.rowY[r - 1];
    const at = (p) => ({ x: HW + L.colX[Math.min(p.c, L.maxC)] + (colGone(p.c + 1) ? 0 : p.co), y: HH + L.rowY[Math.min(p.r, L.maxR)] + (rowGone(p.r + 1) ? 0 : p.ro) });
    let draw = "";
    for (const d of wb.drawings[name] || []) {
      if (opts.rows && (d.abs || !opts.rows.has(d.from.r + 1))) continue;
      let x, y, w, hh;
      if (d.abs) { x = HW + d.abs.x; y = HH + d.abs.y; w = d.w; hh = d.h; }
      else {
        const a = at(d.from);
        x = a.x; y = a.y;
        if (d.to) { const b = at(d.to); w = b.x - a.x; hh = b.y - a.y; } else { w = d.w; hh = d.h; }
      }
      if (!w || !hh) continue;
      const box = `left:${x}px;top:${y}px;width:${w}px;height:${hh}px`;
      if (d.img) draw += `<img class="xl-pic" src="${d.img}" alt="" style="${box}">`;
      else if (d.chart) draw += `<div class="xl-chart" style="${box}">${chartSvg(wb, d.chart, w, hh)}</div>`;
    }

    // Styles for the cells' fonts, one class per cell style used.
    const used = new Set();
    for (const m of html.matchAll(/xl-x(\d+)/g)) used.add(Number(m[1]));
    const css = [...used].map((i) => `.xl-x${i}{${fontCss(wb.styles.xfs[i]?.font || wb.styles.fonts[0], modern)}}`).join("");
    host.innerHTML = `<style>${css}</style><div class="xl-sheet" style="zoom:${opts.zoom || 1}">${html}<div class="xl-draw">${draw}</div></div>`;
    return L;
  }

  // ---- Charts --------------------------------------------------------------------------------
  function drawColor(wb, el) {
    if (!el) return null;
    const c = kid(el, "srgbClr") || kid(el, "schemeClr") || kid(el, "sysClr") || kid(el, "prstClr");
    if (!c) return null;
    let v = c.localName === "srgbClr" ? attr(c, "val") : c.localName === "sysClr" ? attr(c, "lastClr") || "000000"
      : c.localName === "schemeClr" ? wb.scheme?.[attr(c, "val")] || "000000" : { black: "000000", white: "FFFFFF" }[attr(c, "val")] || "000000";
    const mod = kid(c, "lumMod"), off = kid(c, "lumOff"), shade = kid(c, "shade"), tnt = kid(c, "tint");
    v = lum(v, mod ? Number(attr(mod, "val")) / 100000 : 1, off ? Number(attr(off, "val")) / 100000 : 0);
    if (shade) v = lum(v, Number(attr(shade, "val")) / 100000);
    if (tnt) { const t = Number(attr(tnt, "val")) / 100000; v = tint(v, 1 - t); }
    return `#${v}`;
  }
  const fillOf = (wb, spPr) => {
    if (!spPr) return undefined;
    if (kid(spPr, "noFill")) return "none";
    if (kid(spPr, "solidFill")) return drawColor(wb, kid(spPr, "solidFill"));
    const g = kid(spPr, "gradFill");
    if (g) { const stops = deep(g, "gs"); return drawColor(wb, stops[Math.floor(stops.length / 2)] || stops[0]); }
    return undefined;
  };

  function niceStep(max) {
    if (max <= 0) return 1;
    const raw = max / 5, p = 10 ** Math.floor(Math.log10(raw)), n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }

  function chartSvg(wb, doc, W, H, light = false) {
    const space = doc.documentElement;
    const chart = kid(space, "chart");
    const plot = kid(chart, "plotArea");
    const bar = deep(plot, "barChart")[0];
    const bg = light ? "#FFFFFF" : fillOf(wb, kid(space, "spPr")) || "#FFFFFF";
    const dark = (() => { const m = /^#(..)(..)(..)$/.exec(bg || ""); if (!m) return false; const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16)); return 0.299 * r + 0.587 * g + 0.114 * b < 128; })();
    const ink = dark ? "#D9D9D9" : "#595959";
    const title = deep(kid(chart, "title"), "t").map((t) => t.textContent).join("");
    const refVals = (ref) => {
      const f = deep(ref, "f")[0];
      if (!f) return deep(ref, "v").map((v) => (Number.isFinite(Number(v.textContent)) ? Number(v.textContent) : v.textContent));
      try { return wb.calc.flat(wb.calc.range(parse(f.textContent))); } catch { return []; }
    };
    const series = bar ? kids(bar, "ser").map((s, i) => ({
      name: deep(kid(s, "tx"), "v")[0]?.textContent || "", cats: refVals(kid(s, "cat")), vals: refVals(kid(s, "val")).map((v) => (typeof v === "number" ? v : 0)),
      color: ((c) => (light && c && /^#([0-9A-F]{2})\1\1$/i.test(c) ? "#0f766e" : c))(fillOf(wb, kid(s, "spPr"))) || `#${wb.scheme?.[`accent${(i % 6) + 1}`] || "4472C4"}`,
    })) : [];
    const valAx = deep(plot, "valAx")[0];
    const axFmt = attr(kid(valAx, "numFmt"), "formatCode") || "General";
    const cats = series[0]?.cats || [];
    const n = Math.max(cats.length, ...series.map((s) => s.vals.length), 1);
    const max = Math.max(0, ...series.flatMap((s) => s.vals));
    const step = niceStep(max), top = Math.max(step, Math.ceil(max / step) * step);
    const label = (v) => format(v, axFmt === "General" ? "#,##0" : axFmt).text.trim();
    const padL = Math.min(90, 14 + 7 * Math.max(...[0, top].map((v) => label(v).length))), padT = title ? 34 : 12, padB = 26, padR = 12;
    const pw = Math.max(10, W - padL - padR), ph = Math.max(10, H - padT - padB);
    const bw = (pw / n) * 0.62 / Math.max(series.length, 1);
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="${light ? MODERN_FONT.replace(/"/g, "'") : "Calibri,Arial,sans-serif"}">`;
    svg += `<rect width="${W}" height="${H}" fill="${bg === "none" ? "transparent" : bg}"/>`;
    if (title) svg += `<text x="${W / 2}" y="22" text-anchor="middle" font-size="15" font-weight="700" fill="${ink}">${esc(title)}</text>`;
    for (let v = 0; v <= top + 1e-9; v += step) {
      const y = padT + ph - (v / top) * ph;
      svg += `<line x1="${padL}" x2="${padL + pw}" y1="${y}" y2="${y}" stroke="${dark ? "#555" : "#D9D9D9"}" stroke-width="0.75"/>`;
      svg += `<text x="${padL - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="${ink}">${esc(label(v))}</text>`;
    }
    for (let i = 0; i < n; i++) {
      const cx = padL + (pw / n) * (i + 0.5);
      series.forEach((s, j) => {
        const v = s.vals[i] || 0;
        const hh = (Math.max(0, v) / top) * ph;
        const x = cx - (bw * series.length) / 2 + j * bw;
        if (hh > 0) svg += `<rect x="${x}" y="${padT + ph - hh}" width="${bw}" height="${hh}" fill="${s.color}"><title>${esc(String(cats[i] ?? ""))}: ${esc(label(v))}</title></rect>`;
      });
      const c = cats[i];
      if (c !== undefined && c !== null) svg += `<text x="${cx}" y="${padT + ph + 16}" text-anchor="middle" font-size="10" fill="${ink}">${esc(typeof c === "number" ? general(c) : c)}</text>`;
    }
    return svg + "</svg>";
  }

  return { load: (zip) => Workbook.load(zip), render, chart: chartSvg, format, parse, colName, colNum, refOf, parseRef, toSerial, fromSerial, HEAD_W, HEAD_H };
})();

/* ===== reviewpage.js (from the asset management system) ===== */
// Review Report page (#/review/<client>): the client review workbook shown as Excel shows it
// (public/js/sheetview.js), with the same sheets, colours and charts. Cells can be typed into:
//   - DETAILED PORTFOLIO: a scheme's sub type, invested, units, value, XIRR, SIP, new SIP,
//     remarks and suggestions (saved per scheme, so totals and the other sheets follow); right-click
//     a scheme to change its fund type or leave it out.
//   - Every other sheet: any cell that is not a formula (saved per cell).
// Changes are saved per client on the server (/api/review/edits), apart from the uploaded data,
// which is never changed. Export builds the Excel file with them (public/js/review.js).
const ReviewPage = (() => {
  let view = null;
  const enc = encodeURIComponent;
  const SAVE_DELAY = 700;
  const DETAILED = "DETAILED PORTFOLIO";
  const NUMBER_FIELDS = new Set(["invested", "quantity", "current_value", "xirr", "sip", "newSip"]);

  let data = null, edits = {}, wb = null, schemeRows = new Map(), names = new Map();
  let groups = [], openGroups = new Set(); // DETAILED PORTFOLIO blocks; folded unless opened
  let openCards = new Set(); // dashboard cards opened with their dropdown (fund types, sections)
  let foldsSet = false; // the card view starts with every scheme shown
  let blocks = [], grandRow = null; // DETAILED PORTFOLIO platform blocks, for the card view
  // Sheets whose hidden columns hold client figures, so the page shows them.
  const SHOW_HIDDEN = new Set(["SUMMARY PORTFOLIO", DETAILED]);
  let sheetName = null, sel = null, editor = null, active = false, building = null, pending = false;
  let saveTimer = null, saving = null, dirty = false;
  let zoom = Number(store("xlZoom")) || 1;
  // Dashboard look by default; "Excel view" shows row numbers, column letters and the formula bar.
  let excelView = store("xlExcelView") === "1";
  const TAB_NAMES = { "1": "Cover", "SUMMARY PORTFOLIO": "Summary Portfolio", "DETAILED PORTFOLIO": "Detailed Portfolio" };

  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; }
    return null;
  }

  const isNum = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

  // ---- Saving -----------------------------------------------------------------------------
  function setStatus(text, cls = "") {
    const el = $("xlStatus");
    if (el) { el.textContent = text; el.className = `xl-status ${cls}`; }
  }

  function scheduleSave() {
    dirty = true;
    setStatus("Saving…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY);
  }

  async function save() {
    clearTimeout(saveTimer);
    if (!dirty) return saving;
    dirty = false;
    const client = data.clientName;
    saving = rrSaveEdits(data.clientKey, clean(edits))
      .then(() => { if (data?.clientName === client && !dirty) setStatus("All changes saved", "ok"); })
      .catch((e) => { dirty = true; setStatus(`Not saved: ${e.message}`, "err"); throw e; });
    return saving;
  }

  async function flush() {
    if (!data) return;
    try { if (dirty) await save(); else await saving; } catch {}
  }

  // Drop empty objects so the saved document only holds real changes. Cell values of "" are kept:
  // they mean the reviewer cleared that cell.
  function clean(o, isCells = false) {
    if (Array.isArray(o) || o === null || typeof o !== "object") return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      const c = clean(v, isCells || k === "cells");
      if (c === undefined || c === false || (c === "" && !isCells) || c === null) continue;
      if (typeof c === "object" && !Object.keys(c).length) continue;
      out[k] = c;
    }
    return out;
  }

  // ---- Page ---------------------------------------------------------------------------------
  async function show(name) {
    active = false;
    await flush();
    view = rrHost();
    document.body.classList.add("xl-mode");
    view.innerHTML = '<div class="loading">Loading the review sheet…</div>';
    try {
      data = await rrLoad(name);
    } catch (e) {
      data = null;
      view.innerHTML = `<div class="xl-error"><nav class="crumbs"><a href="javascript:void(0)" onclick="ReviewReport.close()">‹ Close</a></nav>
        <div class="card empty-state"><h2>Couldn't load the review report</h2><p>${esc(e.message)}</p></div></div>`;
      return;
    }
    edits = data.edits && typeof data.edits === "object" ? structuredClone(data.edits) : {};
    dirty = false;
    sel = null;
    const prep = Review.prepare(data, {});
    names = new Map([...prep.raw.holdings, ...prep.raw.sips].map((r) => [Review.rowKey(r), r.security_name || "Scheme"]));
    foldsSet = false;
    openGroups = new Set();
    openCards = new Set();
    seeded = new Set();
    shell();
    active = true;
    await rebuild();
  }

  function shell() {
    const c = data.clientName;
    view.innerHTML = `<div class="xl-app ${excelView ? "" : "modern"}" id="xlApp">
      <div class="xl-bar">
        <a class="xl-back" href="javascript:void(0)" id="xlClose" title="Close the review and go back">‹</a>
        <div class="xl-avatar" aria-hidden="true">${esc(c.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase())}</div>
        <div class="xl-title"><b>${esc(c)}</b><span title="Click a cell to change it. Right-click a scheme to change its fund type or leave it out.">Review sheet</span></div>
        <div class="xl-kpis" id="xlKpis"></div>
        <label class="xl-date" title="Review date">Date <input type="date" id="xlDate" value="${esc(edits.reviewDate || data.today)}"></label>
        <span id="xlStatus" class="xl-status ${data.editsSavedAt ? "ok" : ""}">${data.editsSavedAt ? "Changes saved" : "No changes yet"}</span>
        <button type="button" class="xl-btn" id="xlView" title="Switch between the dashboard look and a spreadsheet look">${excelView ? "Dashboard view" : "Excel view"}</button>
        <button type="button" class="xl-btn" id="xlReset">Reset changes</button>
        <button type="button" class="xl-btn" id="xlPrev" title="Review reports exported before, kept with the client">Previous reviews</button>
        <button type="button" class="xl-btn xl-export" id="xlExport" title="Builds the review workbook, downloads it and keeps a copy under Previous reviews">Export Excel</button>
      </div>
      <div class="xl-fx"><span id="xlName" class="xl-name"></span><span class="xl-fxl">fx</span><input id="xlFx" autocomplete="off" spellcheck="false"></div>
      <div id="xlHost" class="xl-host" tabindex="0"></div>
      <div class="xl-foot">
        <div id="xlTabs" class="xl-tabs" role="tablist"></div>
        <span class="xl-folds" id="xlFolds" hidden><button type="button" data-fold="open">▾ Expand all</button><button type="button" data-fold="close">▸ Collapse all</button></span>
        <button type="button" id="xlOut" class="xl-out" hidden></button>
        <div class="xl-zoom"><button type="button" data-zoom="-1" aria-label="Zoom out">−</button><span id="xlZoom"></span><button type="button" data-zoom="1" aria-label="Zoom in">+</button></div>
      </div>
      <div id="xlMenu" class="xl-menu" hidden></div>
    </div>`;
    $("xlExport").addEventListener("click", exportNow);
    $("xlClose").addEventListener("click", () => ReviewReport.close());
    $("xlPrev").addEventListener("click", (e) => openMenu(e, rrPreviousItems(data.clientKey)));
    $("xlView").addEventListener("click", () => {
      excelView = !excelView;
      store("xlExcelView", excelView ? "1" : "0");
      $("xlApp").classList.toggle("modern", !excelView);
      $("xlView").textContent = excelView ? "Dashboard view" : "Excel view";
      draw();
    });
    $("xlReset").addEventListener("click", reset);
    $("xlDate").addEventListener("change", (e) => {
      const v = e.target.value;
      if (v && v !== data.today) edits.reviewDate = v; else delete edits.reviewDate;
      changed();
    });
    $("xlFx").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); if (sel) commit(sel.r, sel.c, $("xlFx").value, { r: 1, c: 0 }); $("xlHost").focus(); }
      if (e.key === "Escape") { showSelection(); $("xlHost").focus(); }
    });
    view.querySelectorAll("[data-zoom]").forEach((b) => b.addEventListener("click", () => {
      zoom = Math.min(2, Math.max(0.4, Math.round((zoom + Number(b.dataset.zoom) * 0.1) * 10) / 10));
      store("xlZoom", zoom);
      draw();
    }));
    $("xlOut").addEventListener("click", (e) => leftOutMenu(e));
    view.querySelectorAll("[data-fold]").forEach((b) => b.addEventListener("click", () => {
      openGroups = b.dataset.fold === "open" ? new Set(groups.map((g) => g.id)) : new Set();
      openCards = b.dataset.fold === "open" ? new Set([...openCards, ...[...$("xlHost").querySelectorAll("[data-toggle]")].map((x) => x.dataset.toggle)]) : new Set();
      draw();
    }));
    const host = $("xlHost");
    host.addEventListener("click", (e) => {
      const tg = e.target.closest("[data-toggle]");
      if (tg && !e.target.closest("[data-r][data-c], button")) {
        if (openCards.has(tg.dataset.toggle)) openCards.delete(tg.dataset.toggle); else openCards.add(tg.dataset.toggle);
        draw();
        return;
      }
      const td = e.target.closest("[data-r][data-c]");
      if (!td) return;
      const r = Number(td.dataset.r);
      const g = sheetName === DETAILED && groups.find((x) => x.head === r || x.total === r);
      if (g && (g.head === r || !openGroups.has(g.id))) {
        if (openGroups.has(g.id)) openGroups.delete(g.id); else openGroups.add(g.id);
        draw();
      }
      select(r, Number(td.dataset.c));
      if (td.classList.contains("cv-edit")) openEditor();
    });
    host.addEventListener("dblclick", (e) => {
      const td = e.target.closest("[data-r][data-c]");
      if (td) { select(Number(td.dataset.r), Number(td.dataset.c)); openEditor(); }
    });
    host.addEventListener("contextmenu", (e) => {
      const td = e.target.closest("[data-r][data-c]");
      if (!td) return;
      e.preventDefault();
      select(Number(td.dataset.r), Number(td.dataset.c));
      cellMenu(e);
    });
    host.addEventListener("keydown", onKey);
  }

  // Rebuilds the workbook from the uploaded data and the edits, and shows it again.
  async function rebuild() {
    if (building) { pending = true; return building; }
    const host = $("xlHost");
    host?.classList.add("busy");
    building = (async () => {
      try {
        const out = await Review.assemble(data, await Review.template(), clean(edits));
        schemeRows = out.schemeRows;
        groups = out.groups || [];
        blocks = out.blocks || [];
        if (!foldsSet) { foldsSet = true; if (!excelView) openGroups = new Set(groups.map((g) => g.id)); }
        grandRow = out.grand ?? null;
        wb = await SheetView.load(out.zip);
        if (!sheetName || !wb.sheets.some((s) => s.name === sheetName && !s.hidden)) {
          const remembered = store("xlSheet");
          sheetName = wb.sheets.some((s) => s.name === remembered && !s.hidden) ? remembered
            : wb.sheets.find((s) => s.name === "Summary")?.name || wb.sheets.find((s) => !s.hidden).name;
        }
        if (active) { tabs(); draw(); leftOut(); kpis(); }
      } catch (e) {
        if (active) host.innerHTML = `<div class="card empty-state"><h2>Couldn't build the review sheet</h2><p>${esc(e.message)}</p></div>`;
      } finally {
        host?.classList.remove("busy");
      }
    })();
    await building;
    building = null;
    if (pending) { pending = false; await rebuild(); }
  }

  function tabs() {
    $("xlTabs").innerHTML = wb.sheets.filter((s) => !s.hidden).map((s) =>
      `<button type="button" role="tab" class="xl-tab ${s.name === sheetName ? "on" : ""}" data-sheet="${esc(s.name)}" aria-selected="${s.name === sheetName}">${esc(TAB_NAMES[s.name] || s.name.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()))}</button>`).join("");
    $("xlTabs").querySelectorAll("[data-sheet]").forEach((b) => b.addEventListener("click", () => {
      sheetName = b.dataset.sheet;
      store("xlSheet", sheetName);
      sel = null;
      tabs();
      draw(true);
    }));
  }

  function draw(top = false) {
    const host = $("xlHost");
    const scroll = top ? { x: 0, y: 0 } : { x: host.scrollLeft, y: host.scrollTop };
    const detailed = sheetName === DETAILED;
    const hideRows = new Set();
    if (detailed) for (const g of groups) if (!openGroups.has(g.id)) for (let r = g.first; r <= g.last; r++) hideRows.add(r);
    if (detailed && !excelView) Cards.render(host);
    else if (!excelView && Pages[sheetName]) Pages[sheetName](host);
    else SheetView.render(wb, sheetName, host, { zoom, modern: !excelView, isEdited, isEditable, hideRows, showHidden: SHOW_HIDDEN.has(sheetName), decorate: detailed ? decorate : null });
    $("xlFolds").hidden = !(detailed && groups.length) && !host.querySelector("[data-toggle]");
    host.scrollLeft = scroll.x;
    host.scrollTop = scroll.y;
    $("xlZoom").textContent = `${Math.round(zoom * 100)}%`;
    showSelection();
  }

  // Fold arrows on DETAILED PORTFOLIO: on each fund type (or platform) heading, and on its
  // Grand Total while folded.
  function decorate(r, c) {
    const g = groups.find((x) => x.head === r || x.total === r);
    if (!g) return null;
    const open = openGroups.has(g.id);
    const n = [...schemeRows.keys()].filter((x) => x >= g.first && x <= g.last).length;
    if (g.head === r && c === 2) {
      return { cls: "xl-fold", before: `<span class="xl-caret" title="${open ? "Hide" : "Show"} the ${n} scheme${n === 1 ? "" : "s"}">${open ? "▾" : "▸"}</span>` };
    }
    if (g.total === r && !open && c === 1) return { cls: "xl-fold", before: `<span class="xl-caret">▸</span>` };
    if (g.head === r || (g.total === r && !open)) return { cls: "xl-fold" };
    return null;
  }

  // DETAILED PORTFOLIO in the dashboard look: a card per platform, its fund types as rows that
  // open into scheme cards. Every figure is read from the sheet, so edits and totals match the
  // Excel view and the export; values carry data-r/data-c, so clicking one types into that cell.
  const TYPE_COLORS = ["#1f3864", "#0f766e", "#b45309", "#7c3aed", "#e8590c", "#0284c7", "#be185d", "#4d7c0f"];
  const Cards = {
    val: (r, c) => wb.value(DETAILED, r, SheetView.colNum(c)),
    num(r, c) { const v = this.val(r, c); return typeof v === "number" ? v : null; },
    text(r, c) {
      const v = this.val(r, c);
      if (v === null || v === undefined || v === "") return "";
      const f = SheetView.format(v, wb.xf(wb.sheet(DETAILED), r, SheetView.colNum(c)).fmt);
      return `${f.left ?? ""}${f.text}`.trim();
    },
    // One figure: label over value. Editable figures open the editor on click.
    cell(r, c, label, shown, cls = "") {
      const cc = SheetView.colNum(c);
      const edit = isEditable(r, cc), edited = isEdited(r, cc);
      return `<div class="cv-f ${cls}"><span>${label}</span><b class="${edit ? "cv-edit" : ""} ${edited ? "xl-edited" : ""}" data-r="${r}" data-c="${cc}"`
        + `${edit ? ` title="Click to change"` : ""}>${shown || "–"}</b></div>`;
    },
    pct(r, c) { const v = this.num(r, c); return v === null ? "" : fmt.pct(v); },
    gain(r) {
      const inv = this.num(r, "D") || 0, cur = this.num(r, "J") ?? this.num(r, "G") ?? 0;
      return cur - inv;
    },
    stats(r) {
      return this.statsOf({ inv: this.num(r, "D") ?? 0, cur: this.num(r, "J") ?? this.num(r, "G") ?? 0, ret: this.pct(r, "L"), xirr: this.pct(r, "K"), sip: this.num(r, "O") ?? 0 });
    },
    statsOf({ inv, cur, ret, xirr, sip }) {
      const g = cur - inv;
      return `<div class="cv-stats">
        <div><span>Invested</span><b>${fmt.money(inv)}</b></div>
        <div><span>Current value</span><b>${fmt.money(cur)}</b></div>
        <div class="${g < 0 ? "cv-down" : "cv-up"}"><span>Gain</span><b>${fmt.money(g)}</b></div>
        <div><span>Abs. return</span><b>${ret || "–"}</b></div>
        <div><span>XIRR</span><b>${xirr || "–"}</b></div>
        <div><span>Live SIP</span><b>${fmt.money(sip)}</b></div>
      </div>`;
    },
    scheme(r) {
      const g = (this.num(r, "G") || 0) - (this.num(r, "D") || 0);
      const ret = this.pct(r, "L");
      return `<article class="cv-scheme">
        <div class="cv-shead" data-r="${r}" data-c="2" title="Right-click to change the fund type or leave it out">
          <span class="cv-no">${this.text(r, "A")}</span><h4>${esc(this.text(r, "B") || "Scheme")}</h4>
          ${ret ? `<span class="cv-pill ${g < 0 ? "cv-down" : "cv-up"}">${ret}</span>` : ""}
        </div>
        ${this.cell(r, "C", "Sub type", esc(this.text(r, "C")), "cv-wide")}
        <div class="cv-main">
          ${this.cell(r, "D", "Invested", this.num(r, "D") === null ? "" : fmt.money(this.num(r, "D")))}
          ${this.cell(r, "G", "Current value", this.num(r, "G") === null ? "" : fmt.money(this.num(r, "G")))}
        </div>
        <div class="cv-grid">
          ${this.cell(r, "F", "Units", this.text(r, "F"))}
          ${this.cell(r, "K", "XIRR", this.pct(r, "K"))}
          ${this.cell(r, "M", "Holding", this.pct(r, "M"))}
          ${this.cell(r, "N", "Tenure", esc(this.text(r, "N")))}
          ${this.cell(r, "O", "Live SIP", this.num(r, "O") === null ? "" : fmt.money(this.num(r, "O")))}
          ${this.cell(r, "P", "New SIP", this.num(r, "P") === null ? "" : fmt.money(this.num(r, "P")))}
        </div>
        ${this.cell(r, "T", "Remarks", esc(this.text(r, "T")), "cv-wide cv-note")}
        ${this.cell(r, "U", "Suggestions", esc(this.text(r, "U")), "cv-wide cv-note")}
      </article>`;
    },
    rowsOf: (g) => [...schemeRows.keys()].filter((x) => x >= g.first && x <= g.last).sort((a, b) => a - b),
    cur(r) { return this.num(r, "J") ?? this.num(r, "G") ?? 0; },
    initials: (t) => t.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "•",
    // One platform inside a fund type: its figures, then all its scheme cards.
    platform(e, typeValue) {
      const { g, platform, color } = e;
      const open = openGroups.has(g.id);
      const rows = this.rowsOf(g);
      const value = this.cur(g.total);
      const share = typeValue ? Math.max(0, Math.min(100, (value / typeValue) * 100)) : 0;
      const gain = this.gain(g.total);
      return `<div class="cv-group ${open ? "open" : ""}">
        <div class="cv-ghead" data-r="${g.head}" data-c="2" role="button" aria-expanded="${open}" title="${open ? "Hide" : "Show"} the schemes">
          <span class="cv-caret">${open ? "▾" : "▸"}</span>
          <div class="cv-gname"><i class="cv-plogo cv-c${color % 3}">${esc(this.initials(platform))}</i><div><b>${esc(platform)}</b><span>${rows.length} scheme${rows.length === 1 ? "" : "s"}</span></div></div>
          <div class="cv-hb" title="${share.toFixed(1)}% of this fund type"><i style="width:${share}%"></i></div>
          <div class="cv-gnum"><span>Invested</span><b>${fmt.money(this.num(g.total, "D") ?? 0)}</b></div>
          <div class="cv-gnum"><span>Current</span><b>${fmt.money(value)}</b></div>
          <div class="cv-gnum ${gain < 0 ? "cv-down" : "cv-up"}"><span>Return</span><b>${this.pct(g.total, "L") || "–"}</b></div>
        </div>
        ${open ? `<div class="cv-schemes">${rows.map((r) => this.scheme(r)).join("") || '<p class="cv-empty">No schemes.</p>'}</div>` : ""}
      </div>`;
    },
    // Fund types first (Equity, Hybrid, Debt, Others, then Stocks, PMS…), each with its platforms.
    types() {
      const out = new Map();
      blocks.forEach((b, bi) => {
        if (b.loans) return;
        const [platform, product = ""] = this.text(b.head, "B").split(" · ");
        for (const id of b.folds) {
          const g = groups.find((x) => x.id === id);
          if (!g) continue;
          const parts = id.split("|");
          const mf = parts[1] === "MF";
          const key = mf ? `MF|${parts[2]}` : parts[1];
          if (!out.has(key)) out.set(key, { name: mf ? parts[2] : product || parts[1], kind: mf ? "Mutual funds" : "", entries: [] });
          out.get(key).entries.push({ g, platform, color: bi });
        }
      });
      const order = (k) => { const i = Review.MF_TYPES.indexOf(k.replace(/^MF\|/, "")); return k.startsWith("MF|") && i >= 0 ? i : 100; };
      return [...out.entries()].sort((a, b) => order(a[0]) - order(b[0])).map(([, t]) => t);
    },
    type(t, i) {
      const totals = t.entries.map((e) => e.g.total);
      const inv = totals.reduce((a, r) => a + (this.num(r, "D") ?? 0), 0);
      const cur = totals.reduce((a, r) => a + this.cur(r), 0);
      const sip = totals.reduce((a, r) => a + (this.num(r, "O") ?? 0), 0);
      const w = totals.filter((r) => this.num(r, "K") !== null && this.cur(r));
      const wv = w.reduce((a, r) => a + this.cur(r), 0);
      const xirr = wv ? fmt.pct(w.reduce((a, r) => a + this.num(r, "K") * this.cur(r), 0) / wv) : "";
      const count = t.entries.reduce((a, e) => a + this.rowsOf(e.g).length, 0);
      const np = t.entries.length;
      const key = `type|${t.name}`, open = openCards.has(key);
      return `<section class="cv-block ${open ? "" : "cv-closed"}">
        <header class="cv-head cv-toggle" data-toggle="${esc(key)}" role="button" aria-expanded="${open}" title="${open ? "Hide" : "Show"} the platforms">
          <div class="cv-logo cv-t${i % 6}">${esc(t.name.slice(0, 1).toUpperCase())}</div>
          <div class="cv-title"><h3>${esc(t.name)}</h3><span>${t.kind ? `${t.kind} · ` : ""}${np} platform${np === 1 ? "" : "s"} · ${count} scheme${count === 1 ? "" : "s"}</span></div>
          ${this.statsOf({ inv, cur, sip, xirr, ret: inv ? fmt.pct(((cur - inv) / inv) * 100) : "" })}
          <span class="cv-drop">${open ? "▴" : "▾"}</span>
        </header>
        ${open ? `<div class="cv-groups">${t.entries.map((e) => this.platform(e, cur)).join("")}</div>` : ""}
      </section>`;
    },
    loans(b) {
      return `<section class="cv-block cv-loans"><header class="cv-head"><div class="cv-title"><h3>${esc(this.text(b.head, "B"))}</h3></div></header>
        <div class="cv-loanlist">${b.loans.map((r) => `<div><span>${esc(this.text(r, "B"))}</span><b>${fmt.money(this.num(r, "G") ?? 0)}</b></div>`).join("")}</div></section>`;
    },
    render(host) {
      const scroll = host.scrollTop;
      // Where the money sits: one bar across the fund types.
      const types = this.types();
      const parts = types.map((t) => ({ name: t.name, v: Math.max(0, t.entries.reduce((a, e) => a + this.cur(e.g.total), 0)) }));
      const sum = parts.reduce((a, x) => a + x.v, 0);
      const COLORS = TYPE_COLORS;
      const mix = sum && parts.length > 1 ? `<section class="cv-mix"><h3>Portfolio by fund type</h3>
          <div class="cv-mixbar">${parts.map((x, i) => `<i style="width:${(x.v / sum) * 100}%;background:${COLORS[i % COLORS.length]}" title="${esc(x.name)}"></i>`).join("")}</div>
          <div class="cv-legend">${parts.map((x, i) => `<span style="--dot:${COLORS[i % COLORS.length]}">${esc(x.name)} <b>${fmt.money(x.v)}</b> ${((x.v / sum) * 100).toFixed(1)}%</span>`).join("")}</div>
        </section>` : "";
      host.innerHTML = `<div class="cv" style="zoom:${zoom}">${mix}${types.map((t, i) => this.type(t, i)).join("")
        || '<div class="card empty-state"><h2>No holdings</h2><p>Upload this client\'s portfolio to see it here.</p></div>'}${blocks.filter((b) => b.loans).map((b) => this.loans(b)).join("")}</div>`;
      host.scrollTop = scroll;
    },
  };

  // The other sheets in the dashboard look, as cards built from their cells. Every value carries
  // data-r/data-c, so it stays clickable and editable as in the Excel view.
  let seeded = new Set(); // card pages whose cards have been opened by default once
  const Pages = {
    v: (r, c) => wb.value(sheetName, r, c),
    t(r, c) {
      const v = this.v(r, c);
      if (v === null || v === undefined || v === "") return "";
      const f = SheetView.format(v, wb.xf(wb.sheet(sheetName), r, c).fmt);
      return `${f.left ?? ""}${f.text}`.trim();
    },
    n(r, c) { const v = this.v(r, c); return typeof v === "number" ? v : null; },
    range: (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i),
    // A cell's value that types into the cell when clicked.
    val(r, c, cls = "") {
      const e = isEditable(r, c);
      return `<b class="${cls} ${e ? "cv-edit" : ""} ${isEdited(r, c) ? "xl-edited" : ""}" data-r="${r}" data-c="${c}"${e ? ' title="Click to change"' : ""}>${esc(this.t(r, c)) || "–"}</b>`;
    },
    initials: (t) => t.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "•",
    findRow(c, re, from = 1) {
      const sh = wb.sheet(sheetName);
      for (let r = from; r <= sh.maxRow; r++) if (re.test(this.t(r, c))) return r;
      return null;
    },

    // Cover: the client, the review and the sheet's document details.
    "1"(host) {
      const logo = (wb.drawings["1"] || []).find((d) => d.img);
      const [title, sub = ""] = this.t(8, 4).split("\n");
      const tabs = wb.sheets.filter((s) => !s.hidden && s.name !== "1");
      host.innerHTML = `<div class="cv" style="zoom:${zoom}">
        <section class="cv-cover">
          <div class="cv-cover-main">
            ${logo ? `<div class="cv-cover-logo"><img src="${logo.img}" alt=""></div>` : ""}
            <span class="cv-eyebrow">${esc(title)} ${esc(sub)}</span>
            <h2>${this.val(17, 4)}</h2>
            <p>Review date ${esc(SheetView.format(SheetView.toSerial(new Date(`${edits.reviewDate || data.today}T00:00:00Z`)), "dd mmm yyyy").text)}</p>
          </div>
          <dl class="cv-cover-meta">${[3, 4, 5].map((r) => `<div><dt>${esc(this.t(r, 16))}</dt><dd>${this.val(r, 17)}</dd></div>`).join("")}</dl>
        </section>
        <div class="cv-tiles">${tabs.map((s, i) => `<button type="button" class="cv-tile" data-goto="${esc(s.name)}"><i class="cv-logo cv-t${i % 6}">${i + 1}</i>
          <span><b>${esc(TAB_NAMES[s.name] || s.name.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()))}</b><small>Open this section</small></span><em>›</em></button>`).join("")}</div>
      </div>`;
      host.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => $("xlTabs").querySelector(`[data-sheet="${CSS.escape(b.dataset.goto)}"]`)?.click()));
    },

    // Summary: today's wealth and live SIP, and the two journey charts.
    Summary(host) {
      const charts = (wb.drawings.Summary || []).filter((d) => d.chart);
      const tile = (lr, vr, cls) => `<section class="cv-hero ${cls}"><span>${esc(this.t(lr, 8))}</span><b>${esc(this.t(vr, 8)) || "–"}</b></section>`;
      host.innerHTML = `<div class="cv" style="zoom:${zoom}">
        <div class="cv-two">${tile(5, 11, "cv-hero-a")}${tile(18, 24, "cv-hero-b")}</div>
        <div class="cv-two">${charts.map((d) => `<section class="cv-block cv-chart">${SheetView.chart(wb, d.chart, 640, 330, true)}</section>`).join("")}</div>
      </div>`;
    },

    // ---- Shared pieces for the card pages ----
    str(r, c) { const x = wb.raw(sheetName, r, c); return x && !x.f && typeof x.v === "string" && x.v.trim() ? x.v.trim() : null; },
    filled(r, cols) { return cols.some((c) => { const v = this.v(r, c); return v !== null && v !== undefined && v !== "" && v !== 0; }); },
    stat: (label, value, cls = "") => `<div class="${cls}"><span title="${esc(label)}">${esc(label)}</span><b>${value}</b></div>`,
    // A card that opens with its dropdown. o: {key, logo, logoCls, title, sub, stats, body() (only built when open), dim}.
    drop(o) {
      const open = openCards.has(o.key);
      return `<section class="cv-block ${open ? "" : "cv-closed"} ${o.dim ? "cv-dim" : ""}">
        <header class="cv-head cv-toggle" data-toggle="${esc(o.key)}" role="button" aria-expanded="${open}">
          ${o.logo ? `<div class="cv-logo ${o.logoCls || ""}">${esc(o.logo)}</div>` : ""}
          <div class="cv-title"><h3>${esc(o.title)}</h3>${o.sub ? `<span>${o.sub}</span>` : ""}</div>
          ${o.stats ? `<div class="cv-stats cv-stats-auto">${o.stats}</div>` : ""}
          <span class="cv-drop">${open ? "▴" : "▾"}</span>
        </header>
        ${open ? `<div class="cv-inner">${o.body()}</div>` : ""}
      </section>`;
    },
    // A clean table of cells: rows [{r, label, cls}], cols [{c, label}]; values type into their cells.
    table(rows, cols, opts = {}) {
      return `<div class="cv-tablewrap"><table class="cv-table ${opts.cls || ""}"><thead><tr>${opts.noLabel ? "" : `<th>${esc(opts.corner || "")}</th>`}${cols.map((x) => `<th>${esc(x.label)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((x) => `<tr class="${x.cls || ""}">${opts.noLabel ? "" : `<th>${esc(x.label)}</th>`}${cols.map((k) => `<td class="${typeof this.v(x.r, k.c) === "number" || !this.str(x.r, k.c) ? "cv-num" : ""}">${this.val(x.r, k.c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    },
    seed(sheet, keys) {
      if (seeded.has(sheet)) return;
      seeded.add(sheet);
      for (const k of keys) openCards.add(k);
    },
    page(host, html) {
      host.innerHTML = `<div class="cv" style="zoom:${zoom}">${html}</div>`;
    },

    // Portfolio Journey: like DETAILED PORTFOLIO. A "wealth by year" card, then a card per section
    // (mutual funds, stocks, other savings, passive income) that opens to its platforms or items;
    // each opens to its rows by year, which can be typed into.
    "Portfolio Journey"(host) {
      const sh = wb.sheet(sheetName);
      const start = this.n(5, 6) || 0, rd = this.n(2, 7);
      const year = rd ? SheetView.fromSerial(rd).getUTCFullYear() : start;
      const yc = 6 + Math.max(0, year - start);
      let last = yc;
      for (const x of sh.cells.values()) if (x.r > 5 && x.c > last && typeof x.v === "number" && !x.f && x.v) last = x.c;
      const years = this.range(6, last).map((c) => ({ c, label: this.t(5, c) }));
      const ycols = years.map((y) => y.c);
      const label = (r) => this.str(r, 5) || this.str(r, 4) || this.t(r, 4) || this.t(r, 2);
      const money = (r, c = yc) => fmt.money(this.n(r, c) ?? 0);
      const growth = (r) => {
        const a = this.n(r, yc - 1), b = this.n(r, yc);
        if (yc <= 6 || !a || b === null) return "";
        const g = ((b - a) / Math.abs(a)) * 100;
        return `<span class="cv-pill ${g < 0 ? "cv-down" : "cv-up"}">${g >= 0 ? "▲" : "▼"} ${Math.abs(g).toFixed(1)}%</span>`;
      };
      // Bar chart beside an item's table: its rows in the review year, and its total year by year
      // when there is more than one year. Redrawn with the page, so typed values show at once.
      const barChart = (rows, head) => {
        const isSip = (r) => /SIP|Monthly|Contribution/i.test(label(r));
        const pick = (list) => list.map((r) => ({ label: label(r), v: this.n(r, yc) || 0 })).filter((x) => x.v > 0);
        const parts = pick(rows.filter((r) => !isSip(r))), sips = pick(rows.filter((r) => isSip(r) && !/Live SIP$|Portfolio/i.test(label(r))));
        const byYear = years.map((y) => ({ label: y.label, v: this.n(head, y.c) || 0, on: y.c === yc }));
        const showYears = byYear.filter((x) => x.v > 0).length > 1;
        if (!parts.length && !sips.length && !showYears) return `<div class="cv-bars cv-bars-empty">Bar chart appears here once values are added.</div>`;
        const hbars = (list) => {
          const max = Math.max(...list.map((x) => x.v));
          return list.map((x, i) => `<div class="cv-hb" title="${esc(x.label)}: ${fmt.money(x.v)}"><span class="cv-hb-l">${esc(x.label)}</span>
            <span class="cv-hb-track"><i style="width:${Math.max((x.v / max) * 100, 1.5).toFixed(1)}%;--c:var(--bar${i % 6})"></i></span><b>${fmt.money(x.v)}</b></div>`).join("");
        };
        const vbars = (list) => {
          const max = Math.max(...list.map((x) => x.v)) || 1;
          return `<div class="cv-vbars">${list.map((x) => `<div class="cv-vbar${x.on ? " on" : ""}" title="${esc(x.label)}: ${fmt.money(x.v)}">
            <b>${x.v ? fmt.money(x.v) : ""}</b><span class="cv-vbar-track"><i style="height:${x.v ? Math.max((x.v / max) * 100, 2).toFixed(1) : 0}%"></i></span><small>${esc(x.label)}</small></div>`).join("")}</div>`;
        };
        return `<div class="cv-bars">
          ${parts.length ? `<div class="cv-bars-h">Value by fund type · ${esc(String(year))}</div>${hbars(parts)}` : ""}
          ${sips.length ? `<div class="cv-bars-h cv-bars-gap">Monthly SIP · ${esc(String(year))}</div>${hbars(sips)}` : ""}
          ${showYears ? `<div class="cv-bars-h cv-bars-gap">Total by year</div>${vbars(byYear)}` : ""}
        </div>`;
      };
      const find = (re, from = 6) => this.findRow(2, re, from);
      const stocks = find(/^STOCKS$/i), other = find(/^OTHER SAVINGS/i), grand = find(/^Grand Total Portfolio Value/i), passive = find(/^Existing Passive Income/i);
      const SECTION_ROW = /^(Total\s+\S|Grand Total|Redemption|Reason|Withdrawal|Remarks)/i;
      // Items of a section: a new one starts at each name in column B.
      const parse = (a, b) => {
        const items = [], extra = [];
        let cur = null;
        for (let r = a; r <= b; r++) {
          const name = this.str(r, 2);
          if (name && SECTION_ROW.test(name)) { cur = null; extra.push(r); continue; }
          if (name) { cur = { name, rows: [] }; items.push(cur); }
          if (cur && label(r)) cur.rows.push(r);
        }
        return { items, extra };
      };
      const item = (sec, it, i) => {
        const key = `pj|${sec}|${it.name}`, open = openCards.has(key);
        const total = it.rows.find((r) => this.str(r, 4) && !this.str(r, 5) && it.rows.length > 2 && /Portfolio Value$/i.test(this.str(r, 4)));
        const head = it.head ?? total ?? it.rows[0];
        const sip = it.sip ?? it.rows.find((r) => r !== head && /SIP|Monthly|Contribution/i.test(label(r)) && (!total || !this.str(r, 5)));
        const any = it.rows.some((r) => this.filled(r, ycols));
        const chips = years.map((y) => `<span class="cv-chip ${y.c === yc ? "on" : ""}"><small>${esc(y.label)}</small>${money(head, y.c)}</span>`).join("");
        return `<div class="cv-group ${open ? "open" : ""} ${any ? "" : "cv-dim"}">
          <div class="cv-ghead cv-jhead" data-toggle="${esc(key)}" role="button" aria-expanded="${open}">
            <span class="cv-caret">${open ? "▾" : "▸"}</span>
            <div class="cv-gname"><i class="cv-plogo cv-c${i % 3}">${esc(this.initials(it.name))}</i><div><b>${esc(it.name)}</b><span>${any ? esc(label(head)) : "No values yet · click to add"}</span></div></div>
            <div class="cv-chips">${chips}</div>
            <div class="cv-gnum"><span>${esc(String(year))}</span><b>${money(head)}</b>${growth(head)}</div>
            ${sip ? `<div class="cv-gnum"><span>${/SIP/i.test(label(sip)) ? "Live SIP" : "Monthly"}</span><b>${money(sip)}</b></div>` : "<div></div>"}
          </div>
          ${open ? `<div class="cv-schemes cv-one"><div class="cv-jsplit">${this.table(it.rows.map((r) => ({ r, label: label(r), cls: r === total ? "cv-trow" : "" })), years, { corner: "By year" })}
            ${barChart(it.rows.filter((r) => r !== total && r !== head), head)}</div></div>` : ""}
        </div>`;
      };
      const sections = [];
      const sec = (key, title, logo, a, b, sub) => {
        if (!a || b < a) return;
        const { items, extra } = parse(a, b);
        const stats = extra.filter((r) => /^(Total|Grand Total)/i.test(this.str(r, 2)) && this.n(r, yc) !== null);
        const notes = extra.filter((r) => !stats.includes(r));
        // The TOTAL block of mutual funds: the totals by fund type, across platforms.
        for (const it of items) if (/^TOTAL$/i.test(it.name)) { it.name = "All platforms"; it.head = stats[0]; it.sip = stats[1]; }
        sections.push(this.drop({ key: `pj|${key}`, logo, logoCls: `cv-t${sections.length % 6}`, title,
          sub: `${sub} · ${items.length} ${key === "passive" ? "source" : "item"}${items.length === 1 ? "" : "s"}`,
          stats: [0, 1].map((k) => (stats[k] ? this.stat(this.str(stats[k], 2).replace(/\s*\(.*\)$/, "").replace(/^Grand Total\s*:\s*/i, "Total "), money(stats[k])) : "<div></div>")).join(""),
          body: () => `<div class="cv-groups">${items.map((it, i) => item(key, it, i)).join("")}</div>
            ${notes.length ? `<div class="cv-notes">${this.table(notes.map((r) => ({ r, label: this.str(r, 2) })), years, { corner: "Notes", cls: "cv-table-notes" })}</div>` : ""}` }));
      };
      sec("mf", "Mutual funds", "M", 6, (stocks || sh.maxRow + 1) - 1, "By platform");
      sec("stocks", "Stocks & PMS", "S", stocks && stocks + 1, (other || sh.maxRow + 1) - 1, "By platform");
      sec("other", "Other savings & investments", "O", other && other + 1, (grand || passive || sh.maxRow + 1) - 1, "EPF, PPF, FD, NPS, gold and more");
      sec("passive", "Passive income", "P", passive && passive + 1, sh.maxRow, "Existing monthly provision");
      // Wealth by year, from the grand total rows.
      const gRows = grand ? this.range(grand, (passive || grand + 3) - 1).filter((r) => this.str(r, 2)) : [];
      const tiles = gRows.length ? `<section class="cv-block cv-years"><header class="cv-head"><div class="cv-logo cv-t0">₹</div><div class="cv-title"><h3>Wealth by year</h3><span>All assets, up to the review year</span></div></header>
        <div class="cv-yeargrid">${years.map((y, i) => {
          const v = this.n(gRows[0], y.c), p = i ? this.n(gRows[0], y.c - 1) : null;
          const g = p ? ((v - p) / Math.abs(p)) * 100 : null;
          return `<div class="cv-year ${y.c === yc ? "on" : ""}"><span>${esc(y.label)}</span><b>${fmt.money(v ?? 0)}</b>
            ${g !== null && Number.isFinite(g) ? `<em class="${g < 0 ? "cv-down" : "cv-up"}">${g >= 0 ? "▲" : "▼"} ${Math.abs(g).toFixed(1)}% vs ${esc(years[i - 1].label)}</em>` : "<em>&nbsp;</em>"}
            ${gRows.slice(1).map((r) => `<small>${esc(this.str(r, 2).replace(/^(Grand )?Total /i, "").replace(/\s*\(.*\)$/, ""))} <i>${fmt.money(this.n(r, y.c) ?? 0)}</i></small>`).join("")}</div>`;
        }).join("")}</div></section>` : "";
      this.page(host, tiles + sections.join(""));
    },

    // Summary Portfolio: a "review history" card (wealth, invested, gain and SIP on each review
    // date), then a card per platform that opens to its figures by date.
    "SUMMARY PORTFOLIO"(host) {
      const sh = wb.sheet(sheetName);
      const dates = this.range(3, sh.maxRow).filter((r) => this.v(r, 1) !== null && this.v(r, 1) !== "");
      const groups = sh.merges.filter((m) => m.r1 === 1 && this.t(1, m.c1)).sort((a, b) => a.c1 - b.c1)
        .map((m) => ({ title: this.t(1, m.c1), cols: this.range(m.c1, m.c2).filter((c) => this.t(2, c)) }));
      const head = (c) => this.t(2, c);
      const colOf = (g, re) => [...g.cols].reverse().find((c) => re.test(head(c)));
      const latest = dates[dates.length - 1];
      const grandG = groups.find((g) => /GRAND TOTAL/i.test(g.title));
      const inv = grandG && colOf(grandG, /INVESTED/i), wealth = grandG && colOf(grandG, /WEALTH|VALUE/i), gain = grandG && colOf(grandG, /GAIN/i);
      const sipC = this.range(1, sh.maxCol).find((c) => /Monthly Avg Financial Savings|^TOTAL LIVE SIP$/i.test(head(c)));
      const hist = dates.length ? `<section class="cv-block cv-years"><header class="cv-head"><div class="cv-logo cv-t0">₹</div><div class="cv-title"><h3>Review history</h3><span>${dates.length} review date${dates.length === 1 ? "" : "s"}</span></div></header>
        <div class="cv-yeargrid">${dates.map((r, i) => {
          const v = wealth ? this.n(r, wealth) : null, p = i && wealth ? this.n(dates[i - 1], wealth) : null;
          const g = p ? ((v - p) / Math.abs(p)) * 100 : null;
          return `<div class="cv-year ${r === latest ? "on" : ""}"><span>${esc(this.t(r, 1))}</span><b>${fmt.money(v ?? 0)}</b>
            ${g !== null && Number.isFinite(g) ? `<em class="${g < 0 ? "cv-down" : "cv-up"}">${g >= 0 ? "▲" : "▼"} ${Math.abs(g).toFixed(1)}% since last review</em>` : "<em>&nbsp;</em>"}
            ${inv ? `<small>Invested <i>${fmt.money(this.n(r, inv) ?? 0)}</i></small>` : ""}
            ${gain ? `<small>Gain <i>${fmt.money(this.n(r, gain) ?? 0)}</i></small>` : ""}
            ${sipC ? `<small>Live SIP <i>${fmt.money(this.n(r, sipC) ?? 0)}</i></small>` : ""}</div>`;
        }).join("")}</div></section>` : "";
      const cards = groups.map((g, i) => {
        const any = dates.some((r) => this.filled(r, g.cols));
        const tot = colOf(g, /WEALTH|PORTFOLIO VALUE/i) || colOf(g, /TOTAL/i), sip = colOf(g, /SIP/i);
        return this.drop({ key: `sp|${g.title}`, logo: this.initials(g.title.replace(/\b(TOTAL|PORTFOLIO)\b/gi, "").trim() || g.title), logoCls: `cv-t${i % 6}`,
          title: g.title.replace(/\b\w+/g, (w) => (w.length > 3 || !/^[A-Z]+$/.test(w) ? w[0] + w.slice(1).toLowerCase() : w)), dim: !any,
          sub: any ? `${g.cols.length} column${g.cols.length === 1 ? "" : "s"} · latest ${esc(this.t(latest, 1))}` : "No figures yet · open to add",
          stats: any ? (tot ? this.stat(head(tot).replace(/^TOTAL\s*/i, "") || "Total", fmt.money(this.n(latest, tot) ?? 0)) : "<div></div>") + (sip && sip !== tot ? this.stat("Live SIP", fmt.money(this.n(latest, sip) ?? 0)) : "<div></div>") : "",
          body: () => this.table(dates.map((r) => ({ r, label: this.t(r, 1) })), g.cols.map((c) => ({ c, label: head(c) })), { corner: "Review date" }) });
      });
      this.page(host, hist + cards.join(""));
    },

    // Freedom Blueprint: a card per section. Personal details as a form, the levels as cards
    // with progress, the asset table as a clean table, and the charts on light cards.
    "Freedom Blueprint"(host) {
      const sh = wb.sheet(sheetName);
      const COLS = this.range(2, 16);
      const marks = [];
      for (let r = 1; r <= sh.maxRow; r++) {
        const t = this.t(r, 2);
        if (/^Section [A-Z]\b|^CONCLUSION$/i.test(t)) marks.push({ r, title: t });
        else if (/^In How Many Years/i.test(t)) marks.push({ r, title: t, question: true });
      }
      const keys = marks.map((m) => `bp|${m.title}`);
      this.seed(sheetName, keys);
      const strCells = (r) => COLS.filter((c) => this.str(r, c));
      const charts = (a, b) => (wb.drawings[sheetName] || []).filter((d) => d.chart && d.from && d.from.r + 1 >= a && d.from.r + 1 <= b);
      // Tables in a block of rows: a heading row (3+ text cells), maybe a second heading row, then data rows.
      const tables = (a, b) => {
        const out = [];
        let r = a;
        while (r <= b) {
          const hs = strCells(r);
          if (hs.length < 3 || hs.some((c) => wb.raw(sheetName, r + 1, c)?.f)) { r++; continue; }
          const cols = hs.map((c) => ({ c, label: this.str(r, c).replace(/\s+/g, " ") }));
          let d = r + 1;
          const sub = strCells(d);
          if (sub.length && sub.every((c) => hs.includes(c)) && !COLS.some((c) => typeof this.v(d, c) === "number")) {
            for (const x of cols) if (this.str(d, x.c)) x.label += ` · ${this.str(d, x.c).replace(/\s+/g, " ")}`;
            d++;
          }
          const rows = [];
          let gap = 0;
          for (; d <= b && gap < 2; d++) {
            if (this.filled(d, hs) || hs.some((c) => wb.raw(sheetName, d, c))) { rows.push(d); gap = 0; } else if (rows.length) gap++;
          }
          out.push({ head: r, cols, rows: rows.filter((x) => this.filled(x, hs)) });
          r = d;
        }
        return out;
      };
      const levelCards = (t) => {
        const [lv, stage, ...rest] = t.cols;
        const req = rest.find((x) => /Required\s+Wealth/i.test(x.label)), exp = rest.find((x) => /^Expected Wealth/i.test(x.label));
        return `<div class="cv-levels">${t.rows.map((r) => {
          const fill = wb.xf(sh, r, lv.c).fill;
          const p = req && exp && this.n(r, req.c) ? Math.max(0, Math.min(100, ((this.n(r, exp.c) || 0) / this.n(r, req.c)) * 100)) : null;
          return `<article class="cv-level" style="--lv:#${fill || "E6ECF6"}">
            <div class="cv-lvhead"><span class="cv-lvchip">${esc(this.t(r, lv.c))}</span><h4>${esc(this.t(r, stage.c))}</h4></div>
            ${p !== null ? `<div class="cv-prog" title="${p.toFixed(0)}% of the target"><i style="width:${p}%"></i></div><small class="cv-progl">${p >= 100 ? "Reached" : `${p.toFixed(0)}% of the target`}</small>` : ""}
            <div class="cv-lvfields">${rest.map((x) => `<div class="cv-f ${x.label.length > 40 ? "cv-wide2" : ""}"><span>${esc(x.label)}</span>${this.val(r, x.c)}</div>`).join("")}</div>
          </article>`;
        }).join("")}</div>`;
      };
      const body = (m, a, b) => {
        let html = "";
        if (/Personal/i.test(m.title)) {
          const fields = [];
          for (let r = a; r <= b; r++) {
            const ls = strCells(r).filter((c) => !/^Date\s*:?$/i.test(this.str(r, c)));
            if (ls.length >= 2) { for (const c of ls) fields.push({ label: this.str(r, c), r: r + 1, c }); r++; }
          }
          const dc = COLS.find((c) => /^Date\s*:?$/i.test(this.str(m.r, c) || ""));
          return `<div class="cv-form">${fields.map((f) => `<div class="cv-f"><span>${esc(f.label)}</span>${this.val(f.r, f.c, "cv-input")}</div>`).join("")}
            ${dc ? `<div class="cv-f"><span>Review date</span>${this.val(m.r, COLS.find((c) => c > dc && this.v(m.r, c) !== null) || dc + 1, "cv-input")}</div>` : ""}</div>`;
        }
        const ts = tables(a, b);
        const before = ts.length ? ts[0].head : b + 1;
        const notes = this.range(a, before - 1).flatMap((r) => strCells(r).map((c) => this.str(r, c)));
        if (notes.length) html += `<p class="cv-lead">${notes.map(esc).join(" ")}</p>`;
        for (const t of ts) {
          const isLevels = t.rows.length && t.rows.every((r) => /Level\s*\d/i.test(this.t(r, t.cols[0].c)));
          html += isLevels ? levelCards(t)
            : this.table(t.rows.map((r) => ({ r, label: "", cls: /^total$/i.test(this.t(r, t.cols[1]?.c) || this.t(r, t.cols[0].c)) ? "cv-trow" : "" })), t.cols, { noLabel: true, cls: "cv-table-wide" });
        }
        const cs = charts(a, b);
        if (cs.length) html += `<div class="cv-two">${cs.map((d) => `<section class="cv-block cv-chart">${SheetView.chart(wb, d.chart, 640, 330, true)}</section>`).join("")}</div>`;
        if (!ts.length) {
          const text = this.range(a, b).flatMap((r) => COLS.filter((c) => this.str(r, c)).map((c) => ({ r, c })));
          html += text.map((x) => `<p class="cv-text">${this.val(x.r, x.c)}</p>`).join("");
        }
        return html;
      };
      const cards = marks.map((m, i) => {
        const end = (marks[i + 1]?.r || sh.maxRow + 1) - 1;
        if (m.question) {
          const vc = COLS.find((c) => c > 2 && this.v(m.r, c) !== null && this.v(m.r, c) !== "");
          return `<section class="cv-question"><span>${esc(m.title)}</span><div>${this.val(m.r, vc || 15, "cv-qval")}<small>years</small></div></section>`;
        }
        const [letter, name] = m.title.includes(":") ? m.title.split(/\s*:\s*/) : ["", m.title];
        return this.drop({ key: `bp|${m.title}`, logo: (letter.match(/Section ([A-Z])/i)?.[1] || name[0]).toUpperCase(), logoCls: `cv-t${i % 6}`,
          title: name.replace(/\s+$/, ""), sub: letter || "", body: () => body(m, m.r + 1, end) });
      });
      this.page(host, cards.join(""));
    },
  };

  // Totals with the changes, for the header.
  function kpis() {
    const el = $("xlKpis");
    if (!el) return;
    const f = Review.prepare(data, clean(edits)).current;
    const gain = f.value - f.invested;
    const chip = (label, v, cls = "") => `<div class="xl-kpi ${cls}"><span>${label}</span><b>${v}</b></div>`;
    // XIRR as the review sheet works it out (value-weighted, on DETAILED PORTFOLIO's total row).
    const xirr = wb && grandRow ? wb.value(DETAILED, grandRow, 11) : null;
    el.innerHTML = chip("Invested", fmt.money(f.invested), "k-inv") + chip("Current value", fmt.money(f.value), "k-cur")
      + chip("Gain", fmt.money(gain), gain < 0 ? "xl-down" : "xl-up")
      + chip("Abs. return", fmt.pct(f.invested ? (gain / f.invested) * 100 : null), "k-ret")
      + chip("XIRR", typeof xirr === "number" ? fmt.pct(xirr) : "–", "k-xirr")
      + chip("Live SIP", fmt.money(f.sip), "k-sip");
  }

  // ---- Which cells can change -----------------------------------------------------------------
  const field = (r, c) => (sheetName === DETAILED && schemeRows.has(r) ? Review.DETAIL_FIELDS[SheetView.colName(c)] : null);
  function isEditable(r, c) {
    if (sheetName === DETAILED) return !!field(r, c);
    const x = wb.raw(sheetName, r, c);
    return !x || !x.f;
  }
  function isEdited(r, c) {
    if (sheetName === DETAILED) {
      const f = field(r, c);
      return !!f && edits.schemes?.[schemeRows.get(r)]?.[f] !== undefined;
    }
    return edits.cells?.[sheetName]?.[SheetView.refOf(r, c)] !== undefined;
  }

  // ---- Selection and typing -------------------------------------------------------------------
  function select(r, c) {
    sel = { r, c };
    showSelection();
  }

  function rawText(r, c) {
    const x = wb.raw(sheetName, r, c);
    if (!x) return "";
    if (x.f) return `=${x.f}`;
    if (x.v === null || x.v === undefined) return "";
    if (typeof x.v === "number") {
      const st = wb.xf(wb.sheet(sheetName), r, c);
      if (/[dy]/i.test(st.fmt.replace(/"[^"]*"|\[[^\]]*\]/g, "")) && !/[0#]/.test(st.fmt)) return SheetView.format(x.v, "dd-mm-yyyy").text;
      if (/%/.test(st.fmt)) return `${Math.round(x.v * 1e6) / 1e4}%`;
      return String(Math.round(x.v * 1e4) / 1e4);
    }
    return typeof x.v === "object" ? x.v.e || "" : String(x.v);
  }

  function showSelection() {
    const host = $("xlHost");
    if (!host) return;
    host.querySelectorAll(".xl-sel").forEach((x) => x.classList.remove("xl-sel"));
    if (!sel) { $("xlName").textContent = ""; $("xlFx").value = ""; $("xlFx").readOnly = true; return; }
    const td = host.querySelector(`[data-r="${sel.r}"][data-c="${sel.c}"]`);
    if (td) td.classList.add("xl-sel");
    $("xlName").textContent = SheetView.refOf(sel.r, sel.c);
    $("xlFx").value = rawText(sel.r, sel.c);
    $("xlFx").readOnly = !isEditable(sel.r, sel.c);
    $("xlFx").title = isEditable(sel.r, sel.c) ? "" : readOnlyReason(sel.r, sel.c);
  }

  function readOnlyReason(r) {
    if (sheetName === DETAILED) return schemeRows.has(r) ? "This column is worked out from the others." : "Totals and headings are worked out from the schemes.";
    return "This cell is a formula and is worked out from other cells.";
  }

  function move(dr, dc) {
    if (!sel) return;
    const r = Math.max(1, sel.r + dr), c = Math.max(1, sel.c + dc);
    // Skip hidden rows and columns.
    const host = $("xlHost");
    let rr = r, cc = c;
    for (let i = 0; i < 50 && !host.querySelector(`[data-r="${rr}"][data-c="${cc}"]`); i++) { rr += dr; cc += dc; if (rr < 1 || cc < 1) return; }
    if (!host.querySelector(`[data-r="${rr}"][data-c="${cc}"]`)) return;
    select(rr, cc);
    host.querySelector(".xl-sel")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function onKey(e) {
    if (editor || !sel) return;
    const k = e.key;
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, e.shiftKey ? -1 : 1], Enter: [1, 0] };
    if (k === "F2") { e.preventDefault(); openEditor(); return; }
    if (arrows[k]) { e.preventDefault(); move(...arrows[k]); return; }
    if (k === "Delete" || k === "Backspace") { e.preventDefault(); commit(sel.r, sel.c, ""); return; }
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); openEditor(k); }
  }

  function openEditor(initial) {
    if (!sel) return;
    if (!isEditable(sel.r, sel.c)) { setStatus(readOnlyReason(sel.r, sel.c), "warn"); return; }
    const td = $("xlHost").querySelector(`[data-r="${sel.r}"][data-c="${sel.c}"]`);
    if (!td) return;
    const rect = td.getBoundingClientRect();
    closeEditor(false);
    const { r, c } = sel;
    const input = document.createElement("input");
    input.className = "xl-editor";
    input.value = initial !== undefined ? initial : rawText(r, c);
    Object.assign(input.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${Math.max(rect.width, 120)}px`, height: `${Math.max(rect.height, 22)}px` });
    document.body.appendChild(input);
    editor = { input, r, c };
    input.focus();
    if (initial === undefined) input.select();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); closeEditor(true, { r: 1, c: 0 }); }
      else if (e.key === "Tab") { e.preventDefault(); closeEditor(true, { r: 0, c: e.shiftKey ? -1 : 1 }); }
      else if (e.key === "Escape") { e.preventDefault(); closeEditor(false); }
    });
    input.addEventListener("blur", () => closeEditor(true));
  }

  function closeEditor(keep, step) {
    if (!editor) return;
    const { input, r, c } = editor;
    editor = null;
    input.remove();
    $("xlHost")?.focus({ preventScroll: true });
    if (keep && input.value !== rawText(r, c)) commit(r, c, input.value, step);
    else if (step) move(step.r, step.c);
  }

  // What the reviewer typed, as a number, date serial or text.
  function parseInput(text, r, c) {
    const t = String(text).trim();
    if (t === "") return "";
    if (t.startsWith("=")) return { error: "Formulas can't be typed here; type the value instead." };
    const n = t.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "");
    if (/^-?\d*\.?\d+%$/.test(n)) return Number(n.slice(0, -1)) / 100;
    if (/^-?\d*\.?\d+$/.test(n)) return Number(n);
    const st = wb.xf(wb.sheet(sheetName), r, c);
    const d = /^(\d{1,2})[-/. ](\d{1,2}|[A-Za-z]{3,})[-/. ](\d{2,4})$/.exec(t) || null;
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    if (iso) return SheetView.toSerial(new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3])));
    if (d && (/[dmy]/i.test(st.fmt) || /[A-Za-z]/.test(d[2]))) {
      const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      const m = /^\d+$/.test(d[2]) ? Number(d[2]) : months.indexOf(d[2].slice(0, 3).toLowerCase()) + 1;
      const y = d[3].length === 2 ? 2000 + Number(d[3]) : Number(d[3]);
      if (m >= 1 && m <= 12) return SheetView.toSerial(new Date(Date.UTC(y, m - 1, Number(d[1]))));
    }
    return t;
  }

  async function commit(r, c, text, step) {
    if (!isEditable(r, c)) { setStatus(readOnlyReason(r, c), "warn"); return; }
    const v = parseInput(text, r, c);
    if (v && typeof v === "object") { setStatus(v.error, "warn"); return; }
    if (sheetName === DETAILED) {
      const f = field(r, c), k = schemeRows.get(r);
      const s = ((edits.schemes ||= {})[k] ||= {});
      if (v === "") delete s[f];
      else if (NUMBER_FIELDS.has(f)) {
        if (typeof v !== "number") { setStatus("Type a number in this column.", "warn"); return; }
        s[f] = f === "xirr" && /%/.test(text) ? v * 100 : v;
      } else s[f] = String(typeof v === "number" ? text.trim() : v);
      if (!Object.keys(s).length) delete edits.schemes[k];
    } else {
      ((edits.cells ||= {})[sheetName] ||= {})[SheetView.refOf(r, c)] = v;
    }
    if (step) move(step.r, step.c);
    changed();
  }

  function changed() {
    scheduleSave();
    rebuild();
  }

  // ---- Right-click menu -------------------------------------------------------------------------
  function hideMenu() { const m = $("xlMenu"); if (m) m.hidden = true; }

  function openMenu(e, items) {
    const m = $("xlMenu");
    if (!items.length) return;
    m.innerHTML = items.map((it, i) => (it === "-" ? '<hr>' : it.head ? `<div class="xl-mh">${esc(it.head)}</div>`
      : `<button type="button" data-i="${i}" ${it.on ? 'class="on"' : ""}>${esc(it.label)}</button>`)).join("");
    m.hidden = false;
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = `${Math.min(e.clientX, innerWidth - w - 8)}px`;
    m.style.top = `${Math.min(e.clientY, innerHeight - h - 8)}px`;
    m.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => { hideMenu(); items[Number(b.dataset.i)].run(); }));
  }

  function cellMenu(e) {
    const { r, c } = sel;
    const items = [];
    if (isEditable(r, c)) items.push({ label: "Change this cell…", run: () => openEditor() });
    if (isEdited(r, c)) {
      items.push({ label: "Undo my change to this cell", run: () => {
        if (sheetName === DETAILED) { const s = edits.schemes[schemeRows.get(r)]; delete s[field(r, c)]; if (!Object.keys(s).length) delete edits.schemes[schemeRows.get(r)]; }
        else { delete edits.cells[sheetName][SheetView.refOf(r, c)]; }
        changed();
      } });
    }
    if (sheetName === DETAILED && schemeRows.has(r)) {
      const k = schemeRows.get(r);
      const s = edits.schemes?.[k] || {};
      if (k.split("|")[1] === "MF") {
        items.push("-", { head: `Fund type of ${names.get(k) || "this scheme"}` });
        for (const t of Review.MF_TYPES) {
          items.push({ label: t, on: s.type === t, run: () => { const x = ((edits.schemes ||= {})[k] ||= {}); x.type = t; changed(); } });
        }
        if (s.type) items.push({ label: "As uploaded", run: () => { delete edits.schemes[k].type; if (!Object.keys(edits.schemes[k]).length) delete edits.schemes[k]; changed(); } });
      }
      items.push("-", { label: "Leave this scheme out of the report", run: () => { ((edits.schemes ||= {})[k] ||= {}).excluded = true; changed(); } });
      if (Object.keys(s).length) items.push({ label: "Undo all changes to this scheme", run: () => { delete edits.schemes[k]; changed(); } });
    }
    if (!items.length) items.push({ head: readOnlyReason(r, c) });
    openMenu(e, items);
  }

  const leftOutKeys = () => Object.entries(edits.schemes || {}).filter(([, s]) => s.excluded).map(([k]) => k);
  function leftOut() {
    const b = $("xlOut");
    const ks = leftOutKeys();
    b.hidden = !ks.length;
    b.textContent = `${ks.length} scheme${ks.length === 1 ? "" : "s"} left out ▾`;
  }
  function leftOutMenu(e) {
    const items = [{ head: "Bring a scheme back into the report" }];
    for (const k of leftOutKeys()) items.push({ label: names.get(k) || k, run: () => { delete edits.schemes[k].excluded; if (!Object.keys(edits.schemes[k]).length) delete edits.schemes[k]; changed(); } });
    openMenu(e, items);
  }

  // ---- Export and reset -------------------------------------------------------------------------
  async function exportNow() {
    const b = $("xlExport");
    b.disabled = true;
    b.textContent = "Preparing…";
    try {
      await flush();
      const out = await Review.exportFile(data, clean(edits));
      await rrKeep(data, clean(edits), out);
      setStatus("Exported and kept under Previous reviews", "ok");
    } catch (err) {
      alert(`Could not create the review report: ${err.message}`);
    } finally {
      b.disabled = false;
      b.textContent = "Export Excel";
    }
  }

  async function reset() {
    if (!confirm(`Remove every change made to ${data.clientName}'s review sheet? It goes back to the uploaded figures.`)) return;
    clearTimeout(saveTimer);
    dirty = false;
    try {
      await rrResetEdits(data.clientKey);
    } catch (e) { return alert(`Could not reset: ${e.message}`); }
    edits = {};
    $("xlDate").value = data.today;
    setStatus("Changes removed", "ok");
    await rebuild();
  }

  // Leaving the page (another route) saves what is pending.
  function leave() {
    document.body.classList.remove("xl-mode");
    closeEditor(true);
    hideMenu();
    if (!active) return;
    active = false;
    flush();
  }
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#xlMenu")) hideMenu(); });
  window.addEventListener("beforeunload", (e) => { if (dirty) { save().catch(() => {}); e.preventDefault(); } });

  return { show, leave, flush };
})();

/* ===== BOSS: where the review's data, changes and exports live ===== */
function rrHost() {
  let el = document.getElementById("rrOverlay");
  if (!el) { el = document.createElement("div"); el.id = "rrOverlay"; document.body.appendChild(el); }
  el.hidden = false;
  return el;
}
function rrCss() {
  if (document.getElementById("rrCss")) return;
  const l = Object.assign(document.createElement("link"), { id: "rrCss", rel: "stylesheet", href: "/review/review-report.css" });
  document.head.appendChild(l);
}
let rrZip = null;
function rrJsZip() {
  if (typeof JSZip !== "undefined") return Promise.resolve();
  if (!rrZip) rrZip = new Promise((ok, bad) => {
    const s = Object.assign(document.createElement("script"), { src: "/lib/jszip/jszip.min.js" });
    s.onload = () => ok(); s.onerror = () => { rrZip = null; bad(new Error("The spreadsheet reader could not be loaded.")); };
    document.head.appendChild(s);
  });
  return rrZip;
}
const rrNum = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const rrLiveSip = (x, today) => !(x.endDate && /^\d{4}-\d{2}-\d{2}$/.test(x.endDate) && x.endDate < today);

/* What the original's GET /api/review returned, from BOSS: every upload
   that ever held this client's data (all versions), with the client's
   holdings and SIPs in each. Lines the old platform import left are
   included as investor totals, so a client with only those still has a
   review. A report's sleeves (Equity, Debt...) become one total each. */
async function rrLoad(clientId) {
  const c = (DB.clients || []).find((x) => x.id === clientId && !x.deletedAt);
  if (!c) throw new Error("Client not found.");
  const today = typeof maToday === "function" ? maToday() : new Date().toISOString().slice(0, 10);
  const holdings = [], sips = [], uploads = new Map();
  const name = c.cmsName || "Client";
  const cid = c.pan || clientCode(c);
  const sleeveType = (s) => { const b = typeof MD_SLEEVE_BUCKET !== "undefined" ? MD_SLEEVE_BUCKET[s] : ""; return ["Equity", "Debt", "Hybrid"].includes(b) ? b : "Others"; };
  const pushHolding = (base, r) => {
    const sl = r.sleeves && typeof r.sleeves === "object" ? Object.entries(r.sleeves).filter(([, v]) => rrNum(v && v.current)) : [];
    if (r.level === "summary" && sl.length && base.product === "MF") {
      let covered = 0;
      for (const [s, v] of sl) {
        covered += rrNum(v.current) || 0;
        holdings.push({ ...base, category: s, security_name: `${s} (investor total)`, invested: rrNum(v.invested), current_value: rrNum(v.current),
          xirr: rrNum(v.xirr), return_pct: null, level: "summary", _type: sleeveType(s) });
      }
      const rest = (rrNum(r.current_value) || 0) - covered;
      if (Math.round(rest)) holdings.push({ ...base, category: "", security_name: "Not broken out (investor total)", invested: null,
        current_value: rest, xirr: null, return_pct: null, level: "summary" });
      return;
    }
    holdings.push({ ...base, asset_class: r.asset_class || null, category: r.category || null, security_name: r.security_name || null,
      quantity: rrNum(r.quantity), invested: rrNum(r.invested), current_value: rrNum(r.current_value), return_pct: rrNum(r.return_pct),
      xirr: rrNum(r.xirr), level: r.level || null });
  };
  if (typeof maUploads === "function" && maUploads().length) {
    for (const r of maState().all) {
      if (!r._c || r._c.clientId !== clientId) continue;
      const u = r._u;
      uploads.set(u.seq, { id: u.seq, kind: u.kind, platform: u.platform, platform_key: maKey(u.platform), product: u.product, version: u.version,
        snapshot_date: u.snapshotDate || String(u.at || "").slice(0, 10) });
      const base = { upload_id: u.seq, client_name: name, client_id: cid, platform: r.platform, platform_key: r.platform_key, product: r.product,
        isin: r.isin || null, identifier: r.identifier || null, as_of: r.as_of || null };
      if (u.kind === "sip") sips.push({ ...base, security_name: r.security_name || null, sip_amount: rrNum(r.sip_amount),
        monthly_amount: rrNum(r.monthly_amount), frequency: r.frequency || null, status: r.status || null, live: r.live !== false });
      else pushHolding(base, r);
    }
  }
  let next = Math.max(0, ...[...uploads.keys()]) + 1;
  const legacy = new Map();
  const legacyUpload = (x, kind) => {
    const k = (x.batchId || x.platform) + "|" + kind;
    if (!legacy.has(k)) {
      const label = typeof impPlatformLabel === "function" ? impPlatformLabel(x.platform) : x.platform;
      legacy.set(k, { id: next++, kind, platform: label, platform_key: maKey(label), product: x.product || "MF", version: 1,
        snapshot_date: x.reportAsOn || String(x.asOf || "").slice(0, 10) || today });
      uploads.set(legacy.get(k).id, legacy.get(k));
    }
    return legacy.get(k);
  };
  for (const h of (DB.platformHoldings || []).filter((x) => !x.deletedAt && x.clientId === clientId && x.source !== "multiasset")) {
    const u = legacyUpload(h, "aum");
    pushHolding({ upload_id: u.id, client_name: name, client_id: cid, platform: u.platform, platform_key: u.platform_key, product: u.product,
      isin: null, identifier: null, as_of: u.snapshot_date },
      { level: "summary", security_name: "All schemes (investor total)", invested: h.invested, current_value: h.current, xirr: h.xirr, sleeves: h.sleeves });
  }
  for (const x of (DB.platformSips || []).filter((s) => !s.deletedAt && s.clientId === clientId && s.source !== "multiasset")) {
    const u = legacyUpload(x, "sip");
    sips.push({ upload_id: u.id, client_name: name, client_id: cid, platform: u.platform, platform_key: u.platform_key, product: u.product,
      security_name: x.schemeName || null, isin: x.isin || null, identifier: x.folio || x.sipNo || null, sip_amount: rrNum(x.amount),
      monthly_amount: rrNum(x.monthlyAmount || x.amount), frequency: x.frequency || null, status: x.status || null, live: rrLiveSip(x, today) });
  }
  if (!holdings.length && !sips.length) throw new Error("No data for this client yet. Upload their platform files in Setup › Platform Import Mapping.");
  const saved = (DB.reviewEdits || []).find((x) => x.clientId === clientId);
  return { clientName: name, clientId: cid, clientKey: clientId, today, uploads: [...uploads.values()].sort((a, b) => a.id - b.id),
    holdings, sips, edits: saved ? saved.edits || {} : {}, editsSavedAt: saved ? saved.savedAt : null };
}
async function rrSaveEdits(clientId, edits) {
  DB.reviewEdits = (DB.reviewEdits || []).filter((x) => x.clientId !== clientId);
  const data = JSON.stringify(edits || {});
  if (data.length > 1024 * 1024) throw new Error("Too many changes to save.");
  const savedAt = new Date().toISOString();
  if (Object.keys(edits || {}).length) DB.reviewEdits.push({ clientId, edits, savedAt, by: currentUser });
  const ok = await save("reviewEdits");
  if (ok === false) throw new Error("the server did not take it");
  return { ok: true, savedAt };
}
async function rrResetEdits(clientId) {
  DB.reviewEdits = (DB.reviewEdits || []).filter((x) => x.clientId !== clientId);
  await save("reviewEdits");
  return { ok: true };
}
/* Every export is kept: the file itself, and with it the changes it was made with. */
async function rrKeep(data, edits, out) {
  const id = uid("RVR");
  const b64 = maBufToB64(out.buffer);
  const wrote = await sset("reviewFile." + id, { name: out.name, b64 });
  if (wrote === false) throw new Error("The review was downloaded but could not be kept.");
  DB.reviewReports = (DB.reviewReports || []).concat([{ id, clientId: data.clientKey, clientName: data.clientName, reviewDate: out.date,
    file: out.name, size: out.buffer.byteLength, edits, at: new Date().toISOString(), by: currentUser }]);
  await save("reviewReports");
  await logAudit("CMS", data.clientKey, "Review report exported", [{ field: "Review report", oldValue: "", newValue: out.name }]);
}
function rrReportsOf(clientId) {
  return (DB.reviewReports || []).filter((x) => x.clientId === clientId).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
function rrPreviousItems(clientId) {
  const list = rrReportsOf(clientId);
  if (!list.length) return [{ head: "No review has been exported yet. Export Excel keeps each one here." }];
  return [{ head: "Previous reviews · press one to download it" }].concat(list.map((x) => ({
    label: `Review as on ${fmtDate(x.reviewDate)} · exported ${fmtDate(String(x.at).slice(0, 10))} by ${teamName(x.by) || x.by || "—"}`,
    run: () => rrDownload(x.id) })));
}
async function rrDownload(id) {
  const f = await sget("reviewFile." + id, null);
  if (!f || !f.b64) { alert("That review file is no longer kept."); return; }
  const bin = atob(f.b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  download(xlsxBlob(u8), f.name || "Review.xlsx");
}
async function rrRemove(id) {
  const x = (DB.reviewReports || []).find((r) => r.id === id);
  if (!x || !confirm(`Delete the review as on ${fmtDate(x.reviewDate)} for ${x.clientName}? This cannot be undone.`)) return;
  DB.reviewReports = DB.reviewReports.filter((r) => r.id !== id);
  await save("reviewReports");
  await sdel("reviewFile." + id);
  await logAudit("CMS", x.clientId, "Review report deleted", [{ field: "Review report", oldValue: x.file, newValue: "" }]);
  if (typeof render === "function") render();
}
/* The list for a client's own pages. */
function previousHtml(clientId) {
  const list = rrReportsOf(clientId);
  return `<div class="section-title">Previous review reports <span class="small-note">${list.length}</span></div>`
    + (list.length ? `<div class="table-wrap"><table><thead><tr><th>Review as on</th><th>Exported</th><th>By</th><th></th></tr></thead><tbody>
      ${list.map((x) => `<tr><td><b>${fmtDate(x.reviewDate)}</b></td><td>${fmtDate(String(x.at).slice(0, 10))}</td><td>${esc(teamName(x.by) || x.by || "—")}</td>
        <td style="white-space:nowrap"><button class="btn sm" onclick="ReviewReport.download('${esc(x.id)}')">Download</button>
        ${isAdmin() ? `<button class="btn sm ghost" onclick="ReviewReport.remove('${esc(x.id)}')">Delete</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="small-note">None yet. Open the review report and press Export Excel; each export is kept here.</div>`);
}
async function open(clientId) {
  const c = (DB.clients || []).find((x) => x.id === clientId);
  if (!c) return;
  if (typeof recordOpenToMe === "function" && !recordOpenToMe("CMS", c)) { alert("You do not have access to this client."); return; }
  if (typeof closeModal === "function") closeModal();
  rrCss();
  const host = rrHost();
  host.innerHTML = '<div class="loading">Loading the review sheet…</div>';
  try { await rrJsZip(); }
  catch (e) { host.innerHTML = `<div class="card"><h2>Couldn't open the review report</h2><p>${esc(e.message)}</p><button class="btn" onclick="ReviewReport.close()">Close</button></div>`; return; }
  await ReviewPage.show(clientId);
}
function close() {
  ReviewPage.leave();
  const el = document.getElementById("rrOverlay");
  if (el) { el.hidden = true; el.innerHTML = ""; }
  if (typeof render === "function") render();
}
return { open, close, download: rrDownload, remove: rrRemove, previousHtml, load: rrLoad, reports: rrReportsOf,
  _review: Review, _page: ReviewPage };
})();
