/* THE CLIENT REVIEW REPORT, ON THE CLIENT AND ON THE REVIEW.

   The firm asked for the Client Review Report to be shown where a review
   is worked, and for a click on it to open the whole report. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.step('a client with holdings', async () => {
    await t.eval(async ()=>{
      const c = {id:'CMS-ZZRR1', cmsName:'ZZ Review Tab', mobile:'9800000073', email:'zzrr@zz.in',
        rmName: currentUser, branch:'Varanasi', createdAt:new Date().toISOString()};
      initState('CMS', c); DB.clients.push(c); await save('clients');
      DB.platformHoldings = DB.platformHoldings || [];
      DB.platformHoldings.push({id:'PH-ZZRR1', clientId:c.id, platform:'Finowise', product:'MutualFund',
        schemeName:'ZZ Equity Fund', current:150000, invested:100000, asOf:'2026-10-20'});
      await save('platformHoldings');
      const r = {id:'RMS-ZZRR1', clientId:c.id, reviewType:'Portfolio Review', assignTo:currentUser,
        createdAt:new Date().toISOString()};
      initState('RMS', r); DB.reviews.push(r); await save('reviews');
    });
    return 'ZZ Review Tab, one holding, one review';
  });

  for(const [where, nav] of [['the review', ['rms','RMS-ZZRR1']], ['the client', ['cms','CMS-ZZRR1']]]){
    await t.step('on ' + where + ': a Review Report tab whose card opens the full report', async () => {
      const r = await t.eval(async (nav)=>{
        navigate(nav[0], nav[1]);
        await new Promise(res=>setTimeout(res, 300));
        const tab = [...document.querySelectorAll('.tab')].find(x=>/^\s*Review Report\s*$/.test(x.textContent));
        if(!tab) return {tab:false};
        tab.click();
        await new Promise(res=>setTimeout(res, 300));
        const card = document.getElementById('rrCard');
        const text = card ? card.textContent.replace(/\s+/g,' ') : '';
        if(card) card.click();
        let open = false;
        for(let i=0;i<40 && !open;i++){ await new Promise(res=>setTimeout(res, 250));
          const ov = document.getElementById('rrOverlay'); open = !!(ov && !ov.hidden && document.querySelector('#rrOverlay .xl-title b')); }
        if(typeof ReviewReport !== 'undefined') ReviewReport.close();
        return {tab:true, card:!!card, text, open};
      }, nav);
      if(!r.tab) throw new Error('no Review Report tab');
      if(!r.card) throw new Error('no report card on the tab');
      if(!/1 holding, data as on/.test(r.text)) throw new Error('the card reads: ' + r.text);
      if(!r.open) throw new Error('clicking the card did not open the report');
      return r.text.slice(0, 90);
    });
  }
});
