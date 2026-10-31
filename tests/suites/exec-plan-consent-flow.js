/* AFTER THE BLUEPRINT PRESENTATION MEETING, ONE STAGE AT A TIME.

   The firm's order: the RM submits the Execution Plan (the amount the
   client agreed), which writes the DBT and lays down the Asset
   Allocation; the RM reviews the allocation; only then do the minutes go,
   carrying the plan and the allocation for consent. A yes raises the
   transactions; a request for changes goes back to the RM, round after
   round, and nothing reaches the Transaction Tracker before a yes. */
const {suite} = require('../lib/harness');

const PLAN = `async function(id){
  let l = DB.leads.find(x=>x.id === id);
  if(!l){ l = {id}; DB.leads.push(l); }
  Object.assign(l, {firstName:'ZZ Exec', lastName:id, mobile:'9800888333', email:'zzexec@example.com', dob:'2001-01-01',
    assignedTo: currentUser, transformationForm:'MULTIGOAL', createdAt:new Date().toISOString(),
    iseqScore:22, iseqMaxScore:100, iseqCategory:'Conservative'});
  initState('LMS', l);
  l.planRounds = [];
  l.formData = {MULTIGOAL:{name:'ZZ Exec', mobile:'9800888333', email:'zzexec@example.com', dob:'2001-01-01',
    mg_goals:[{goal:'Car', years:'5', currentValue:'2500000', inflation:'7', returns:'12'}]}};
  await save('leads');
  await markPlanInputSubmitted(l, 'Client');
  await recomputePlan(l);
  const round = latestPlanRound(l);
  round.sentForApprovalAt = new Date().toISOString(); round.seniorStatus = 'Approved';
  l[RECORD_STATE_FIELD.LMS] = 'thirdMeetingDone';
  await save('leads');
  return l;
}`;

suite(async t => {
  await t.home();

  await t.step('at Meeting Completed the minutes wait for the Execution Plan', async () => {
    const r = await t.eval(new Function(`return (async ()=>{
      const l = await (${PLAN})('LMS-ZEX1');
      navigate('lms', l.id); await new Promise(r=>setTimeout(r,300));
      const btn = [...document.querySelectorAll('button')].find(b=>/Execution Plan First/.test(b.textContent));
      return {gap: execPlanGap(l), disabled: !!(btn && btn.disabled), panel: !!document.getElementById('execPlanPanel')};
    })()`));
    if(!/Submit the Execution Plan/.test(r.gap) || !r.disabled || !r.panel) throw new Error(JSON.stringify(r));
    return 'Send Minutes disabled — "Submit the Execution Plan First"';
  });

  await t.step('submitting it writes the DBT at the agreed amount and lays down the allocation', async () => {
    const r = await t.eval(async ()=>{
      const l = DB.leads.find(x=>x.id==='LMS-ZEX1');
      await submitExecPlan(l.id, 2400000, 'ZZ agreed in the meeting');
      const st = execPlanState(l);
      return {dbt: st.dbt && st.dbt.amount, status: st.dbt && st.dbt.status, sheet: !!st.sheet,
        total: st.sheet ? allocTotal(st.sheet) : 0, from: st.sheet && st.sheet.fromExecutionPlan,
        gap: execPlanGap(l), txns: DB.transactions.filter(x=>x.leadId===l.id).length};
    });
    if(r.dbt !== '2400000' || !/Consent/i.test(r.status)) throw new Error('DBT ' + JSON.stringify(r));
    if(!r.sheet || !r.from || r.total !== 2400000) throw new Error('allocation ' + JSON.stringify(r));
    if(!/Review the Asset Allocation/.test(r.gap)) throw new Error('gap: ' + r.gap);
    if(r.txns) throw new Error('transactions raised before consent');
    return 'DBT ₹24,00,000 (' + r.status + '); allocation ₹24,00,000; minutes still wait for the review';
  });

  await t.step('once reviewed, the minutes can go, and the consent page carries the allocation', async () => {
    const r = await t.eval(async ()=>{
      const l = DB.leads.find(x=>x.id==='LMS-ZEX1');
      await markExecAllocReviewed(l.id);
      const gap = execPlanGap(l);
      l[RECORD_STATE_FIELD.LMS] = 'secondMeetingMomSent';
      const round = latestPlanRound(l);
      round.docToken = await createDocLink(l.id, 'BLUEPRINT', {planRound: round.n});
      round.sentToClientAt = new Date().toISOString();
      await save('leads');
      const keep = document.getElementById('root').innerHTML;
      renderBlueprintApprovalPage(DB.docLinks.find(x=>x.token===round.docToken));
      const root = document.getElementById('root');
      const out = {gap, doc: !!root.querySelector('#bpAllocDoc'), boxes: root.querySelectorAll('[data-scheme-remark]').length};
      root.innerHTML = keep;
      return out;
    });
    if(r.gap) throw new Error('still gated: ' + r.gap);
    if(!r.doc || r.boxes < 1) throw new Error(JSON.stringify(r));
    return 'the allocation is on the consent page with ' + r.boxes + ' scheme remark box(es)';
  });

  await t.step('a request for changes goes back to the RM; a yes on the revision raises the transactions', async () => {
    const r = await t.eval(async ()=>{
      window.confirm = () => true; window.alert = () => {};
      const l = DB.leads.find(x=>x.id==='LMS-ZEX1');
      await submitBlueprintDecision(latestPlanRound(l).docToken, false, 'ZZ less in equity');
      const afterNo = {reviewed: execPlanState(l).reviewed, txns: DB.transactions.filter(x=>x.leadId===l.id).length};
      await planModifyAfterDecline(l.id);
      const moved = execPlanState(l).sheet ? execPlanState(l).sheet.planRound : null;
      await planResubmitForConsent(l.id);
      const blocked = !latestPlanRound(l).docToken;
      await markExecAllocReviewed(l.id);
      await planResubmitForConsent(l.id);
      const sent = !!latestPlanRound(l).docToken;
      await submitBlueprintDecision(latestPlanRound(l).docToken, true, '');
      const sheet = execPlanState(l).sheet;
      const txns = DB.transactions.filter(x=>!x.deletedAt && x.recommendationId===sheet.id);
      return {afterNo, moved, round: latestPlanRound(l).n, blocked, sent, txns: txns.length,
        lead: txns.every(x=>x.leadId===l.id), lines: allocSchemes(sheet).filter(x=>numVal(x.amount)>0).length};
    });
    if(r.afterNo.reviewed || r.afterNo.txns) throw new Error('after the no: ' + JSON.stringify(r.afterNo));
    if(r.moved !== r.round) throw new Error('the allocation stayed on the old version');
    if(!r.blocked) throw new Error('the revision went out without the allocation being reviewed again');
    if(!r.sent) throw new Error('the reviewed revision did not go out');
    if(!r.txns || r.txns !== r.lines || !r.lead) throw new Error('transactions: ' + JSON.stringify(r));
    return 'changes → back to the RM, reviewed again, resent; consent raised ' + r.txns + ' transaction(s) on the lead';
  });
});
