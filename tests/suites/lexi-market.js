/* LEXI and live prices: any listed company or index, read by the server
   from the price feed, handed to LEXI with the firm's market view, and
   shown as a card under the answer. A question about the CRM's own
   records never reads a price. */
const http = require('http');
const {suite} = require('../lib/harness');

const BASE = Number(process.env.BOSS_PORT || 3000);
const FEED_PORT = BASE + 317, MOCK_PORT = BASE + 319;

/* A year of daily bars ending now: the last close is `last`, the one
   before it `prev`, so the day's move is known exactly. */
function chart(symbol, name, from, prev, last){
  const n = 250, now = Date.now(), t = [], c = [];
  for(let i = n - 1; i >= 0; i--){ t.push(Math.floor((now - 60000 - i * 86400000) / 1000)); }
  for(let i = 0; i < n - 2; i++) c.push(from + (prev - from) * i / (n - 3) + (i % 2 ? 3 : -3));
  c.push(prev, last);
  return {chart:{result:[{meta:{symbol, longName:name, currency:'INR', fullExchangeName:'NSE', regularMarketPrice:last,
    regularMarketTime:Math.floor(now / 1000), regularMarketDayHigh:last + 5, regularMarketDayLow:last - 9,
    fiftyTwoWeekHigh:Math.max(from, last) + 20, fiftyTwoWeekLow:Math.min(from, last) - 20},
    timestamp:t, indicators:{quote:[{close:c, high:c.map(x => x + 4), low:c.map(x => x - 4)}]}}], error:null}};
}
const CHARTS = {
  'HDFCBANK.NS': chart('HDFCBANK.NS', 'HDFC Bank Limited', 600, 700, 707),
  'ICICIBANK.NS': chart('ICICIBANK.NS', 'ICICI Bank Limited', 1400, 1210, 1200),
  '^NSEI': chart('^NSEI', 'NIFTY 50', 25800, 22888.95, 22811.35),
  '^BSESN': chart('^BSESN', 'S&P BSE SENSEX', 84000, 74800, 74550),
  'RELIANCE.NS': chart('RELIANCE.NS', 'Reliance Industries Limited', 1500, 1400, 1410),
  'TCS.NS': chart('TCS.NS', 'Tata Consultancy Services Limited', 4200, 3100, 3120),
  'INFY.NS': chart('INFY.NS', 'Infosys Limited', 1900, 1500, 1490),
};
const SEARCH = {
  'hdfc bank': {quotes:[{symbol:'HDFCBANK.BO', shortname:'HDFC BANK', quoteType:'EQUITY'}, {symbol:'HDB', shortname:'HDFC Bank ADR', quoteType:'EQUITY'},
    {symbol:'HDFCBANK.NS', longname:'HDFC Bank Limited', quoteType:'EQUITY', sectorDisp:'Financial Services'}],
    news:[{title:'HDFC Bank shares near 52-week low', publisher:'Business Line', providerPublishTime:Math.floor(Date.now() / 1000) - 3600}]},
  'icici bank': {quotes:[{symbol:'ICICIBANK.NS', longname:'ICICI Bank Limited', quoteType:'EQUITY'}], news:[]},
  'reliance industries': {quotes:[{symbol:'RELIANCE.NS', longname:'Reliance Industries Limited', quoteType:'EQUITY'}], news:[]},
  'tcs': {quotes:[{symbol:'TCS.NS', longname:'Tata Consultancy Services Limited', quoteType:'EQUITY'}], news:[]},
  'infosys': {quotes:[{symbol:'INFY.NS', longname:'Infosys Limited', quoteType:'EQUITY'}], news:[]},
  'nothing like this': {quotes:[], news:[]},
};
const hits = [];
const feed = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  hits.push(u.pathname + u.search);
  res.setHeader('Content-Type', 'application/json');
  if(u.pathname === '/v1/finance/search'){
    const q = String(u.searchParams.get('q') || '').toLowerCase();
    if(q === 'broken feed'){ res.statusCode = 500; return res.end('{}'); }
    return res.end(JSON.stringify(SEARCH[q] || {quotes:[], news:[]}));
  }
  const m = u.pathname.match(/^\/v8\/finance\/chart\/(.+)$/);
  const ch = m && CHARTS[decodeURIComponent(m[1])];
  if(!ch){ res.statusCode = 404; return res.end('{"chart":{"result":null}}'); }
  res.end(JSON.stringify(ch));
});
const seen = [];
const mock = http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d);
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if(req.url.endsWith('/models')) return res.end(JSON.stringify({data:[{id:'mock-model'}]}));
    const j = JSON.parse(body || '{}'); seen.push(j);
    const sys = ((j.messages||[]).find(m=>m.role==='system')||{}).content || '';
    const text = /WHICH RECORDS/.test(sys) ? '{"reads":[],"client":null}' : 'Decision now: MOCK MARKET ANSWER';
    res.end(JSON.stringify({choices:[{message:{role:'assistant', content:text}}]}));
  });
});
const lastUser = () => { const m = seen[seen.length-1].messages; return m[m.length-1].content; };
const lastSys = () => ((seen[seen.length-1].messages||[]).find(m=>m.role==='system')||{}).content || '';

suite(async t => {
  await new Promise(r => feed.listen(FEED_PORT, '127.0.0.1', r));
  await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));
  try {
  await t.home();
  const quote = q => t.eval(async (q) => { const r = await fetch('/api/market/quote?q=' + encodeURIComponent(q), {headers: apiHeaders()}); return {status: r.status, body: await r.json()}; }, q);

  t.section('the server reads any listed company');
  await t.step('a name finds its NSE listing, and the day is read off a year of prices', async () => {
    const {body: r} = await quote('HDFC Bank');
    const x = r.quote || {};
    if(!r.ok || x.symbol !== 'HDFCBANK.NS') throw new Error(JSON.stringify(r).slice(0, 300));
    if(x.price !== 707 || x.change !== 7 || x.changePct !== 1) throw new Error('day ' + JSON.stringify({price:x.price, change:x.change, pct:x.changePct}));
    if(!(x.rsi14 > 0 && x.rsi14 <= 100) || !x.sma50 || !x.sma200 || !/^uptrend/.test(x.trend || '')) throw new Error('technicals ' + JSON.stringify({rsi:x.rsi14, sma50:x.sma50, sma200:x.sma200, trend:x.trend}));
    if((x.closes || []).length !== 60 || x.sector !== 'Financial Services' || !/52-week low/.test((r.news[0] || {}).title || '')) throw new Error('extras ' + JSON.stringify({closes:(x.closes||[]).length, sector:x.sector, news:r.news}));
    return 'HDFCBANK.NS ₹707, +7 (+1.00%), RSI ' + x.rsi14 + ', ' + x.trend.split(':')[0] + ', NSE chosen over BSE and the US listing';
  });
  await t.step('an index is read by the name people use for it', async () => {
    const before = hits.filter(h => h.startsWith('/v1/')).length;
    const {body: r} = await quote('nifty');
    if(!r.ok || r.quote.symbol !== '^NSEI' || r.quote.price !== 22811.35) throw new Error(JSON.stringify(r).slice(0, 200));
    if(hits.filter(h => h.startsWith('/v1/')).length !== before) throw new Error('searched for an index it knows');
    return 'nifty → ^NSEI at 22,811.35, no search';
  });
  await t.step('no listing, or a feed that is down, is an answer for LEXI, not an error', async () => {
    const a = await quote('Nothing like this'), b = await quote('Broken feed');
    if(a.status !== 200 || a.body.ok || !a.body.notFound) throw new Error('not found ' + JSON.stringify(a));
    if(b.status !== 200 || b.body.ok || b.body.notFound || !/500/.test(b.body.message)) throw new Error('down ' + JSON.stringify(b));
    return 'not found: "' + a.body.message + '"; down: "' + b.body.message + '"';
  });

  t.section('LEXI answers from live prices');
  await t.step('"konsa loon" between two companies hands LEXI both, with the market view, and draws a card each', async () => {
    const r = await t.eval(async (port) => {
      await lexiSetPe('19.1', '2026-10-22');
      await fetch('/api/connections/bossai', {method:'PUT', headers:Object.assign({'Content-Type':'application/json'}, apiHeaders()),
        body: JSON.stringify({enabled:true, config:{baseUrl:'http://127.0.0.1:'+port+'/v1', model:'mock-model'}})});
      await fetch('/api/connections/bossai/test', {method:'POST', headers: apiHeaders()});
      navigate('dashboard'); ai.turns = []; aiTogglePanel(); await aiRefreshStatus(true);
      document.getElementById('aiInput').value = 'HDFC Bank aur ICICI Bank mein konsa loon?'; await aiSend();
      const cards = [...document.querySelectorAll('.lexi-quote')].map(e => e.innerText.replace(/\s+/g, ' '));
      return {cards, answer: (document.getElementById('aiTurns') || document.body).innerText};
    }, MOCK_PORT);
    const u = lastUser();
    if(!u.includes('"liveMarket"') || !u.includes('HDFCBANK.NS') || !u.includes('ICICIBANK.NS') || !u.includes('"marketZone"') || !/Fair Value/.test(u)) throw new Error(u.slice(0, 500));
    if(!u.includes('policy-valuation-matrix')) throw new Error('the valuation matrix was not sent');
    if(!/liveMarket/.test(lastSys()) || !/Decision now/.test(lastSys())) throw new Error('rule missing from the brief');
    if(r.cards.length !== 2 || !/₹707/.test(r.cards[0]) || !/▲ 7/.test(r.cards[0]) || !/▼ 10/.test(r.cards[1])) throw new Error('cards ' + JSON.stringify(r.cards));
    if(!/MOCK MARKET ANSWER/.test(r.answer)) throw new Error('answer not shown');
    return 'both quotes and the Fair Value zone in the data; cards: ' + r.cards.map(c => c.split(' · ')[0]).join(' | ');
  });
  await t.step('a question about the CRM\'s records reads no prices', async () => {
    const before = hits.length;
    await t.eval(async () => { document.getElementById('aiInput').value = 'Aaj kitne tasks pending hain?'; await aiSend(); });
    if(hits.length !== before || lastUser().includes('liveMarket')) throw new Error('read prices for a records question');
    return 'no price read';
  });
  await t.step('"konsa share loon?" with no company reads the Nifty 50 and a default list, and says so', async () => {
    await t.eval(async () => { document.getElementById('aiInput').value = 'Konsa share loon abhi?'; await aiSend(); });
    const u = lastUser();
    for(const sym of ['^NSEI', 'HDFCBANK.NS', 'ICICIBANK.NS', 'RELIANCE.NS', 'TCS.NS', 'INFY.NS']) if(!u.includes(sym)) throw new Error('missing ' + sym + ': ' + u.slice(0, 300));
    if(!/not a screen of the whole market/.test(u)) throw new Error('the default list is not flagged');
    return 'Nifty 50 and five large companies read, flagged as a default list';
  });
  await t.step('a balance in the question sizes the answer: amount, shares each would buy, no junk lookups', async () => {
    await t.eval(async () => { document.getElementById('aiInput').value = 'Mere paas 5 lakh rupaye balance hai, konsa company ka share loon?'; await aiSend(); });
    const u = lastUser(), h = hits.filter(x => x.startsWith('/v1/finance/search')).map(x => decodeURIComponent(x.split('q=')[1].split('&')[0]));
    if(!u.includes('"investAmount":500000')) throw new Error('amount not sent: ' + u.slice(0, 300));
    if(!u.includes('"sharesAffordable":707')) throw new Error('shares for HDFC Bank (500000 / 707) not worked out');
    if(h.some(x => /mere|paas|balance|rupaye/i.test(x))) throw new Error('looked up filler words: ' + h.join(' | '));
    if(!/investAmount/.test(lastSys())) throw new Error('rule missing from the brief');
    return 'investAmount 500000, 707 HDFC Bank shares affordable, and no search was for "mere paas", "balance" or "rupaye" (searched: ' + [...new Set(h)].join(', ') + ')';
  });
  await t.step('amounts and words around the company are not read as company names', async () => {
    const r = await t.eval(() => ({
      amt: ['5 lakh', '₹2.5 cr', '50k', 'Rs 75,000', '1,00,000 hain', 'Nifty 50', 'Adani Ports 1', 'TCS 3500 ka share'].map(x => lexiMoneyIn(x)),
      two: lexiMarketAsk('5 lakh ka balance hai HDFC Bank lun ya ICICI Bank?', []),
      lag: lexiMarketAsk('Mera balance 1,00,000 hai, HDFC Bank aur ICICI Bank mein kitna lagaun?', []),
      client: lexiMarketAsk('Ek client ke account mein 2 lakh balance hai, konsa share loon?', [{}]),
      byName: lexiMarketAsk('Priya Sharma ke account mein 2 lakh balance hai, HDFC Bank lun ya ICICI Bank?', [{cmsName:'Priya Sharma'}]),
      records: ['Aaj kitne clients ne share kharide', 'Client ka report share karo', 'Konsa fund loon 5 lakh ke liye?', 'Ye document lagana hai'].map(x => lexiMarketAsk(x, [])),
      named: [lexiMarketAsk('Priya ka KYC share karo', [{}]), lexiMarketAsk('Priya ke liye kya buy karna hai', [{cmsName:'Priya Sharma'}])],
    }));
    if(JSON.stringify(r.amt) !== JSON.stringify([500000, 25000000, 50000, 75000, 100000, 0, 0, 0])) throw new Error('amounts ' + JSON.stringify(r.amt));
    if(JSON.stringify(r.two) !== '["HDFC Bank","ICICI Bank"]' || JSON.stringify(r.lag) !== '["HDFC Bank","ICICI Bank"]') throw new Error('names ' + JSON.stringify([r.two, r.lag]));
    if(!r.client || r.client[0] !== 'NIFTY 50') throw new Error('a named client lost the market read: ' + JSON.stringify(r.client));
    if(JSON.stringify(r.byName) !== '["HDFC Bank","ICICI Bank"]') throw new Error('the client\'s own name was looked up as a company: ' + JSON.stringify(r.byName));
    if(r.records.some(x => x !== null) || r.named.some(x => x !== null)) throw new Error('a records question read prices: ' + JSON.stringify([r.records, r.named]));
    return 'amounts parsed; a client plus "konsa share loon" reads the market; funds, reports and tasks do not';
  });
  } finally { feed.close(); mock.close(); }
});
