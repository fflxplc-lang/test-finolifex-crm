/* THE APPRAISAL PAGE, TIDIED.

   The calculator is unchanged. Around it: the year at a glance (people,
   not opened, draft, finalised, increments finalised) filtering the
   table; the score, increment, amount and new CTC up front for the
   person open; every card folds; and the "where each figure comes from"
   reference starts folded. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.step('two people, one appraisal worked out', async () => {
    const r = await t.eval(async ()=>{
      const mk = (id, name) => ({id, name, role: roleList().slice(-1)[0], email: id.toLowerCase() + '@example.com',
        status:'Active', scope:'own', branch:'Varanasi', adminFlags: fullAdminFlags(false),
        perms: fullPerms(false, {view:1}), monthlySalary: 50000, createdAt: new Date().toISOString()});
      DB.team.push(mk('USR-APP1', 'ZZ Asha'), mk('USR-APP2', 'ZZ Ravi'));
      await save('team');
      DB.config.appraisal = Object.assign({}, DB.config.appraisal, {growth: {'2026': {abs: 18, sip: 22, lump: 15}}});
      await save('config');
      window._hrFold = null; try { localStorage.removeItem('boss.hrFold'); } catch(e){}
      window._apprYear = '2026';
      await apprOpen('USR-APP1', '2026');
      const rec = apprRecordFor('USR-APP1', '2026');
      for(const [k, v] of [['curiosity', 80], ['competence', 80], ['commitment', 80], ['creativity', 80]]) await apprSetRating(rec.id, k, v);
      await apprSetKpi(rec.id, 0, 100);
      navigate('hrappraisal'); await new Promise(r=>setTimeout(r, 60));
      return {head: Array.from(document.querySelectorAll('.appr-head-box b')).map(b=>b.textContent),
        tiles: Array.from(document.querySelectorAll('.appr-tile')).map(x=>x.textContent.replace(/\s+/g, ' ').trim())};
    });
    if(r.head.length !== 4) throw new Error('headline: ' + JSON.stringify(r.head));
    if(!r.tiles.some(x=>/Draft/.test(x) && /^1/.test(x))) throw new Error(JSON.stringify(r.tiles));
    return r.head.join(' · ');
  });

  await t.step('a tile filters the table', async () => {
    const r = await t.eval(async ()=>{
      const names = () => Array.from(document.querySelectorAll('[data-hrfold="apprPeople"] tbody tr td:first-child'))
        .map(td=>td.textContent.trim());
      const all = names();
      apprFilter('draft'); await new Promise(r=>setTimeout(r, 30));
      const draft = names();
      apprFilter('draft');
      return {all, draft};
    });
    if(!r.all.includes('ZZ Ravi') || r.draft.length !== 1 || r.draft[0] !== 'ZZ Asha') throw new Error(JSON.stringify(r));
    return r.draft.join(', ') + ' of ' + r.all.length;
  });

  await t.step('the reference card starts folded and every card folds', async () => {
    const r = await t.eval(()=>{
      const keys = Array.from(document.querySelectorAll('[data-hrfold]')).map(el=>el.getAttribute('data-hrfold'));
      const mapFolded = document.querySelector('[data-hrfold="apprMap"]').classList.contains('hr-folded');
      hrFoldToggle('apprMap');
      const opened = !document.querySelector('[data-hrfold="apprMap"]').classList.contains('hr-folded');
      hrFoldToggle('apprMap');
      return {keys, mapFolded, opened};
    });
    for(const k of ['apprRating', 'apprResult', 'apprGrowth', 'apprPeople', 'apprMap'])
      if(!r.keys.includes(k)) throw new Error('missing ' + k + ': ' + r.keys);
    if(!r.mapFolded || !r.opened) throw new Error(JSON.stringify(r));
    return r.keys.join(', ');
  });

  await t.step('the HR dashboard no longer says appraisal does not exist', async () => {
    const r = await t.eval(async ()=>{ navigate('hrdashboard'); await new Promise(r=>setTimeout(r, 60));
      return document.getElementById('content').textContent; });
    if(/future appraisal|No rating, weightage or review cycle exists/.test(r)) throw new Error('old wording still there');
    return 'wording updated';
  });
});
