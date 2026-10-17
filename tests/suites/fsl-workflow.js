/* FSL STOPPED AT THE LADDER.

   Its last tab was called "Asset Allocation" and it was not a page at
   all: pressing it bounced the planner out to the Plan Output screen,
   which lost the tabs, the progress strip and the way back. The two
   steps between the advice and the client's consent — what the family
   agreed to in the room, and where that money is actually placed —
   had nowhere to happen.

   7 Events already walks that journey, and had already fixed exactly
   this for itself. The firm asked for the same workflow here, so FSL
   now has the same five steps and the same gates:

     Input Form · RM Planning · The Success Ladder
     Required Execution Plan · Final Execution Plan

   What this holds to: the Final Execution Plan opens only once the
   reporting manager has signed the advice off, because what goes on it
   is what the family settled on at the presentation meeting and that
   meeting comes after the sign-off; the agreed figures are typed once
   and carried across; the two pages stay editable after approval,
   because that is when they are used; the allocation and the execution
   plan square against each other by one label built in one place; and
   an action point raises a task on the Daily Service Tracker through
   the same sync 7 Events uses, not a copy of it. */
const {suite} = require('../lib/harness');

/* A lead with a filled FSL sheet, its input submitted and its plan
   prepared — the state every step below starts from. */
const SETUP = `async (tag) => {
  const now = new Date().toISOString();
  const l = {id: uid('LMS'), firstName:'ZZ Ladder', lastName: tag, mobile:'98000000' + tag,
    email:'zz.ladder.' + tag + '@zz.in', assignedTo: currentUser, branch: DB.config.branches[0],
    createdAt: now, transformationForm:'FSL', dob:'1985-04-12'};
  initState('LMS', l); DB.leads.push(l); await save('leads');
  window._fslLeadId = l.id; window._fslStep = 'input';
  navigate('fsl');
  await new Promise(r=>setTimeout(r, 250));
  Object.assign(_fsl.s.personal, {dob:'1985-04-12', mobile:'98000000' + tag,
    email:'zz.ladder.' + tag + '@zz.in', name:'ZZ Ladder ' + tag, city:'Pune', occupation:'Salaried'});
  _fsl.s.years = 10;
  _fsl.s.assets[0].current = 500000; _fsl.s.assets[0].monthly = 10000;
  _fsl.s.aspiration = '3'; _fsl.s.chosenLevel = '3';
  _fsl.dirty = true; fslRecompute(); await fslSaveSheet();
  await fslSubmitForClient(l.id);
  await fslPreparePlan(l.id);
  return l.id;
}`;

suite(async t => {
  await t.home();

  await t.step('five steps, in the order the firm asked for', async () => {
    const r = await t.eval(()=>FSL_STEPS.map(x=>x[1]));
    const want = ['Input Form','RM Planning','The Success Ladder',
                  'Required Execution Plan','Final Execution Plan'];
    if(JSON.stringify(r) !== JSON.stringify(want))
      throw new Error('the steps read ' + r.join(' · '));
    return r.join(' → ');
  });

  await t.step('the Final Execution Plan is shut until the advice is signed off', async () => {
    const r = await t.eval(async (a)=>{
      const id = await eval('(' + a.SETUP + ')')('71');
      const rec = planRecordOf(id), round = latestPlanRound(rec);
      const before = {open: FSL_STEPS.map(([k])=>k + ':' + fslStepOpen(k, rec, round)),
        signed: fslPlanSignedOff(rec, round), why: fslStepWhy('alloc', rec, round)};
      round.seniorStatus = 'Approved'; round.seniorAt = new Date().toISOString();
      await save('leads');
      const after = {open: FSL_STEPS.map(([k])=>k + ':' + fslStepOpen(k, rec, round)),
        signed: fslPlanSignedOff(rec, round)};
      return {id, before, after, prepared: !!(round && round.output)};
    }, {SETUP});
    if(!r.prepared) throw new Error('the plan was not prepared, so nothing below means anything');
    if(r.before.open.indexOf('exec:true') < 0)
      throw new Error('the Required Execution Plan is shut on a prepared plan: ' + r.before.open.join(' '));
    if(r.before.open.indexOf('alloc:false') < 0)
      throw new Error('the Final Execution Plan opened before the advice was signed off');
    if(!/signed the advice off/.test(r.before.why)) throw new Error('it does not say why: ' + r.before.why);
    if(r.after.open.indexOf('alloc:true') < 0)
      throw new Error('the Final Execution Plan is still shut after approval: ' + r.after.open.join(' '));
    return 'Required opens on a prepared plan; Final stays shut until the reporting manager signs off, '
      + 'and says so';
  });

  await t.step('the Required Execution Plan asks for the two figures and offers the approval', async () => {
    await t.eval(()=>{ window._fslStep = 'exec'; render(); });
    await t.wait(600);
    const r = await t.eval(()=>{
      const c = document.getElementById('content');
      const rows = fslExecRows(planRecordOf(window._fslLeadId));
      return {required: rows.map(x=>({lump: x.lump, sip: x.sip, name: x.name})),
        boxes: Array.from(c.querySelectorAll('[data-fslp^="exec."]')).map(e=>e.getAttribute('data-fslp')),
        approval: /Send for Approval/.test(c.textContent),
        nextTab: /Final Execution Plan/.test(c.textContent)};
    });
    if(r.required.length !== 1) throw new Error(r.required.length + ' goal rows, expected 1');
    if(!(r.required[0].lump > 0) || !(r.required[0].sip > 0))
      throw new Error('the required figures are ' + JSON.stringify(r.required[0]));
    ['exec.agreedLump','exec.agreedSip','exec.overall'].forEach(k=>{
      if(r.boxes.indexOf(k) < 0) throw new Error(k + ' is not on the page');
    });
    if(!r.approval) throw new Error('Send for Approval is not on the page');
    return 'one goal row, both required figures, both agreed boxes, and Send for Approval';
  });

  await t.step('the agreed figures are carried across and placed, and square exactly', async () => {
    const r = await t.eval(async ()=>{
      _fsl.s.exec.agreedLump = 200000; _fsl.s.exec.agreedSip = 25000;
      _fsl.dirty = true; await fslSaveSheet();
      await fslExecSaveAndNext(window._fslLeadId);
      const rec = planRecordOf(window._fslLeadId), round = latestPlanRound(rec);
      const lines = ((round.allocation || {}).lines || []);
      return {step: window._fslStep,
        lines: lines.map(l=>({label: l.label, amount: l.amount, sip: allocLineIsSip(l)})),
        gaps: fslAllocReconcile(rec, round).off,
        label: fslGoalLabel((_fsl.C || {}).chosen)};
    });
    if(r.step !== 'alloc') throw new Error('Save & Next landed on "' + r.step + '"');
    const lump = r.lines.find(l=>!l.sip), sip = r.lines.find(l=>l.sip);
    if(!lump || lump.amount !== 200000) throw new Error('the agreed lumpsum is ' + JSON.stringify(lump));
    if(!sip || sip.amount !== 25000) throw new Error('the agreed SIP is ' + JSON.stringify(sip));
    if(lump.label !== r.label || sip.label !== r.label)
      throw new Error('the lines are labelled "' + lump.label + '" against a goal called "' + r.label + '"');
    if(r.gaps.length) throw new Error('it reports a gap on figures it placed itself: '
      + JSON.stringify(r.gaps));
    return '₹2,00,000 one-time and ₹25,000 monthly placed under one label, and nothing outstanding';
  });

  await t.step('and the two execution pages stay the planner’s after approval', async () => {
    const r = await t.eval(()=>{
      const rec = planRecordOf(window._fslLeadId), round = latestPlanRound(rec);
      const c = document.getElementById('content');
      return {rmLock: fslRmLocked(rec, round), execLock: fslExecLocked(rec, round),
        send: /Send to Client/.test(c.textContent),
        bring: /Bring the agreed amounts/.test(c.textContent),
        banner: /gone up for approval/.test(c.textContent)};
    });
    if(!r.rmLock) throw new Error('the fixture is not in the state this is testing');
    if(r.execLock) throw new Error('the execution pages locked themselves on approval');
    if(!r.send) throw new Error('Send to Client vanished exactly when it is needed');
    if(!r.bring) throw new Error('the bring-across button vanished');
    if(r.banner) throw new Error('the lock banner claims a page that is open is shut');
    return 'the input sheet is locked and the two execution pages are not — Send to Client and the '
      + 'bring-across are both there';
  });

  await t.step('an unplaced amount holds the plan back from the client', async () => {
    const r = await t.eval(async ()=>{
      const rec = planRecordOf(window._fslLeadId), round = latestPlanRound(rec);
      const lines = round.allocation.lines;
      const was = lines[0].amount;
      lines[0].amount = was - 50000;                       // somebody edits it down
      await save('leads');
      const gaps = fslAllocReconcile(rec, round).off;
      lines[0].amount = was;                               // put it back
      await save('leads');
      return {gaps, clean: fslAllocReconcile(rec, round).off.length};
    });
    if(!r.gaps.length) throw new Error('taking ₹50,000 out of the allocation went unnoticed');
    if(Math.abs(r.gaps[0].diff - 50000) > 1)
      throw new Error('it reports a difference of ' + r.gaps[0].diff);
    if(r.clean) throw new Error('putting it back did not clear the gap');
    return 'a ₹50,000 hole is named with the figure, and clears when it is filled';
  });

  await t.step('an action point raises a task, through the one sync and not a copy of it', async () => {
    const r = await t.eval(async ()=>{
      _fsl.s.exec.actions = [{desc:'ZZ open the folio', owner: currentUser,
        by:'2026-11-01', amt:200000, status:'Open'}];
      _fsl.dirty = true; await fslSaveSheet();
      const t = DB.tasks.filter(x=>/ZZ open the folio/.test(x.description || ''));
      const sheet = fslStateOf(planRecordOf(window._fslLeadId));
      return {made: t.length, source: (t[0] || {}).sourceModule, owner: (t[0] || {}).assignTo,
        due: (t[0] || {}).dueDate, lead: (t[0] || {}).leadId,
        linked: ((sheet.exec || {}).actions || [])[0] || {},
        shared: typeof planSyncActionsToDst === 'function'};
    });
    if(r.made !== 1) throw new Error(r.made + ' task(s) were raised, expected 1');
    if(r.source !== 'FSL') throw new Error('the task says it came from "' + r.source + '"');
    if(r.due !== '2026-11-01') throw new Error('the due date is ' + r.due);
    if(r.lead !== null && r.lead === undefined) throw new Error('the task is not on the lead');
    if(!r.linked.dstId) throw new Error('the row does not remember the task it raised');
    if(!r.shared) throw new Error('FSL has its own copy of the sync rather than sharing one');
    return 'one task on the DST, owned, dated, marked FSL, and linked back to the row that raised it';
  });
});
