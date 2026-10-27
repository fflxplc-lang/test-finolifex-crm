/* THE "FIX BUGS AND CHANGE SOME FEATURES" REVIEW.

   DST: a Due Date before the Assigned Date is refused in the form (with
   the exact wording, the calendar greyed before the Assigned Date) and by
   the server; the same day is fine. A task's steps show a live dependency.
   KPI / MIS cards open the records they were counted from. And "How this
   blueprint is worked" explains each blueprint on its own. */
const {suite} = require('../lib/harness');
const MSG = 'Due Date cannot be earlier than Assigned Date. Please select a valid Due Date.';

suite(async t => {
  await t.step('DST form: an earlier Due Date is flagged, the same day is not', async () => {
    const r = await t.eval(async () => {
      navigate('dst', 'new');
      await new Promise(r => setTimeout(r, 150));
      const a = document.getElementById('f_assignedDate'), d = document.getElementById('f_dueDate');
      if(!a || !d) return {missing: true};
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', {bubbles: true})); };
      set(a, "2026-10-20"); set(d, "2026-10-19"); await new Promise(r => setTimeout(r, 20));
      const note = () => ((d.closest('.field') || document).querySelector('.field-error') || {}).textContent || '';
      const bad = note(), min = d.min;
      set(d, "2026-10-20"); await new Promise(r => setTimeout(r, 20));
      const same = note();
      set(d, "2026-10-25"); set(a, "2026-10-26"); await new Promise(r => setTimeout(r, 20));
      const moved = note();
      return {bad, min, same, moved};
    });
    if(r.missing) throw new Error('the DST form has no date fields');
    if(r.bad.indexOf(MSG) < 0) throw new Error('no message for an earlier date: ' + JSON.stringify(r));
    if(r.min !== '2026-10-20') throw new Error('calendar not limited: ' + r.min);
    if(r.same) throw new Error('the same day was refused: ' + r.same);
    if(r.moved.indexOf(MSG) < 0) throw new Error('moving the Assigned Date past the Due Date was not caught');
    return 'flagged, calendar from the Assigned Date, same day allowed';
  });

  await t.step('the server refuses a task whose Due Date is before its Assigned Date', async () => {
    t.expectConsole(/422/);
    const r = await t.eval(async () => {
      const bad = {id: 'TSK-ZZBAD', taskType: 'ZZ', assignedDate: '2026-10-20', dueDate: '2026-10-18', overallStatus: 'Not Started'};
      const res = await fetch('/api/storage/tasks', {method: 'PUT', headers: Object.assign({'Content-Type': 'application/json'}, apiHeaders()),
        body: JSON.stringify({value: JSON.stringify((DB.tasks || []).concat([bad]))})});
      const body = await res.json().catch(() => ({}));
      const ok = Object.assign({}, bad, {id: 'TSK-ZZOK', dueDate: '2026-10-20'});
      const res2 = await fetch('/api/storage/tasks', {method: 'PUT', headers: Object.assign({'Content-Type': 'application/json'}, apiHeaders()),
        body: JSON.stringify({value: JSON.stringify((DB.tasks || []).concat([ok]))})});
      await fetch('/api/storage/tasks', {method: 'PUT', headers: Object.assign({'Content-Type': 'application/json'}, apiHeaders()),
        body: JSON.stringify({value: JSON.stringify(DB.tasks || [])})});
      return {status: res.status, error: body.error || '', okStatus: res2.status};
    });
    if(r.status !== 422 || r.error.indexOf(MSG) < 0) throw new Error(JSON.stringify(r));
    if(r.okStatus !== 200) throw new Error('same-day task refused: ' + r.okStatus);
    return '422 with the message; same day saved';
  });

  await t.step('a task with steps shows the live dependency', async () => {
    const r = await t.eval(async () => {
      const today = new Date().toISOString().slice(0, 10);
      const base = {assignedDate: today, dueDate: today, assignTo: (DB.team[0] || {}).id};
      DB.tasks = (DB.tasks || []).filter(x => !/^TSK-ZZD/.test(x.id)).concat([
        Object.assign({id: 'TSK-ZZD0', taskType: 'ZZ Parent', overallStatus: 'In Progress'}, base),
        Object.assign({id: 'TSK-ZZD1', parentTaskId: 'TSK-ZZD0', description: 'ZZ Step one', overallStatus: 'Completed', createdAt: '2026-10-01T01:00:00Z'}, base),
        Object.assign({id: 'TSK-ZZD2', parentTaskId: 'TSK-ZZD0', description: 'ZZ Step two', overallStatus: 'In Progress', createdAt: '2026-10-01T02:00:00Z'}, base),
        Object.assign({id: 'TSK-ZZD3', parentTaskId: 'TSK-ZZD0', description: 'ZZ Step three', overallStatus: 'Not Started', createdAt: '2026-10-01T03:00:00Z'}, base),
      ]);
      const dep = dstDependency('TSK-ZZD0').map(x => x.status);
      navigate('dst', 'TSK-ZZD0');
      await new Promise(r => setTimeout(r, 150));
      const txt = document.getElementById('root').textContent;
      return {dep, shown: /Live Task Dependency/.test(txt), subs: subTasksOf('TSK-ZZD0').length};
    });
    if(r.subs !== 3) throw new Error('steps not linked to the parent: ' + JSON.stringify(r));
    if(r.dep.join(',') !== 'Completed,In Progress,Blocked') throw new Error(JSON.stringify(r));
    if(!r.shown) throw new Error('the task page has no Live Task Dependency section');
    return r.dep.join(' → ');
  });

  await t.step('every KPI card opens its records, and the count matches the card', async () => {
    const r = await t.eval(async () => {
      const f = misFigures();
      const out = [];
      for(const k of Object.keys(KPI_DETAIL)){
        openKpiDetail(k);
        await new Promise(r => setTimeout(r, 30));
        const modal = document.getElementById('modalBody');
        const txt = modal ? modal.textContent : '';
        out.push({k, rows: KPI_DETAIL[k].rows(f).length, back: /Back to KPIs/.test(txt), search: !!document.getElementById('kpiQ')});
        closeModal();
      }
      return out;
    });
    const bad = r.filter(x => !x.back || !x.search);
    if(r.length !== 9 || bad.length) throw new Error(JSON.stringify(r));
    return r.map(x => x.k + ' ' + x.rows).join(', ');
  });

  await t.step('"How this blueprint is worked" is its own for each blueprint', async () => {
    const r = await t.eval(async () => {
      const out = {};
      for(const type of ['MULTIGOAL', 'FSL', 'SEVENEVENTS', 'GAB']){
        navigate(blueprintModuleView(type));
        await new Promise(r => setTimeout(r, 60));
        const btn = [...document.querySelectorAll('#root button')].find(b => /How this blueprint is worked/.test(b.textContent));
        if(!btn){ out[type] = 'no button'; continue; }
        btn.click();
        await new Promise(r => setTimeout(r, 60));
        const m = document.getElementById('modalBody');
        const txt = m ? m.textContent : '';
        const heads = m ? [...m.querySelectorAll('.bp-how-sec h4')].map(h => h.textContent) : [];
        out[type] = {heads: heads.length, close: !!(m && [...m.querySelectorAll('button')].find(b => b.textContent.trim() === 'Close')),
          label: txt.indexOf(APPROACH_FORMS[type].label) >= 0, txt};
        closeModal();
      }
      return out;
    });
    for(const [type, v] of Object.entries(r)){
      if(typeof v === 'string') throw new Error(type + ': ' + v);
      if(v.heads !== 10 || !v.close || !v.label) throw new Error(type + ': ' + JSON.stringify(Object.assign({}, v, {txt: undefined})));
    }
    if(!/Major Health Problems/.test(r.SEVENEVENTS.txt) || !/Asset Mapping/.test(r.SEVENEVENTS.txt)) throw new Error('7 Events misses its events');
    if(/Major Health Problems/.test(r.GAB.txt)) throw new Error('GAB shows the 7 Events');
    if(!/Success Ladder/.test(r.FSL.txt) || !/Formula Audit/.test(r.GAB.txt)) throw new Error('pages not listed');
    return 'four separate explanations, ten sections each';
  });
});
