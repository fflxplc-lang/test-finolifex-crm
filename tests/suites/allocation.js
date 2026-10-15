/* THE ALLOCATION TABLE, AND WHICH GOAL A LINE IS FOR.

   Modification 19 asked for the For column to go. It repeated under every
   line the goal already written across the top of the box the line sits in.
   The job it did — pointing a line at a different goal — became ⇄ Goal, a
   row action, and this is what holds that bargain to its terms: the column
   is gone, the job is not. */
const {suite} = require('../lib/harness');

suite(async t => {
  t.section('the column is gone, in both renderings');

  await t.step('no For header, no per-row goal box, and ⇄ Goal in their place', async () => {
    const r = await t.eval(()=>{
      const src = Array.from(document.querySelectorAll('script')).map(s=>s.textContent).join('\n');
      const i = src.indexOf('alloc-goal-head');
      if(i < 0) return {err:'the allocation renderer was not found at all'};
      const chunk = src.slice(i, i + 1600);
      return {forCol: /<th>For<\/th>/.test(chunk),
              lbl: /f_planLbl\$\{i\}/.test(chunk),
              repoint: typeof window.openPlanLineGoal === 'function' && /⇄ Goal/.test(chunk),
              scheme: chunk.indexOf('Scheme / Strategy') >= 0,
              folio: chunk.indexOf('Folio / Account ID') >= 0};
    });
    if(r.err) throw new Error(r.err);
    if(r.forCol) throw new Error('the For column is still drawn');
    if(r.lbl) throw new Error('the per-row goal input is still drawn');
    if(!r.repoint) throw new Error('there is no way left to point a line at another goal');
    if(!r.scheme) throw new Error('the table does not say Scheme / Strategy');
    if(!r.folio) throw new Error('the table does not say Folio / Account ID');
    return 'gone from the header and the row; ⇄ Goal in their place';
  });

  await t.step('the subtotal lines its figure up under Amount', async () => {
    const src = await t.eval(()=>{
      const s = Array.from(document.querySelectorAll('script')).map(x=>x.textContent).join('\n');
      const i = s.indexOf('alloc-sub');
      return s.slice(i - 40, i + 120);
    });
    if(!/colspan="5">This goal/.test(src))
      throw new Error('the subtotal spans the wrong column count: ' + src.slice(0, 90));
    return 'five columns before the amount, read-only and editable alike';
  });

  t.section('⇄ Goal does the job the column used to');

  let leadId;
  await t.step('a line moves, keeps its money, and the move is audited', async () => {
    const r = await t.eval(async ()=>{
      const l = {id:uid('LEAD'), leadName:'ZZ Repoint', firstName:'ZZ', lastName:'Repoint',
        rmName:currentUser, createdAt:new Date().toISOString(), createdBy:currentUser};
      initState('LMS', l);
      l.planRounds = [{n:1, type:'SEVENEVENTS', allocation:{lines:[
        {id:uid('ALLOC'), label:'Retirement', amount:100000, transactionType:'Lumpsum'}]}}];
      DB.leads.push(l); await save('leads');
      openPlanLineGoal(l.id, 0);
      const pick = document.getElementById('f_lineGoalPick');
      if(!pick) return {err:'the picker never opened'};
      const offered = Array.from(pick.options).map(o=>o.value);
      pick.value = '__other'; planLineGoalPicked();
      const other = document.getElementById('f_lineGoalOther');
      if(!other || other.closest('.field').style.display === 'none')
        return {err:'the free-text goal never appeared'};
      other.value = "Child's education";
      await savePlanLineGoal(l.id, 0);
      const line = DB.leads.find(x=>x.id===l.id).planRounds[0].allocation.lines[0];
      const audit = (DB.auditLog||[]).filter(a=>a.recordId===l.id && /Re-pointed/.test(a.action||''));
      return {id:l.id, offered, label:line.label, amount:line.amount,
              scheme:line.schemeId, audits:audit.length};
    });
    if(r.err) throw new Error(r.err);
    if(r.offered.indexOf('Retirement') < 0)
      throw new Error('the goal it already had was not offered: ' + r.offered.join('/'));
    if(r.label !== "Child's education") throw new Error('the line still reads ' + r.label);
    if(r.amount !== 100000) throw new Error('the amount changed to ' + r.amount);
    if(!r.audits) throw new Error('nothing was written to the audit');
    leadId = r.id;
    return 'moved to "' + r.label + '", amount untouched, ' + r.audits + ' audit entry';
  });

  await t.step('a goal already on the plan can be picked rather than retyped', async () => {
    const r = await t.eval(async (id)=>{
      openPlanLineGoal(id, 0);
      const pick = document.getElementById('f_lineGoalPick');
      if(!pick) return {err:'no picker'};
      const has = Array.from(pick.options).map(o=>o.value);
      pick.value = "Child's education";                   // the one it is already on
      await savePlanLineGoal(id, 0);
      const line = DB.leads.find(x=>x.id===id).planRounds[0].allocation.lines[0];
      const ov = document.getElementById('overlay');
      return {has, label:line.label, open: !!(ov && ov.classList.contains('show'))};
    }, leadId);
    if(r.err) throw new Error(r.err);
    if(r.has.indexOf("Child's education") < 0)
      throw new Error('its own goal is not in the list: ' + r.has.join('/'));
    if(r.label !== "Child's education") throw new Error('the label changed to ' + r.label);
    if(r.open) throw new Error('choosing the goal it is already on left the box open');
    return 'the list carries what the plan knows; choosing the same one just closes';
  });

  await t.step('a goal named as nothing is refused', async () => {
    const before = t.dialogs.length;
    const label = await t.eval(async (id)=>{
      openPlanLineGoal(id, 0);
      document.getElementById('f_lineGoalPick').value = '__other';
      planLineGoalPicked();
      document.getElementById('f_lineGoalOther').value = '   ';
      await savePlanLineGoal(id, 0);
      return DB.leads.find(x=>x.id===id).planRounds[0].allocation.lines[0].label;
    }, leadId);
    if(t.dialogs.length === before) throw new Error('an empty goal was accepted silently');
    if(label !== "Child's education") throw new Error('the line was blanked to "' + label + '"');
    await t.eval(()=>{ if(typeof closeModal==='function') closeModal(); });
    return 'refused, and the line kept the goal it had';
  });

  await t.step('only the one alert we provoked', async () => {
    const loose = t.dialogs.filter(d => !/Name the goal/.test(d));
    if(loose.length) throw new Error('alerts: ' + loose.join(' | ').slice(0, 200));
    return t.dialogs.length + ' dialog(s), all asked for';
  });
});
