/* THE PLATFORM REPORTS THE FIRM ACTUALLY DOWNLOADS.

   Motilal Oswal's client-wise AUM and Omni Science's PMS fund activity are
   read as reports; NJ's Group Wise AUM and a Branch Wise AUM are summaries
   of money already counted and are named and left out; NJ's Folio Detail
   fills in the client records and adds no holdings; several SIPs in one
   folio and scheme are each kept; and a PDF factsheet whose holdings wrap
   over two lines, under a "Mkt Value %Assets" caption, adds up to its total.
   All fixtures are made up. */
const {suite} = require('../lib/harness');
const {xlsx} = require('../lib/xlsx-write');

function pdfBytes(lines){
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const ops = lines.map(([x, y, text]) => `BT /F1 9 Tf ${x} ${y} Td (${esc(text)}) Tj ET`).join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const b64 = buf => Buffer.from(buf).toString('base64');
const F = {
  mo: b64(xlsx('Sheet1', [
    ['Client Name', 'Client Code', 'Sub Broker Code', 'Total AUM', 'Cash', 'Mutual Fund', 'FD', 'Bonds', 'PMS', 'Real Estate', 'AIF', 'PE', 'IAP', 'ledger'],
    ['ZZ MO ONE', 'ZZ1001', 'RZZ', '300000', '100000', '50000', '0', '0', '0', '0', '0', '0', '149999', '1'],
    ['ZZ MO TWO', 'ZZ1002', 'RZZ', '2000', '2000', '0', '0', '0', '0', '0', '0', '0', '0', '0']])),
  omni: b64(xlsx('Fundactivity', [
    ['', '', '', '', '', 'Fund Activity Report'], [],
    ['', '', '', '', '', '', '', '', '', '', '', 'Capital IN', '', '', '', '', '', '', 'Capital Out', '', '', '', 'AUM'],
    ['', 'OFIN Code', '', 'Client Name', '', '', 'Scheme Name', 'Status', 'Date of Investment', 'Distributor', 'Opening NAV', 'Initial Investment', '', '', 'Additional Investment', '', '', '', 'Capital Withdrawal', '', '', '', 'Closing NAV'],
    ['', 'OFINCode', '', '', '', '', 'PMS', '', '', '', '', 'Cash', 'Stock', 'Total', 'Cash', 'Stock', 'Total', 'Grand Total', 'Cash', 'Stock', 'Total', '', ''],
    ['', '00001', '', 'ZZ OMNI ONE', '', '', 'ZZ Supreme', 'Active', '04-Sep-2017', '', '1000000', '', '', '0', '', '', '0', '0', '', '', '0', '', '1100000'],
    ['', '00002', '', 'ZZ OMNI TWO', '', '', 'ZZ Hybrid', 'Active', '23-Apr-2018', '', '500000', '', '', '0', '', '', '0', '0', '', '', '0', '', '400000'],
    ['', '', '', '', '', '', '', '', '', 'Total', '1500000', '', '', '0', '', '', '0', '0', '', '', '0', '', '1500000'],
    ['', '', '', '', '', '', '', '', '', 'Count', '2', '', '', '', '', '', '', '', '', '', '', '', '2']])),
  group: b64(xlsx('AUM Report', [
    ['Group Wise AUM Report ( As On 28-09-2026 )'],
    ['Sr. No.', 'Partner/Employee', 'Group', 'AUM(₹)'],
    ['', '', '', 'EQUITY', 'DEBT', 'HYBRID', 'PHYSICAL ASSETS', 'OTHERS', 'TOTAL'],
    ['1', 'ZZ PARTNER', 'ZZ FAMILY', '1000', '0', '0', '0', '0', '1000']])),
  branch: b64(xlsx('Branch Wise AUM Report', [
    ['ZZ Firm'], ['Branch Wise AUM'], ['Report Date: 28-09-2026'],
    ['Branch Name', 'Aug-2026', 'Sep-2026'], ['ZZ Branch', '100', '200'], ['Grand Total:', '100', '200']])),
  folio: b64(xlsx('Sheet1', [
    ['Folio Detail Report( As on12-10-2026)'],
    ['Sr No', 'AMC', 'Folio No', 'Partner/ Employee', 'Group', 'Investor Name', 'First Holder PAN', 'First holder DOB', 'Address', 'City', 'Pin code', 'State', 'Mobile No', 'Email', 'Bank Ac No.', 'Bank_Name', 'Bank Branch', 'IFSC Code'],
    ['1', 'ZZ MF', 'F1', 'ZZ P', 'ZZ G', 'ZZ Folio Person', 'ZZFOL1234F', '18-05-1982', '1 ZZ Road', 'PUNE', '411033', 'MAHARASHTRA', '9876501234', 'zz.folio@example.in', '0001', 'ZZ BANK', 'ZZ BR', 'ZZBK0000001'],
    ['2', 'ZZ MF', 'F2', 'ZZ P', 'ZZ G', 'ZZ Folio Person', 'ZZFOL1234F', '18-05-1982', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-'],
    ['3', 'ZZ MF', 'F3', 'ZZ P', 'ZZ G', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-']])),
  fwsip: b64(xlsx('SIP', [
    ['ZZ Firm'], ['Active SIP Report'],
    ['Investor Name', 'PAN Number', 'Mobile', 'Branch', 'RM Name', 'Associate Name', 'Folio', 'Scheme Name', 'Reg Date', 'Start Date', 'End Date', 'SIP Date', 'Frequency', 'SIP Amount', 'Monthly Amount', 'Inv. Cost', 'Current Value', 'XIRR(%)', 'Client ID', 'ISIN No', 'RTA Code'],
    ['ZZ SIP PERSON', 'ZZSIP1234S', '', '', '', '', '111/1', 'ZZ Flexi Fund - Growth', '16-04-2026', '20-04-2026', '15-04-2056', '15', 'Monthly', '3000', '3000', '', '', '', 'C1', 'INE0ZZ', ''],
    ['ZZ SIP PERSON', 'ZZSIP1234S', '', '', '', '', '111/1', 'ZZ Flexi Fund - Growth', '22-04-2026', '24-04-2026', '25-04-2056', '25', 'Monthly', '3000', '3000', '', '', '', 'C1', 'INE0ZZ', ''],
    ['ZZ SIP PERSON', 'ZZSIP1234S', '', '', '', '', '111/1', 'ZZ Flexi Fund - Growth', '22-04-2026', '24-04-2026', '25-04-2056', '25', 'Monthly', '3000', '3000', '', '', '', 'C1', 'INE0ZZ', '']])),
  fwaum: b64(xlsx('AUM', [
    ['ZZ Firm'], ['Investor Wise AUM Report'], ['Report Date: 30-10-2026'],
    ['Name', 'PAN', 'Branch', 'RM Name', 'Associate Name', 'Inv.\nCost', 'Current\n Value', 'XIRR', 'Mobile'],
    ['ZZ OWNER', 'ZZOWN1234O', '', '', '', '100', '1000', '1', '9000000001'],
    ['ZZ OWNER TRADERS', 'ZZOWN1234O', '', '', '', '100', '500', '1', '9000000001'],
    ['ZZ SAME NAME', '', '', '', '', '100', '200', '1', '9000000002'],
    ['ZZ SAME NAME', '', '', '', '', '100', '300', '1', '9000000003'],
    ['ZZ SAME NAME', '', '', '', '', '100', '50', '1', '9000000002']])),
  /* Two halves on the page, a holding whose name wraps under its figures,
     and the two figures under a single "Mkt Value %Assets" caption. */
  pdf: b64(pdfBytes([
    [40, 560, 'Account: 1 - ZZ PDF PERSON'],
    [430, 540, 'Sr. Security'], [600, 540, 'Sector'], [700, 540, 'Mkt Value %Assets'],
    [40, 525, 'Strategy: ZZ'], [430, 525, '1 ZZ Coal Limited'], [600, 525, 'METALS'], [700, 525, '22,815'], [745, 525, '1.14%'],
    [600, 510, 'FINANCIAL'], [700, 510, '19,138'], [745, 510, '0.96%'],
    [430, 500, '2 ZZ Life Insurance Company'],
    [40, 485, '17 Cash 1.28%'], [430, 485, '3 ZZ Power Limited'], [600, 485, 'ENERGY'], [700, 485, '8,047'], [745, 485, '0.40%'],
    [430, 470, 'Total'], [700, 470, '50,000'], [745, 470, '100%']])),
};

suite(async t => {
  const read = (key, name, kind) => t.eval(async a => {
    const bin = atob(a.b64); const u = new Uint8Array(bin.length); for(let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const out = await maReadFile(new File([u], a.name), a.kind, '', false);
    return {layout: out.layout || '', status: out.status, details: !!out.detailsOnly, notes: out.notes.join('; '),
      rows: out.rows.map(h => ({n: h.client_name, v: h.current_value, s: h.security_name, sip: h.sip_amount, sl: h.sleeves, cd: h.cd, ex: h.extra}))};
  }, {b64: F[key], name, kind: kind || 'aum'});

  await t.step('Motilal Oswal AUM: one row per client, its total and what it is made of', async () => {
    const r = await read('mo', 'MOTILAL OSWAL AUM REPORT.xlsx');
    const one = r.rows.find(x => x.n === 'ZZ MO ONE') || {};
    if(r.layout !== 'mo_aum' || r.rows.length !== 2 || one.v !== 300000) throw new Error(JSON.stringify(r).slice(0, 400));
    if(!one.sl || one.sl.Stocks.current !== 100000 || one.sl.IAP.current !== 149999 || one.ex.platformClientCode !== 'ZZ1001') throw new Error(JSON.stringify(one));
    return '2 clients, ZZ MO ONE 3,00,000 with Stocks, MF and IAP sleeves';
  });

  await t.step('Omni Science PMS fund activity: the closing value per account, foot lines ignored', async () => {
    const r = await read('omni', 'Omnisci Aum Report.xlsx');
    const sum = r.rows.reduce((n, x) => n + x.v, 0);
    if(r.layout !== 'omni_pms' || r.rows.length !== 2 || sum !== 1500000 || /not imported/.test(r.notes)) throw new Error(JSON.stringify(r).slice(0, 500));
    return '2 accounts, 15,00,000, nothing reported as skipped';
  });

  await t.step('NJ Group Wise and Branch Wise AUM are named as summaries and not added', async () => {
    const g = await read('group', 'NJ_AUM_REPORT groupwise.xlsx');
    const b = await read('branch', 'finowise-Branch-Wise-AUM-Report.xlsx');
    if(g.layout !== 'nj_group' || g.rows.length || !/Investor Wise/.test(g.notes)) throw new Error(JSON.stringify(g));
    if(b.layout !== 'branch_summary' || b.rows.length || !/counted twice/.test(b.notes)) throw new Error(JSON.stringify(b));
    return 'both refused with the reason';
  });

  await t.step('NJ Folio Detail fills the client record and adds no holdings', async () => {
    const r = await read('folio', 'NJ_Folio_Detail_Report.xls');
    if(!r.details || r.layout !== 'nj_folio' || r.rows.length !== 2) throw new Error(JSON.stringify(r).slice(0, 400));
    const c = await t.eval(async rows => {
      const res = await maApplyClients(rows.map(x => ({client_name: x.n, pan: x.cd.pan, cd: x.cd})), {create: true, overwrite: false, platform: 'NJ', file: 'f.xls'});
      const c = DB.clients.find(x => x.cmsName === 'ZZ Folio Person') || {};
      return {created: res.created.length, pan: c.pan, dob: c.dob, mobile: c.mobile, email: c.email, city: c.mailingCity, zip: c.mailingZip,
        bank: c.bankName, ifsc: c.ifsc, acc: c.accNo, held: DB.platformHoldings.filter(h => !h.deletedAt && h.clientId === c.id).length};
    }, r.rows);
    if(c.created !== 1 || c.pan !== 'ZZFOL1234F' || c.dob !== '1982-05-18' || c.mobile !== '9876501234' || c.city !== 'PUNE'
       || c.bank !== 'ZZ BANK' || c.ifsc !== 'ZZBK0000001' || c.held) throw new Error(JSON.stringify(c));
    return 'one client, PAN, DOB, mobile, address and bank filled, no holdings';
  });

  await t.step('several SIPs in one folio and scheme are each kept', async () => {
    const r = await read('fwsip', 'finowise-Active-SIP-Report.xlsx', 'sip');
    if(r.layout !== 'finowise_sip' || r.rows.length !== 2) throw new Error(JSON.stringify(r).slice(0, 500));
    return '2 SIPs of 3,000 kept, the exact repeat dropped';
  });

  await t.step('a two-panel PDF factsheet: wrapped names rejoined, figures not run together', async () => {
    const r = await t.eval(async a => {
      const bin = atob(a); const u = new Uint8Array(bin.length); for(let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const out = await maReadFile(new File([u], 'ZZ_factsheet.pdf'), 'aum', '', false);
      return out.rows.map(h => [h.security_name, h.current_value]);
    }, F.pdf);
    const sum = r.reduce((n, x) => n + x[1], 0);
    if(r.length !== 3 || sum !== 50000 || r[0][0] !== 'ZZ Coal Limited' || !r.some(x => /Life Insurance/.test(x[0]) && x[1] === 19138)) throw new Error(JSON.stringify(r));
    return r.map(x => x[0] + ' ' + x[1]).join(', ');
  });
  await t.step('every rupee in an investor-wise report is counted: same PAN added together, same-named people kept apart', async () => {
    const r = await t.eval(async a => {
      const bin = atob(a); const u = new Uint8Array(bin.length); for(let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const out = await maReadFile(new File([u], 'finowise-Investor-Wise-AUM-Report.xlsx'), 'aum', '', false);
      const res = await maApplyClients(out.rows, {create: true, overwrite: false, platform: 'Finowise', file: 'f.xlsx'});
      const same = DB.clients.filter(c => !c.deletedAt && c.cmsName === 'ZZ SAME NAME').map(c => c.mobile).sort();
      return {n: out.rows.length, sum: out.rows.reduce((n, h) => n + h.current_value, 0), notes: out.notes.join('; '), same, created: res.created.length};
    }, F.fwaum);
    if(r.sum !== 2050) throw new Error('read ' + r.sum + ' of 2,050: ' + r.notes);
    if(r.n !== 3 || r.same.join(',') !== '9000000002,9000000003') throw new Error(JSON.stringify(r));
    return '2,050 of 2,050; the owner\'s two lines added together; two ZZ SAME NAME clients told apart by mobile';
  });
});
