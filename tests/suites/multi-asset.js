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
      MA.snapDate = o.snap || ''; navigate('assetupload'); }, opts);
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
    const m = await t.eval(()=>({nav: NAV_GROUPS.some(g=>g.id === 'assets'), plats: maPlatforms().length}));
    if(!m.nav) throw new Error('Multi Assets is not in the rail');
    return 'Mehta and Rao; Multi Assets in the rail with ' + m.plats + ' platforms on the matrix';
  });

  t.section('Platform Wise, Excel');

  await t.step('a Motilal Oswal stocks file lands for three clients, two of them matched to BOSS', async () => {
    const r = await upload([['stocks-motilal-oswal:aum', FILES.stocks1]]);
    const x = r.results.find(y=>y.slot === 'Motilal Oswal:aum');
    if(!x || !x.ok) throw new Error('upload: ' + JSON.stringify(r.results));
    if(x.version !== 1) throw new Error('version ' + x.version);
    if(x.rows !== 4) throw new Error(x.rows + ' rows read, expected 4 (the total line is not a holding)');
    if(x.clients !== 3 || x.matched !== 2) throw new Error(x.clients + ' clients, ' + x.matched + ' matched');
    if(!/Added/.test(r.modal)) throw new Error('the result says: ' + r.modal);
    const c = await current();
    const mehta = c.h.filter(h=>h.cid === ids.mehta);
    if(mehta.length !== 2) throw new Error('Mehta has ' + mehta.length + ' current holdings');
    return '4 holdings, 3 clients (2 in BOSS, 1 kept as uploaded); popup says Added';
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
      navigate('assets'); seen.home = txt();
      maGo({page: 'scope', product: 'Stocks'}); seen.cat = txt();
      maGo({page: 'scope', platform: 'Motilal Oswal'}); seen.plat = txt();
      maOpenClient('c:' + id); seen.client = txt();
      navigate('assetsips'); seen.sips = txt();
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
    if(!/Multi-asset holdings/i.test(txt) || !/ZZ Infra Ltd/.test(txt) || !/Motilal Oswal/.test(txt)) throw new Error(txt.slice(0, 500));
    return 'Platform-reported holdings + Multi-asset holdings on the profile';
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
});
