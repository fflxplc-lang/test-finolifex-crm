/* EMAIL SWITCHED OFF DOES NOT STOP THE WORK.

   With the email connector switched off, Send Report to Client said the
   report was not sent and kept the client at Unit Allotted, so the
   workflow could not move. Email is optional: the client moves on, the
   letter is in the mail log for sending by hand, and the adviser is told. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.step('report with email off: the client still moves to Family Mapping', async () => {
    t.dialogs.length = 0;
    const r = await t.eval(async ()=>{
      mailChannel.loaded = true; mailChannel.ready = false;
      mailChannel.message = 'The email connector is switched off.';
      const c = {id:'CMS-ZZSMTP', cmsName:'ZZ Smtp Off', mobile:'9800000072', email:'zzsmtp@zz.in',
        rmName: currentUser, branch:'Varanasi', createdAt:new Date().toISOString()};
      initState('CMS', c); c[RECORD_STATE_FIELD.CMS] = 'unitAllotted';
      DB.clients.push(c); await save('clients');
      openSendReportModal('CMS', c.id, 'reportSent');
      await submitSendReport('CMS', c.id, 'reportSent');
      const log = (DB.communications||[]).filter(m=>m.clientId===c.id && m.channel==='Email').slice(-1)[0] || {};
      return {state: stateOf('CMS', c), log: log.status, sentAt: !!c.reportSentAt, notSent: !!c.reportNotSentAt};
    });
    if(r.state !== 'familyMapping') throw new Error('the client is at ' + r.state);
    if(r.log !== 'Not Sent') throw new Error('the mail log says ' + r.log);
    if(r.sentAt || !r.notSent) throw new Error('the record claims the report went: ' + JSON.stringify(r));
    const told = t.dialogs.find(d=>/moved on anyway/.test(d));
    if(!told) throw new Error('the adviser was not told: ' + JSON.stringify(t.dialogs));
    return 'Family Mapping; the letter logged as Not Sent; adviser told once';
  });
});
