/* MULTI ASSETS: EVERY PLATFORM AND CATEGORY, VERSIONED, AND IN THE CLIENT'S BOOK.

   The firm's multi-asset back office, inside BOSS. What has to hold:

     · a file of any category (MF, Stocks, PMS, AIF, Bonds, LAS, Other)
       from any platform goes in through the upload matrix, Platform Wise
       or Client Wise, Excel or PDF;
     · nothing is overwritten: a new file is the next version, the screens
       read the newest, a client whose rows did not change is left alone,
       and the same file twice is refused;
     · removing a version brings back the one before it;
     · LAS is shown on its own and never added to AUM;
     · what is uploaded reaches the BOSS client it belongs to — matched by
       PAN, then name — on the Portfolio tab, in the book AUM and in
       platformHoldings, which every other screen reads;
     · a mutual fund report that came in through the older platform import
       and again through here is counted once: the newer one wins.

   Every file goes through the real matrix: the real file input, the real
   reader, the real Upload All. */
const {suite} = require('../lib/harness');
const {xlsx, xlsxBook} = require('../lib/xlsx-write');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bossma-'));
const write = (name, sheet, rows) => { const p = path.join(DIR, name); fs.writeFileSync(p, xlsx(sheet, rows)); return p; };

/* A PDF with a real text layer, laid out as a statement is: a heading line
   naming the investor, then a table whose columns are positioned text. */
function pdfFile(name, lines){
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const ops = lines.map(([x, y, text]) => `BT /F1 9 Tf ${x} ${y} Td (${esc(text)}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const p = path.join(DIR, name);
  fs.writeFileSync(p, out, 'latin1');
  return p;
}

/* Stocks at Motilal Oswal, Platform Wise: Mehta (PAN in BOSS), Rao (PAN in
   BOSS), and somebody BOSS has never heard of. */
const STOCK_HEAD = ['Client Name', 'PAN', 'Stock Name', 'ISIN', 'Qty', 'Avg Price', 'LTP', 'Market Value'];
const FILES = {
  stocks1: write('MO_Holdings_Mar.xlsx', 'Holdings', [
    ['Motilal Oswal — Holdings as on 31-Mar-2026'],
    STOCK_HEAD,
    ['ZZ Mehta Rajesh', 'ZZMEH1234R', 'ZZ Infra Ltd', 'INE000ZZ0001', '100', '500', '600', '60,000'],
    ['ZZ Mehta Rajesh', 'ZZMEH1234R', 'ZZ Power Ltd', 'INE000ZZ0002', '50', '200', '180', '9,000'],
    ['ZZ Rao Sunita', 'ZZRAO5678S', 'ZZ Infra Ltd', 'INE000ZZ0001', '10', '500', '600', '6,000'],
    ['ZZ Outsider Person', 'ZZOUT9999Z', 'ZZ Bank Ltd', 'INE000ZZ0003', '5', '1000', '1100', '5,500'],
    ['Grand Total', '', '', '', '', '', '', '80,500'],
  ]),
  /* April: Rao bought more; Mehta and the outsider did not change. */
  stocks2: write('MO_Holdings_Apr.xlsx', 'Holdings', [
    ['Motilal Oswal — Holdings as on 30-Apr-2026'],
    STOCK_HEAD,
    ['ZZ Mehta Rajesh', 'ZZMEH1234R', 'ZZ Infra Ltd', 'INE000ZZ0001', '100', '500', '600', '60,000'],
    ['ZZ Mehta Rajesh', 'ZZMEH1234R', 'ZZ Power Ltd', 'INE000ZZ0002', '50', '200', '180', '9,000'],
    ['ZZ Rao Sunita', 'ZZRAO5678S', 'ZZ Infra Ltd', 'INE000ZZ0001', '30', '520', '600', '18,000'],
    ['ZZ Outsider Person', 'ZZOUT9999Z', 'ZZ Bank Ltd', 'INE000ZZ0003', '5', '1000', '1100', '5,500'],
  ]),
  /* Mehta's own Finowise statement, Client Wise: the holdings sheet, and a
     SIP sheet the matrix reads by itself when no SIP file is chosen. */
  mf: (() => {
    const rows = [
      ['Investor: ZZ Mehta Rajesh   PAN: ZZMEH1234R'],
      ['Portfolio valuation as on 31-Mar-2026'],
      ['Scheme Name', 'Folio No', 'Units', 'Cost Value', 'Current Value', 'XIRR'],
      ['ZZ Bluechip Fund - Direct Growth', 'F-001', '1000', '1,00,000', '1,30,000', '14.2'],
      ['ZZ Short Debt Fund - Direct Growth', 'F-002', '500', '50,000', '54,000', '7.1'],
    ];
    const sip = [
      ['Scheme', 'SIP Amount', 'Frequency', 'SIP Date', 'Start Date', 'End Date', 'Status'],
      ['ZZ Bluechip Fund - Direct Growth', '10,000', 'Monthly', '5', {d: '2024-04-05'}, {d: '2030-04-05'}, 'Active'],
      ['ZZ Short Debt Fund - Direct Growth', '15,000', 'Quarterly', '10', {d: '2023-01-10'}, {d: '2025-01-10'}, 'Ceased'],
    ];
    const p = path.join(DIR, 'Finowise_Mehta.xlsx');
    fs.writeFileSync(p, xlsxBook([{name: 'Holdings', rows}, {name: 'SIP Summary', rows: sip}]));
    return p;
  })(),
  las: write('Volt_LAS.xlsx', 'Loans', [
    ['Client Name', 'PAN', 'Description', 'Loan Outstanding'],
    ['ZZ Rao Sunita', 'ZZRAO5678S', 'Loan against mutual funds', '2,00,000'],
  ]),
  pdf: pdfFile('Piper_AIF_Rao.pdf', [
    [40, 540, 'Investor: ZZ Rao Sunita PAN: ZZRAO5678S'],
    [40, 525, 'Statement as on 31-Mar-2026'],
    [40, 500, 'Scheme Name'], [260, 500, 'Units'], [340, 500, 'Invested Amount'], [460, 500, 'Current Value'],
    [40, 485, 'ZZ Growth AIF Cat III'], [260, 485, '1000'], [340, 485, '1000000'], [460, 485, '1150000'],
  ]),
};

/* The reports the old column-mapping import knew, now through the upload. */
FILES.fwAum = write('Finowise_AUM_Report.xlsx', 'AUM', [
  ['Name', 'PAN', 'Branch', 'RM Name', 'Associate Name', 'Inv. Cost', 'Current Value', 'XIRR', 'Mobile'],
  ['ZZ Mehta Rajesh', 'ZZMEH1234R', '', '', '', '1,50,000', '2,00,000', '15.5', '9876500001'],
  ['ZZ Newman Kiran', 'ZZNEW1111K', '', '', 'ZZ Assoc', '40,000', '50,000', '11', '9876500002'],
]);
FILES.njSip = write('NJ_SIP_Report.xlsx', 'SIP', [
  ['Sr. No.', 'Investor', 'Folio No', 'Scheme', 'Start Date', 'End Date', 'Amount (₹)', 'Frequency', 'Monthly SIP Amount',
   'Total No. of Installments', 'SIP Type', 'SIP No.', 'Base SIP No.', 'Top-Up Start Date', 'Registered Top-Up Amt.'],
  ['1', 'ZZ Newman Kiran', 'NJ-77', 'ZZ Midcap Fund - Growth', '05-01-2024', '05-01-2034', '5,000', 'Monthly', '5,000',
   '120', 'Normal', 'SIP-9001', '', '', ''],
]);
FILES.taught = write('Philip_Holdings.xlsx', 'Holdings', [
  ['Client Name', 'PAN', 'Mobile No', 'Scrip', 'Qty', 'Holding Worth'],
  ['ZZ Rao Sunita', 'ZZRAO5678S', '9876500003', 'ZZ Steel Ltd', '50', '25,000'],
]);

const SEED = async () => {
  const br = (DB.config.branches || ['Varanasi'])[0];
  const mk = (name, pan) => {
    const c = {id: uid('CMS'), cmsName: name, pan, branch: br, rmName: currentUser,
      createdAt: new Date().toISOString(), createdBy: currentUser};
    initState('CMS', c); DB.clients.push(c);
    return c.id;
  };
  const out = {mehta: mk('ZZ Mehta Rajesh', 'zzmeh1234r'), rao: mk('ZZ Rao Sunita', 'ZZRAO5678S')};
  await save('clients');
  /* Mehta's Finowise MF as the older platform import left it, a month ago. */
  DB.platformHoldings.push({id: uid('PHD'), key: 'finowise|' + out.mehta, clientId: out.mehta, platform: 'finowise',
    report: 'AUM', format: 'finowise_aum', invested: 90000, current: 120000, xirr: 12,
    asOf: new Date(Date.now() - 30 * 86400000).toISOString(), firstSeenAt: new Date().toISOString()});
  await save('platformHoldings');
  return out;
};

suite(async t => {
  let ids = null;
  const book = who => t.eval(id => ({
    pfh: DB.platformHoldings.filter(h=>h.clientId === id && !h.deletedAt).map(h=>({p: h.platform, prod: h.product || '', cur: h.current, src: h.source || 'wizard'})),
    sips: DB.platformSips.filter(s=>s.clientId === id && !s.deletedAt).map(s=>({scheme: s.schemeName, m: s.monthlyAmount})),
    bookAum: clientBookAum(DB.clients.find(c=>c.id === id)),
  }), who);

  /* Choose files on the matrix and press Upload All. */
  const upload = async (files, opts) => {
    opts = opts || {};
    await t.eval(o => { MA.picked = {}; MA.result = null; MA.uploadType = o.type || 'platform'; MA.clientName = o.client || '';
      MA.snapDate = o.snap || ''; maNav('upload'); }, opts);
    await t.wait(300);
    for(const [slot, file] of files){
      await t.page.setInputFiles(`input[data-ma="${slot}"]`, file);
      await t.wait(80);
    }
    await t.page.click('#maUploadAll');
    for(let i = 0; i < 60; i++){ await t.wait(250); if(await t.eval(()=>!MA.busy && !!MA.result)) break; }
    const r = await t.eval(()=>({results: MA.result.results.map(x=>({slot: x.job.platform.name + ':' + x.job.kind + (x.job.auto ? ':auto' : ''),
      ok: !!x.ok, skipped: !!x.skipped, unchanged: !!x.unchanged, error: x.error || '',
      version: x.created ? x.created.version : 0, rows: x.created ? x.created.rowsCount : 0,
      clients: x.created ? x.created.clientsCount : 0, matched: x.created ? x.created.matchedClients : 0,
      unchangedClients: x.created ? x.created.unchangedClients : 0, unmatched: x.created ? x.created.unmatched : []})),
      modal: (document.getElementById('maResultTable') || {}).innerText || ''}));
    await t.eval(()=>closeModal());
    return r;
  };
  const current = () => t.eval(()=>{ maInvalidate(); const s = maState();
    return {h: s.holdings.map(r=>({c: r._c.name, cid: r._c.clientId, prod: r.product, plat: r.platform, name: r.security_name, v: r.current_value, ver: r._u.version})),
            s: s.sips.map(r=>({c: r._c.name, name: r.security_name, m: r.monthly_amount, live: r.live}))}; });

  await t.step('seed two clients with PANs, and an older Finowise MF line for one of them', async () => {
    ids = await t.eval(SEED);
    await t.wait(300);
    const m = await t.eval(()=>{ maNav('upload'); return {rail: NAV_GROUPS.some(g=>g.id === 'assets'),
      tab: currentView === 'settings' && settingsTab === 'importmaps', matrix: !!document.querySelector('input[data-ma]'), plats: maPlatforms().length}; });
    if(m.rail) throw new Error('a separate module is in the rail; the upload belongs in Platform Import Mapping');
    if(!m.tab || !m.matrix) throw new Error(JSON.stringify(m));
    return 'Mehta and Rao; the upload matrix is in Setup › Platform Import Mapping with ' + m.plats + ' platforms';
  });

  t.section('Platform Wise, Excel');

  await t.step('a Motilal Oswal stocks file lands for three clients, and the one BOSS lacked is added', async () => {
    const r = await upload([['stocks-motilal-oswal:aum', FILES.stocks1]]);
    const x = r.results.find(y=>y.slot === 'Motilal Oswal:aum');
    if(!x || !x.ok) throw new Error('upload: ' + JSON.stringify(r.results));
    if(x.version !== 1) throw new Error('version ' + x.version);
    if(x.rows !== 4) throw new Error(x.rows + ' rows read, expected 4 (the total line is not a holding)');
    if(x.clients !== 3 || x.matched !== 3) throw new Error(x.clients + ' clients, ' + x.matched + ' matched');
    if(!/1 new client added/.test(r.modal)) throw new Error('the result does not say a client was added: ' + r.modal);
    const out = await t.eval(()=>DB.clients.find(c=>!c.deletedAt && c.cmsName === 'ZZ Outsider Person'));
    if(!out || out.pan !== 'ZZOUT9999Z' || !/Platform upload/.test(out.createdVia || '')) throw new Error('the new client: ' + JSON.stringify(out));
    if(!/Added/.test(r.modal)) throw new Error('the result says: ' + r.modal);
    const c = await current();
    const mehta = c.h.filter(h=>h.cid === ids.mehta);
    if(mehta.length !== 2) throw new Error('Mehta has ' + mehta.length + ' current holdings');
    return '4 holdings, 3 clients (2 already in BOSS, ZZ Outsider Person added with PAN); popup says Added';
  });

  await t.step('the stocks reach Mehta\'s book: a platformHoldings line, and the book AUM counts it', async () => {
    const b = await book(ids.mehta);
    const line = b.pfh.find(h=>h.prod === 'Stocks');
    if(!line || line.cur !== 69000) throw new Error('lines: ' + JSON.stringify(b.pfh));
    if(Math.round(b.bookAum) !== 69000 + 120000) throw new Error('book AUM ' + b.bookAum);
    return 'Stocks · Motilal Oswal 69,000 beside the wizard\'s Finowise 1,20,000 → book ' + b.bookAum;
  });

  await t.step('April\'s file is version 2, and only Rao (who changed) gets new rows', async () => {
    const r = await upload([['stocks-motilal-oswal:aum', FILES.stocks2]]);
    const x = r.results.find(y=>y.slot === 'Motilal Oswal:aum');
    if(!x || !x.ok) throw new Error(JSON.stringify(r.results));
    if(x.version !== 2) throw new Error('version ' + x.version);
    if(x.unchangedClients !== 2) throw new Error(x.unchangedClients + ' unchanged clients, expected 2');
    if(x.rows !== 1) throw new Error(x.rows + ' rows saved, expected Rao\'s one');
    const c = await current();
    const rao = c.h.find(h=>h.cid === ids.rao && h.prod === 'Stocks');
    const meh = c.h.find(h=>h.cid === ids.mehta && h.name === 'ZZ Infra Ltd');
    if(!rao || rao.v !== 18000 || rao.ver !== 2) throw new Error('Rao: ' + JSON.stringify(rao));
    if(!meh || meh.ver !== 1) throw new Error('Mehta should still read version 1: ' + JSON.stringify(meh));
    return 'v2 · 1 row (Rao 6,000 → 18,000) · Mehta and the outsider kept as before';
  });

  await t.step('the same file again is refused, by its contents', async () => {
    const r = await upload([['stocks-motilal-oswal:aum', FILES.stocks2]]);
    const x = r.results[0];
    if(!x.skipped || !/Already uploaded as version 2/.test(x.error)) throw new Error(JSON.stringify(x));
    return x.error;
  });

  t.section('Client Wise, a statement with a SIP sheet');

  await t.step('Mehta\'s Finowise statement: holdings, and the SIPs read from the same file', async () => {
    const r = await upload([['mf-finowise:aum', FILES.mf]], {type: 'client', client: 'ZZ Mehta Rajesh'});
    const a = r.results.find(y=>y.slot === 'Finowise:aum'), s = r.results.find(y=>y.slot === 'Finowise:sip:auto');
    if(!a || !a.ok || a.rows !== 2) throw new Error('AUM: ' + JSON.stringify(r.results));
    if(!s || !s.ok || s.rows !== 2) throw new Error('SIPs from the AUM file: ' + JSON.stringify(r.results));
    const c = await current();
    const live = c.s.filter(x=>x.c === 'ZZ Mehta Rajesh' && x.live);
    if(live.length !== 1 || live[0].m !== 10000) throw new Error('live SIPs: ' + JSON.stringify(c.s));
    return '2 holdings + 2 SIPs (1 live at 10,000/mo, 1 ceased)';
  });

  await t.step('the newer Finowise MF replaces the wizard\'s older line instead of adding to it', async () => {
    const b = await book(ids.mehta);
    const wiz = b.pfh.filter(h=>h.src === 'wizard');
    const mf = b.pfh.find(h=>h.prod === 'MF' && h.src === 'multiasset');
    if(wiz.length) throw new Error('the older line is still counted: ' + JSON.stringify(b.pfh));
    if(!mf || mf.cur !== 184000) throw new Error('MF line: ' + JSON.stringify(b.pfh));
    if(Math.round(b.bookAum) !== 69000 + 184000) throw new Error('book AUM ' + b.bookAum);
    if(b.sips.length !== 1 || b.sips[0].m !== 10000) throw new Error('SIP book: ' + JSON.stringify(b.sips));
    const shadow = await t.eval(id=>DB.platformHoldings.find(h=>h.clientId === id && h.platform === 'finowise'), ids.mehta);
    if(!shadow || !shadow.maShadowed) throw new Error('the older line was not set aside');
    return 'book = Stocks 69,000 + MF 1,84,000; the wizard line set aside, not deleted; one live SIP in the SIP book';
  });

  t.section('LAS, and a PDF');

  await t.step('a Volt Money loan is shown on its own and never added to AUM', async () => {
    const before = (await book(ids.rao)).bookAum;
    const r = await upload([['las-volt-money:aum', FILES.las]]);
    if(!r.results[0].ok) throw new Error(JSON.stringify(r.results));
    const b = await book(ids.rao);
    if(b.bookAum !== before) throw new Error('book AUM moved from ' + before + ' to ' + b.bookAum);
    if(b.pfh.some(h=>h.prod === 'LAS')) throw new Error('a loan line reached platformHoldings');
    const t2 = await t.eval(()=>{ const v = maView(); return maSums(v.holdings, v.sips); });
    if(t2.loans !== 200000) throw new Error('loans total ' + t2.loans);
    return 'loans 2,00,000 on the dashboard; Rao\'s book AUM unchanged at ' + before;
  });

  await t.step('a PDF statement is read off its text layer (Piper Serica · AIF, Client Wise)', async () => {
    const r = await upload([['aif-piper-serica:aum', FILES.pdf]], {type: 'client', client: 'ZZ Rao Sunita'});
    const x = r.results.find(y=>y.slot === 'Piper Serica:aum');
    if(!x || !x.ok || x.rows !== 1) throw new Error(JSON.stringify(r.results));
    const c = await current();
    const aif = c.h.find(h=>h.prod === 'AIF');
    if(!aif || aif.v !== 1150000 || aif.cid !== ids.rao) throw new Error(JSON.stringify(aif));
    if(r.results.some(y=>/:sip:auto/.test(y.slot))) throw new Error('a holdings table was read as SIPs: ' + JSON.stringify(r.results));
    const fake = c.s.filter(x=>x.c === 'ZZ Rao Sunita');
    if(fake.length) throw new Error('Rao has SIPs that were never in a file: ' + JSON.stringify(fake));
    return 'ZZ Growth AIF Cat III · 11,50,000, tied to Rao';
  });

  t.section('the screens');

  await t.step('Dashboard, a category, a platform, a client and the SIPs page all draw', async () => {
    const out = await t.eval(async id => {
      const txt = () => document.getElementById('content').innerText;
      const seen = {};
      maGo({page: 'home'}); seen.home = txt();
      maGo({page: 'scope', product: 'Stocks'}); seen.cat = txt();
      maGo({page: 'scope', platform: 'Motilal Oswal'}); seen.plat = txt();
      maOpenClient('c:' + id); seen.client = txt();
      maNav('sips'); seen.sips = txt();
      return seen;
    }, ids.mehta);
    if(!/Categories/i.test(out.home) || !/Stocks/.test(out.home) || !/LAS/.test(out.home)) throw new Error('home: ' + out.home.slice(0, 300));
    if(!/By platform/i.test(out.cat)) throw new Error('category page');
    if(!/By category/i.test(out.plat)) throw new Error('platform page');
    if(!/Scheme-wise investment details/i.test(out.client) || !/ZZ Bluechip Fund/.test(out.client) || !/v2|v1/.test(out.client)) throw new Error('client page: ' + out.client.slice(0, 400));
    if(!/ZZ Bluechip Fund/.test(out.sips)) throw new Error('SIPs page');
    return 'home · Stocks · Motilal Oswal · ZZ Mehta Rajesh · SIPs';
  });

  await t.step('a SIP opens its details: schedule, current holding, other SIPs', async () => {
    const txt = await t.eval(()=>{
      const s = maState().sips.find(r=>r.live);
      maOpenSip(maSipId(s));
      return document.getElementById('modalBody').innerText;
    });
    await t.eval(()=>closeModal());
    if(!/Installments so far/i.test(txt) || !/Current holding in this scheme/i.test(txt)) throw new Error(txt.slice(0, 400));
    return 'installments, next due, the holding in the scheme';
  });

  await t.step('the client\'s Portfolio tab carries the schemes, the SIPs and the platform lines', async () => {
    const txt = await t.eval(id => { const d = document.createElement('div'); d.innerHTML = cpPortfolio(DB.clients.find(c=>c.id === id)); return d.innerText; }, ids.mehta);
    if(!/Holdings by scheme/i.test(txt) || !/ZZ Infra Ltd/.test(txt) || !/Motilal Oswal/.test(txt)) throw new Error(txt.slice(0, 500));
    return 'Platform-reported holdings + Multi-asset holdings on the profile';
  });

  await t.step('the Main Dashboard\'s Live AUM and Live SIP cards carry the uploads, cut by platform', async () => {
    const r = await t.eval(()=>{ const rows = mdBookRows();
      const aum = rows.reduce((n, x)=>n + x.aum, 0), sip = rows.reduce((n, x)=>n + x.sip, 0);
      navigate('dashboard'); const txt = document.getElementById('content').innerText;
      return {aum, sip, plats: Array.from(new Set(rows.filter(x=>x.aum).map(x=>x.platform))), txt: txt.slice(0, 2000)}; });
    /* Mehta: Stocks 69,000 + MF 1,84,000; Rao: Stocks 18,000 + AIF 11,50,000; the
       client the upload added: Stocks 5,500. LAS is not AUM. */
    if(Math.round(r.aum) !== 69000 + 184000 + 18000 + 1150000 + 5500) throw new Error('Live AUM ' + r.aum + ' from ' + r.plats);
    if(Math.round(r.sip) !== 10000) throw new Error('Live SIP ' + r.sip);
    if(!/14,26,500/.test(r.txt)) throw new Error('the card does not show it: ' + r.txt.slice(0, 600));
    return 'Live AUM 14,26,500 (' + r.plats.join(', ') + ') · Live SIP 10,000';
  });

  await t.step('every dashboard downloads an Excel report with the original system\'s sheets', async () => {
    const sheets = await t.eval(()=>{
      let got = null; const real = downloadXlsx;
      window.downloadXlsx = (s, name) => { got = {names: s.map(x=>x.name), name, holdings: (s.find(x=>x.name === 'Holdings') || {rows: []}).rows.length}; return 1; };
      try { maExportXlsx({}, 'All clients'); } finally { window.downloadXlsx = real; }
      return got;
    });
    const want = ['Summary', 'Client Summary', 'Holdings', 'Loans (LAS)', 'SIPs', 'Source Files'];
    if(!sheets || want.some(n=>sheets.names.indexOf(n) < 0)) throw new Error(JSON.stringify(sheets));
    return sheets.names.join(' · ') + ' (' + (sheets.holdings - 1) + ' holdings)';
  });

  t.section('history');

  await t.step('everything survives a reload: uploads and their rows come back from the server', async () => {
    const before = await current();
    await t.home();
    const after = await current();
    if(after.h.length !== before.h.length || after.s.length !== before.s.length) throw new Error(before.h.length + ' → ' + after.h.length);
    return after.h.length + ' holdings and ' + after.s.length + ' SIPs after a reload';
  });

  await t.step('removing version 2 brings Rao\'s version 1 back, everywhere', async () => {
    const id = await t.eval(()=>DB.assetUploads.find(u=>u.platform === 'Motilal Oswal' && u.version === 2).id);
    await t.eval(async x => { await maRemoveUpload(x); }, id);
    await t.wait(300);
    const c = await current();
    const rao = c.h.find(h=>h.cid === ids.rao && h.prod === 'Stocks');
    if(!rao || rao.v !== 6000 || rao.ver !== 1) throw new Error(JSON.stringify(rao));
    const b = await book(ids.rao);
    const line = b.pfh.find(h=>h.prod === 'Stocks');
    if(!line || line.cur !== 6000) throw new Error('book line ' + JSON.stringify(b.pfh));
    const gone = await t.eval(x=>DB['assetRows.' + x] === undefined, id);
    if(!gone) throw new Error('its rows are still held');
    return 'Rao back to 6,000 (v1) on the dashboard and in his book; v2\'s rows gone';
  });

  await t.step('removing the Finowise statement brings the wizard\'s older line back', async () => {
    const id = await t.eval(()=>DB.assetUploads.find(u=>u.platform === 'Finowise' && u.kind === 'aum').id);
    const sid = await t.eval(()=>DB.assetUploads.find(u=>u.platform === 'Finowise' && u.kind === 'sip').id);
    await t.eval(async x => { await maRemoveUpload(x[0]); await maRemoveUpload(x[1]); }, [id, sid]);
    await t.wait(300);
    const b = await book(ids.mehta);
    const wiz = b.pfh.find(h=>h.src === 'wizard');
    if(!wiz || wiz.cur !== 120000) throw new Error(JSON.stringify(b.pfh));
    return 'the 1,20,000 line is counted again';
  });

  t.section('the Finowise, Anand Rathi and NJ reports, through the same upload');

  await t.step('a Finowise AUM report is read column by column: PAN, mobile, associate, XIRR', async () => {
    const r = await upload([['mf-finowise:aum', FILES.fwAum]]);
    const x = r.results.find(y=>y.slot === 'Finowise:aum');
    if(!x || !x.ok || x.rows !== 2) throw new Error(JSON.stringify(r.results));
    if(!/read as the Finowise/i.test(r.modal)) throw new Error('not read as the Finowise report: ' + r.modal);
    if(!/1 new client added/.test(r.modal) || !/1 client record updated/.test(r.modal)) throw new Error(r.modal);
    const c = await t.eval(()=>{ const f = n => DB.clients.find(c=>!c.deletedAt && c.cmsName === n);
      return {meh: f('ZZ Mehta Rajesh'), nw: f('ZZ Newman Kiran')}; });
    if(c.meh.mobile !== '9876500001') throw new Error('Mehta\'s blank mobile was not filled: ' + c.meh.mobile);
    if(!c.nw || c.nw.pan !== 'ZZNEW1111K' || c.nw.mobile !== '9876500002' || c.nw.associateName !== 'ZZ Assoc')
      throw new Error('the new client: ' + JSON.stringify(c.nw));
    const b = await book(ids.mehta);
    const mf = b.pfh.find(h=>h.prod === 'MF' && h.src === 'multiasset');
    if(!mf || mf.cur !== 200000 || b.pfh.some(h=>h.src === 'wizard')) throw new Error('Mehta\'s MF: ' + JSON.stringify(b.pfh));
    const line = await t.eval(id=>DB.platformHoldings.find(h=>!h.deletedAt && h.clientId === id && h.source === 'multiasset'), c.nw.id);
    if(!line || line.current !== 50000 || line.invested !== 40000 || line.xirr !== 11) throw new Error(JSON.stringify(line));
    return 'Mehta 2,00,000 replaces the older line, mobile filled; ZZ Newman Kiran added with PAN, mobile and associate';
  });

  await t.step('an NJ SIP report lands in the SIP book with its own columns (SIP No., installments)', async () => {
    const r = await upload([['mf-nj:sip', FILES.njSip]]);
    const x = r.results.find(y=>y.slot === 'NJ:sip');
    if(!x || !x.ok || x.rows !== 1) throw new Error(JSON.stringify(r.results));
    const s = await t.eval(()=>{ const c = DB.clients.find(c=>!c.deletedAt && c.cmsName === 'ZZ Newman Kiran');
      return DB.platformSips.find(x=>!x.deletedAt && x.clientId === c.id); });
    if(!s || s.monthlyAmount !== 5000 || s.sipNo !== 'SIP-9001' || s.installments !== 120 || s.folio !== 'NJ-77')
      throw new Error(JSON.stringify(s));
    const sip = await t.eval(()=>mdBookRows().reduce((n, x)=>n + x.sip, 0));
    /* Mehta's 10,000 left with the statement removed above, so this is the only live SIP. */
    if(Math.round(sip) !== 5000) throw new Error('Live SIP ' + sip);
    return 'ZZ Midcap Fund 5,000/mo, matched by name, with SIP No. and installments; Live SIP 5,000';
  });

  await t.step('a column a platform names its own way is taught once, and read from then on', async () => {
    await t.eval(async ()=>{ maNav('upload');
      document.getElementById('maColHeading').value = 'Holding Worth';
      document.getElementById('maColField').value = 'current_value';
      document.getElementById('maColKind').value = 'aum';
      await maAddColumnName(); });
    const listed = await t.eval(()=>document.getElementById('maColumnNames').innerText);
    if(!/Holding Worth/.test(listed)) throw new Error('not listed: ' + listed);
    const r = await upload([['stocks-philip-capital:aum', FILES.taught]]);
    const x = r.results.find(y=>y.slot === 'Philip Capital:aum');
    if(!x || !x.ok) throw new Error(JSON.stringify(r.results));
    const b = await book(ids.rao);
    const line = b.pfh.find(h=>h.p === 'Philip Capital');
    if(!line || line.cur !== 25000) throw new Error(JSON.stringify(b.pfh));
    const mob = await t.eval(id=>DB.clients.find(c=>c.id === id).mobile, ids.rao);
    if(mob !== '9876500003') throw new Error('Rao\'s mobile: ' + mob);
    return '"Holding Worth" read as Current value: Rao 25,000 at Philip Capital; Mobile No filled his record';
  });
});
