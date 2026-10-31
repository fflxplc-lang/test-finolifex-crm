/* A REMARK FOR EACH SCHEME ON THE CONSENT PAGE.

   The client answering an allocation can now say something about each
   scheme on its own. The remark is saved on that scheme's line, shown to
   the adviser, and carried to the transaction the line becomes. */
const {suite} = require('../lib/harness');

const SEED = `async function(tag){
  const lid = 'LMS-ZZSR-' + tag;
  if(!DB.leads.find(l=>l.id===lid)){
    const lead = {id:lid, firstName:'ZZ Scheme', lastName:'Remark ' + tag, mobile:'9811100' + String(tag.charCodeAt(0)).padStart(3,'0'),
      email:'zzsr'+tag+'@zz.in', assignedTo: currentUser, source:'Seminar', createdAt:new Date().toISOString()};
    initState('LMS', lead); DB.leads.push(lead);
  }
  const rec = {id:uid('REC'), leadId: lid, status:'Sent to Client',
    productCategory:'Mutual Fund', investmentMode:'SIP', allocType:'Purchase',
    schemes:[
      Object.assign(newAllocSchemeLine({productCategory:'Mutual Fund'}), {schemeName:'ZZ Scheme One', amount:'25000', transactionType:'Purchase'}),
      Object.assign(newAllocSchemeLine({productCategory:'Mutual Fund'}), {schemeName:'ZZ Scheme Two', amount:'50000', transactionType:'Purchase'}),
    ],
    attachments:[], createdAt:new Date().toISOString()};
  DB.recommendations.push(rec);
  await save('leads'); await save('recommendations');
  const token = uid('DOC');
  DB.docLinks.push({token, type:'ALLOC', recordModule:'LMS', recordId: lid,
    allocationId: rec.id, allocationIds:[rec.id], status:'Active', createdAt:new Date().toISOString(),
    expiresAt:new Date(Date.now() + 72*3600*1000).toISOString()});
  await save('docLinks');
  return {lid, rec: rec.id, token};
}`;

suite(async t => {
  await t.home();

  await t.step('the consent page has a remarks box under each scheme', async () => {
    const r = await t.eval(new Function(`return (async ()=>{
      const b = await (${SEED})('A');
      renderPublicDocForm(b.token);
      return [...document.querySelectorAll('[data-scheme-remark]')].map(x=>x.placeholder);
    })()`));
    if(r.length !== 2) throw new Error(r.length + ' scheme boxes');
    if(!/ZZ Scheme One/.test(r[0]) || !/ZZ Scheme Two/.test(r[1])) throw new Error(JSON.stringify(r));
    return '2 boxes, one per scheme';
  });

  await t.step('asking about one scheme only is enough to send it back, and it is kept on that line', async () => {
    const r = await t.eval(new Function(`return (async ()=>{
      const b = await (${SEED})('B');
      renderPublicDocForm(b.token);
      document.getElementById('f_discAck').checked = true; planAckChanged();
      document.getElementById('f_schRemark_' + b.rec + '_1').value = 'ZZ please pick a smaller fund';
      await submitAllocationDecision(b.token, false, b.rec);
      const rec = DB.recommendations.find(x=>x.id===b.rec);
      const sub = DB.docSubmissions.filter(x=>x.allocationId===b.rec).slice(-1)[0] || {};
      return {status: rec.status, one: rec.schemes[0].clientRemark || '', two: rec.schemes[1].clientRemark || '',
        sub: (sub.schemeRemarks||[]).map(x=>x.scheme + ': ' + x.remark), card: allocSummaryCardHtml(rec),
        hist: (rec.queryHistory||[]).slice(-1).map(x=>x.remarks)[0] || ''};
    })()`));
    if(r.status !== 'Client Query') throw new Error('status ' + r.status);
    if(r.one || r.two !== 'ZZ please pick a smaller fund') throw new Error('lines hold ' + JSON.stringify([r.one, r.two]));
    if(r.sub.join() !== 'ZZ Scheme Two: ZZ please pick a smaller fund') throw new Error('submission ' + JSON.stringify(r.sub));
    if(!/Client: .ZZ please pick a smaller fund/.test(r.card)) throw new Error('the adviser does not see it');
    if(!/ZZ Scheme Two: ZZ please pick a smaller fund/.test(r.hist)) throw new Error('the query says ' + r.hist);
    return 'Scheme Two carries it; the adviser\'s card shows it';
  });

  await t.step('approving with a remark carries it to that scheme\'s transaction', async () => {
    const r = await t.eval(new Function(`return (async ()=>{
      const b = await (${SEED})('C');
      renderPublicDocForm(b.token);
      document.getElementById('f_discAck').checked = true; planAckChanged();
      document.getElementById('f_schRemark_' + b.rec + '_0').value = 'ZZ start next month';
      await submitAllocationDecision(b.token, true, b.rec);
      const t = DB.transactions.filter(x=>x.recommendationId===b.rec && x.schemeName==='ZZ Scheme One')[0] || {};
      return {remark: t.clientRemark || '', n: DB.transactions.filter(x=>x.recommendationId===b.rec).length};
    })()`));
    if(r.remark !== 'ZZ start next month') throw new Error(JSON.stringify(r));
    return r.n + ' transactions; Scheme One carries the remark';
  });
});
