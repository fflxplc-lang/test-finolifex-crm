/* LEXI signals: each holding read against the firm's investment policy
   (recommended list, risk-profile allocation, market valuation zone),
   valued at the AMFI NAV the server fetches, on the client's page, on
   Analytics, and handed to LEXI AI for a buy / sell / hold question. */
const http = require('http');
const {suite} = require('../lib/harness');

const BASE = Number(process.env.BOSS_PORT || 3000);
const NAV_PORT = BASE + 311, MOCK_PORT = BASE + 313;
const NAV_FILE = [
  'Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date',
  '',
  'Open Ended Schemes(Equity Scheme - Mid Cap Fund)',
  'HDFC Mutual Fund',
  '100001;INF179K01ZZ1;-;HDFC Mid Cap Fund - Growth Plan;150.0000;21-Oct-2026',
  '100002;INF179K01ZZ2;-;HDFC Mid Cap Fund - Growth Option - Direct Plan;170.0000;21-Oct-2026',
  '100003;-;INF179K01ZZ3;HDFC Mid Cap Fund - IDCW Option;40.0000;21-Oct-2026',
  '100004;INF846K01ZZ4;-;Axis Bluechip Fund - Regular Plan - Growth;60.0000;21-Oct-2026',
].join('\r\n');
let navHits = 0;
const navSrv = http.createServer((req, res) => { navHits++; res.setHeader('Content-Type', 'text/plain'); res.end(NAV_FILE); });
const seen = [];
const mock = http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d);
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if(req.url.endsWith('/models')) return res.end(JSON.stringify({data:[{id:'mock-model'}]}));
    const j = JSON.parse(body || '{}'); seen.push(j);
    const sys = ((j.messages||[]).find(m=>m.role==='system')||{}).content || '';
    const text = /WHICH RECORDS/.test(sys) ? '{"reads":[],"client":null}' : 'MOCK SIGNALS ANSWER';
    res.end(JSON.stringify({choices:[{message:{role:'assistant', content:text}}]}));
  });
});
const lastUser = () => { const m = seen[seen.length-1].messages; return m[m.length-1].content; };

suite(async t => {
  await new Promise(r => navSrv.listen(NAV_PORT, '127.0.0.1', r));
  await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));
  try {
  await t.home();
  const cid = await t.eval(() => {
    const c = {id: uid('CMS'), cmsName:'Signal Sharma', riskProfile:'Moderate', createdAt:new Date().toISOString(), assignedTo: me().id, branch:'Pune'};
    initState('CMS', c); DB.clients.push(c);
    const H = o => DB.platformHoldings.push(Object.assign({id: uid('H'), clientId: c.id}, o));
    H({schemeName:'HDFC Mid Cap Fund - Growth Plan', units: 1000, invested: 100000, current: 120000});
    H({schemeName:'Quant Multi Asset Fund - Growth', invested: 90000, current: 100000});
    H({schemeName:'Axis Bluechip Fund - Regular Plan - Growth', invested: 250000, current: 300000});
    H({schemeName:'Aditya Birla Sun Life Liquid Fund - Growth', invested: 20000, current: 20000});
    return c.id;
  });

  t.section('the policy read against each holding');
  await t.step('the recommended list decides hold or switch', async () => {
    const r = await t.eval((id) => {
      const s = lexiClientSignals(DB.clients.find(c=>c.id===id));
      return s.rows.map(x=>({scheme:x.scheme, action:x.action, to:x.switchTo, cat:x.cat}));
    }, cid);
    const by = Object.fromEntries(r.map(x=>[x.scheme.split(' ')[0], x]));
    if(by.HDFC.action !== 'Hold' || by.HDFC.cat !== 'Mid cap') throw new Error('HDFC ' + JSON.stringify(by.HDFC));
    if(by.Quant.action !== 'Switch' || !/ICICI/.test(by.Quant.to)) throw new Error('Quant ' + JSON.stringify(by.Quant));
    if(by.Axis.action !== 'Switch' || !/Nippon India Large Cap/.test(by.Axis.to)) throw new Error('Axis ' + JSON.stringify(by.Axis));
    if(by.Aditya.action !== 'Hold' || by.Aditya.cat !== 'Liquid') throw new Error('ABSL ' + JSON.stringify(by.Aditya));
    return 'hold HDFC Mid Cap and ABSL Liquid; switch Quant Multi Asset and Axis Bluechip';
  });
  await t.step('the server marks units to the AMFI NAV', async () => {
    const r = await t.eval(async () => {
      const res = await fetch('/api/market/nav', {method:'POST', headers:Object.assign({'Content-Type':'application/json'}, apiHeaders()),
        body: JSON.stringify({items:[{name:'HDFC Mid Cap Fund - Growth Plan'}, {name:'HDFC Mid Cap Fund Direct Growth'}, {name:'Nothing Like This Fund'}]})});
      return res.json();
    });
    const [a, b, c] = r.results || [];
    if(!r.ok || a.nav !== 150 || b.nav !== 170 || !c.missing) throw new Error(JSON.stringify(r));
    return 'regular 150, direct 170, unknown missing';
  });
  await t.step('equity above the allowed range asks to sell equity, and the market zone leans the advice', async () => {
    const r = await t.eval(async (id) => {
      navigate('cms', id);
      for(let i=0; i<40 && (lexiNav.busy || !lexiNav.fetchedAt); i++) await new Promise(r=>setTimeout(r, 100));
      const s = lexiClientSignals(DB.clients.find(c=>c.id===id));
      const card = document.body.innerText;
      DB.config.marketZone = {zone:'Expensive', setOn:new Date().toISOString(), by: me().id};
      const z = lexiClientSignals(DB.clients.find(c=>c.id===id));
      DB.config.marketZone = null;
      return {pct: s.pct, moves: s.moves, live: s.live, total: s.total, card: /LEXI SIGNALS/.test(card) && /Switch/.test(card), zoneWhy: (z.moves[0]||{}).why || ''};
    }, cid);
    if(!r.live || r.total !== 150000 + 100000 + 300000 + 20000) throw new Error('valuation ' + JSON.stringify(r));
    const sell = r.moves.find(m=>m.action==='Sell' && m.asset==='Equity');
    if(!sell || r.pct[0] <= 80) throw new Error('moves ' + JSON.stringify(r));
    if(!r.card) throw new Error('signals card not on the client page');
    if(!/Expensive/.test(r.zoneWhy) || !/arbitrage/.test(r.zoneWhy)) throw new Error('zone ' + r.zoneWhy);
    return 'equity ' + r.pct[0] + '%: sell about ₹' + sell.amount;
  });

  t.section('Analytics and LEXI AI');
  await t.step('Analytics lists the clients to act on', async () => {
    const r = await t.eval(() => { navigate('analytics'); const el = document.getElementById('anSignals'); return el ? el.innerText : ''; });
    if(!/Signal Sharma/.test(r) || !/Market valuation zone/.test(r)) throw new Error(r.slice(0, 300));
    return 'Signal Sharma is listed';
  });
  await t.step('a buy / sell question about the client hands LEXI the signals', async () => {
    await t.eval(async (port) => {
      await fetch('/api/connections/bossai', {method:'PUT', headers:Object.assign({'Content-Type':'application/json'}, apiHeaders()),
        body: JSON.stringify({enabled:true, config:{baseUrl:'http://127.0.0.1:'+port+'/v1', model:'mock-model'}})});
      await fetch('/api/connections/bossai/test', {method:'POST', headers: apiHeaders()});
      navigate('dashboard'); ai.turns = []; aiTogglePanel(); await aiRefreshStatus(true);
      document.getElementById('aiInput').value = 'Signal Sharma ke portfolio mein kya buy, hold ya sell karna hai?'; await aiSend();
    }, MOCK_PORT);
    const u = lastUser();
    if(!u.includes('portfolioSignals') || !u.includes('Quant Multi Asset') || !u.includes('"Switch"')) throw new Error(u.slice(0, 400));
    const sys = ((seen[seen.length-1].messages||[]).find(m=>m.role==='system')||{}).content || '';
    if(!/LEXI AI/.test(sys) || !/portfolioSignals/.test(sys)) throw new Error('rules missing');
    return 'signals in the data, rule in the brief';
  });
  await t.step('a book-wide sell question gets the clients to act on', async () => {
    await t.eval(async () => { document.getElementById('aiInput').value = 'Which clients should sell or switch something?'; await aiSend(); });
    const u = lastUser();
    if(!u.includes('portfolioSignals') || !u.includes('Signal Sharma')) throw new Error(u.slice(0, 400));
    return 'book signals sent';
  });
  } finally { navSrv.close(); mock.close(); }
});
