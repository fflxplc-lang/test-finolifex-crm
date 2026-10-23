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
  return {chart:{result:[{meta:{symbol, longName:name, currency:'INR', fullExchangeName:'NSE', regularMarketPrice:last, chartPreviousClose:prev,
    regularMarketTime:Math.floor(now / 1000), regularMarketDayHigh:last + 5, regularMarketDayLow:last - 9,
    fiftyTwoWeekHigh:Math.max(from, last) + 20, fiftyTwoWeekLow:Math.min(from, last) - 20},
    timestamp:t, indicators:{quote:[{close:c, high:c.map(x => x + 4), low:c.map(x => x - 4), open:c.map(x => x - 1.5), volume:c.map((_, i) => 100000 + i * 37)}]}}], error:null}};
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
    if((x.history || []).length < 250 || x.history[x.history.length - 1][1] !== 707) throw new Error('year of closes ' + JSON.stringify((x.history || []).slice(-2)));
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

  await t.step('the candles behind the large chart come per timeframe, and a listing can be refreshed by its symbol', async () => {
    const ask = async url => { const r = await t.eval(async (u) => { const x = await fetch(u, {headers: apiHeaders()}); return {status: x.status, body: await x.json()}; }, url); return r; };
    const c = await ask('/api/market/candles?symbol=HDFCBANK.NS&range=3M');
    if(!c.body.ok || c.body.candles.length !== 250 || c.body.candles[0].length !== 6 || c.body.interval !== '1d') throw new Error('candles ' + JSON.stringify(c.body).slice(0, 300));
    const last = c.body.candles[c.body.candles.length - 1];
    if(last[4] !== 707 || !(last[2] >= last[4] && last[3] <= last[4]) || !(last[5] > 0)) throw new Error('last bar ' + JSON.stringify(last));
    const asked = {}; for(const [r, want] of [['1D', 'range=1d&interval=5m'], ['5D', 'range=5d&interval=15m'], ['1Y', 'range=1y&interval=1d'], ['5Y', 'range=5y&interval=1wk'], ['ALL', 'range=max&interval=1mo']]){
      await ask('/api/market/candles?symbol=HDFCBANK.NS&range=' + r);
      if(!hits.some(h => h.includes('/HDFCBANK.NS?' + want))) throw new Error('no feed read for ' + r + ' (' + want + ')');
      asked[r] = want;
    }
    const bad = await ask('/api/market/candles?symbol=HDFC%20BANK&range=3M'), badR = await ask('/api/market/candles?symbol=HDFCBANK.NS&range=9Y');
    if(bad.status !== 200 || bad.body.ok || badR.status !== 200 || badR.body.ok || !badR.body.message) throw new Error('bad input answered ' + JSON.stringify([bad, badR]));
    const q = await ask('/api/market/quote?symbol=ICICIBANK.NS');
    if(!q.body.ok || q.body.quote.symbol !== 'ICICIBANK.NS' || q.body.quote.price !== 1200) throw new Error('quote by symbol ' + JSON.stringify(q.body).slice(0, 200));
    return 'OHLCV per timeframe (' + Object.keys(asked).join(', ') + '); a bad symbol or range is an answer (ok:false), not an error; quote by symbol refreshes without a search';
  });

  await t.step('every quote carries the chartist\'s checks: trend strength, MACD, Bollinger, ATR, levels, and a checklist with its lean', async () => {
    const ask = async url => (await t.eval(async (u) => (await fetch(u, {headers: apiHeaders()})).json(), url));
    const up = (await ask('/api/market/quote?symbol=HDFCBANK.NS')).quote.technical, dn = (await ask('/api/market/quote?symbol=ICICIBANK.NS')).quote.technical;
    for(const [n, x] of [['rising', up], ['falling', dn]]){
      for(const k of ['macd', 'bollinger', 'trendStrength', 'atr14', 'levels', 'checklist', 'volatilityPct', 'rsiReading', 'volumeVsAvg20'])
        if(x[k] == null) throw new Error(n + ' series lacks ' + k + ': ' + JSON.stringify(x).slice(0, 300));
      if(x.levels.low20 > x.levels.high20 || x.levels.low60 > x.levels.low20 || x.bollinger.lower >= x.bollinger.upper || !(x.atr14.value > 0)) throw new Error(n + ' figures are inconsistent ' + JSON.stringify(x));
    }
    if(!/bullish/.test(up.checklist.bias) || up.checklist.positive < 5) throw new Error('a rising series should lean up: ' + JSON.stringify(up.checklist));
    if(!/bearish/.test(dn.checklist.bias) || dn.checklist.positive > 2) throw new Error('a falling series should lean down: ' + JSON.stringify(dn.checklist));
    if(!(up.trendStrength.plusDi > up.trendStrength.minusDi) || !(dn.trendStrength.minusDi > dn.trendStrength.plusDi)) throw new Error('+DI / -DI point the wrong way');
    if(dn.macd.line > 0) throw new Error('MACD of the falling series is above zero: ' + JSON.stringify(dn.macd));
    return 'HDFC (rising): ' + up.checklist.bias + ' ' + up.checklist.positive + '/' + up.checklist.of + ', ADX ' + up.trendStrength.adx + '; ICICI (falling): ' + dn.checklist.bias + ' ' + dn.checklist.positive + '/' + dn.checklist.of + ', ADX ' + dn.trendStrength.adx;
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
    if(!u.includes('"technical"') || !u.includes('"checklist"') || !u.includes('"trendStrength"')) throw new Error('the technical block was not sent');
    const sys = lastSys();
    for(const w of ['forty years', 'Read:', 'What would change this view', 'not price targets', 'againstTheLean', 'last close']) if(!sys.includes(w)) throw new Error('the brief lacks "' + w + '"');
    if(r.cards.some(c => !/Technical: \w+.*checks up.*MACD.*ADX.*support.*resistance/i.test(c))) throw new Error('the cards carry no technical line ' + JSON.stringify(r.cards));
    if(!/MOCK MARKET ANSWER/.test(r.answer)) throw new Error('answer not shown');
    return 'both quotes and the Fair Value zone in the data; cards: ' + r.cards.map(c => c.split(' · ')[0]).join(' | ');
  });
  await t.step('a click on a price card opens the trading chart: candles, volume, timeframes, hover, zoom, live refresh', async () => {
    const wait = ms => t.eval(ms => new Promise(r => setTimeout(r, ms)), ms);
    const r1 = await t.eval(async () => {
      document.querySelector('.lexi-quote').click();
      await new Promise(r => setTimeout(r, 700));
      const st = window._lexiChart, cv = document.getElementById('lcCanvas'), o = {};
      o.open = !!document.getElementById('lexiChartOv'); o.tfs = [...document.querySelectorAll('#lcTfs button')].map(b => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? '*' : ''));
      o.bars = st.bars.length; o.shape = st.bars[0].length;
      const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let inked = 0; for(let i = 3; i < px.length; i += 4) if(px[i] > 0) inked++; o.inked = inked;
      const b = cv.getBoundingClientRect();
      cv.dispatchEvent(new PointerEvent('pointermove', {clientX: b.left + b.width * .4, clientY: b.top + 120, bubbles: true}));
      o.ohlc = document.getElementById('lcOhlc').innerText.replace(/\s+/g, ' '); o.cross = st.cross;
      cv.dispatchEvent(new WheelEvent('wheel', {clientX: b.left + b.width * .5, deltaY: -300, bubbles: true, cancelable: true}));
      o.zoomed = st.n; [...document.querySelectorAll('#lcTools button')].find(x => x.textContent === 'Reset').click(); o.reset = st.n;
      o.price0 = document.getElementById('lcPrice').textContent; o.text = document.getElementById('lexiChartOv').innerText.replace(/\s+/g, ' ');
      o.href = document.querySelector('#lexiChartOv a[href*="tradingview"]').getAttribute('href');
      return o;
    });
    if(!r1.open || r1.tfs.join() !== '1D,5D,1M,3M,6M*,YTD,1Y,5Y,All') throw new Error('timeframes ' + JSON.stringify(r1.tfs));
    if(r1.bars !== 250 || r1.shape !== 6) throw new Error('bars ' + r1.bars + ' x ' + r1.shape);
    if(r1.inked < 3000) throw new Error('the canvas is blank (' + r1.inked + ' pixels)');
    if(!/O [\d,.]+ H [\d,.]+ L [\d,.]+ C [\d,.]+/.test(r1.ohlc) || r1.cross == null) throw new Error('hover read-out ' + r1.ohlc);
    if(!(r1.zoomed < 250) || r1.reset !== 250) throw new Error('zoom ' + r1.zoomed + ' reset ' + r1.reset);
    if(r1.price0 !== '₹707') throw new Error('price ' + r1.price0);
    for(const w of ['Trend strength (ADX)', 'Support / resistance', 'Technical lean', '52-week range', 'RSI (14)', '50-day average', '200-day average', 'Financial Services', '52-week low']) if(!r1.text.includes(w)) throw new Error('missing ' + w);
    if(r1.href !== 'https://www.tradingview.com/chart/?symbol=NSE%3AHDFCBANK') throw new Error('link ' + r1.href);
    // each timeframe asks the feed for its own bar size
    const tfHit = {};
    for(const [tf, want] of [['1D', 'range=1d&interval=5m'], ['1Y', 'range=1y&interval=1d'], ['5Y', 'range=5y&interval=1wk'], ['All', 'range=max&interval=1mo']]){
      const n0 = hits.length;
      await t.eval(async (tf) => { [...document.querySelectorAll('#lcTfs button')].find(b => b.textContent === tf).click(); await new Promise(r => setTimeout(r, 500)); }, tf);
      if(!hits.slice(n0).some(h => h.includes('/HDFCBANK.NS?' + want))) throw new Error(tf + ' did not read ' + want);
      tfHit[tf] = want;
    }
    // the feed moves; the open chart follows it on its own refresh
    const ch = CHARTS['HDFCBANK.NS'].chart.result[0];
    ch.meta.regularMarketPrice = 712; ch.indicators.quote[0].close[ch.indicators.quote[0].close.length - 1] = 712;
    await t.eval(async () => { [...document.querySelectorAll('#lcTfs button')].find(b => b.textContent === '6M').click(); await new Promise(r => setTimeout(r, 400)); });
    const r2 = await t.eval(async () => { await lexiChartRefresh(); const st = window._lexiChart; return {price: document.getElementById('lcPrice').textContent, last: st.bars[st.bars.length - 1][4], stamp: /refreshed \d\d:\d\d:\d\d/.test(document.getElementById('lcLive').innerText)}; });
    ch.meta.regularMarketPrice = 707; ch.indicators.quote[0].close[ch.indicators.quote[0].close.length - 1] = 707;
    if(r2.price !== '₹712' || r2.last !== 712 || !r2.stamp) throw new Error('refresh ' + JSON.stringify(r2));
    const r3 = await t.eval(async () => { document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); return {closed: !document.getElementById('lexiChartOv'), state: window._lexiChart}; });
    if(!r3.closed || r3.state !== null) throw new Error('Escape did not close it');
    if(lastUser().includes('"history"')) throw new Error('the year of prices was sent to the model');
    return 'candles + volume drawn, hover reads O/H/L/C, zoom and reset, ' + Object.keys(tfHit).join('/') + ' each read their own bars, refresh moved the price 707 → 712, Escape closes';
  });
  await t.step('the price cards in the chat follow the feed on their own, not only the open chart', async () => {
    const ch = CHARTS['HDFCBANK.NS'].chart.result[0], q = ch.indicators.quote[0].close;
    ch.meta.regularMarketPrice = 715; q[q.length - 1] = 715;
    const r = await t.eval(async () => {
      const card = () => [...document.querySelectorAll('.lexi-quote')].find(e => e.dataset.sym === 'HDFCBANK.NS');
      const before = card().querySelector('.lq-price').textContent.replace(/\s+/g, ' ');
      await lexiQuoteTick();
      return {before, after: card().querySelector('.lq-price').textContent.replace(/\s+/g, ' '), when: card().querySelector('.lq-when').textContent};
    });
    ch.meta.regularMarketPrice = 707; q[q.length - 1] = 707;
    if(!/₹707/.test(r.before) || !/₹715/.test(r.after) || !/▲ 15/.test(r.after) || !/^Live from/.test(r.when)) throw new Error(JSON.stringify(r));
    return 'a card read ' + r.before.split(' ')[0] + ' then ' + r.after.split(' ')[0] + ' after the feed moved, footer "' + r.when.split(',')[0] + '"';
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
  await t.step('a policy question that names no company is answered against the live Nifty 50 and the zone', async () => {
    const ask = async (text) => { const n0 = hits.length; await t.eval(async (text) => { navigate('dashboard'); ai.turns = []; document.getElementById('aiInput').value = text; await aiSend(); }, text); return hits.slice(n0); };
    const h1 = await ask('I have 10 lakh as lump sum for a Moderate client, should it go into equity now?');
    const u = lastUser();
    if(!h1.some(h => h.includes('/%5ENSEI') || h.includes('/^NSEI'))) throw new Error('the Nifty 50 was not read: ' + JSON.stringify(h1));
    if(!u.includes('"marketNow"') || !u.includes('^NSEI') || !u.includes('"technical"') || !u.includes('"marketZone"')) throw new Error(u.slice(0, 400));
    if(!u.includes('policy-valuation-matrix') || !u.includes('policy-risk-allocation')) throw new Error('the valuation matrix and the allocation were not sent');
    if(!/marketNow/.test(lastSys())) throw new Error('rule missing from the brief');
    const h2 = await ask('kitne clients ke KYC pending hain');
    if(h2.some(h => /finance\/chart/.test(h))) throw new Error('a records question read prices: ' + JSON.stringify(h2));
    const h3 = await ask('SIP mandate kaise banate hain');
    if(h3.some(h => /finance\/chart/.test(h))) throw new Error('a how-to read prices: ' + JSON.stringify(h3));
    // a live PE from the feed sets the zone; the firm's own entry is kept beside it when it differs
    const z = await t.eval(() => ({live: lexiLiveZoneLabel([{symbol:'NIFTY', name:'Nifty 50', pe:25.4, source:'Trendlyne'}]), none: lexiLiveZoneLabel([{symbol:'NIFTY', name:'Nifty 50'}]), set: lexiZoneLabel()}));
    if(!/^Expensive \(live Nifty 50 PE 25\.4 from Trendlyne\)/.test(z.live) || !z.live.includes('the firm') || z.none !== z.set) throw new Error(JSON.stringify(z));
    return 'a lump-sum question read the Nifty 50 and sent marketNow + the zone; a records question and a how-to read no prices; a live PE of 25.4 gives "' + z.live.split(' (')[0] + '"';
  });
  } finally { feed.close(); mock.close(); }
});
