/* =====================================================================
   MULTI ASSETS

   The multi-asset back office (MF, Stocks, PMS, AIF, Bonds, LAS, Other),
   brought into BOSS from the firm's "Assets Management and Review System".
   What it does is what that system did:

     · An upload matrix: every platform under its category, each with an
       AUM file and a SIP file (Excel or PDF), sent Client Wise (one
       client) or Platform Wise (a bulk file of many clients).
     · Nothing is overwritten. Each upload is the next version (v2, v3…)
       of its platform + category; the screens read the newest version of
       each client + category + platform, and the exact same file twice is
       skipped. Removing a version brings the one before it back.
     · Dashboards: the whole book, a category, a platform, a client — and
       a SIPs page whose every SIP opens its own details.
     · LAS (loans against securities) is shown on its own and is never
       added to AUM.
     · Every dashboard downloads an Excel report.

   And one thing it could not do on its own: what is uploaded here is
   BOSS's data, so it is matched to BOSS's clients (PAN first, then the
   name) and written through to the stores every other screen already
   reads — platformHoldings and platformSips. The client's Portfolio tab,
   Portfolio Review, the Main Dashboard's book AUM and the monthly AUM
   ledger all show it without knowing it came from here.

   Storage. An upload's description lives in `assetUploads`. Its rows live
   under a key of their own, `assetRows.<upload id>`, written once and
   never rewritten: a month of platform-wise files is tens of thousands of
   rows, and one store holding all of them would soon pass what one write
   may carry. The keys are loaded into DB like any store, so a full backup
   carries them.

   This file is loaded before BOSS and only defines things; nothing in it
   runs until BOSS calls it.
   ===================================================================== */

const MA_PRODUCTS = ['MF','Stocks','PMS','AIF','Bonds','LAS','Other'];
const MA_PRODUCT_LABEL = {MF:'Mutual Funds', Stocks:'Stocks', PMS:'PMS', AIF:'AIF', Bonds:'Bonds',
  LAS:'LAS (loans against securities)', Other:'Other'};
const MA_LOANS = 'LAS';
const MA_UNASSIGNED = 'Unassigned';
/* The platforms from the firm's Multi Asset System Workflow sheet. More
   are added from the Upload page and kept in config. */
const MA_DEFAULT_PLATFORMS = [
  ['MF', ['Finowise','Freedomlifex','NJ','Anand Rathi']],
  ['Stocks', ['Motilal Oswal','Omni Science','Piper Serica','Philip Capital']],
  ['PMS', ['NJ','Omni Science','AMETRA']],
  ['AIF', ['Piper Serica']],
  ['Bonds', ['Philip Capital']],
  ['LAS', ['Volt Money']],
  ['Other', ['GIFT CITY']],
];
/* The asset class a row takes when its file gives none that is recognised. */
const MA_DEFAULT_ASSET = {MF:'Mutual Fund', Stocks:'Equity', PMS:'PMS', AIF:'AIF', Bonds:'Debt', LAS:'Loan', Other:'Other'};
const MA_HOLDING_FIELDS = ['client_id','asset_class','category','security_name','isin','identifier','quantity',
  'avg_cost','invested','current_price','current_value','gain_loss','return_pct','xirr','as_of','start_date','end_date','level'];
const MA_SIP_FIELDS = ['client_id','asset_class','security_name','isin','identifier','sip_amount','monthly_amount',
  'frequency','sip_day','start_date','end_date','status','live','as_of'];
const MA_NUMERIC = new Set(['quantity','avg_cost','invested','current_price','current_value','gain_loss','return_pct',
  'xirr','sip_amount','monthly_amount']);
const MA_KEEP_OBJECTS = ['sleeves', 'extra', 'src'];
const MA_MAX_BYTES = 8 * 1024 * 1024;
const MA_KEEP_FILE_BYTES = 3 * 1024 * 1024;     // originals up to this size are kept for download
const MA_KIND_LABEL = {aum:'AUM', sip:'SIP'};
const MA_PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/* What the module is holding while it runs. */
const MA = {cache:null, picked:{}, uploadType:'platform', clientName:'', snapDate:'', busy:false, createClients:true, overwrite:false, rm:'', noRmRm:'',
  msg:'', result:null, addOpen:false, sipLive:true, sipQ:'', sipProduct:'', sipPlatform:'', clientQ:'',
  histQ:''};

const maKey = s => String(s == null ? '' : s).trim().split(/\s+/).filter(Boolean).join(' ').toLowerCase();
const maTidy = s => String(s == null ? '' : s).trim().split(/\s+/).filter(Boolean).join(' ');
const maNum = v => (v === null || v === undefined || v === '' || !isFinite(Number(v))) ? null : Number(v);
const maRound = (n, d) => Math.round(n * Math.pow(10, d)) / Math.pow(10, d);
const maRowsKey = id => 'assetRows.' + id;
const maFileKey = id => 'assetFile.' + id;
function maIsRowsKey(k){ return /^assetRows\./.test(String(k || '')); }
function maToday(){ return new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); }
function maPanOf(v){ const p = String(v || '').replace(/\s+/g, '').toUpperCase(); return MA_PAN.test(p) ? p : null; }

/* =====================================================================
   READING A FILE

   The firm's extractor, unchanged in what it recognises: every sheet or
   PDF page is scanned for a header row whose cells match the synonyms
   below, and the rows under it become holdings (an AUM file) or SIP
   registrations (a SIP file). Excel is read by BOSS's own reader
   (workbookSheets: .xlsx, .xls, the HTML ".xls" platforms send, CSV), and
   a PDF by pdf.js, which is loaded only when a PDF is chosen.
   ===================================================================== */
const MaExtract = (function(){
  const AUM_FIELDS = ['client_name','client_id','pan','mobile','email','dob','branch','rm_name','associate','asset_class','category','security_name','isin','identifier','quantity',
    'avg_cost','invested','current_price','current_value','gain_loss','return_pct','xirr','as_of','start_date','end_date','level'];
  const CLIENT_SYNONYMS = {
    client_name: ['client name','client','investor name','investor','customer name','customer',
      'account holder','account holder name','holder name','first holder','first holder name',
      'applicant name','name of investor','name of client','beneficiary name'],
    client_id: ['client id','client code','ucc','account no','account number',
      'investor id','customer id','dp id','bo id','demat account'],
  };
  /* The client's own details, which fill in the BOSS client record. */
  const DETAIL_SYNONYMS = {
    pan: ['pan','pan no','pan number','pan card','pan card no','investor pan','client pan','first holder pan'],
    mobile: ['mobile','mobile no','mobile number','phone','phone no','phone number','contact no','contact number','cell no'],
    email: ['email','email id','email address','e mail','e mail id','mail id'],
    dob: ['dob','date of birth','birth date'],
    branch: ['branch','branch name'],
    rm_name: ['rm name','relationship manager','relationship manager name'],
    associate: ['associate name','associate','sub broker','sub broker name'],
  };
  const DETAIL_FIELDS = Object.keys(DETAIL_SYNONYMS);
  const AUM_SYNONYMS = Object.assign({
    client_name: CLIENT_SYNONYMS.client_name,
    client_id: CLIENT_SYNONYMS.client_id,
    category: ['asset class','asset type','category','sub category','instrument type','type',
      'product','product type','product category'],
    security_name: ['security name','security','scheme name','scheme','fund name','fund',
      'stock name','stock','instrument','scrip name','scrip','company name','company',
      'holding','holdings','description','particulars','name','asset name','investment','strategy',
      'strategy name','portfolio name','bond name'],
    isin: ['isin','isin code','isin no'],
    identifier: ['symbol','ticker','scrip code','trading symbol','folio no','folio number','folio','code'],
    quantity: ['quantity','qty','units','balance units','no of shares','shares','holding qty',
      'available qty','closing units','unit balance','quantity available'],
    avg_cost: ['avg cost','average cost','avg price','average price','buy price','purchase price',
      'cost price','avg nav','average nav','purchase nav','avg buy price','average buy price','avg cost price'],
    invested: ['invested amount','invested value','invested','investment amount','investment value',
      'amount invested','cost value','total cost','purchase value','buy value','book value',
      'cost of acquisition','cost','inv cost','investment cost','purchase cost'],
    current_price: ['current price','ltp','market price','current nav','nav','last price','cmp',
      'close price','closing price','price','closing nav','latest nav','latest price'],
    current_value: ['current value','market value','present value','valuation','current amount',
      'closing value','mkt value','value','current market value','market val','total value',
      'closing balance','curr value','cur value','outstanding','outstanding amount','loan outstanding',
      'principal outstanding','loan amount','nav value'],
    gain_loss: ['gain loss','gain','p l','pnl','unrealised p l','unrealized p l','unrealised gain',
      'unrealized gain','profit loss','returns','absolute return','notional gain','net gain','overall gain'],
    return_pct: ['gain %','return %','returns %','p l %','pnl %','change %','% change',
      'abs return %','absolute return %','net chg %','% gain','abs ret %'],
    xirr: ['xirr','xirr %','cagr','cagr %','annualised return','annualized return','irr'],
    as_of: ['as on','as of','valuation date','nav date','date','price date'],
    start_date: ['start date','investment date','invested date','inv date','date of investment','purchase date',
      'buy date','first purchase date','first investment date','allotment date','open date','inception date'],
    end_date: ['end date','maturity date','maturity','redemption date','close date','closing date','expiry date',
      'lock in date','lock in end date','exit date'],
  }, DETAIL_SYNONYMS);
  const AUM_IGNORE = new Set(['realised gain','realized gain','realised p l','realized p l','realised gain loss',
    'dividend','dividend amount','sch wgt %','weight %','weightage %','avg days','holding days','sip date']);
  const AUM_NUMERIC = new Set(['quantity','avg_cost','invested','current_price','current_value','gain_loss','return_pct','xirr']);

  const SIP_FIELDS = ['client_name','client_id','pan','mobile','email','dob','branch','rm_name','associate','asset_class','security_name','isin','identifier','sip_amount',
    'frequency','sip_day','start_date','end_date','status','as_of'];
  const SIP_SYNONYMS = Object.assign({
    client_name: CLIENT_SYNONYMS.client_name,
    client_id: CLIENT_SYNONYMS.client_id,
    security_name: ['scheme name','scheme','fund name','fund','security name','security','instrument',
      'product name','particulars','name','stock name','strategy','strategy name','plan name'],
    isin: ['isin','isin code','isin no'],
    identifier: ['folio no','folio number','folio','sip reg no','sip registration no','registration no',
      'reg no','sip id','sip no','umrn','mandate id'],
    sip_amount: ['sip amount','amount','installment amount','instalment amount','sip installment',
      'sip instalment','monthly sip','sip value','sip amt','installment amt','investment amount','sip'],
    frequency: ['frequency','sip frequency','freq','periodicity','installment frequency'],
    sip_day: ['sip date','sip day','installment day','instalment day','debit date','deduction date',
      'sip debit day','installment date','debit day','ecs date','ecs day'],
    start_date: ['start date','sip start date','from date','registration date','reg date','start','sip start'],
    end_date: ['end date','sip end date','to date','end','expiry date','sip end','cease date'],
    status: ['status','sip status','state','registration status'],
    as_of: ['as on','as of','report date'],
  }, DETAIL_SYNONYMS);
  const SIP_NUMERIC = new Set(['sip_amount']);
  const SIP_IGNORE = new Set(['no of installments','installments','total installments','pending installments',
    'installments paid','units','nav','current value','market value']);
  const MONTHLY_FACTOR = {daily:21, weekly:52/12, fortnightly:26/12, monthly:1, quarterly:1/3,
    'half yearly':1/6, yearly:1/12, annual:1/12};

  function normFrequency(f){
    const s = String(f || '').toLowerCase();
    if(!s) return 'Monthly';
    if(/daily|day/.test(s)) return 'Daily';
    if(/fortnight|bi-?week/.test(s)) return 'Fortnightly';
    if(/week/.test(s)) return 'Weekly';
    if(/quarter/.test(s)) return 'Quarterly';
    if(/half|semi/.test(s)) return 'Half Yearly';
    if(/year|annual/.test(s)) return 'Yearly';
    return 'Monthly';
  }
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const round = (n, d) => Math.round(n * Math.pow(10, d)) / Math.pow(10, d);
  const blank = c => c === null || c === undefined || String(c).trim() === '';

  function completeSip(rec){
    rec.frequency = normFrequency(rec.frequency);
    if(rec.sip_day !== null && rec.sip_day !== undefined){
      const d = /^\d{4}-\d{2}-(\d{2})/.exec(String(rec.sip_day));
      const n = d ? Number(d[1]) : parseNumber(rec.sip_day);
      rec.sip_day = n && n >= 1 && n <= 31 ? Math.round(n) : null;
    }
    const st = String(rec.status || '').toLowerCase();
    if(/cease|cancel|stop|inactive|terminat|closed|expired|reject|fail|pause|discontinu|matured/.test(st)) rec.live = false;
    else if(/active|live|registered|running|approved|success|ongoing|confirmed/.test(st)) rec.live = true;
    else rec.live = !(rec.end_date && /^\d{4}-\d{2}-\d{2}$/.test(rec.end_date) && rec.end_date < todayIso());
    if(!rec.status) rec.status = rec.live ? 'Active' : 'Ended';
    const f = MONTHLY_FACTOR[rec.frequency.toLowerCase()];
    rec.monthly_amount = rec.sip_amount !== null ? round(rec.sip_amount * (f === undefined ? 1 : f), 2) : null;
    rec.asset_class = inferAssetClass(rec.security_name, rec.isin, rec.identifier, null);
    if(!rec.security_name) rec.security_name = rec.identifier || rec.isin;
    return rec;
  }

  const PROFILES = {
    aum: {fields: AUM_FIELDS, synonyms: AUM_SYNONYMS, ignore: AUM_IGNORE, numeric: AUM_NUMERIC,
      dates: new Set(['as_of','start_date','end_date','dob']),
      nameFields: ['security_name','identifier','isin'], amountFields: ['quantity','current_value','invested','current_price'],
      requiredAny: ['quantity','current_value','invested'], special: true, complete: null},
    sip: {fields: SIP_FIELDS, synonyms: SIP_SYNONYMS, ignore: SIP_IGNORE, numeric: SIP_NUMERIC,
      dates: new Set(['as_of','start_date','end_date','dob']),
      nameFields: ['security_name','identifier','isin'], amountFields: ['sip_amount'],
      requiredAny: ['sip_amount'], special: false, complete: completeSip},
  };
  let P = PROFILES.aum;
  /* Reading SIPs out of an AUM statement nobody called a SIP file asks for
     more: a column that only a SIP table has (a frequency, a SIP day, or
     "SIP" in its heading). Otherwise a holdings table with an "Invested
     Amount" column would come back as one SIP per scheme. */
  let STRICT = false;
  /* Column names the firm has taught it (Upload page › Column names):
     a heading, exactly as a file spells it, and the field it is. */
  let CUSTOM = new Map();
  const TOTAL_ROW = /^(grand\s+)?(sub\s*)?total\b|^net\s+total|^overall/i;
  const CLIENT_HEADING = /^(?:client|investor|customer|account\s+holder|holder)(?:\s*name)?\s*[:\-–]\s*(.+?)(?:\s+(?:pan|client\s*(?:id|code)|ucc)(?:\s*no)?\s*[:\-–]\s*([A-Z0-9]+))?\s*$/i;
  const NAME_PAN = /^(?:(?:client|investor|customer)?\s*name\s*[:\-–]\s*)?([A-Za-z][A-Za-z .'&-]{1,80}?)\s*\(\s*([A-Z]{5}[0-9]{4}[A-Z])\s*\)\s*$/;
  const SECTION_END = /\b(transactions?|txn|trxn|realised|realized|redeemed|redemptions?|past|closed|sold|switch(es)?|capital gains?|dividend history|stp|swp|cash ?flows?|sip details|sip summary|systematic)\b/i;
  const TXN_HEADER = /\b(transaction|txn|trxn|tran(s)? type|purchase type|redemption|switch in|switch out)\b/;
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function norm(text){
    let s = String(text == null ? '' : text).toLowerCase().replace(/&/g, ' ').replace(/\//g, ' ').replace(/\n/g, ' ');
    s = s.indexOf('%') >= 0 ? s.replace(/[()]/g, ' ') : s.replace(/\(.*?\)/g, ' ');
    s = s.replace(/[^a-z0-9% ]+/g, ' ').replace(/\b(pct|percent|percentage)\b/g, '%');
    return s.split(/\s+/).filter(Boolean).join(' ');
  }
  function matchField(header){
    const h = norm(header);
    if(!h || h.length > 60) return null;
    if(CUSTOM.has(h)) return CUSTOM.get(h);
    if(P.ignore.has(h)) return null;
    if(P.special){
      if(/\b(xirr|cagr)\b/.test(h)) return 'xirr';
      if(h.indexOf('%') >= 0 && /gain|return|ret|rtn|p l|pnl|chg|change/.test(h) && !/annuali[sz]ed/.test(h)) return 'return_pct';
    }
    let best = null, bestScore = 0;
    Object.keys(P.synonyms).forEach(field=>{
      P.synonyms[field].forEach(syn=>{
        let score;
        if(h === syn) score = 100 + syn.length;
        else if(new RegExp('(^|\\s)' + reEsc(syn) + '(\\s|$)').test(h)) score = syn.length;
        else return;
        if(score > bestScore){ best = field; bestScore = score; }
      });
    });
    if(P.special && best === 'return_pct' && h.indexOf('%') < 0 && h.indexOf('xirr') < 0) best = 'gain_loss';
    return best;
  }
  function parseNumber(value){
    if(value === null || value === undefined || typeof value === 'boolean') return null;
    if(typeof value === 'number') return isFinite(value) ? value : null;
    let s = String(value).trim();
    if(!s || ['-','--','—','NA','N/A','nil'].indexOf(s) >= 0) return null;
    const negative = (s.charAt(0) === '(' && s.slice(-1) === ')') || (s.slice(-1) === '-' && s.length > 1);
    s = s.replace(/\(\s*\d{1,2}[-/.][A-Za-z0-9]{1,9}[-/.]\d{2,4}\s*\)/g, ' ').trim();
    // A date is not a number, however many digits it has.
    if(/^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{1,2}[-/][A-Za-z0-9]{1,9}[-/]\d{2,4}$/.test(s)) return null;
    s = s.replace(/\b(rs|inr|usd|cr|dr)\b\.?/gi, '').replace(/−/g, '-').replace(/[^\d.\-eE]/g, '');
    if(!s || s === '-' || s === '.') return null;
    const num = Number(s);
    if(!isFinite(num)) return null;
    return negative ? -Math.abs(num) : num;
  }
  const MONTHS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const pad = n => String(n).padStart(2, '0');
  function parseDate(value){
    const s = String(value == null ? '' : value).trim();
    if(!s) return null;
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if(m) return m[1] + '-' + m[2] + '-' + m[3];
    m = /^(\d{1,2})[-/ ]([A-Za-z]{3,9}|\d{1,2})[-/ ](\d{2,4})$/.exec(s);
    if(m){
      const mon = /\d/.test(m[2]) ? Number(m[2]) : MONTHS[m[2].slice(0, 3).toLowerCase()];
      let year = Number(m[3]);
      if(year < 100) year += 2000;
      if(mon) return year + '-' + pad(mon) + '-' + pad(Number(m[1]));
    }
    /* A bare Excel day count, from a cell the workbook did not style as a date. */
    if(/^\d{5}(\.\d+)?$/.test(s) && Number(s) > 20000 && Number(s) < 80000 && typeof xlsxSerialToDate === 'function')
      return xlsxSerialToDate(Math.floor(Number(s)));
    return s;
  }
  function inferAssetClass(name, isin, symbol, category){
    const n = ((name || '') + ' ' + (symbol || '')).toLowerCase();
    const i = (isin || '').toUpperCase();
    const sym = (symbol || '').toUpperCase();
    const c = (category || '').toLowerCase();
    if(/\bsgb|sovereign gold|gold bond/.test(n)) return 'Gold';
    if(/\betf\b|bees\b/.test(n) || c.indexOf('etf') >= 0) return 'ETF';
    if(/^INF[A-Z0-9]{9}$/.test(i) || /\b(fund|scheme|growth|idcw|dividend plan|direct plan|regular plan)\b/.test(n)) return 'Mutual Fund';
    if(/\b(bond|debenture|ncd|g-sec|gsec|t-bill|treasury)\b/.test(n)) return 'Debt';
    if(/\b(fd|fixed deposit)\b/.test(n) || /fixed deposit|\bfd\b/.test(c)) return 'Fixed Deposit';
    if(/\bpms\b|portfolio management/.test(c)) return 'PMS';
    if(/\baif\b|alternative investment/.test(c)) return 'AIF';
    if(/insurance|ulip/.test(c) || /\bulip\b/.test(n)) return 'Insurance';
    if(/\bnps\b|national pension/.test(c + ' ' + n)) return 'NPS';
    if(/bond|debt|debenture|ncd/.test(c) && c.indexOf('fund') < 0) return 'Debt';
    if(/\b(equity|stock|share)s?\b/.test(c) && c.indexOf('fund') < 0 && c.indexOf('mutual') < 0) return 'Equity';
    if(c.indexOf('mutual') >= 0 || c.indexOf('fund') >= 0) return 'Mutual Fund';
    if(/^INE[A-Z0-9]{9}$/.test(i) || /^[A-Z&-]{2,20}$/.test(sym || '-')) return 'Equity';
    return category ? String(category).trim().replace(/\b\w/g, ch=>ch.toUpperCase()) : 'Unclassified';
  }
  function findHeader(rows, maxScan){
    const scan = maxScan || (P.special ? 40 : 400);
    let best = null;
    rows.slice(0, scan).forEach((row, idx)=>{
      const mapping = {}, used = new Set();
      row.forEach((cell, col)=>{
        const field = matchField(cell);
        if(field && !used.has(field)){ mapping[col] = field; used.add(field); }
      });
      const hasName = P.nameFields.some(f=>used.has(f));
      const hasAmount = P.amountFields.some(f=>used.has(f));
      const sipLike = !STRICT || P !== PROFILES.sip || used.has('frequency') || used.has('sip_day')
        || row.some(c=>/\bsip\b/.test(norm(c)));
      if(hasName && hasAmount && sipLike && Object.keys(mapping).length >= 2
         && (!best || Object.keys(mapping).length > Object.keys(best.mapping).length)){
        best = {index: idx, mapping};
      }
    });
    return best;
  }
  function readHeading(row, ctx){
    const cells = row.filter(c=>!blank(c)).map(c=>String(c).trim());
    const m = CLIENT_HEADING.exec(cells.join(' ')) || (cells.length && NAME_PAN.exec(cells[0].split(/\n/)[0].trim()));
    if(!m) return false;
    ctx.client = m[1].trim();
    ctx.clientId = m[2] || null;
    return true;
  }
  const SUMMARY_LABEL = 'All schemes (investor total)';
  function summaryMapping(row, mapping){
    if(P !== PROFILES.aum) return mapping;
    const fields = Object.values(mapping);
    const nameCol = Object.keys(mapping).find(c=>mapping[c] === 'security_name');
    const head = nameCol !== undefined ? norm(row[nameCol]) : '';
    const investorWise = nameCol !== undefined && (fields.indexOf('client_id') >= 0 || fields.indexOf('pan') >= 0) && fields.indexOf('client_name') < 0
      && /^(name|investor|investor name|client|client name|customer name)$/.test(head)
      && !['isin','identifier','quantity'].some(f=>fields.indexOf(f) >= 0);
    if(!investorWise) return mapping;
    const m = Object.assign({}, mapping, {[nameCol]: 'client_name'});
    Object.defineProperty(m, 'summary', {value: true});
    return m;
  }
  const isText = c => typeof c === 'string' && parseNumber(c) === null && !/^\d{4}-\d{2}-\d{2}$/.test(c.trim());
  function rowsToHoldings(rows, mapping, start, ctx){
    ctx = ctx || {};
    const holdings = [];
    for(const row of rows.slice(start)){
      if(row.every(blank)) continue;
      if(readHeading(row, ctx)) continue;
      const texts = row.filter(c=>!blank(c));
      if(texts.length <= 2 && texts.every(c=>typeof c === 'string' && parseNumber(c) === null) && SECTION_END.test(texts.join(' '))) break;
      const fieldCells = row.filter(c=>typeof c === 'string' && matchField(c)).length;
      if(fieldCells >= 3 && !row.some(c=>!blank(c) && !isText(c))){
        if(row.some(c=>typeof c === 'string' && TXN_HEADER.test(norm(c)))) break;
        const next = findHeader([row]);
        if(next){ mapping = summaryMapping(row, next.mapping); continue; }
        break;
      }
      const rec = {};
      P.fields.forEach(f=>{ rec[f] = null; });
      Object.keys(mapping).forEach(col=>{
        const field = mapping[col];
        const val = row[col];
        if(blank(val)) return;
        if(P.numeric.has(field)) rec[field] = parseNumber(val);
        else if(P.dates.has(field)) rec[field] = parseDate(val);
        else rec[field] = String(val).split(/\s+/).filter(Boolean).join(' ');
      });
      if(mapping.summary){
        if(!rec.client_name || row.some(c=>typeof c === 'string' && TOTAL_ROW.test(c.trim()))) continue;
        rec.level = 'summary'; rec.security_name = SUMMARY_LABEL;
      }
      const label = rec.security_name || rec.identifier || rec.isin || '';
      if(!label || TOTAL_ROW.test(label) || P.synonyms.security_name.indexOf(norm(label)) >= 0) continue;
      if(!P.requiredAny.some(f=>rec[f] !== null)) continue;
      if(!rec.client_name && ctx.client){
        rec.client_name = ctx.client;
        rec.client_id = rec.client_id || ctx.clientId;
      }
      holdings.push(P.complete(rec));
    }
    return holdings;
  }
  function complete(rec){
    const q = rec.quantity;
    if(rec.invested === null && q !== null && rec.avg_cost !== null) rec.invested = round(q * rec.avg_cost, 2);
    if(rec.current_value === null && q !== null && rec.current_price !== null) rec.current_value = round(q * rec.current_price, 2);
    if(rec.avg_cost === null && q && rec.invested !== null) rec.avg_cost = round(rec.invested / q, 4);
    if(rec.current_price === null && q && rec.current_value !== null) rec.current_price = round(rec.current_value / q, 4);
    if(rec.gain_loss === null && rec.current_value !== null && rec.invested !== null) rec.gain_loss = round(rec.current_value - rec.invested, 2);
    if(rec.return_pct === null && rec.gain_loss !== null && rec.invested) rec.return_pct = round(rec.gain_loss / rec.invested * 100, 2);
    rec.asset_class = inferAssetClass(rec.security_name, rec.isin, rec.identifier, rec.category);
    if(!rec.security_name) rec.security_name = rec.identifier || rec.isin;
    return rec;
  }
  PROFILES.aum.complete = complete;
  function tablesToHoldings(tables){
    let holdings = [];
    const ctx = {};
    for(const rows of tables){
      if(!rows.length) continue;
      const found = findHeader(rows);
      if(!found) continue;
      const mapping = summaryMapping(rows[found.index], found.mapping);
      rows.slice(0, found.index).forEach(r=>readHeading(r, ctx));
      holdings = holdings.concat(rowsToHoldings(rows, mapping, found.index + 1, ctx));
    }
    return holdings;
  }
  function reportDate(texts){
    const re = /(?:as\s+on|as\s+of|as\s+at|statement\s+date|valuation\s+date|report\s+date|holding\s+date)[:\s]*(\d{1,2}[-/ ][A-Za-z0-9]{2,9}[-/ ]\d{2,4}|\d{4}-\d{2}-\d{2})/i;
    for(const t of texts){ const m = re.exec(t); if(m) return parseDate(m[1]); }
    return null;
  }
  function applyReportDate(rows, date){ if(date) rows.forEach(h=>{ h.as_of = h.as_of || date; }); }

  /* Excel, and everything else BOSS's reader opens. Its cells are strings
     with the holes of a sparse sheet; they are made dense here so a blank
     cell is a null, as the extractor expects. */
  async function extractExcel(file){
    const book = await workbookSheets(file);
    const tables = [], headerText = [], notes = [];
    let read = 0;
    book.sheets.forEach(s=>{
      if(/transaction|txn/i.test(s.name || '')) return;
      read++;
      const rows = (s.rows || []).map(r=>Array.from(r || [], v=>(v === undefined || v === '') ? null : v));
      tables.push(rows);
      rows.slice(0, 15).forEach(r=>headerText.push(r.filter(c=>!blank(c)).join(' ')));
    });
    const holdings = tablesToHoldings(tables);
    applyReportDate(holdings, reportDate(headerText));
    if(read > 1) notes.push(read + ' sheets scanned');
    return {holdings, notes};
  }

  /* PDFs have no tables, only positioned text: words are grouped into lines
     by their height on the page, and into cells where the gap between
     words is large. */
  function pageLines(items){
    const words = items.filter(it=>it.str && it.str.trim())
      .map(it=>({text: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || 8}));
    words.sort((a, b)=>b.y - a.y || a.x - b.x);
    const lines = [];
    for(const w of words){
      const line = lines.find(l=>Math.abs(l.y - w.y) <= Math.max(2, w.h * 0.4));
      if(line) line.words.push(w); else lines.push({y: w.y, words: [w]});
    }
    return lines.map(l=>{
      l.words.sort((a, b)=>a.x - b.x);
      const cells = [];
      for(const w of l.words){
        const prev = cells[cells.length - 1];
        const gap = prev ? w.x - prev.x1 : Infinity;
        if(prev && gap < w.h * 0.9){
          prev.text += (gap > w.h * 0.15 ? ' ' : '') + w.text;
          prev.x1 = w.x + w.w;
        } else cells.push({text: w.text, x0: w.x, x1: w.x + w.w});
      }
      cells.forEach(c=>{ c.text = c.text.trim(); });
      cells.y = l.y; cells.h = Math.max(...l.words.map(w=>w.h));
      return cells;
    });
  }
  /* A holding whose name wraps onto two or three lines prints its figures
     on one of them and its name on another, a line above or below. Those
     halves are put back together; a name-only line with no figures near it
     is a wrapped tail and is dropped. */
  function joinWrapped(rows, mapping){
    const fieldCol = f => Object.keys(mapping).find(k=>mapping[k] === f);
    const nameCol = fieldCol('security_name');
    const valCols = ['current_value', 'invested', 'quantity'].map(fieldCol).filter(x=>x !== undefined);
    if(nameCol === undefined || !valCols.length) return rows.map(r=>r.row);
    const nameOf = r => String(r.row[nameCol] == null ? '' : r.row[nameCol]).replace(/^\d{1,3}\s+/, '').trim();
    const hasName = r => /[A-Za-z]{2,}/.test(nameOf(r));
    const hasVal = r => valCols.some(i=>parseNumber(r.row[i]) !== null);
    const near = (a, b) => a && b && Math.abs(a.y - b.y) <= 3 * Math.max(a.h || 8, b.h || 8);
    const out = [];
    let pendVal = null, pendName = null;
    rows.forEach(r=>{
      // A Total line is never half of a holding.
      if(r.row.some(c=>/^(grand\s+|sub\s*)?total\b/i.test(String(c == null ? '' : c).trim()))){ out.push(r.row); pendVal = pendName = null; return; }
      const n = hasName(r), v = hasVal(r);
      // "1 Coal India Limited": the serial number printed under "Sr." is not part of the name.
      if(n && v){ const row = r.row.slice(); row[nameCol] = nameOf(r); out.push(row); pendVal = pendName = null; return; }
      if(v){
        if(near(pendName, r)){ const row = r.row.slice(); row[nameCol] = nameOf(pendName); out.push(row); pendName = null; }
        else pendVal = r;
        return;
      }
      if(n){
        if(near(pendVal, r)){ const row = pendVal.row.slice(); row[nameCol] = nameOf(r); out.push(row); pendVal = null; }
        else pendName = r;
        return;
      }
      out.push(r.row);
    });
    return out;
  }
  function alignToColumns(cells, columns){
    const row = new Array(columns.length).fill(null);
    /* A page laid out in two halves (a sector table beside the holdings)
       puts both on one line: text wholly outside the table's own width
       belongs to the other half and is left out. */
    const left = Math.min(...columns.map(c=>c.x0)), right = Math.max(...columns.map(c=>c.x1));
    const pad = Math.max(24, (right - left) * 0.08);
    for(const c of cells){
      if(c.x1 < left - pad || c.x0 > right + pad) continue;
      let bestCol = -1, bestScore = -Infinity;
      columns.forEach((col, i)=>{
        const overlap = Math.min(c.x1, col.x1) - Math.max(c.x0, col.x0);
        const dist = Math.abs((c.x0 + c.x1) / 2 - (col.x0 + col.x1) / 2);
        const score = overlap > 0 ? 1000 + overlap : -dist;
        if(score > bestScore){ bestScore = score; bestCol = i; }
      });
      /* Two figures under one heading — "Mkt Value %Assets" printed as a
         single caption — are two columns, not one number: 22,815 and
         1.14% must not run together into 228151.14. The first is kept. */
      const isFig = t => /^[(\-−]?[₹$]?\s*[\d,]+(\.\d+)?\s*%?\)?$/.test(String(t).trim());
      if(row[bestCol] !== null && isFig(row[bestCol]) && isFig(c.text)) continue;
      row[bestCol] = row[bestCol] === null ? c.text : row[bestCol] + ' ' + c.text;
    }
    return row;
  }
  async function extractPdf(buffer, password){
    const lib = await maLoadPdfJs();
    /* Text is all that is read. isEvalSupported off keeps pdf.js from ever
       compiling a font program, which text extraction has no use for. */
    const pdf = await lib.getDocument({data: new Uint8Array(buffer), password: password || undefined,
      isEvalSupported: false}).promise;
    const notes = [], texts = [];
    let columns = null, mapping = null, holdings = [], block = [];
    const ctx = {};
    const flush = () => {
      if(block.length && mapping) holdings = holdings.concat(rowsToHoldings(joinWrapped(block, mapping), mapping, 0, ctx));
      block = [];
    };
    for(let p = 1; p <= pdf.numPages; p++){
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const lines = pageLines(content.items);
      texts.push(lines.map(cells=>cells.map(c=>c.text).join(' ')).join('\n'));
      for(const cells of lines){
        const raw = cells.map(c=>c.text);
        const header = findHeader([raw]);
        if(header){ flush(); columns = cells; mapping = header.mapping; }
        else if(!readHeading(raw, ctx) && columns) block.push({row: alignToColumns(cells, columns), y: cells.y, h: cells.h});
      }
      flush();
    }
    if(!texts.some(t=>t.trim())) notes.push('PDF has no text layer (scanned image); holdings could not be read');
    applyReportDate(holdings, reportDate(texts.slice(0, 2)));
    return {holdings, notes};
  }

  /* kind: 'aum' (holdings) or 'sip' (SIP registrations). */
  async function extract(file, buffer, format, password, kind, strict){
    P = PROFILES[kind] || PROFILES.aum;
    STRICT = !!strict;
    CUSTOM = new Map();
    maColumnNames().forEach(c=>{
      if((c.kind === 'both' || c.kind === (P === PROFILES.sip ? 'sip' : 'aum')) && P.fields.indexOf(c.field) >= 0) CUSTOM.set(norm(c.heading), c.field);
    });
    return format === 'pdf' ? extractPdf(buffer, password) : extractExcel(file);
  }
  function matchFieldFor(header, kind){ P = PROFILES[kind || 'aum']; CUSTOM = new Map(); return matchField(header); }
  return {extract, matchField: matchFieldFor, parseNumber, parseDate, inferAssetClass, completeSip, norm,
    fields: {aum: AUM_FIELDS, sip: SIP_FIELDS, details: DETAIL_FIELDS}};
})();

let _maPdf = null;
function maLoadPdfJs(){
  const have = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
  if(have) return Promise.resolve(have);
  if(_maPdf) return _maPdf;
  _maPdf = new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    s.src = '/lib/pdfjs/pdf.min.js';
    s.onload = ()=>{
      const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
      if(!lib){ _maPdf = null; reject(new Error('The PDF reader did not start.')); return; }
      lib.GlobalWorkerOptions.workerSrc = '/lib/pdfjs/pdf.worker.min.js';
      resolve(lib);
    };
    s.onerror = ()=>{ _maPdf = null; reject(new Error('The PDF reader could not be loaded.')); };
    document.head.appendChild(s);
  });
  return _maPdf;
}

/* =====================================================================
   THE PLATFORMS, THE UPLOADS AND THEIR ROWS
   ===================================================================== */
function maPlatforms(){
  const cfg = (typeof DB !== 'undefined' && DB.config && DB.config.assetPlatforms) || null;
  if(Array.isArray(cfg) && cfg.length) return cfg;
  const out = [];
  MA_DEFAULT_PLATFORMS.forEach(([product, names])=>names.forEach(name=>out.push({id: maKey(product + ' ' + name).replace(/\s+/g, '-'), name, product})));
  return out;
}
function maUploads(){ return (DB.assetUploads || []).filter(u=>u && !u.deletedAt); }
function maRowsOf(u){ const v = DB[maRowsKey(u.id)]; return Array.isArray(v) ? v : []; }

/* Every upload's rows into DB, under the upload's own key. Called by
   loadAll(); only the keys not already held are fetched. */
async function maLoadRows(){
  const ups = maUploads();
  const want = new Set(ups.map(u=>maRowsKey(u.id)));
  Object.keys(DB).forEach(k=>{ if(maIsRowsKey(k) && !want.has(k)) delete DB[k]; });
  const missing = ups.filter(u=>!Array.isArray(DB[maRowsKey(u.id)]));
  for(let i = 0; i < missing.length; i += 8){
    await Promise.all(missing.slice(i, i + 8).map(async u=>{ DB[maRowsKey(u.id)] = await sget(maRowsKey(u.id), []); }));
  }
  MA.cache = null;
}

/* ---- which BOSS client a row belongs to ------------------------------
   The client's own record when the row can be tied to one — by the client
   the upload was made for, then PAN, then name (only when one client has
   it). A row that matches nobody is still somebody: it is kept under its
   PAN, or under its name, and shows on these screens as it was uploaded. */
function maClientIndex(){
  const clients = (DB.clients || []).filter(c=>c && !c.deletedAt);
  const byId = new Map(clients.map(c=>[c.id, c]));
  return Object.assign(impClientIndex(clients), {byId});
}
function maResolver(allRows){
  const idx = maClientIndex();
  /* A name that was only ever seen with one PAN is that PAN. */
  const pansOfName = new Map();
  allRows.forEach(r=>{
    const p = maPanOf(r.pan || r.client_id);
    const n = maKey(r.client_name);
    if(p && n){ if(!pansOfName.has(n)) pansOfName.set(n, new Set()); pansOfName.get(n).add(p); }
  });
  const memo = new Map();
  return r=>{
    const pan = maPanOf(r.pan || r.client_id);
    const memoKey = (r.cid || '') + '|' + (pan || '') + '|' + maKey(r.client_name);
    if(memo.has(memoKey)) return memo.get(memoKey);
    let out = null;
    const hit = c => ({ck: 'c:' + c.id, clientId: c.id, name: c.cmsName || r.client_name || MA_UNASSIGNED, pan: maPanOf(c.pan) || pan});
    if(r.cid && idx.byId.has(r.cid)) out = hit(idx.byId.get(r.cid));
    if(!out && pan){ const h = idx.byPan.get(pan) || []; if(h.length === 1) out = hit(h[0]); }
    const nm = maKey(r.client_name);
    if(!out && nm && nm !== maKey(MA_UNASSIGNED) && !pan){
      const h = idx.byName.get(nm) || []; if(h.length === 1) out = hit(h[0]);
    }
    if(!out){
      let p = pan;
      if(!p && nm && pansOfName.has(nm) && pansOfName.get(nm).size === 1) p = Array.from(pansOfName.get(nm))[0];
      if(p){
        const h = idx.byPan.get(p) || [];
        out = h.length === 1 ? hit(h[0]) : {ck: 'p:' + p, clientId: '', name: maTidy(r.client_name) || MA_UNASSIGNED, pan: p};
      } else out = {ck: 'n:' + (nm || maKey(MA_UNASSIGNED)), clientId: '', name: maTidy(r.client_name) || MA_UNASSIGNED, pan: null};
    }
    memo.set(memoKey, out);
    return out;
  };
}

/* =====================================================================
   WHAT THE SCREENS SHOW: THE NEWEST VERSION OF EACH

   The firm's rule, as the original system's views had it:
     · a holding is one client + category + platform (MF: any platform,
       because two platforms report the same folio) + identifier + ISIN or
       name, and the newest upload holding it wins;
     · an investor-total row (a report with no schemes) counts only when
       no scheme rows exist for that client + category + platform;
     · a SIP is the same rule as a holding.
   ===================================================================== */
function maState(){
  const c = MA.cache;
  if(c && c.uploadsRef === DB.assetUploads && c.clientsRef === DB.clients && c.nUp === (DB.assetUploads || []).length
     && c.nCl === (DB.clients || []).length && Date.now() - c.at < 1500) return c;
  const ups = maUploads();
  const all = [];
  ups.forEach(u=>maRowsOf(u).forEach(r=>{
    Object.defineProperty(r, '_u', {value: u, enumerable: false, writable: true, configurable: true});
    all.push(r);
  }));
  const who = maResolver(all);
  all.forEach(r=>{
    const w = who(r);
    Object.defineProperty(r, '_c', {value: w, enumerable: false, writable: true, configurable: true});
  });
  const holdRows = all.filter(r=>r._u.kind !== 'sip');
  const sipRows = all.filter(r=>r._u.kind === 'sip');
  const idKey = r => r._c.ck + '|' + r.product + '|' + (r.product === 'MF' ? '' : r.platform_key) + '|'
    + String(r.identifier || '').toLowerCase() + '|' + (String(r.isin || '').toUpperCase() || String(r.security_name || '').toLowerCase());
  const newest = (rows, keyOf) => {
    const best = new Map();
    rows.forEach(r=>{ const k = keyOf(r), s = r._u.seq || 0; if(!best.has(k) || s > best.get(k)) best.set(k, s); });
    return rows.filter(r=>(r._u.seq || 0) === best.get(keyOf(r)));
  };
  const detail = newest(holdRows.filter(r=>r.level !== 'summary'), idKey);
  const scopeKey = r => r._c.ck + '|' + r.product + '|' + r.platform_key;
  const withDetail = new Set(detail.map(scopeKey));
  const summary = newest(holdRows.filter(r=>r.level === 'summary'), scopeKey).filter(r=>!withDetail.has(scopeKey(r)));
  const holdings = detail.concat(summary);
  const sips = newest(sipRows, idKey);
  const cur = new Set(holdings.concat(sips).map(r=>r._u.id));
  MA.cache = {uploadsRef: DB.assetUploads, clientsRef: DB.clients, nUp: (DB.assetUploads || []).length,
    nCl: (DB.clients || []).length, at: Date.now(), all, holdings, sips, currentUploads: cur};
  return MA.cache;
}
function maInvalidate(){ MA.cache = null; }

/* Who may see which client. A row tied to a BOSS client follows that
   client's visibility, the same as everywhere else in BOSS; a row tied to
   nobody is seen by those who may upload. This mirrors the role hierarchy,
   which BOSS enforces in the browser — it is not a security boundary. */
function maCanUpload(){ return can('CMS','edit') || canAdmin('manageModuleSettings'); }
function maVisibleFilter(){
  if(isAdmin()) return ()=>true;
  const vis = new Set(visibleRecords(DB.clients || [], c=>c.rmName, c=>c.branch).map(c=>c.id));
  const loose = maCanUpload();
  return r => r._c.clientId ? vis.has(r._c.clientId) : loose;
}
function maView(){
  const s = maState(), ok = maVisibleFilter();
  return {holdings: s.holdings.filter(ok), sips: s.sips.filter(ok), all: s.all.filter(ok), currentUploads: s.currentUploads};
}

/* ---- the sums every dashboard draws ---------------------------------- */
function maSums(holdings, sips){
  const inv = holdings.filter(h=>h.product !== MA_LOANS), loans = holdings.filter(h=>h.product === MA_LOANS);
  const t = {holdings: inv.length, invested: 0, current_value: 0, gain_loss: 0, as_of: '', xirrW: 0, xirrBase: 0,
    loans: 0, loan_rows: loans.length, sips: sips.length, live_sips: 0, sip_monthly: 0};
  inv.forEach(h=>{
    t.invested += h.invested || 0; t.current_value += h.current_value || 0; t.gain_loss += h.gain_loss || 0;
    const d = h.as_of || (h._u && h._u.snapshotDate) || '';
    if(/^\d{4}-\d{2}-\d{2}$/.test(d) && d > t.as_of) t.as_of = d;
    if(h.xirr !== null && h.xirr !== undefined){ t.xirrW += h.xirr * (h.current_value || 0); t.xirrBase += h.current_value || 0; }
  });
  loans.forEach(h=>{ t.loans += h.current_value || 0; });
  sips.forEach(s=>{ if(s.live){ t.live_sips++; t.sip_monthly += s.monthly_amount || 0; } });
  t.xirr = t.xirrBase ? t.xirrW / t.xirrBase : null;
  t.return_pct = t.invested ? t.gain_loss / t.invested * 100 : null;
  const people = new Set(holdings.concat(sips).map(r=>r._c.ck));
  const plats = new Set(holdings.concat(sips).map(r=>r.platform_key));
  t.clients = people.size; t.platforms = plats.size;
  t.files = new Set(holdings.concat(sips).map(r=>r._u.id)).size;
  return t;
}
/* Grouped sums: by category, platform, client, asset class. */
function maGroup(holdings, sips, keyOf, labelOf){
  const m = new Map();
  const add = (r, isSip) => {
    const k = keyOf(r);
    if(!m.has(k)) m.set(k, {key: k, label: labelOf(r), h: [], s: []});
    m.get(k)[isSip ? 's' : 'h'].push(r);
  };
  holdings.forEach(r=>add(r, false)); sips.forEach(r=>add(r, true));
  return Array.from(m.values()).map(g=>Object.assign(g, maSums(g.h, g.s), {
    loanValue: g.h.filter(r=>r.product === MA_LOANS).reduce((n, r)=>n + (r.current_value || 0), 0),
    products: Array.from(new Set(g.h.concat(g.s).map(r=>r.product))),
    platformNames: Array.from(new Set(g.h.concat(g.s).map(r=>r.platform))),
  })).sort((a, b)=>b.current_value - a.current_value || b.sip_monthly - a.sip_monthly || b.loanValue - a.loanValue);
}

/* =====================================================================
   AN UPLOAD

   The original system's createUpload, here. Same rules:
     · the exact same file again for the same scope is refused;
     · a client whose rows match what the screens already show for this
       platform + category is left as it is — only clients whose data
       changed get the new rows;
     · anything else is the next version, kept beside the earlier ones.
   ===================================================================== */
function maCleanRow(src, fields){
  const r = {};
  fields.forEach(f=>{
    const v = src[f];
    if(f === 'live') r[f] = v !== false;
    else if(f === 'sip_day') r[f] = v !== null && v !== '' && v !== undefined && Number.isInteger(Number(v)) ? Number(v) : null;
    else r[f] = MA_NUMERIC.has(f) ? maNum(v) : (v === null || v === undefined || v === '') ? null : String(v).slice(0, 300);
  });
  return r;
}
function maSnapshotDate(given, rows){
  if(/^\d{4}-\d{2}-\d{2}$/.test(given || '')) return given;
  const counts = {};
  rows.forEach(r=>{ if(/^\d{4}-\d{2}-\d{2}$/.test(r.as_of || '')) counts[r.as_of] = (counts[r.as_of] || 0) + 1; });
  const best = Object.entries(counts).sort((a, b)=>b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0];
  return best ? best[0] : maToday();
}
async function maSha256(buffer){
  try {
    const d = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(d)).map(b=>b.toString(16).padStart(2, '0')).join('');
  } catch(e){ return null; }
}
function maBufToB64(buf){
  const u8 = new Uint8Array(buf); let s = '';
  for(let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/* body: {uploadType, clientName, clientId, platform, product, kind, batchId, snapshotDate,
          file, format, size, sha256, status, notes, rows, buffer} */
async function maCreateUpload(body){
  const uploadType = body.uploadType === 'client' ? 'client' : 'platform';
  const kind = body.kind === 'sip' ? 'sip' : 'aum';
  const prod = MA_PRODUCTS.indexOf(body.product) >= 0 ? body.product : 'Other';
  const platform = maTidy(body.platform);
  const clientName = uploadType === 'client' ? maTidy(body.clientName) : '';
  if(!platform) throw new Error('Choose the investment platform.');
  if(uploadType === 'client' && !clientName) throw new Error('Enter the client name.');
  const sameScope = u => u.uploadType === uploadType && maKey(u.clientName) === maKey(clientName)
    && maKey(u.platform) === maKey(platform) && u.product === prod && u.kind === kind;
  const scoped = maUploads().filter(sameScope);
  if(body.sha256){
    const dup = scoped.find(u=>u.sha256 === body.sha256);
    if(dup) return {skipped: true, message: 'Already uploaded as version ' + dup.version + ' ("' + dup.file
      + '", data as of ' + fmtDate(dup.snapshotDate) + ').'};
  }
  const fields = kind === 'sip' ? MA_SIP_FIELDS : MA_HOLDING_FIELDS;
  const state = maState();
  const input = Array.isArray(body.rows) ? body.rows.slice(0, 20000) : [];

  /* A PAN gives a name to rows whose file names nobody, from the file
     itself first and then from what is already uploaded. */
  const inFile = new Map();
  input.forEach(h=>{ const p = maPanOf(h.pan || h.client_id); if(p && maTidy(h.client_name) && !inFile.has(p)) inFile.set(p, maTidy(h.client_name)); });
  const known = new Map();
  state.all.forEach(r=>{ const p = maPanOf(r.pan || r.client_id); if(p && !known.has(p) && r._c.name !== MA_UNASSIGNED) known.set(p, r._c.name); });
  const whoIs = h => { const p = maPanOf(h.pan || h.client_id); return maTidy(h.client_name) || (p && (inFile.get(p) || known.get(p))) || ''; };

  let source = input;
  if(uploadType === 'client'){
    /* A file holding several clients keeps only this client's rows. */
    const people = new Set(source.map(h=>maKey(whoIs(h))).filter(Boolean));
    if(people.size > 1){
      const client = body.clientId ? (DB.clients || []).find(c=>c.id === body.clientId) : null;
      const pan = client ? maPanOf(client.pan) : null;
      source = source.filter(h=>maKey(whoIs(h)) === maKey(clientName) || (pan && maPanOf(h.pan || h.client_id) === pan));
      if(!source.length) throw new Error('This file holds ' + people.size + ' clients and none of them is ' + clientName
        + '. Upload it Platform Wise instead.');
    }
  }
  let rows = source.map(h=>{
    const name = uploadType === 'client' ? clientName : (whoIs(h) || MA_UNASSIGNED);
    const r = Object.assign({client_name: name, pan: maPanOf(h.pan || h.client_id), cid: uploadType === 'client' ? (body.clientId || h.cid || '') : (h.cid || ''),
      platform, platform_key: maKey(platform), product: prod}, maCleanRow(h, fields));
    /* A known platform report carries more than the common fields: its
       sleeves, the rest of its columns, and the source row verbatim. */
    MA_KEEP_OBJECTS.forEach(k=>{ if(h[k] && typeof h[k] === 'object') r[k] = h[k]; });
    if(!r.asset_class || r.asset_class === 'Unclassified' || (prod !== 'MF' && r.asset_class === 'Mutual Fund') || prod === MA_LOANS)
      r.asset_class = MA_DEFAULT_ASSET[prod];
    return r;
  });

  /* Clients whose rows are what the screens already show for this platform
     + category are left as they are. */
  const who = maResolver(state.all.concat(rows));
  rows.forEach(r=>Object.defineProperty(r, '_c', {value: who(r), enumerable: false, writable: true, configurable: true}));
  const sig = list => list.map(r=>JSON.stringify(fields.filter(f=>f !== 'as_of')
    .map(f=>typeof r[f] === 'number' ? Math.round(r[f] * 100) / 100 : (r[f] === undefined ? null : r[f]))
    .concat([r.sleeves || null, r.extra || null]))).sort().join('\n');
  const curList = kind === 'sip' ? state.sips : state.holdings;
  const byClient = (list) => { const m = new Map(); list.forEach(r=>{ const k = r._c.ck; if(!m.has(k)) m.set(k, []); m.get(k).push(r); }); return m; };
  const before = byClient(curList.filter(r=>r.platform_key === maKey(platform) && r.product === prod));
  const after = byClient(rows);
  const unchanged = new Set();
  after.forEach((list, k)=>{ if(before.has(k) && sig(before.get(k)) === sig(list)) unchanged.add(k); });
  const unchangedClients = unchanged.size;
  rows = rows.filter(r=>!unchanged.has(r._c.ck));
  if(!rows.length && input.length) return {skipped: true, unchanged: true, unchangedClients,
    message: 'Nothing changed: the dashboard already has this data.'};
  const people = new Set(rows.filter(r=>r.client_name !== MA_UNASSIGNED).map(r=>r._c.ck));
  const matched = new Set(rows.filter(r=>r._c.clientId).map(r=>r._c.clientId));
  const unmatched = Array.from(new Set(rows.filter(r=>!r._c.clientId).map(r=>r._c.name)));
  const snap = maSnapshotDate(body.snapshotDate, rows);
  const prev = scoped.reduce((n, u)=>Math.max(n, u.version || 0), 0);
  const seq = (DB.assetUploads || []).reduce((n, u)=>Math.max(n, u.seq || 0), 0) + 1;
  const up = {id: uid('MAU'), seq, uploadType, clientName, clientId: uploadType === 'client' ? (body.clientId || '') : '',
    platform, product: prod, kind, version: prev + 1, snapshotDate: snap, batchId: body.batchId || '',
    file: String(body.file || '').split(/[\\/]/).pop().slice(0, 200), format: body.format || '', size: Number(body.size) || 0,
    sha256: body.sha256 || null, status: body.status || 'Processed', notes: String(body.notes || '').slice(0, 1000),
    rowsCount: rows.length, clientsCount: people.size, matchedClients: matched.size, unmatched: unmatched.slice(0, 200),
    unchangedClients, hasFile: false, at: new Date().toISOString(), by: currentUser};
  /* Rows first, under their own key: an upload whose rows did not land
     must not be listed as though they had. */
  const clean = rows.map(r=>{ const o = {}; Object.keys(r).forEach(k=>{ if(r[k] !== null && r[k] !== undefined) o[k] = r[k]; }); return o; });
  DB[maRowsKey(up.id)] = clean;
  const wrote = await sset(maRowsKey(up.id), clean);
  if(wrote === false){ delete DB[maRowsKey(up.id)]; throw new Error('The rows could not be saved.'); }
  if(body.buffer && body.buffer.byteLength && body.buffer.byteLength <= MA_KEEP_FILE_BYTES){
    try {
      await sset(maFileKey(up.id), {name: up.file, type: body.fileType || '', b64: maBufToB64(body.buffer)});
      up.hasFile = true;
    } catch(e){ /* the rows are what matter; the original is a convenience */ }
  }
  DB.assetUploads = (DB.assetUploads || []).concat([up]);
  await save('assetUploads');
  maInvalidate();
  return {upload: up, isNew: prev === 0, version: prev + 1, snapshotDate: snap, rowsCount: rows.length,
    clientsCount: people.size, matchedClients: matched.size, unmatched, unchangedClients};
}

/* Removing an upload. Its rows go with it, and whatever it had replaced
   is what the screens show again. */
async function maRemoveUpload(id){
  if(!maCanUpload()){ alert('You do not have permission to remove uploads.'); return; }
  const u = (DB.assetUploads || []).find(x=>x.id === id);
  if(!u) return;
  const live = maState().currentUploads.has(id);
  if(!confirm('Remove ' + u.platform + ' · ' + u.product + ' · ' + MA_KIND_LABEL[u.kind] + ' version ' + u.version
    + ' ("' + u.file + '")?\n\n' + (live ? 'It is in use now; the version before it comes back on every screen.'
      : 'It is not the version in use, so nothing on the screens changes.') + '\n\nThis cannot be undone.')) return;
  DB.assetUploads = (DB.assetUploads || []).filter(x=>x.id !== id);
  await save('assetUploads');
  delete DB[maRowsKey(id)];
  await sdel(maRowsKey(id));
  if(u.hasFile) await sdel(maFileKey(id));
  maInvalidate();
  await logAudit('Import', id, 'Multi-asset upload removed', [
    {field:'Upload', oldValue: u.platform + ' · ' + u.product + ' · ' + MA_KIND_LABEL[u.kind] + ' v' + u.version + ' · ' + u.file, newValue: ''}]);
  await maSyncCrm();
  render();
}
async function maDownloadOriginal(id){
  const f = await sget(maFileKey(id), null);
  if(!f || !f.b64){ alert('The original file was not kept for this upload.'); return; }
  const bin = atob(f.b64), u8 = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([u8], {type: f.type || 'application/octet-stream'}));
  const a = document.createElement('a'); a.href = url; a.download = f.name || 'upload'; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 4000);
}
async function maResetAll(){
  if(!isAdmin()){ alert('Only an ' + ADMIN_ROLE + ' can reset the multi-asset data.'); return; }
  const typed = prompt('This deletes every uploaded file and every imported holding and SIP for all clients, '
    + 'including those from the old platform import. Clients and the platform list are kept. '
    + 'It cannot be undone.\n\nType DELETE to confirm.');
  if(typed !== 'DELETE' && typed !== 'RESET') return;
  const ups = (DB.assetUploads || []).slice();
  const nH = (DB.platformHoldings || []).length, nS = (DB.platformSips || []).length;
  DB.assetUploads = [];
  await save('assetUploads');
  for(const u of ups){ delete DB[maRowsKey(u.id)]; await sdel(maRowsKey(u.id)); if(u.hasFile) await sdel(maFileKey(u.id)); }
  DB.platformHoldings = []; DB.platformSips = [];
  await save('platformHoldings'); await save('platformSips');
  const at = new Date().toISOString();
  (DB.importBatches || []).forEach(b=>{ if(!b.removedAt){ b.removedAt = at; b.removedBy = currentUser; } });
  await save('importBatches');
  maInvalidate();
  await logAudit('Import', 'multiasset', 'All imported data deleted', [{field:'Uploads deleted', oldValue: String(ups.length), newValue: '0'},
    {field:'Imported holding lines', oldValue: String(nH), newValue: '0'}, {field:'Imported SIP lines', oldValue: String(nS), newValue: '0'}]);
  await maSyncCrm();
  render();
}

/* =====================================================================
   INTO THE REST OF BOSS

   The newest figures of every client this module could tie to a BOSS
   client are written to the two stores the rest of BOSS reads:

     platformHoldings  one line per client + platform + category, with the
                       asset classes as its sleeves (LAS is not written:
                       a loan is never AUM);
     platformSips      one line per live SIP.

   Each line carries source 'multiasset' and a key beginning 'ma|', so the
   lines are rebuilt from scratch every time and nothing the platform
   import wizard wrote is ever touched — with one exception. The wizard
   already reads Finowise, Anand Rathi and NJ mutual fund reports; if both
   doors have been used for the same client and platform, the newer one
   wins and the older is set aside (deletedAt, maShadowed), so the same
   money is never counted twice. Set aside, not deleted: when the newer
   one goes, the older comes back.
   ===================================================================== */
/* The Main Dashboard cuts AUM by Equity, Debt, Hybrid and Others; a line's
   sleeves are named that way so its Product cut reads as it always has. */
function maBucket(r){
  const a = String(r.asset_class || '');
  if(a === 'Equity' || a === 'Debt') return a;
  if(a === 'Mutual Fund' && typeof mdProductBucket === 'function')
    return mdProductBucket({productCategory: (r.category || '') + ' ' + (r.security_name || '')});
  return 'Others';
}
function maLegacyPlatformId(name){
  const p = (typeof IMPORT_PLATFORMS !== 'undefined' ? IMPORT_PLATFORMS : []).find(x=>maKey(x.label) === maKey(name));
  return p ? p.id : null;
}
async function maSyncCrm(opts){
  opts = opts || {};
  const s = maState();
  const now = new Date().toISOString();
  const latestAt = new Map();          // clientId|legacyPlatform → newest upload time for MF
  const stamp = (cid, plat, at) => { const k = cid + '|' + plat; if(!latestAt.has(k) || at > latestAt.get(k)) latestAt.set(k, at); };
  s.holdings.concat(s.sips).forEach(r=>{
    if(!r._c.clientId || r.product !== 'MF') return;
    const lp = maLegacyPlatformId(r.platform);
    if(lp) stamp(r._c.clientId, lp, r._u.at);
  });
  /* Which door is newer, per client and legacy platform. */
  const legacyAt = new Map();
  (DB.platformHoldings || []).concat(DB.platformSips || []).forEach(h=>{
    if(!h || h.source === 'multiasset' || !h.clientId) return;
    if(h.deletedAt && !h.maShadowed) return;
    const k = h.clientId + '|' + h.platform, at = String(h.asOf || '');
    if(!legacyAt.has(k) || at > legacyAt.get(k)) legacyAt.set(k, at);
  });
  const maWins = (cid, lp) => { const k = cid + '|' + lp; return latestAt.has(k) && (!legacyAt.has(k) || latestAt.get(k) > legacyAt.get(k)); };
  const legacyWins = (cid, platformName, product) => {
    if(product !== 'MF') return false;
    const lp = maLegacyPlatformId(platformName);
    return !!(lp && legacyAt.has(cid + '|' + lp) && !maWins(cid, lp));
  };

  /* ---- AUM lines ---- */
  const groups = new Map();
  s.holdings.forEach(r=>{
    if(!r._c.clientId || r.product === MA_LOANS) return;
    if(legacyWins(r._c.clientId, r.platform, r.product)) return;
    const k = 'ma|' + r.platform_key + '|' + r.product + '|' + r._c.clientId;
    if(!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  const oldH = new Map((DB.platformHoldings || []).filter(h=>h && h.source === 'multiasset').map(h=>[h.key, h]));
  const freshH = [];
  groups.forEach((rows, key)=>{
    const t = maSums(rows, []);
    const sleeves = {};
    rows.forEach(r=>{
      const n = maBucket(r);
      const sl = sleeves[n] = sleeves[n] || {invested: 0, current: 0, w: 0, x: 0};
      sl.invested += r.invested || 0; sl.current += r.current_value || 0;
      if(r.xirr !== null && r.xirr !== undefined){ sl.x += r.xirr * (r.current_value || 0); sl.w += r.current_value || 0; }
    });
    Object.keys(sleeves).forEach(n=>{ const sl = sleeves[n]; sleeves[n] = {invested: maRound(sl.invested, 2), current: maRound(sl.current, 2),
      xirr: sl.w ? maRound(sl.x / sl.w, 2) : ''}; });
    const newestU = rows.reduce((a, r)=>(!a || (r._u.seq || 0) > (a.seq || 0)) ? r._u : a, null);
    const was = oldH.get(key);
    /* A known platform report (Finowise, Anand Rathi, NJ) has one total
       row per client with its own sleeves and columns: those are written
       as the report gave them, exactly as the old import wrote them. */
    const one = rows.length === 1 && rows[0].level === 'summary' ? rows[0] : null;
    const own = one && one.sleeves && Object.keys(one.sleeves).length ? one.sleeves : null;
    freshH.push(Object.assign({}, one && one.extra || {}, one && one.src ? {src: one.src} : {}, {id: was ? was.id : uid('PHD'), key, clientId: rows[0]._c.clientId, platform: rows[0].platform,
      product: rows[0].product, report: 'AUM', format: 'multiasset', source: 'multiasset',
      invested: maRound(t.invested, 2), current: maRound(t.current_value, 2), xirr: t.xirr === null ? '' : maRound(t.xirr, 2),
      sleeves: own || sleeves, schemes: rows.filter(r=>r.level !== 'summary').length,
      reportAsOn: t.as_of || newestU.snapshotDate || '', asOf: newestU.at, file: newestU.file, batchId: newestU.id,
      importedBy: newestU.by, firstSeenAt: was ? was.firstSeenAt : now,
      prev: was && (was.current !== maRound(t.current_value, 2)) ? {invested: was.invested, current: was.current, xirr: was.xirr, asOf: was.asOf} : (was ? was.prev : undefined)}));
  });
  /* ---- SIP lines (live ones only: an ended SIP is not part of the SIP book) ---- */
  const oldS = new Map((DB.platformSips || []).filter(x=>x && x.source === 'multiasset').map(x=>[x.key, x]));
  const freshS = [];
  s.sips.forEach(r=>{
    if(!r._c.clientId || !r.live) return;
    if(legacyWins(r._c.clientId, r.platform, r.product)) return;
    let key = 'ma|' + r.platform_key + '|' + r.product + '|' + r._c.clientId + '|' + String(r.identifier || '').toLowerCase()
      + '|' + (String(r.isin || '').toUpperCase() || String(r.security_name || '').toLowerCase());
    /* A second SIP in the same scheme and folio is its own SIP, told apart
       by when it started and the day it is debited. */
    if(freshS.some(x=>x.key === key)) key += '|' + (r.start_date || '') + '|' + (r.sip_day || '') + '|' + (r.sip_amount || '');
    if(freshS.some(x=>x.key === key)) return;
    const was = oldS.get(key);
    freshS.push(Object.assign({}, r.extra || {}, r.src ? {src: r.src} : {}, {id: was ? was.id : uid('PSP'), key, clientId: r._c.clientId, platform: r.platform, product: r.product,
      report: 'SIP', format: 'multiasset', source: 'multiasset', schemeName: r.security_name || '', folio: r.identifier || '',
      isin: r.isin || '', amount: r.sip_amount, monthlyAmount: r.monthly_amount, frequency: r.frequency || '',
      sipDate: r.sip_day, startDate: r.start_date || '', endDate: r.end_date || '', status: r.status || '',
      reportAsOn: r._u.snapshotDate || '', asOf: r._u.at, file: r._u.file, batchId: r._u.id, importedBy: r._u.by,
      firstSeenAt: was ? was.firstSeenAt : now}));
  });
  /* ---- the wizard's lines for the same client and platform ---- */
  let shadowChanged = false;
  const shade = list => list.forEach(h=>{
    if(!h || h.source === 'multiasset' || !h.clientId) return;
    const beaten = maWins(h.clientId, h.platform);
    if(beaten && !h.deletedAt){ h.deletedAt = now; h.maShadowed = true; shadowChanged = true; }
    else if(!beaten && h.maShadowed){ delete h.deletedAt; delete h.maShadowed; shadowChanged = true; }
  });
  const legacyH = (DB.platformHoldings || []).filter(h=>h && h.source !== 'multiasset');
  const legacyS = (DB.platformSips || []).filter(x=>x && x.source !== 'multiasset');
  shade(legacyH); shade(legacyS);
  const sigOf = list => JSON.stringify(list.map(x=>Object.assign({}, x, {firstSeenAt: '', id: ''})).sort((a, b)=>a.key < b.key ? -1 : 1));
  const hChanged = shadowChanged || sigOf(Array.from(oldH.values())) !== sigOf(freshH);
  const sChanged = shadowChanged || sigOf(Array.from(oldS.values())) !== sigOf(freshS);
  if(hChanged){ DB.platformHoldings = legacyH.concat(freshH); await save('platformHoldings'); }
  if(sChanged){ DB.platformSips = legacyS.concat(freshS); await save('platformSips'); }
  /* The book's monthly line, as the platform import records it. */
  if((hChanged || sChanged) && !opts.noLedger && typeof aumLedgerRecord === 'function')
    await aumLedgerRecord(opts.asOn || '', opts.batchId || '');
  return {holdings: freshH.length, sips: freshS.length, changed: hChanged || sChanged};
}

/* =====================================================================
   SCREENS
   ===================================================================== */
function maStyle(){
  if(document.getElementById('maStyle')) return '';
  const s = document.createElement('style');
  s.id = 'maStyle';
  s.textContent = `
    .ma-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin:8px 0 14px}
    .ma-card{border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:var(--card);cursor:pointer}
    .ma-card:hover{border-color:var(--navy)}
    .ma-card .t{font-weight:700;font-size:13px}.ma-card .v{font-size:18px;font-weight:700;margin:4px 0}
    .ma-card .d{font-size:12px;color:var(--muted)}
    .ma-crumbs{font-size:12px;color:var(--muted);margin-bottom:8px}.ma-crumbs a{cursor:pointer;color:var(--navy)}
    .ma-alloc{display:flex;flex-direction:column;gap:6px}.ma-alloc-row{display:grid;grid-template-columns:150px 1fr 110px 54px;gap:8px;align-items:center;font-size:12px}
    .ma-bar{height:9px;border-radius:5px;background:var(--line);overflow:hidden}.ma-bar i{display:block;height:100%;background:var(--teal,var(--navy))}
    .ma-matrix td{vertical-align:middle}.ma-matrix input[type=file]{max-width:210px;font-size:12px}
    .ma-chip{display:inline-block;font-size:10px;padding:1px 6px;border-radius:8px;background:var(--line);margin-left:4px}
    .ma-seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
    .ma-seg button{border:0;background:transparent;padding:8px 14px;cursor:pointer;text-align:left}
    .ma-seg button.on{background:var(--navy);color:#fff}.ma-seg small{display:block;font-size:11px;opacity:.8}
    .ma-link{cursor:pointer;color:var(--navy);font-weight:600}
    @media (max-width:640px){.ma-alloc-row{grid-template-columns:90px 1fr 80px 44px}}
  `;
  document.head.appendChild(s);
  return '';
}
const maPct = n => (n === null || n === undefined || n === '' || !isFinite(Number(n))) ? '—' : (Math.round(Number(n) * 100) / 100) + '%';
const maMoney = n => (n === null || n === undefined) ? '—' : money(n);
const maDate = d => d ? fmtDate(d) : '—';
/* Everything here lives inside Setup › Platform Import Mapping, as its
   sections: Upload files, Uploaded data, SIPs and Column mapping. */
function maNav(section){ window._impMapSection = section; navigate('settings', 'importmaps'); }
function maGo(route){ window._maRoute = route || {page: 'home'}; maNav('data'); }
function maOpenClient(ck){ maGo({page: 'client', ck}); }
function maCrumbs(parts){
  return `<div class="ma-crumbs">${parts.map(([label, onclick])=>onclick ? `<a onclick="${onclick}">${esc(label)}</a>` : `<b>${esc(label)}</b>`).join(' › ')}</div>`;
}
function maKpis(t){
  return kpiCards([
    {label: 'Current value (AUM)', value: money(t.current_value)},
    {label: 'Invested', value: money(t.invested)},
    {label: 'Gain', html: `<span style="color:var(--${t.gain_loss >= 0 ? 'ok' : 'danger'})">${money(t.gain_loss)}</span>`
      + (t.return_pct === null ? '' : ` <small>${maPct(t.return_pct)}</small>`)},
    {label: 'XIRR', value: maPct(t.xirr)},
    {label: 'Monthly SIP', value: money(t.sip_monthly) + (t.live_sips ? ' · ' + t.live_sips + ' live' : ''),
      onclick: "maNav('sips')"},
    {label: 'Loans (LAS, not in AUM)', value: money(t.loans)},
  ]);
}
function maAllocHtml(holdings, total){
  const g = maGroup(holdings.filter(h=>h.product !== MA_LOANS), [], h=>h.asset_class || 'Unclassified', h=>h.asset_class || 'Unclassified');
  if(!g.length || !total) return '';
  return `<div class="section-title">Asset allocation</div><div class="ma-alloc">${g.map(a=>{
    const p = a.current_value / total * 100;
    return `<div class="ma-alloc-row"><span>${esc(a.label)}</span><span class="ma-bar"><i style="width:${Math.max(0, Math.min(100, p)).toFixed(1)}%"></i></span>
      <span class="se-r">${money(a.current_value)}</span><span class="se-r">${p.toFixed(1)}%</span></div>`;
  }).join('')}</div>`;
}
function maClientsTable(holdings, sips, opts){
  opts = opts || {};
  const q = maKey(MA.clientQ);
  let rows = maGroup(holdings, sips, r=>r._c.ck, r=>r._c.name);
  if(q) rows = rows.filter(r=>maKey(r.label).indexOf(q) >= 0);
  const shown = rows.slice(0, 300);
  return `<div class="list-searchrow"><input class="search list-search" id="maClientSearch" placeholder="Search clients" value="${esc(MA.clientQ)}"
      oninput="MA.clientQ=this.value; render()"><span class="small-note" style="margin:0">${rows.length} client${rows.length === 1 ? '' : 's'}${rows.length > shown.length ? ', the first ' + shown.length + ' shown' : ''}</span></div>
    ${repTable([{t: 'Client'}, {t: 'In BOSS'}, {t: 'Categories'}, {t: 'Platforms'}, {t: 'Invested', r: 1}, {t: 'Current value', r: 1},
      {t: 'Gain', r: 1}, {t: 'XIRR', r: 1}, {t: 'Monthly SIP', r: 1}, {t: 'Loans', r: 1}],
      shown.map(r=>{
        const one = (r.h[0] || r.s[0])._c;
        return `<tr class="row-clickable" onclick="maOpenClient('${esc(r.key)}')"><td><b>${esc(r.label)}</b>${one.pan ? `<div class="small-note" style="margin:2px 0 0">${esc(bossMaskSafe(one.pan))}</div>` : ''}</td>
        <td>${one.clientId ? '<span class="badge ok">Matched</span>' : '<span class="badge muted">Not in BOSS</span>'}</td>
        <td>${r.products.map(p=>`<span class="ma-chip">${esc(p)}</span>`).join('')}</td>
        <td class="small-note">${esc(r.platformNames.join(', '))}</td>
        <td class="se-r">${money(r.invested)}</td><td class="se-r">${money(r.current_value)}</td>
        <td class="se-r ${r.gain_loss < 0 ? 'md-down' : ''}">${money(r.gain_loss)}</td><td class="se-r">${maPct(r.xirr)}</td>
        <td class="se-r">${r.sip_monthly ? money(r.sip_monthly) : '—'}</td><td class="se-r">${r.loanValue ? money(r.loanValue) : '—'}</td></tr>`;
      }), opts.empty || 'No client data here yet.')}`;
}
function bossMaskSafe(p){ return typeof bossMask === 'function' ? bossMask(p, 4) : p; }
function maEmptyHtml(){
  return `<div class="card"><div class="section-title" style="margin-top:0">No investment data yet</div>
    <div class="small-note">Upload AUM and SIP files for any platform and category from
      <a class="cell-link" href="javascript:void(0)" onclick="maNav('upload')">Platform Import Mapping › Upload files</a>. What is read is matched to BOSS's
      clients by PAN, then by name, and shows on their Portfolio tab, in Portfolio Review and in the book AUM.</div></div>`;
}

/* ---- the Dashboard: home, a category or platform, a client ---------- */
function viewAssets(){
  maStyle();
  if(!can('CMS','view')) return permissionWall('CMS');
  const r = window._maRoute || {page: 'home'};
  if(r.page === 'client') return maClientPage(r.ck);
  if(r.page === 'scope') return maScopePage(r);
  return maHomePage();
}
function maHomePage(){
  const v = maView();
  if(!v.holdings.length && !v.sips.length) return maEmptyHtml();
  const t = maSums(v.holdings, v.sips);
  const products = maGroup(v.holdings, v.sips, r=>r.product, r=>r.product)
    .sort((a, b)=>MA_PRODUCTS.indexOf(a.key) - MA_PRODUCTS.indexOf(b.key));
  const plats = maGroup(v.holdings, v.sips, r=>r.platform_key, r=>r.platform);
  const recent = maUploads().slice().sort((a, b)=>(b.seq || 0) - (a.seq || 0)).slice(0, 8);
  return `
    ${moduleHeader({title: 'All platforms', subtitle: t.clients + ' clients · ' + t.platforms + ' platforms · ' + t.files + ' files in use · as at ' + maDate(t.as_of),
      actions: [maCanUpload() ? {label: 'Upload files', icon: '⬆', onclick: "maNav('upload')"} : null,
        {label: 'Download Excel', icon: '⤓', onclick: "maExportXlsx({}, 'All clients')"}]})}
    ${maKpis(t)}
    <div class="section-title">Categories</div>
    <div class="ma-cards">${products.map(p=>`<div class="ma-card" onclick="maGo({page:'scope', product:'${esc(p.key)}'})">
      <div class="t">${esc(MA_PRODUCT_LABEL[p.key] || p.key)}</div>
      <div class="v">${money(p.key === MA_LOANS ? p.loanValue : p.current_value)}</div>
      <div class="d">${p.clients} client${p.clients === 1 ? '' : 's'} · ${p.platforms} platform${p.platforms === 1 ? '' : 's'}${p.sip_monthly ? ' · SIP ' + money(p.sip_monthly) + '/mo' : ''}${p.key === MA_LOANS ? ' · not in AUM' : ''}</div></div>`).join('')}</div>
    <div class="section-title">Platforms</div>
    <div class="ma-cards">${plats.map(p=>`<div class="ma-card" onclick="maGo({page:'scope', platform:'${esc(p.label)}'})">
      <div class="t">${esc(p.label)}</div><div class="v">${money(p.current_value || p.loanValue)}</div>
      <div class="d">${p.products.join(', ')} · ${p.clients} client${p.clients === 1 ? '' : 's'}${p.loanValue ? (p.current_value ? ' · loans ' + money(p.loanValue) : ' · loans, not in AUM') : ''}</div></div>`).join('')}</div>
    <div class="card">${maAllocHtml(v.holdings, t.current_value)}</div>
    <div class="card"><div class="section-title" style="margin-top:0">Recent updates</div>
      ${repTable([{t: 'When'}, {t: 'Platform'}, {t: 'Category'}, {t: 'File'}, {t: 'Version'}, {t: 'Data as of'}, {t: 'Rows', r: 1}],
        recent.map(u=>`<tr><td>${esc(fmtDate(u.at))}</td><td>${esc(u.platform)}</td><td>${esc(u.product)} · ${MA_KIND_LABEL[u.kind]}</td>
          <td class="small-note">${esc(u.file)}${u.uploadType === 'client' ? ' · for ' + esc(u.clientName) : ''}</td><td>v${u.version}</td>
          <td>${maDate(u.snapshotDate)}</td><td class="se-r">${u.rowsCount}</td></tr>`), 'No uploads yet.')}</div>
    <div class="card"><div class="section-title" style="margin-top:0">Clients</div>${maClientsTable(v.holdings, v.sips)}</div>`;
}
function maScopePage(r){
  const v = maView();
  const pk = r.platform ? maKey(r.platform) : '';
  const inScope = x => (!pk || x.platform_key === pk) && (!r.product || x.product === r.product);
  const h = v.holdings.filter(inScope), s = v.sips.filter(inScope);
  const title = r.platform && r.product ? r.platform + ' · ' + r.product : (r.platform || (MA_PRODUCT_LABEL[r.product] || r.product));
  const crumbs = maCrumbs([['All platforms', "maGo({page:'home'})"]].concat(
    r.platform && r.product ? [[r.platform, `maGo({page:'scope', platform:'${esc(r.platform)}'})`], [r.product]] : [[title]]));
  if(!h.length && !s.length) return crumbs + `<div class="card"><div class="small-note">No data uploaded here yet.</div></div>`;
  const t = maSums(h, s);
  const split = r.platform && !r.product
    ? maGroup(h, s, x=>x.product, x=>x.product).sort((a, b)=>MA_PRODUCTS.indexOf(a.key) - MA_PRODUCTS.indexOf(b.key))
    : (!r.platform ? maGroup(h, s, x=>x.platform_key, x=>x.platform) : []);
  const history = maUploads().filter(u=>(!pk || maKey(u.platform) === pk) && (!r.product || u.product === r.product))
    .sort((a, b)=>(b.seq || 0) - (a.seq || 0));
  return `${crumbs}
    ${moduleHeader({title, subtitle: t.clients + ' clients · ' + t.holdings + ' holdings' + (t.sips ? ' · ' + t.sips + ' SIPs' : '') + ' · as at ' + maDate(t.as_of),
      actions: [{label: 'Download Excel', icon: '⤓', onclick: `maExportXlsx({platform:'${esc(r.platform || '')}', product:'${esc(r.product || '')}'}, '${esc(title)}')`}]})}
    ${maKpis(t)}
    ${split.length ? `<div class="card"><div class="section-title" style="margin-top:0">${r.platform ? 'By category' : 'By platform'}</div>
      ${repTable([{t: r.platform ? 'Category' : 'Platform'}, {t: 'Clients', r: 1}, {t: 'Invested', r: 1}, {t: 'Current value', r: 1}, {t: 'Gain', r: 1},
        {t: 'XIRR', r: 1}, {t: 'Monthly SIP', r: 1}, {t: 'Loans', r: 1}],
        split.map(g=>`<tr class="row-clickable" onclick="maGo({page:'scope', platform:'${esc(r.platform || g.label)}', product:'${esc(r.product || g.key)}'})">
          <td><b>${esc(g.label)}</b></td><td class="se-r">${g.clients}</td><td class="se-r">${money(g.invested)}</td><td class="se-r">${money(g.current_value)}</td>
          <td class="se-r">${money(g.gain_loss)}</td><td class="se-r">${maPct(g.xirr)}</td><td class="se-r">${g.sip_monthly ? money(g.sip_monthly) : '—'}</td>
          <td class="se-r">${g.loanValue ? money(g.loanValue) : '—'}</td></tr>`))}</div>` : ''}
    <div class="card">${maAllocHtml(h, t.current_value)}</div>
    <div class="card"><div class="section-title" style="margin-top:0">Clients</div>${maClientsTable(h, s)}</div>
    <div class="card"><div class="section-title" style="margin-top:0">Update history</div>${maHistoryTable(history)}</div>`;
}
function maClientPage(ck){
  const v = maView();
  const h = v.holdings.filter(r=>r._c.ck === ck), s = v.sips.filter(r=>r._c.ck === ck);
  const allMine = v.all.filter(r=>r._c.ck === ck);
  const one = (h[0] || s[0] || allMine[0] || {})._c;
  const crumbs = maCrumbs([['All platforms', "maGo({page:'home'})"], [one ? one.name : 'Client']]);
  if(!one) return crumbs + `<div class="card"><div class="small-note">No data for this client yet.</div></div>`;
  const t = maSums(h, s);
  const pp = maGroup(h, s, r=>r.platform_key + '|' + r.product, r=>r.platform);
  const loans = h.filter(r=>r.product === MA_LOANS);
  const schemes = h.filter(r=>r.product !== MA_LOANS)
    .sort((a, b)=>MA_PRODUCTS.indexOf(a.product) - MA_PRODUCTS.indexOf(b.product) || a.platform.localeCompare(b.platform) || (b.current_value || 0) - (a.current_value || 0));
  const myUploads = Array.from(new Set(allMine.map(r=>r._u))).sort((a, b)=>(b.seq || 0) - (a.seq || 0));
  const curIds = new Set(h.concat(s).map(r=>r._u.id));
  return `${crumbs}
    ${moduleHeader({title: one.name, subtitle: (one.pan ? 'PAN ' + bossMaskSafe(one.pan) + ' · ' : '') + t.holdings + ' holdings · ' + t.sips + ' SIPs · as at ' + maDate(t.as_of),
      actions: [one.clientId ? {label: 'Open the client', icon: '👤', onclick: `navigate('cms','${esc(one.clientId)}')`} : null,
        {label: 'Download Excel', icon: '⤓', onclick: `maExportXlsx({ck:'${esc(ck)}'}, '${esc(one.name).replace(/'/g, '')}')`}]})}
    ${one.clientId ? '' : `<div class="small-note" style="margin-top:0">This client is not in BOSS yet — no client record carries this PAN or name, so the figures stay here and are not added to a BOSS client's portfolio.</div>`}
    ${maKpis(t)}
    <div class="card"><div class="section-title" style="margin-top:0">Category &amp; platform</div>
      ${repTable([{t: 'Platform'}, {t: 'Category'}, {t: 'Version'}, {t: 'Data as of'}, {t: 'Invested', r: 1}, {t: 'Current value', r: 1}, {t: 'Gain', r: 1},
        {t: 'XIRR', r: 1}, {t: 'Monthly SIP', r: 1}],
        pp.map(g=>{
          const u = g.h.concat(g.s).reduce((a, r)=>(!a || (r._u.seq || 0) > (a.seq || 0)) ? r._u : a, null);
          const prod = (g.h[0] || g.s[0]).product;
          return `<tr><td><b>${esc(g.label)}</b></td><td>${esc(prod)}</td><td>v${u.version}</td><td>${maDate(u.snapshotDate)}</td>
            <td class="se-r">${prod === MA_LOANS ? '—' : money(g.invested)}</td><td class="se-r">${money(prod === MA_LOANS ? g.loanValue : g.current_value)}${prod === MA_LOANS ? ' <span class="ma-chip">loan</span>' : ''}</td>
            <td class="se-r">${prod === MA_LOANS ? '—' : money(g.gain_loss)}</td><td class="se-r">${maPct(g.xirr)}</td><td class="se-r">${g.sip_monthly ? money(g.sip_monthly) : '—'}</td></tr>`;
        }))}</div>
    <div class="card">${maAllocHtml(h, t.current_value)}</div>
    <div class="card"><div class="section-title" style="margin-top:0">Scheme-wise investment details</div>${maHoldingsTable(schemes)}</div>
    ${s.length ? `<div class="card"><div class="section-title" style="margin-top:0">SIP details</div>${maSipTable(s, {noClient: true})}</div>` : ''}
    ${loans.length ? `<div class="card"><div class="section-title" style="margin-top:0">Loans against securities (not in AUM)</div>
      ${repTable([{t: 'Platform'}, {t: 'Loan / facility'}, {t: 'Outstanding', r: 1}, {t: 'As of'}],
        loans.map(l=>`<tr><td>${esc(l.platform)}</td><td>${esc(l.security_name || '—')}</td><td class="se-r">${money(l.current_value)}</td><td>${maDate(l.as_of || l._u.snapshotDate)}</td></tr>`))}</div>` : ''}
    <div class="card"><div class="section-title" style="margin-top:0">Update history</div>
      <div class="small-note" style="margin-top:0">Every upload with this client's data is kept. The latest version of each platform + category is used above.</div>
      ${repTable([{t: 'Uploaded'}, {t: 'Platform'}, {t: 'Category'}, {t: 'File'}, {t: 'Version'}, {t: 'Data as of'}, {t: 'Rows', r: 1}, {t: 'In use'}],
        myUploads.map(u=>`<tr><td>${esc(fmtDate(u.at))}</td><td>${esc(u.platform)}</td><td>${esc(u.product)} · ${MA_KIND_LABEL[u.kind]}</td>
          <td class="small-note">${esc(u.file)}</td><td>v${u.version}</td><td>${maDate(u.snapshotDate)}</td>
          <td class="se-r">${allMine.filter(r=>r._u === u).length}</td><td>${curIds.has(u.id) ? '<span class="badge ok">In use</span>' : '<span class="badge muted">Earlier</span>'}</td></tr>`))}</div>`;
}
function maHoldingsTable(rows, opts){
  opts = opts || {};
  return repTable([opts.client ? {t: 'Client'} : null, {t: 'Category'}, {t: 'Platform'}, {t: 'Scheme / security'}, {t: 'Asset class'}, {t: 'Folio / code'},
      {t: 'Units', r: 1}, {t: 'Invested', r: 1}, {t: 'Current value', r: 1}, {t: 'Gain', r: 1}, {t: 'Return', r: 1}, {t: 'XIRR', r: 1}].filter(Boolean),
    rows.map(r=>`<tr>${opts.client ? `<td>${esc(r._c.name)}</td>` : ''}<td>${esc(r.product)}</td><td>${esc(r.platform)}</td>
      <td><b>${esc(r.security_name || '—')}</b>${r.isin ? `<div class="small-note" style="margin:2px 0 0">${esc(r.isin)}</div>` : ''}</td>
      <td>${esc(r.asset_class || '—')}</td><td>${esc(r.identifier || '—')}</td>
      <td class="se-r">${r.quantity === null || r.quantity === undefined ? '—' : maRound(r.quantity, 3).toLocaleString(numberLocale())}</td>
      <td class="se-r">${maMoney(r.invested)}</td><td class="se-r">${maMoney(r.current_value)}</td>
      <td class="se-r ${(r.gain_loss || 0) < 0 ? 'md-down' : ''}">${maMoney(r.gain_loss)}</td><td class="se-r">${maPct(r.return_pct)}</td><td class="se-r">${maPct(r.xirr)}</td></tr>`),
    'No holdings.');
}
function maSipId(r){ return r._u.id + ':' + maRowsOf(r._u).indexOf(r); }
function maSipTable(rows, opts){
  opts = opts || {};
  return repTable([opts.noClient ? null : {t: 'Client'}, {t: 'Platform'}, {t: 'Category'}, {t: 'Scheme'}, {t: 'SIP amount', r: 1}, {t: 'Frequency'},
      {t: 'Monthly', r: 1}, {t: 'SIP day', r: 1}, {t: 'Start'}, {t: 'End'}, {t: 'Status'}].filter(Boolean),
    rows.map(r=>`<tr class="row-clickable" onclick="maOpenSip('${esc(maSipId(r))}')">${opts.noClient ? '' : `<td><b>${esc(r._c.name)}</b></td>`}
      <td>${esc(r.platform)}</td><td>${esc(r.product)}</td><td>${esc(r.security_name || '—')}${r.identifier ? `<div class="small-note" style="margin:2px 0 0">${esc(r.identifier)}</div>` : ''}</td>
      <td class="se-r">${maMoney(r.sip_amount)}</td><td>${esc(r.frequency || '—')}</td><td class="se-r">${maMoney(r.monthly_amount)}</td>
      <td class="se-r">${r.sip_day || '—'}</td><td>${maDate(r.start_date)}</td><td>${maDate(r.end_date)}</td>
      <td>${r.live ? `<span class="badge ok">${esc(r.status || 'Active')}</span>` : `<span class="badge muted">${esc(r.status || 'Ended')}</span>`}</td></tr>`),
    'No SIPs.');
}

/* ---- SIPs ------------------------------------------------------------ */
function viewAssetSips(){
  maStyle();
  if(!can('CMS','view')) return permissionWall('CMS');
  const v = maView();
  const q = maKey(MA.sipQ);
  let rows = v.sips.filter(s=>(!MA.sipLive || s.live) && (!MA.sipProduct || s.product === MA.sipProduct)
    && (!MA.sipPlatform || s.platform_key === MA.sipPlatform)
    && (!q || maKey(s._c.name + ' ' + (s.security_name || '') + ' ' + (s.identifier || '')).indexOf(q) >= 0));
  rows = rows.sort((a, b)=>(b.monthly_amount || 0) - (a.monthly_amount || 0) || a._c.name.localeCompare(b._c.name));
  const t = maSums([], rows);
  const plats = Array.from(new Map(v.sips.map(s=>[s.platform_key, s.platform])).entries());
  return `
    ${moduleHeader({title: '🔁 SIPs', subtitle: rows.length + ' SIP' + (rows.length === 1 ? '' : 's') + ' · ' + money(t.sip_monthly) + ' a month live',
      actions: [{label: 'Download Excel', icon: '⤓', onclick: "maExportXlsx({sipsOnly:true}, 'SIPs')"}]})}
    <div class="list-searchrow">
      <input class="search list-search" id="maSipSearch" placeholder="Search client, scheme or folio" value="${esc(MA.sipQ)}" oninput="MA.sipQ=this.value; render()">
      <select class="list-sort" onchange="MA.sipLive=this.value==='live'; render()">
        <option value="live" ${MA.sipLive ? 'selected' : ''}>Live SIPs</option><option value="all" ${MA.sipLive ? '' : 'selected'}>All SIPs</option></select>
      <select class="list-sort" onchange="MA.sipProduct=this.value; render()"><option value="">Every category</option>
        ${MA_PRODUCTS.map(p=>`<option value="${p}" ${MA.sipProduct === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
      <select class="list-sort" onchange="MA.sipPlatform=this.value; render()"><option value="">Every platform</option>
        ${plats.map(([k, n])=>`<option value="${esc(k)}" ${MA.sipPlatform === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
    </div>
    ${v.sips.length ? maSipTable(rows.slice(0, 1000)) : maEmptyHtml()}
    ${rows.length > 1000 ? `<div class="small-note">The first 1000 are shown; narrow the search, or download the Excel for all of them.</div>` : ''}`;
}
const MA_STEP_MONTHS = {Monthly: 1, Quarterly: 3, 'Half Yearly': 6, Yearly: 12};
function maAddMonths(iso, n){
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(d, last));
  return dt.toISOString().slice(0, 10);
}
/* Installments so far, installments left and the next due date, worked
   out from the dates and the frequency. Estimates: the files do not list
   the actual debits. */
function maSchedule(s, today){
  today = today || maToday();
  const step = MA_STEP_MONTHS[s.frequency];
  if(!step || !/^\d{4}-\d{2}-\d{2}$/.test(s.start_date || '')) return null;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(s.end_date || '') ? s.end_date : null;
  let paid = 0, next = null, cur = s.start_date;
  for(let i = 0; i < 1200; i++){
    if(end && cur > end) break;
    if(cur > today){ next = cur; break; }
    paid++;
    cur = maAddMonths(s.start_date, step * (i + 1));
  }
  let total = null;
  if(end){ total = 0; for(let i = 0; i < 1200 && maAddMonths(s.start_date, step * i) <= end; i++) total++; }
  return {paid, total, remaining: total === null ? null : Math.max(total - paid, 0), next_due: s.live ? next : null,
    invested_estimate: s.sip_amount ? paid * s.sip_amount : null};
}
function maOpenSip(ref){
  const [uid_, idx] = String(ref).split(':');
  const u = maUploads().find(x=>x.id === uid_);
  const s = u ? maRowsOf(u)[Number(idx)] : null;
  if(!s){ alert('That SIP is no longer on file.'); return; }
  maState();
  const st = maState(), cur = new Set(st.sips);
  const same = r => r._c.ck === s._c.ck && ((s.isin && r.isin === s.isin) || (s.identifier && r.identifier === s.identifier)
    || maKey(r.security_name) === maKey(s.security_name));
  const history = st.all.filter(r=>r._u.kind === 'sip' && r.platform_key === s.platform_key && r.product === s.product && same(r))
    .sort((a, b)=>(b._u.seq || 0) - (a._u.seq || 0));
  const holding = st.holdings.filter(same);
  const others = st.sips.filter(r=>r._c.ck === s._c.ck && r !== s);
  const sch = maSchedule(s);
  const line = (l, v) => `<div class="rms-insight-row"><label>${esc(l)}</label><div>${v}</div></div>`;
  openModal(esc(s.security_name || 'SIP'), `
    <div class="small-note" style="margin-top:0">${esc(s._c.name)} · ${esc(s.platform)} · ${esc(s.product)} · ${cur.has(s) ? 'the version in use' : 'an earlier version'}</div>
    <div class="rms-insight">
      ${line('SIP amount', maMoney(s.sip_amount))}${line('Frequency', esc(s.frequency || '—'))}
      ${line('Monthly equivalent', maMoney(s.monthly_amount))}${line('SIP day', s.sip_day || '—')}
      ${line('Status', s.live ? `<span class="badge ok">${esc(s.status || 'Active')}</span>` : `<span class="badge muted">${esc(s.status || 'Ended')}</span>`)}
      ${line('Folio / registration', esc(s.identifier || '—'))}${line('ISIN', esc(s.isin || '—'))}
      ${line('Start · end', maDate(s.start_date) + ' → ' + maDate(s.end_date))}
      ${sch ? line('Installments so far', sch.paid + (sch.total !== null ? ' of ' + sch.total + ' (' + sch.remaining + ' left)' : '')) : ''}
      ${sch && sch.next_due ? line('Next installment', maDate(sch.next_due)) : ''}
      ${sch && sch.invested_estimate ? line('Invested through this SIP (estimate)', money(sch.invested_estimate)) : ''}
      ${line('Source', esc(s._u.file) + ' · v' + s._u.version + ' · data as of ' + maDate(s._u.snapshotDate))}
    </div>
    ${holding.length ? `<div class="section-title">Current holding in this scheme</div>${maHoldingsTable(holding)}` : ''}
    ${history.length > 1 ? `<div class="section-title">How this SIP changed across uploads</div>
      ${repTable([{t: 'Version'}, {t: 'Data as of'}, {t: 'Amount', r: 1}, {t: 'Monthly', r: 1}, {t: 'Frequency'}, {t: 'Status'}],
        history.map(r=>`<tr><td>v${r._u.version}${cur.has(r) ? ' <span class="ma-chip">in use</span>' : ''}</td><td>${maDate(r._u.snapshotDate)}</td>
          <td class="se-r">${maMoney(r.sip_amount)}</td><td class="se-r">${maMoney(r.monthly_amount)}</td><td>${esc(r.frequency || '—')}</td><td>${esc(r.status || '—')}</td></tr>`))}` : ''}
    ${others.length ? `<div class="section-title">Other SIPs of ${esc(s._c.name)}</div>${maSipTable(others, {noClient: true})}` : ''}
  `, `<button class="btn" onclick="closeModal()">Close</button>`);
}

/* ---- Upload (the Admin Panel) --------------------------------------- */
function maLastUpload(p, kind){
  return maUploads().filter(u=>maKey(u.platform) === maKey(p.name) && u.product === p.product && u.kind === kind
    && u.uploadType === MA.uploadType && (MA.uploadType !== 'client' || maKey(u.clientName) === maKey(MA.clientName)))
    .sort((a, b)=>(b.seq || 0) - (a.seq || 0))[0] || null;
}
function maHistoryTable(list, opts){
  opts = opts || {};
  const cur = maState().currentUploads;
  const mayRemove = maCanUpload();
  return repTable([{t: 'Uploaded'}, {t: 'Type'}, {t: 'Platform'}, {t: 'Category'}, {t: 'File'}, {t: 'Version'}, {t: 'Data as of'},
      {t: 'Rows', r: 1}, {t: 'Clients', r: 1}, {t: 'In use'}, mayRemove ? {t: ''} : null].filter(Boolean),
    list.map(u=>`<tr><td>${esc(fmtDate(u.at))}<div class="small-note" style="margin:2px 0 0">${esc(teamName(u.by))}</div></td>
      <td>${u.uploadType === 'client' ? 'Client Wise<div class="small-note" style="margin:2px 0 0">' + esc(u.clientName) + '</div>' : 'Platform Wise'}</td>
      <td>${esc(u.platform)}</td><td>${esc(u.product)} · ${MA_KIND_LABEL[u.kind]}</td>
      <td class="small-note">${u.hasFile ? `<a class="cell-link" href="javascript:void(0)" onclick="maDownloadOriginal('${esc(u.id)}')">${esc(u.file)}</a>` : esc(u.file)}
        ${u.notes ? `<div>${esc(u.notes)}</div>` : ''}${u.unmatched && u.unmatched.length ? `<div>Not in BOSS: ${esc(u.unmatched.slice(0, 6).join(', '))}${u.unmatched.length > 6 ? ' and ' + (u.unmatched.length - 6) + ' more' : ''}</div>` : ''}</td>
      <td>v${u.version}</td><td>${maDate(u.snapshotDate)}</td><td class="se-r">${u.rowsCount}</td><td class="se-r">${u.clientsCount}</td>
      <td>${cur.has(u.id) ? '<span class="badge ok">In use</span>' : '<span class="badge muted">Earlier</span>'}</td>
      ${mayRemove ? `<td><button class="btn sm ghost" onclick="maRemoveUpload('${esc(u.id)}')">Remove</button></td>` : ''}</tr>`),
    opts.empty || 'No uploads yet.');
}
function viewAssetUpload(){
  maStyle();
  if(!maCanUpload()) return permissionWall('CMS');
  const plats = maPlatforms();
  const nPicked = Object.keys(MA.picked).filter(k=>MA.picked[k]).length;
  const clientNames = (DB.clients || []).filter(c=>!c.deletedAt && c.cmsName).map(c=>c.cmsName).sort();
  const hq = maKey(MA.histQ);
  const hist = maUploads().slice().sort((a, b)=>(b.seq || 0) - (a.seq || 0))
    .filter(u=>!hq || maKey([u.platform, u.product, u.file, u.clientName].join(' ')).indexOf(hq) >= 0);
  return `
    ${moduleHeader({title: 'Upload platform files', subtitle: 'AUM and SIP files for every platform and category (MF, Stocks, PMS, AIF, Bonds, LAS, Other), Excel or PDF'})}
    <div class="card">
      <div class="section-title" style="margin-top:0">1. Upload type</div>
      <div class="ma-seg" role="tablist">
        <button type="button" class="${MA.uploadType === 'client' ? 'on' : ''}" onclick="MA.uploadType='client'; render()"><b>Client Wise</b><small>Files for one client</small></button>
        <button type="button" class="${MA.uploadType === 'platform' ? 'on' : ''}" onclick="MA.uploadType='platform'; render()"><b>Platform Wise</b><small>Bulk files with many clients</small></button>
      </div>
      <div class="form-grid" style="margin-top:12px">
        ${MA.uploadType === 'client' ? `<div class="field"><label>Client name <span class="req">*</span></label>
          <input type="text" id="maClientName" list="maClientList" value="${esc(MA.clientName)}" placeholder="A BOSS client, or a name" autocomplete="off"
            onchange="MA.clientName=this.value; render()">
          <datalist id="maClientList">${clientNames.slice(0, 3000).map(n=>`<option value="${esc(n)}">`).join('')}</datalist>
          <div class="small-note" style="margin:4px 0 0">${maClientFromName(MA.clientName) ? 'Matched to the BOSS client of that name.' : (MA.clientName ? (MA.createClients ? 'No BOSS client has this name yet; one is added when you upload.' : 'No BOSS client has this name; the data stays on the upload screens until one is added.') : '')}</div></div>` : ''}
        <div class="field"><label>Data as of <span class="small-note">(optional)</span></label>
          <input type="date" id="maSnapDate" value="${esc(MA.snapDate)}" onchange="MA.snapDate=this.value">
          <div class="small-note" style="margin:4px 0 0">Leave blank to use the date in each file, or today.</div></div>
        <div class="field"><label>PDF password <span class="small-note">(only for locked PDFs)</span></label>
          <input type="password" id="maPdfPassword" autocomplete="off" placeholder="Optional">
          <div class="small-note" style="margin:4px 0 0">Used to open the file in this browser, never stored.</div></div>
      </div>
      <div class="ma-opts" style="margin-top:10px;display:flex;gap:18px;flex-wrap:wrap">
        <label class="row" style="gap:6px"><input type="checkbox" id="maCreateClients" ${MA.createClients ? 'checked' : ''} onchange="MA.createClients=this.checked; render()">
          Add clients that aren't in BOSS yet</label>
        <label class="row" style="gap:6px"><input type="checkbox" id="maOverwrite" ${MA.overwrite ? 'checked' : ''} onchange="MA.overwrite=this.checked">
          Overwrite client details already filled in (PAN, mobile, email, date of birth, branch, RM, associate)</label>
      </div>
      <div class="field" style="margin:10px 0 0;max-width:420px"><label>RM for clients without one</label>
        <select id="maRm" onchange="MA.rm=this.value">${maRmOptionsHtml(MA.rm, 'None \u2014 use the RM named in the file')}</select>
        <div class="small-note" style="margin:4px 0 0">Clients added or matched by the upload who have no RM yet are mapped to this person,
          who is told in BOSS and finds them in their CMS list. An RM named in the file is used first.</div></div>
      <div class="small-note" style="margin:6px 0 0">Everything uploaded goes into BOSS itself: the client record, the client's Portfolio tab,
        the Main Dashboard's Live AUM and Live SIP, Portfolio Review and the reports. Blank client details are always filled in from the file.</div>
    </div>
    <div class="card">
      <div class="between"><div class="section-title" style="margin:0">2. Choose files <span class="small-note">AUM and SIP file for each platform</span></div>
        <button class="btn sm" onclick="MA.addOpen=!MA.addOpen; render()">+ Add platform</button></div>
      ${MA.addOpen ? `<div class="row" style="gap:8px;margin:10px 0;flex-wrap:wrap">
        <input type="text" id="maNewPlatform" placeholder="Platform name" maxlength="80">
        <select id="maNewProduct">${MA_PRODUCTS.map(p=>`<option value="${p}">${esc(p)}</option>`).join('')}</select>
        <button class="btn sm primary" onclick="maAddPlatform()">Add</button></div>` : ''}
      <div class="table-wrap"><table class="ma-matrix"><thead><tr><th>Category</th><th>Platform</th><th>AUM file</th><th>SIP file</th>
        <th>Last update ${MA.uploadType === 'client' ? (MA.clientName ? 'for ' + esc(MA.clientName) : '') : '(bulk files)'}</th></tr></thead>
      <tbody>${plats.map(p=>{
        const la = maLastUpload(p, 'aum'), ls = maLastUpload(p, 'sip');
        const last = [la, ls].filter(Boolean).sort((a, b)=>(b.seq || 0) - (a.seq || 0))[0];
        const fileCell = kind => `<input type="file" accept=".xlsx,.xls,.csv,.pdf" data-ma="${esc(p.id)}:${kind}" onchange="maPick(this)" ${MA.busy ? 'disabled' : ''}>
          ${MA.picked[p.id + ':' + kind] ? `<div class="small-note" style="margin:2px 0 0">${esc(MA.picked[p.id + ':' + kind].name)}</div>` : ''}`;
        return `<tr><td>${esc(p.product)}</td><td><b>${esc(p.name)}</b></td><td>${fileCell('aum')}</td><td>${fileCell('sip')}</td>
          <td class="small-note">${last ? 'v' + last.version + ' · ' + esc(fmtDate(last.at)) + ' · data as of ' + maDate(last.snapshotDate) : '—'}</td></tr>`;
      }).join('')}</tbody></table></div>
      <div class="between" style="margin-top:10px">
        <span class="small-note" id="maUploadMsg" style="margin:0">${esc(MA.msg || (nPicked ? nPicked + ' file' + (nPicked === 1 ? '' : 's') + ' chosen' : ''))}</span>
        <div class="row" style="gap:8px"><button class="btn" onclick="MA.picked={}; MA.msg=''; render()" ${MA.busy ? 'disabled' : ''}>Clear</button>
          <button class="btn primary" id="maUploadAll" onclick="maUploadAll()" ${MA.busy || !nPicked ? 'disabled' : ''}>${MA.busy ? 'Uploading…' : 'Upload All'}</button></div>
      </div>
    </div>
    ${maColumnNamesHtml()}
    ${maNoRmHtml()}
    <div class="card" id="maImported">
      <div class="between"><div class="section-title" style="margin:0">Imported data</div>
        <span class="small-note" style="margin:0">Remove one upload below, an old import here, or everything at once.</span></div>
      ${maLegacyImportsHtml()}
    </div>
    <div class="card">
      <div class="between"><div class="section-title" style="margin:0">Update history</div>
        <span class="small-note" style="margin:0">Every upload is kept. The screens use the latest version of each platform + category.</span></div>
      <div class="list-searchrow"><input class="search list-search" id="maHistSearch" placeholder="Search uploads" value="${esc(MA.histQ)}" oninput="MA.histQ=this.value; render()"></div>
      ${maHistoryTable(hist.slice(0, 300))}
    </div>
    ${isAdmin() ? `<div class="card" style="border-left:3px solid var(--danger)">
      <div class="between"><div><div class="section-title" style="margin:0">Delete all imported data</div>
        <div class="small-note" style="margin:4px 0 0">Deletes every uploaded file and every imported holding and SIP, including those from the old platform import,
          so the Main Dashboard and the client pages go back to the BOSS ledger. Clients, their details and the platform list are kept. This can't be undone.</div></div>
        <button class="btn danger" onclick="maResetAll()">Delete all imported data</button></div></div>` : ''}`;
}
/* WHO WORKS THE IMPORTED CLIENTS.

   A client an upload added is a CMS client like any other, and is worked
   by its RM. Those still without one are listed here and mapped to an RM
   in one go; the RM is told and finds them in their own CMS list. */
function maRmChoices(){ return typeof activeTeam === 'function' ? activeTeam() : (DB.team || []); }
function maRmOptionsHtml(sel, none){
  return `<option value="">${esc(none)}</option>` + maRmChoices().map(t=>
    `<option value="${esc(t.id)}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}${t.role ? ' \u00b7 ' + esc(roleOf(t)) : ''}</option>`).join('');
}
function maClientsWithoutRm(){
  const imported = new Set((DB.platformHoldings || []).concat(DB.platformSips || []).filter(x=>x && !x.deletedAt && x.clientId).map(x=>x.clientId));
  return (DB.clients || []).filter(c=>c && !c.deletedAt && !c.rmName
    && (imported.has(c.id) || /^Platform upload/.test(c.createdVia || '')));
}
function maNoRmHtml(){
  if(!can('CMS', 'assign')) return '';
  const list = maClientsWithoutRm();
  if(!list.length) return '';
  return `<div class="card" id="maNoRm" style="border-left:3px solid var(--warn)">
    <div class="between"><div><div class="section-title" style="margin:0">Imported clients without an RM <span class="small-note">${list.length}</span></div>
      <div class="small-note" style="margin:4px 0 0">${esc(list.slice(0, 8).map(c=>c.cmsName || clientCode(c)).join(', '))}${list.length > 8 ? ' and ' + (list.length - 8) + ' more' : ''}.
        Nobody is working them until they have an RM.</div></div>
      <div class="row" style="gap:8px"><select id="maNoRmRm" onchange="MA.noRmRm=this.value">${maRmOptionsHtml(MA.noRmRm, 'Choose an RM')}</select>
        <button class="btn primary" onclick="maAssignRm()">Map to RM</button></div></div>
  </div>`;
}
async function maAssignRm(ids, rm){
  if(!can('CMS', 'assign')){ alert('You do not have Assign permission on CMS.'); return; }
  rm = rm || MA.noRmRm || ((document.getElementById('maNoRmRm') || {}).value || '');
  if(!rm || !maRmChoices().some(t=>t.id === rm)){ alert('Choose the RM first.'); return; }
  const list = ids ? (DB.clients || []).filter(c=>ids.indexOf(c.id) >= 0 && !c.deletedAt) : maClientsWithoutRm();
  if(!list.length) return;
  list.forEach(c=>{ c.rmName = rm; c.modifiedBy = currentUser; c.modifiedAt = new Date().toISOString(); });
  await save('clients');
  for(const c of list) await logAudit('CMS', c.id, 'RM mapped', [{field: 'rmName', oldValue: '', newValue: teamName(rm)}]);
  await maTellRms({[rm]: list.map(c=>c.cmsName || '')}, 'imported data');
  MA.noRmRm = '';
  render();
  return list.length;
}
async function maTellRms(assigned, from){
  for(const rm of Object.keys(assigned || {})){
    const names = assigned[rm];
    if(!rm || rm === currentUser || !names.length || typeof notifyUser !== 'function') continue;
    await notifyUser(rm, {kind: 'cms-rm-mapped', view: 'cms', title: names.length === 1 ? 'Client mapped to you: ' + names[0] : names.length + ' clients mapped to you',
      body: 'From ' + from + ' by ' + teamName(currentUser) + '. ' + names.slice(0, 6).join(', ') + (names.length > 6 ? ' and ' + (names.length - 6) + ' more' : '') + '. They are in your CMS list.'});
  }
}
/* The old platform import (before uploads were the one door) left
   holdings and SIPs of its own, one batch per file. Each batch can be
   taken out here: the lines it wrote go, and BOSS reads the ledger, or a
   newer upload, for those clients again. */
function maLegacyLines(batchId){
  const mine = x => x && x.source !== 'multiasset' && x.batchId === batchId;
  return {h: (DB.platformHoldings || []).filter(mine), s: (DB.platformSips || []).filter(mine)};
}
function maLegacyImportsHtml(){
  const batches = (DB.importBatches || []).filter(b=>!b.removedAt).map(b=>Object.assign({b}, maLegacyLines(b.id)))
    .filter(x=>x.h.length || x.s.length).sort((a, b)=>String(b.b.at).localeCompare(String(a.b.at)));
  if(!batches.length) return '<div class="small-note">No data from the old platform import is left. Uploaded files are listed under Update history, each with Remove.</div>';
  const may = maCanUpload();
  return `<div class="small-note" style="margin-top:4px">From the old platform import (Finowise, Anand Rathi, NJ reports):</div>
    <div class="table-wrap"><table><thead><tr><th>Imported</th><th>Report</th><th>File</th><th class="se-r">Holdings</th><th class="se-r">SIPs</th><th class="se-r">Value</th>${may ? '<th></th>' : ''}</tr></thead>
    <tbody>${batches.map(x=>`<tr><td>${esc(fmtDate(String(x.b.at).slice(0, 10)))}<div class="small-note" style="margin:2px 0 0">${esc(teamName(x.b.by))}</div></td>
      <td>${esc(typeof impPlatformLabel === 'function' ? impPlatformLabel(x.b.platform) : x.b.platform)} · ${esc(x.b.report || '')}</td><td class="small-note">${esc(x.b.file || '')}</td>
      <td class="se-r">${x.h.length}</td><td class="se-r">${x.s.length}</td>
      <td class="se-r">${money(x.h.filter(h=>!h.deletedAt).reduce((n, h)=>n + (Number(h.current) || 0), 0) + x.s.filter(v=>!v.deletedAt).reduce((n, v)=>n + (Number(v.monthlyAmount || v.amount) || 0), 0))}</td>
      ${may ? `<td><button class="btn sm ghost" onclick="maRemoveLegacyBatch('${esc(x.b.id)}')">Delete</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}
async function maRemoveLegacyBatch(id){
  if(!maCanUpload()){ alert('You do not have permission to delete imported data.'); return; }
  const b = (DB.importBatches || []).find(x=>x.id === id);
  if(!b) return;
  const l = maLegacyLines(id);
  if(!confirm('Delete what "' + (b.file || id) + '" imported: ' + l.h.length + ' holding line' + (l.h.length === 1 ? '' : 's') + ' and '
    + l.s.length + ' SIP line' + (l.s.length === 1 ? '' : 's') + '?\n\nThe clients stay. This cannot be undone.')) return;
  const gone = new Set(l.h.concat(l.s));
  DB.platformHoldings = (DB.platformHoldings || []).filter(x=>!gone.has(x));
  DB.platformSips = (DB.platformSips || []).filter(x=>!gone.has(x));
  if(l.h.length) await save('platformHoldings');
  if(l.s.length) await save('platformSips');
  b.removedAt = new Date().toISOString(); b.removedBy = currentUser;
  await save('importBatches');
  await logAudit('Import', id, 'Imported data deleted', [{field: 'Batch', oldValue: (b.file || id) + ' · ' + l.h.length + ' holdings, ' + l.s.length + ' SIPs', newValue: ''}]);
  await maSyncCrm();
  render();
}
function maClientFromName(name){
  const n = maKey(name);
  if(!n) return null;
  const hits = (DB.clients || []).filter(c=>!c.deletedAt && maKey(c.cmsName) === n);
  return hits.length === 1 ? hits[0] : null;
}
function maPick(input){
  const [pid, kind] = String(input.getAttribute('data-ma')).split(':');
  const f = input.files && input.files[0];
  if(f) MA.picked[pid + ':' + kind] = f; else delete MA.picked[pid + ':' + kind];
  MA.msg = '';
  const n = Object.keys(MA.picked).length;
  const m = document.getElementById('maUploadMsg'); if(m) m.textContent = n ? n + ' file' + (n === 1 ? '' : 's') + ' chosen' : '';
  const b = document.getElementById('maUploadAll'); if(b) b.disabled = !n;
}
async function maAddPlatform(){
  const name = maTidy((document.getElementById('maNewPlatform') || {}).value).slice(0, 80);
  const product = (document.getElementById('maNewProduct') || {}).value;
  if(!name){ alert('Enter the platform name.'); return; }
  const list = maPlatforms().slice();
  if(list.some(p=>maKey(p.name) === maKey(name) && p.product === product)){ alert(name + ' is already listed under ' + product + '.'); return; }
  list.push({id: maKey(product + ' ' + name).replace(/\s+/g, '-') + '-' + Date.now().toString(36), name, product});
  list.sort((a, b)=>MA_PRODUCTS.indexOf(a.product) - MA_PRODUCTS.indexOf(b.product));
  DB.config.assetPlatforms = list;
  await save('config');
  await logAudit('Settings', 'assetPlatforms', 'Multi-asset platform added', [{field: product, oldValue: '', newValue: name}]);
  MA.addOpen = false;
  render();
}
/* =====================================================================
   THE PLATFORM REPORTS BOSS KNOWS COLUMN BY COLUMN

   Finowise, Anand Rathi and NJ send AUM and SIP reports whose every
   column has a place in BOSS (IMPORT_FORMATS): the client's PAN, mobile
   and RM, each sleeve of the AUM, the SIP's folio and dates. When an
   uploaded Excel file is one of them it is read that way — the same
   reading, checks and client matching the old import ran — and turned
   into rows here, so there is one door for every file.
   ===================================================================== */
function maLooseHead(h){ return String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, ''); }
/* REPORTS THAT ARE NOT HOLDINGS.

   Two kinds of platform file look like an AUM report and must not be read
   as one. A summary — NJ's Group Wise AUM (the Investor Wise figures added
   up by family) or Finowise's Branch Wise AUM (one line per branch) — is
   the same money again, so adding it would count it twice; it is named
   and left out. NJ's Folio Detail report carries no values at all, only
   who each investor is, so it fills in the client records and nothing
   else. */
const MA_DETAILS_ONLY = 'Client details only';
function maSpecialLayout(read, heads, kind){
  const has = h => heads.has(maLooseHead(h));
  if(kind === 'aum' && has('Group') && has('Partner/Employee') && !has('Investor') && (has('TOTAL') || has('EQUITY')))
    return {fmt: {id: 'nj_group', label: 'NJ — Group Wise AUM Report'}, rows: [], failed: 0, notes: ['This is NJ\u2019s Group Wise AUM report: '
      + 'the Investor Wise figures added up by family group. It is not added, so nothing is counted twice \u2014 upload the NJ Investor Wise AUM report for these clients']};
  if(has('Branch Name') && read.headers.filter(h=>/^[A-Za-z]{3}-\d{4}$/.test(String(h).trim())).length >= 2)
    return {fmt: {id: 'branch_summary', label: 'Branch Wise AUM Report'}, rows: [], failed: 0, notes: ['This is a Branch Wise AUM summary: '
      + 'one total per branch per month, with no clients in it. It is not added, so nothing is counted twice \u2014 the client-wise AUM reports make up these totals']};
  if(has('Folio No') && has('Investor Name') && has('First Holder PAN')){
    const col = h => read.headers.findIndex(x=>maLooseHead(x) === maLooseHead(h));
    const C = {name: col('Investor Name'), group: col('Group'), pan: col('First Holder PAN'), dob: col('First holder DOB'),
      mobile: col('Mobile No'), email: col('Email'), street: col('Address'), city: col('City'), zip: col('Pin code'), state: col('State'),
      accNo: col('Bank Ac No.'), bank: col('Bank_Name'), bbranch: col('Bank Branch'), ifsc: col('IFSC Code'), rm: col('Partner/ Employee')};
    const val = (r, i) => { const v = i < 0 ? '' : String(r[i] == null ? '' : r[i]).trim(); return v === '-' ? '' : v; };
    const TYPES = {pan: 'pan', dob: 'date', mobile: 'mobile', email: 'email', mailingStreet: 'text', mailingCity: 'text',
      mailingZip: 'text', mailingState: 'text', accNo: 'text', bankName: 'text', branchName: 'text', ifsc: 'text'};
    const rows = [];
    read.rows.forEach(r=>{
      const name = val(r, C.name);
      if(!name) return;
      const raw = {pan: val(r, C.pan).toUpperCase(), dob: val(r, C.dob), mobile: val(r, C.mobile), email: val(r, C.email),
        mailingStreet: val(r, C.street), mailingCity: val(r, C.city), mailingZip: val(r, C.zip), mailingState: val(r, C.state),
        accNo: val(r, C.accNo), bankName: val(r, C.bank), branchName: val(r, C.bbranch), ifsc: val(r, C.ifsc).toUpperCase()};
      const cd = {};
      Object.keys(raw).forEach(k=>{
        if(!raw[k]) return;
        const cell = typeof impCell === 'function' ? impCell(TYPES[k], raw[k]) : {v: raw[k]};
        if(!cell.err && cell.v !== '' && cell.v !== null && cell.v !== undefined) cd[k] = cell.v;
      });
      rows.push({client_name: impNormName(name), pan: cd.pan || null, cd, level: 'details'});
    });
    const people = new Set(rows.map(h=>h.pan || maKey(h.client_name))).size;
    return {fmt: {id: 'nj_folio', label: 'NJ — Folio Detail Report'}, rows, failed: 0, detailsOnly: true,
      notes: ['Read as the NJ Folio Detail report: ' + rows.length + ' folios of ' + people + ' investors. It carries no values, so it fills in the '
        + 'client records (PAN, date of birth, mobile, email, address, bank) and adds no holdings']};
  }
  return null;
}
async function maKnownLayout(file, kind){
  if(typeof IMPORT_FORMATS === 'undefined' || typeof impReadFile !== 'function') return null;
  let read;
  try { read = await impReadFile(file); } catch(e){ return null; }
  const heads = new Set(read.headers.filter(Boolean).map(maLooseHead));
  const special = maSpecialLayout(read, heads, kind);
  if(special) return special;
  let best = null;
  IMPORT_FORMATS.filter(f=>f.report === (kind === 'sip' ? 'SIP' : 'AUM')).forEach(fmt=>{
    const map = impMapFor(fmt.id);
    const named = Object.keys(map).filter(src=>map[src]);
    const hit = named.filter(src=>heads.has(maLooseHead(src))).length;
    const ratio = named.length ? hit / named.length : 0;
    if(hit >= 3 && ratio >= 0.6 && (!best || ratio > best.ratio)) best = {fmt, map, ratio};
  });
  if(!best) return null;
  const was = typeof impWiz === 'undefined' ? null : impWiz;
  const w = Object.assign(impBlank(), {format: best.fmt.id, platform: best.fmt.platform, file: file.name, sheet: read.sheet,
    headers: read.headers, rows: read.rows, asOn: read.asOn || '', map: Object.assign({}, best.map)});
  impSuggestColumns(w);
  let a;
  try { impWiz = w; a = impAnalyse(); } finally { impWiz = was; }
  if(!a) return null;
  const SUMMARY = 'All schemes (investor total)';
  const out = [];
  a.rows.forEach(r=>{
    if(!r.ok) return;
    const name = r.clientName || impNormName(r.ident.name || r.client.cmsName || '');
    const pan = r.client.pan || (IMP_PAN_RE.test(impNormPan(r.ident.pan || '')) ? impNormPan(r.ident.pan) : '');
    const base = {client_name: name, pan: pan || null, client_id: r.aum.platformClientCode || r.sip.platformClientId || pan || null,
      cid: r.clientId || '', cd: r.client, src: r.src};
    if(best.fmt.report === 'AUM'){
      const aum = Object.assign({}, r.aum), sleeves = aum.s || {};
      delete aum.s;
      const num = v => (v === '' || v === undefined) ? null : v;
      const rec = Object.assign(base, {level: 'summary', security_name: SUMMARY, invested: num(aum.invested),
        current_value: num(aum.current), xirr: num(aum.xirr), as_of: read.asOn || null, sleeves});
      if(rec.current_value === null){
        const sum = Object.values(sleeves).reduce((n, x)=>n + (Number(x && x.current) || 0), 0);
        if(sum) rec.current_value = sum;
      }
      if(rec.invested !== null && rec.current_value !== null) rec.gain_loss = maRound(rec.current_value - rec.invested, 2);
      delete aum.invested; delete aum.current; delete aum.xirr;
      rec.extra = Object.assign(aum, {format: best.fmt.id});
      out.push(rec);
    } else {
      const sip = Object.assign({}, r.sip);
      const rec = Object.assign(base, {security_name: sip.schemeName || '', identifier: sip.folio || sip.sipNo || null,
        isin: sip.isin || null, sip_amount: sip.amount === '' || sip.amount === undefined ? null : sip.amount,
        frequency: sip.frequency || '', sip_day: sip.sipDate || null, start_date: sip.startDate || null,
        end_date: sip.endDate || null, status: sip.status || '', as_of: read.asOn || null});
      MaExtract.completeSip(rec);
      if(sip.monthlyAmount !== '' && sip.monthlyAmount !== undefined) rec.monthly_amount = sip.monthlyAmount;
      ['schemeName', 'folio', 'isin', 'amount', 'monthlyAmount', 'frequency', 'sipDate', 'startDate', 'endDate', 'status'].forEach(k=>{ delete sip[k]; });
      rec.extra = Object.assign(sip, {format: best.fmt.id});
      out.push(rec);
    }
  });
  /* Blank lines, a second heading row and the Total / Count lines at the
     foot are not rows anyone meant to import, and are not reported as such. */
  const blankLine = r => r.errs.some(e=>/is required and this row is blank/.test(e))
    && r.errs.every(e=>/is required and this row is blank|is already on row/.test(e));
  const bad = a.rows.filter(r=>!r.ok && !blankLine(r));
  const notes = ['Read as the ' + best.fmt.label];
  if(read.asOn) notes.push('as on ' + fmtDate(read.asOn));
  (w.guessed || []).forEach(g=>notes.push('the column "' + g.header + '" was read as ' + g.forCol));
  if(bad.length) notes.push(bad.length + ' row' + (bad.length === 1 ? '' : 's') + ' not imported: '
    + bad.slice(0, 5).map(r=>'row ' + r.n + ' (' + r.errs.join('; ') + ')').join(', ') + (bad.length > 5 ? ' and more' : ''));
  return {fmt: best.fmt, rows: out, notes, failed: bad.length};
}

/* =====================================================================
   THE CLIENT RECORD

   What a file says about the client themselves — PAN, mobile, email,
   date of birth, branch, RM, associate — goes onto the BOSS client. A
   blank is filled; something already there is changed only when
   "Overwrite client details" is ticked. A client the file names and BOSS
   does not have is added (unless that box is unticked), so their money
   counts on every screen rather than sitting only in the upload.
   ===================================================================== */
const MA_DETAIL_TO_CLIENT = {pan: ['pan', 'pan'], mobile: ['mobile', 'mobile'], email: ['email', 'email'], dob: ['dob', 'date'],
  branch: ['branch', 'text'], rm_name: ['rmName', 'team'], associate: ['associateName', 'text']};
function maClientDetails(h){
  if(h.cd && typeof h.cd === 'object') return Object.assign({}, h.cd);
  const out = {};
  Object.keys(MA_DETAIL_TO_CLIENT).forEach(f=>{
    const v = f === 'pan' ? (maPanOf(h.pan) || maPanOf(h.client_id)) : h[f];
    if(v === null || v === undefined || String(v).trim() === '') return;
    const [to, type] = MA_DETAIL_TO_CLIENT[f];
    const cell = impCell(type, v);
    if(!cell.err && cell.v !== '' && cell.v !== null && cell.v !== undefined) out[to] = cell.v;
  });
  return out;
}
async function maApplyClients(rows, ctx){
  const res = {created: [], updated: 0, assigned: {}};
  if(!rows.length) return res;
  const live = (DB.clients || []).filter(c=>c && !c.deletedAt);
  const idx = impClientIndex(live);
  const byId = new Map(live.map(c=>[c.id, c]));
  const now = new Date().toISOString();
  let touched = false;
  const groups = new Map();
  rows.forEach(h=>{
    const name = maTidy(h.client_name);
    const pan = maPanOf(h.pan) || maPanOf(h.client_id);
    const k = ctx.clientId ? 'c:' + ctx.clientId : ctx.clientName ? 'cw' : (pan ? 'p:' + pan : 'n:' + maKey(name));
    if(!groups.has(k)) groups.set(k, {name, pan, rows: [], details: {}, cid: h.cid || ''});
    const g = groups.get(k);
    g.rows.push(h);
    if(!g.name) g.name = name;
    if(!g.cid && h.cid) g.cid = h.cid;
    const d = maClientDetails(h);
    Object.keys(d).forEach(f=>{ if(g.details[f] === undefined) g.details[f] = d[f]; });
  });
  /* A Client Wise file that turns out to hold several people: only its
     rows are kept later, so nobody else's mobile or PAN is copied over. */
  if(ctx.clientName && new Set(rows.map(h=>maPanOf(h.pan) || maPanOf(h.client_id) || maKey(h.client_name)).filter(Boolean)).size > 1)
    groups.forEach(g=>{ g.details = {}; });
  if(typeof autoSuspend === 'function') autoSuspend();
  if(typeof auditSuspend === 'function') auditSuspend();
  try {
    for(const g of groups.values()){
      let client = null;
      if(ctx.clientId) client = byId.get(ctx.clientId) || null;
      else if(g.cid && byId.has(g.cid)) client = byId.get(g.cid);
      else {
        const m = impMatchClient({pan: g.pan || '', name: ctx.clientName || g.name}, live, idx);
        if(m.clientId) client = byId.get(m.clientId) || null;
        else if(m.how !== 'new') continue;              // two clients share it: left for a person
      }
      const fresh = !client;
      if(!client){
        const name = ctx.clientName || g.name;
        if(!ctx.create || !name || maKey(name) === maKey(MA_UNASSIGNED)) continue;
        client = {id: uid('CMS'), cmsName: name, createdAt: now, createdBy: currentUser,
          createdVia: 'Platform upload · ' + ctx.platform};
        initState('CMS', client);
        DB.clients.push(client);
        live.push(client); byId.set(client.id, client);
        const p = maPanOf(g.pan);
        if(p){ if(!idx.byPan.has(p)) idx.byPan.set(p, []); idx.byPan.get(p).push(client); }
        const nk = impNormKey(name);
        if(!idx.byName.has(nk)) idx.byName.set(nk, []);
        idx.byName.get(nk).push(client);
        if(p && !g.details.pan) g.details.pan = p;
        res.created.push(name);
        touched = true;
        await logAudit('CMS', client.id, 'Created by platform upload', [{field: 'Source', oldValue: '', newValue: ctx.platform + ' · ' + ctx.file}]);
      }
      const changes = [];
      Object.keys(g.details).forEach(k=>{
        if(k === 'cmsName' && fresh) return;
        const was = client[k];
        const blank = was === undefined || was === null || String(was).trim() === '';
        if(!blank && !ctx.overwrite) return;
        if(String(was == null ? '' : was) === String(g.details[k])) return;
        changes.push({field: k, oldValue: String(was == null ? '' : was), newValue: String(g.details[k])});
        client[k] = g.details[k];
      });
      /* Somebody has to work the client: the RM the file names, or else the
         one picked on the upload page for clients that have none. */
      if(!client.rmName && ctx.rm && maRmChoices().some(t=>t.id === ctx.rm)){
        client.rmName = ctx.rm;
        changes.push({field: 'rmName', oldValue: '', newValue: teamName(ctx.rm)});
      }
      if(client.rmName && changes.some(x=>x.field === 'rmName'))
        (res.assigned[client.rmName] = res.assigned[client.rmName] || []).push(client.cmsName || '');
      if(changes.length){
        touched = true;
        if(!fresh){ res.updated++; await logAudit('CMS', client.id, 'Updated by platform upload', changes); }
      }
      g.rows.forEach(h=>{ h.cid = client.id; });
    }
    if(touched) await save('clients');
  } finally {
    if(typeof autoResume === 'function') autoResume();
    if(typeof auditResume === 'function') await auditResume();
  }
  return res;
}

/* =====================================================================
   COLUMN NAMES

   The reader knows the usual names of every column. A platform that
   calls one something else is taught it here, once: the heading as the
   file spells it and the field it is. Saved in config.assetColumnNames.
   ===================================================================== */
const MA_FIELD_LABEL = {client_name: 'Client name', client_id: 'Client code / ID', pan: 'PAN', mobile: 'Mobile', email: 'Email',
  dob: 'Date of birth', branch: 'Branch', rm_name: 'RM name', associate: 'Associate name', category: 'Category / asset type',
  security_name: 'Scheme / security name', isin: 'ISIN', identifier: 'Folio / symbol / SIP no', quantity: 'Units / quantity',
  avg_cost: 'Average cost', invested: 'Invested amount', current_price: 'Current price / NAV', current_value: 'Current value',
  gain_loss: 'Gain / loss', return_pct: 'Return %', xirr: 'XIRR', as_of: 'Valuation date', start_date: 'Start date',
  end_date: 'End / maturity date', level: '', asset_class: '', sip_amount: 'SIP amount', frequency: 'SIP frequency',
  sip_day: 'SIP day', status: 'SIP status'};
function maColumnNames(){
  const v = typeof DB !== 'undefined' && DB.config && DB.config.assetColumnNames;
  return Array.isArray(v) ? v.filter(c=>c && c.heading && c.field) : [];
}
function maColumnFieldOptions(){
  const seen = new Set(), out = [];
  ['aum', 'sip'].forEach(k=>MaExtract.fields[k].forEach(f=>{ if(MA_FIELD_LABEL[f] && !seen.has(f)){ seen.add(f); out.push(f); } }));
  return out;
}
async function maAddColumnName(){
  const heading = maTidy((document.getElementById('maColHeading') || {}).value).slice(0, 80);
  const field = (document.getElementById('maColField') || {}).value;
  const kind = (document.getElementById('maColKind') || {}).value || 'both';
  if(!heading){ alert('Type the column heading as it appears in the file.'); return; }
  if(!MA_FIELD_LABEL[field]){ alert('Choose what the column holds.'); return; }
  if(kind !== 'both' && MaExtract.fields[kind].indexOf(field) < 0){ alert(MA_FIELD_LABEL[field] + ' is not read from ' + kind.toUpperCase() + ' files.'); return; }
  const n = MaExtract.norm(heading);
  const list = maColumnNames().filter(c=>!(MaExtract.norm(c.heading) === n && (c.kind === kind || kind === 'both' || c.kind === 'both')));
  list.push({heading, field, kind, at: new Date().toISOString(), by: currentUser});
  DB.config.assetColumnNames = list;
  await save('config');
  await logAudit('Settings', 'assetColumnNames', 'Upload column name added', [{field: heading, oldValue: '', newValue: MA_FIELD_LABEL[field] + ' (' + kind + ')'}]);
  render();
}
async function maRemoveColumnName(i){
  const list = maColumnNames();
  const c = list[i]; if(!c) return;
  list.splice(i, 1);
  DB.config.assetColumnNames = list;
  await save('config');
  await logAudit('Settings', 'assetColumnNames', 'Upload column name removed', [{field: c.heading, oldValue: MA_FIELD_LABEL[c.field] || c.field, newValue: ''}]);
  render();
}
function maColumnNamesHtml(){
  const list = maColumnNames();
  const kinds = {both: 'AUM and SIP files', aum: 'AUM files', sip: 'SIP files'};
  return `<div class="card" id="maColumnNames">
    <div class="section-title" style="margin-top:0">Column names</div>
    <div class="small-note" style="margin-top:0">Every file is read by its column headings: the usual names for each field are known already,
      and the Finowise, Anand Rathi and NJ reports are read column by column. If a platform calls a column something else, add the heading
      here exactly as the file spells it and say what it holds. Every later upload reads it that way.</div>
    ${list.length ? `<div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Heading in the file</th><th>Read as</th><th>In</th><th></th></tr></thead>
      <tbody>${list.map((c, i)=>`<tr><td><b>${esc(c.heading)}</b></td><td>${esc(MA_FIELD_LABEL[c.field] || c.field)}</td><td>${esc(kinds[c.kind] || kinds.both)}</td>
        <td><button class="btn sm ghost" onclick="maRemoveColumnName(${i})">Remove</button></td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
      <input type="text" id="maColHeading" placeholder="Heading, e.g. Mkt Val (Rs)" maxlength="80">
      <select id="maColField">${maColumnFieldOptions().map(f=>`<option value="${f}">${esc(MA_FIELD_LABEL[f])}</option>`).join('')}</select>
      <select id="maColKind">${Object.keys(kinds).map(k=>`<option value="${k}">${esc(kinds[k])}</option>`).join('')}</select>
      <button class="btn sm primary" onclick="maAddColumnName()">Add column name</button>
    </div>
  </div>`;
}
const MA_FORMATS = {'.xlsx': 'xlsx', '.xls': 'xls', '.csv': 'xlsx', '.pdf': 'pdf'};
async function maReadFile(file, kind, password, strict){
  const ext = (String(file.name).match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const format = MA_FORMATS[ext];
  if(!format) throw new Error('only Excel (.xlsx, .xls, .csv) or PDF files can be uploaded.');
  if(!file.size) throw new Error('the file is empty.');
  if(file.size > MA_MAX_BYTES) throw new Error('files must be ' + (MA_MAX_BYTES / 1024 / 1024) + ' MB or smaller.');
  const buffer = await file.arrayBuffer();
  if(format === 'pdf'){
    const h = new Uint8Array(buffer.slice(0, 4));
    if(!(h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46)) throw new Error('This does not look like a real .pdf file.');
  }
  let rows = [], notes = [], status;
  if(format !== 'pdf' && !strict){
    const known = await maKnownLayout(file, kind);
    if(known) return {buffer, format, rows: known.rows, notes: known.notes, layout: known.fmt.id, detailsOnly: !!known.detailsOnly,
      status: known.detailsOnly ? MA_DETAILS_ONLY : known.rows.length ? 'Processed' : 'Nothing found'};
  }
  try {
    const out = await MaExtract.extract(file, buffer.slice(0), format, password, kind, strict);
    rows = out.holdings; notes = out.notes;
    status = rows.length ? 'Processed' : 'Nothing found';
    if(!rows.length) notes.push(kind === 'sip' ? 'No SIP table was recognised in this file' : 'No holdings table was recognised in this file');
  } catch(e){
    if(e && e.name === 'PasswordException')
      throw new Error(password ? 'The PDF password is incorrect.' : 'This PDF is password protected. Enter the PDF password and upload again.');
    status = 'Unreadable';
    notes = ['Could not read file: ' + String((e && e.message) || e).slice(0, 200)];
  }
  return {buffer, format, rows, notes, status};
}
async function maUploadAll(){
  if(MA.busy) return;
  const clientName = maTidy(MA.clientName);
  if(MA.uploadType === 'client' && !clientName){ alert('Enter the client name first.'); return; }
  const client = MA.uploadType === 'client' ? maClientFromName(clientName) : null;
  const plats = maPlatforms();
  const jobs = Object.keys(MA.picked).filter(k=>MA.picked[k]).map(k=>{
    const [pid, kind] = k.split(':');
    return {key: k, kind, file: MA.picked[k], platform: plats.find(p=>p.id === pid)};
  }).filter(j=>j.platform).sort((a, b)=>plats.indexOf(a.platform) - plats.indexOf(b.platform) || a.kind.localeCompare(b.kind));
  if(!jobs.length) return;
  /* A portfolio statement often carries a SIP summary too: it is read from
     the AUM file when no SIP file was chosen for that platform. */
  jobs.slice().forEach(j=>{
    if(j.kind === 'aum' && !jobs.some(x=>x.kind === 'sip' && x.platform === j.platform))
      jobs.splice(jobs.indexOf(j) + 1, 0, Object.assign({}, j, {key: j.platform.id + ':sip:auto', kind: 'sip', auto: true}));
  });
  const password = (document.getElementById('maPdfPassword') || {}).value || '';
  MA.busy = true; render();
  const batchId = 'MAB-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const results = [];
  try {
    for(let i = 0; i < jobs.length; i++){
      const job = jobs[i];
      MA.msg = 'Uploading ' + (i + 1) + ' of ' + jobs.length + ': ' + job.platform.name + ' ' + job.platform.product + ' ' + MA_KIND_LABEL[job.kind] + '…';
      const m = document.getElementById('maUploadMsg'); if(m) m.textContent = MA.msg;
      try {
        const r = await maReadFile(job.file, job.kind, password, !!job.auto);
        if(job.auto && !r.rows.length){ continue; }
        if(r.layout === 'nj_group' || r.layout === 'branch_summary'){ results.push({job, refused: true, error: r.notes.join('; ')}); continue; }
        /* The client record first: details filled in, new clients added,
           so every row lands on a BOSS client before it is saved. */
        const cl = await maApplyClients(r.rows, {clientId: client ? client.id : '', clientName: MA.uploadType === 'client' ? clientName : '',
          create: MA.createClients, overwrite: MA.overwrite, rm: MA.rm, platform: job.platform.name, file: job.file.name});
        if(cl.created.length) r.notes.push(cl.created.length + ' new client' + (cl.created.length === 1 ? '' : 's') + ' added to BOSS');
        const nAssigned = Object.values(cl.assigned).reduce((n, l)=>n + l.length, 0);
        if(nAssigned){ r.notes.push(nAssigned + ' client' + (nAssigned === 1 ? '' : 's') + ' given an RM'); await maTellRms(cl.assigned, job.platform.name + ' upload'); }
        if(cl.updated) r.notes.push(cl.updated + ' client record' + (cl.updated === 1 ? '' : 's') + ' updated');
        if(r.detailsOnly){ results.push({job, details: true, clients: cl, rowsCount: r.rows.length, note: r.notes[0] || ''}); continue; }
        const created = await maCreateUpload({uploadType: MA.uploadType, clientName, clientId: client ? client.id : '',
          platform: job.platform.name, product: job.platform.product, kind: job.kind, batchId, snapshotDate: MA.snapDate || null,
          file: job.file.name, fileType: job.file.type || '', format: r.format, size: job.file.size, sha256: await maSha256(r.buffer),
          status: r.status, notes: r.notes.join('; '), rows: r.rows, buffer: r.buffer});
        if(created.skipped) results.push({job, skipped: true, unchanged: created.unchanged, error: created.message, clients: cl});
        else results.push({job, ok: true, created, clients: cl});
      } catch(e){ results.push({job, error: (e && e.message) || String(e)}); }
    }
    const saved = results.filter(r=>r.ok);
    if(saved.length){
      await logAudit('Import', batchId, 'Multi-asset files uploaded', saved.map(r=>({field: r.job.platform.name + ' · ' + r.job.platform.product
        + ' · ' + MA_KIND_LABEL[r.job.kind], oldValue: '', newValue: r.job.file.name + ' (v' + r.created.version + ', ' + r.created.rowsCount + ' rows)'})));
      DB.importHistory.push({id: uid('IMH'), module: 'Platform files · ' + (MA.uploadType === 'client' ? 'Client Wise' : 'Platform Wise'),
        file: saved.map(r=>r.job.file.name).filter((v, i, a)=>a.indexOf(v) === i).join(', '),
        total: saved.reduce((n, r)=>n + r.created.rowsCount, 0), imported: saved.reduce((n, r)=>n + r.created.rowsCount, 0),
        skipped: 0, date: new Date().toISOString(), by: currentUser, batchId});
      await save('importHistory');
      const snap = saved.map(r=>r.created.snapshotDate).sort().pop();
      await maSyncCrm({asOn: snap, batchId});
    }
  } finally {
    MA.busy = false;
  }
  results.filter(r=>r.ok || r.skipped || r.details || r.refused).forEach(r=>{ delete MA.picked[r.job.key]; });
  MA.msg = '';
  MA.result = {results, batchId, uploadType: MA.uploadType, clientName, clientId: client ? client.id : ''};
  render();
  maShowResults();
}
function maShowResults(){
  const R = MA.result; if(!R) return;
  const ok = R.results.filter(r=>r.ok), bad = R.results.filter(r=>r.error && !r.skipped && !r.refused), skipped = R.results.filter(r=>r.skipped);
  const details = R.results.filter(r=>r.details), refused = R.results.filter(r=>r.refused);
  const title = ok.length || details.length ? (bad.length ? 'Uploaded with some problems' : 'Uploaded successfully') : 'Nothing was uploaded';
  const sub = [ok.length ? ok.length + ' file' + (ok.length === 1 ? '' : 's') + ' saved' : '',
    details.length ? details.length + ' read for client details' : '', refused.length ? refused.length + ' summary report' + (refused.length === 1 ? '' : 's') + ' not added' : '',
    skipped.length ? skipped.length + ' unchanged or already uploaded' : '', bad.length ? bad.length + ' failed' : '',
    R.uploadType === 'client' ? 'for ' + R.clientName : '(Platform Wise)'].filter(Boolean).join(' · ');
  const rowsHtml = R.results.map(r=>{
    let res;
    if(r.ok){
      const c = r.created, what = r.job.kind === 'sip' ? 'SIPs' : 'holdings';
      const head = c.isNew ? '<span class="badge ok">Added</span>' : `<span class="badge info">Version ${c.version}</span>`;
      const detail = c.isNew ? 'New data, as of ' + fmtDate(c.snapshotDate) : 'Added as version ' + c.version + ' for ' + fmtDate(c.snapshotDate) + '; earlier versions kept';
      const same = c.unchangedClients ? '; ' + c.unchangedClients + ' client' + (c.unchangedClients === 1 ? '' : 's') + ' unchanged, kept as before' : '';
      const boss = (c.clientsCount ? ' · ' + c.matchedClients + ' matched to BOSS clients' + (c.unmatched.length ? ', ' + c.unmatched.length + ' not in BOSS' : '') : '')
        + (r.clients && r.clients.created.length ? ' · ' + r.clients.created.length + ' new client' + (r.clients.created.length === 1 ? '' : 's') + ' added' : '')
        + (r.clients && r.clients.updated ? ' · ' + r.clients.updated + ' client record' + (r.clients.updated === 1 ? '' : 's') + ' updated' : '')
        + (c.upload && /^Read as the /.test(c.upload.notes || '') ? ' · ' + c.upload.notes.split(';')[0].replace(/^Read as the /, 'read as the ') : '');
      res = `${head} <span class="small-note">${esc(detail)} · ${c.rowsCount} ${what}${R.uploadType === 'platform' ? ', ' + c.clientsCount + ' clients' : ''}${esc(same)}${esc(boss)}</span>`
        + (c.rowsCount ? '' : `<div class="small-note">No ${what} could be read from this file.</div>`);
    } else if(r.details){
      const cl = r.clients || {created: [], updated: 0};
      res = `<span class="badge info">Client details</span> <span class="small-note">${esc(r.note)}${cl.updated ? ' · ' + cl.updated + ' client record' + (cl.updated === 1 ? '' : 's') + ' updated' : ''}${
        cl.created.length ? ' · ' + cl.created.length + ' new client' + (cl.created.length === 1 ? '' : 's') + ' added' : ''}</span>`;
    } else if(r.refused) res = `<span class="badge warn">Not added</span> <span class="small-note">${esc(r.error)}</span>`;
    else if(r.skipped) res = `<span class="badge muted">${r.unchanged ? 'No change' : 'Skipped'}</span> <span class="small-note">${esc(r.error)}</span>`;
    else res = `<span class="badge danger">Failed</span> <span class="small-note">${esc(r.error)}</span>`;
    return `<tr><td>${esc(r.job.platform.name)}</td><td>${esc(r.job.platform.product)}</td>
      <td>${MA_KIND_LABEL[r.job.kind]}${r.job.auto ? ' (read from the AUM file)' : ''}: ${esc(r.job.file.name)}</td><td>${res}</td></tr>`;
  }).join('');
  const dash = "navigate('dashboard')";
  openModal(title, `<div class="small-note" style="margin-top:0">${esc(sub)}</div>
    <div class="table-wrap" id="maResultTable"><table><thead><tr><th>Platform</th><th>Category</th><th>File</th><th>Result</th></tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="4" class="empty">No file was read.</td></tr>'}</tbody></table></div>`,
    `<button class="btn" onclick="closeModal()">Close</button>
     ${ok.some(r=>r.created.rowsCount) ? `<button class="btn" onclick="maExportXlsx({batch:'${esc(R.batchId)}'}, '${R.uploadType === 'client' ? esc(R.clientName).replace(/'/g, '') : 'Platform upload'}')">Generate Report</button>` : ''}
     <button class="btn primary" onclick="closeModal(); ${dash}">Open the dashboard</button>`);
}

/* =====================================================================
   THE EXCEL REPORT

   Summary (totals, by category, platform, asset class, and by client for
   a report of many clients), Client Summary, Holdings, Loans (LAS), SIPs
   and Source Files — the original system's layout, written with BOSS's
   own .xlsx writer.
   ===================================================================== */
function maExportXlsx(scope, label){
  scope = scope || {};
  const v = maView();
  let h, s;
  if(scope.batch){
    const st = maState(), ok = maVisibleFilter();
    h = st.all.filter(r=>r._u.batchId === scope.batch && r._u.kind !== 'sip' && ok(r));
    s = st.all.filter(r=>r._u.batchId === scope.batch && r._u.kind === 'sip' && ok(r));
  } else {
    const pk = scope.platform ? maKey(scope.platform) : '';
    const inScope = r => (!pk || r.platform_key === pk) && (!scope.product || r.product === scope.product) && (!scope.ck || r._c.ck === scope.ck);
    h = scope.sipsOnly ? [] : v.holdings.filter(inScope);
    s = v.sips.filter(inScope);
  }
  if(!h.length && !s.length){ alert('No data found.'); return; }
  const n2 = x => (x === null || x === undefined || x === '') ? '' : maRound(Number(x), 2);
  const t = maSums(h, s);
  const multi = new Set(h.concat(s).map(r=>r._c.ck)).size > 1;
  const sumRows = [['Report', label || 'Platform data'], ['Generated', new Date().toLocaleString(numberLocale())], ['Data as of', t.as_of || ''],
    [], ['Totals'], ['Current value (AUM)', n2(t.current_value)], ['Invested', n2(t.invested)], ['Gain', n2(t.gain_loss)],
    ['Return %', n2(t.return_pct)], ['XIRR %', n2(t.xirr)], ['Monthly SIP (live)', n2(t.sip_monthly)], ['Loans (LAS, not in AUM)', n2(t.loans)],
    ['Clients', t.clients], ['Holdings', t.holdings], ['SIPs', t.sips]];
  const block = (title, groups) => { sumRows.push([], [title, 'Invested', 'Current value', 'Gain', 'XIRR %', 'Monthly SIP', 'Loans']);
    groups.forEach(g=>sumRows.push([g.label, n2(g.invested), n2(g.current_value), n2(g.gain_loss), n2(g.xirr), n2(g.sip_monthly), n2(g.loanValue)])); };
  block('By category', maGroup(h, s, r=>r.product, r=>r.product).sort((a, b)=>MA_PRODUCTS.indexOf(a.key) - MA_PRODUCTS.indexOf(b.key)));
  block('By platform', maGroup(h, s, r=>r.platform_key, r=>r.platform));
  block('By asset class', maGroup(h.filter(r=>r.product !== MA_LOANS), [], r=>r.asset_class || 'Unclassified', r=>r.asset_class || 'Unclassified'));
  const sheets = [{name: 'Summary', rows: sumRows, bold: false}];
  if(multi){
    const cs = maGroup(h, s, r=>r._c.ck, r=>r._c.name);
    sheets.push({name: 'Client Summary', rows: [['Client', 'PAN', 'In BOSS', 'Categories', 'Platforms', 'Invested', 'Current value', 'Gain', 'XIRR %', 'Monthly SIP', 'Loans']]
      .concat(cs.map(g=>{ const c = (g.h[0] || g.s[0])._c; return [g.label, c.pan || '', c.clientId ? 'Yes' : 'No', g.products.join(', '),
        g.platformNames.join(', '), n2(g.invested), n2(g.current_value), n2(g.gain_loss), n2(g.xirr), n2(g.sip_monthly), n2(g.loanValue)]; }))});
  }
  const holdHead = ['Client', 'PAN', 'Category', 'Platform', 'Asset class', 'Scheme / security', 'ISIN', 'Folio / code', 'Units', 'Avg cost', 'Invested',
    'Current price', 'Current value', 'Gain', 'Return %', 'XIRR %', 'As of', 'Source file', 'Version'];
  const holdRow = r => [r._c.name, r._c.pan || '', r.product, r.platform, r.asset_class || '', r.security_name || '', r.isin || '', r.identifier || '',
    n2(r.quantity), n2(r.avg_cost), n2(r.invested), n2(r.current_price), n2(r.current_value), n2(r.gain_loss), n2(r.return_pct), n2(r.xirr),
    r.as_of || r._u.snapshotDate || '', r._u.file, r._u.version];
  const inv = h.filter(r=>r.product !== MA_LOANS), loans = h.filter(r=>r.product === MA_LOANS);
  if(inv.length) sheets.push({name: 'Holdings', rows: [holdHead].concat(inv.map(holdRow))});
  if(loans.length) sheets.push({name: 'Loans (LAS)', rows: [['Client', 'PAN', 'Platform', 'Loan / facility', 'Outstanding', 'As of', 'Source file']]
    .concat(loans.map(r=>[r._c.name, r._c.pan || '', r.platform, r.security_name || '', n2(r.current_value), r.as_of || r._u.snapshotDate || '', r._u.file]))});
  if(s.length) sheets.push({name: 'SIPs', rows: [['Client', 'PAN', 'Category', 'Platform', 'Scheme', 'ISIN', 'Folio / registration', 'SIP amount', 'Frequency',
    'Monthly', 'SIP day', 'Start', 'End', 'Status', 'Live', 'Source file', 'Version']]
    .concat(s.map(r=>[r._c.name, r._c.pan || '', r.product, r.platform, r.security_name || '', r.isin || '', r.identifier || '', n2(r.sip_amount),
      r.frequency || '', n2(r.monthly_amount), r.sip_day || '', r.start_date || '', r.end_date || '', r.status || '', r.live ? 'Yes' : 'No', r._u.file, r._u.version]))});
  const ups = Array.from(new Set(h.concat(s).map(r=>r._u)));
  sheets.push({name: 'Source Files', rows: [['File', 'Type', 'Platform', 'Category', 'Kind', 'Version', 'Data as of', 'Uploaded', 'By', 'Rows in this report']]
    .concat(ups.map(u=>[u.file, u.uploadType === 'client' ? 'Client Wise · ' + u.clientName : 'Platform Wise', u.platform, u.product, MA_KIND_LABEL[u.kind],
      u.version, u.snapshotDate || '', String(u.at || '').slice(0, 16).replace('T', ' '), teamName(u.by), h.concat(s).filter(r=>r._u === u).length]))});
  const safe = String(label || 'Multi_Assets').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'Multi_Assets';
  downloadXlsx(sheets, safe + '_' + maToday() + '.xlsx');
}

/* =====================================================================
   ON A CLIENT'S OWN PAGES

   The client's Portfolio tab and Portfolio Review show the platform
   figures already (they read platformHoldings). This adds what a summary
   line cannot: the schemes themselves, the SIPs, the loans, and a way to
   the client's full multi-asset dashboard.
   ===================================================================== */
function maClientBlockHtml(clientId){
  if(typeof DB === 'undefined' || !maUploads().length) return '';
  const st = maState();
  const ck = 'c:' + clientId;
  const h = st.holdings.filter(r=>r._c.ck === ck), s = st.sips.filter(r=>r._c.ck === ck);
  if(!h.length && !s.length) return '';
  maStyle();
  const t = maSums(h, s);
  const schemes = h.filter(r=>r.product !== MA_LOANS)
    .sort((a, b)=>MA_PRODUCTS.indexOf(a.product) - MA_PRODUCTS.indexOf(b.product) || (b.current_value || 0) - (a.current_value || 0));
  const loans = h.filter(r=>r.product === MA_LOANS);
  return `
    <div class="between" style="margin-top:14px"><div class="section-title" style="margin:0">Holdings by scheme, from the uploaded files</div>
      <button class="btn sm ghost" onclick="ReviewReport.open('${esc(clientId)}')">Review report</button></div>
    <div class="small-note" style="margin-top:4px">Read from the AUM and SIP files uploaded in Platform Import Mapping — the newest version of each platform and category.
      ${t.loans ? 'Loans against securities are shown on their own and are not part of the AUM.' : ''}</div>
    ${repKpis([{label: 'Current value', html: money(t.current_value)}, {label: 'Invested', html: money(t.invested)},
      {label: 'Gain', html: money(t.gain_loss), tone: t.gain_loss >= 0 ? 'ok' : 'danger', note: t.return_pct === null ? '' : maPct(t.return_pct)},
      {label: 'XIRR', value: maPct(t.xirr)}, {label: 'Monthly SIP', html: money(t.sip_monthly), note: t.live_sips + ' live'},
      t.loans ? {label: 'Loans (LAS)', html: money(t.loans), note: 'not in AUM'} : null])}
    ${schemes.length ? maHoldingsTable(schemes) : ''}
    ${s.length ? `<div class="section-title" style="font-size:12px">SIPs</div>${maSipTable(s, {noClient: true})}` : ''}
    ${loans.length ? `<div class="section-title" style="font-size:12px">Loans against securities</div>
      ${repTable([{t: 'Platform'}, {t: 'Loan / facility'}, {t: 'Outstanding', r: 1}], loans.map(l=>`<tr><td>${esc(l.platform)}</td><td>${esc(l.security_name || '—')}</td><td class="se-r">${money(l.current_value)}</td></tr>`))}` : ''}`;
}

/* ---- the four sections of Setup › Platform Import Mapping ----------- */
const MA_SECTIONS = [['upload', 'Upload files']];
function maSectionBar(cur){
  maStyle();
  /* One section: what the files hold is read on the Main Dashboard and the
     client's own pages, not on a second screen here. */
  if(MA_SECTIONS.length < 2) return '';
  return `<div class="tabs" style="margin:0 0 14px">${MA_SECTIONS.map(([id, label])=>`<div class="tab ${cur === id ? 'active' : ''}"
    onclick="window._impMapSection='${id}'; ${id === 'data' ? "window._maRoute={page:'home'}; " : ''}render()">${esc(label)}</div>`).join('')}</div>`;
}
function maSectionHtml(cur){
  if(cur === 'upload') return viewAssetUpload();
  if(cur === 'data') return viewAssets();
  if(cur === 'sips') return viewAssetSips();
  return '';
}
