/* THE ATTENDANCE PAGE, TRIMMED AND FOLDABLE.

   The four time tiles (elapsed / active / inactive / unmeasured) and the
   notes under them are gone from Attendance Management. Each card below
   My Attendance History folds to its heading with its own button, one
   button folds or opens them all, and opening a notification about a
   folded card opens it again. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.step('the time tiles and their notes are not on the page', async () => {
    const r = await t.eval(async ()=>{
      try { localStorage.removeItem('boss.hrFold'); } catch(e){} window._hrFold = null;
      navigate('hrattendance'); await new Promise(r=>setTimeout(r, 60));
      const txt = document.getElementById('content').textContent;
      return {tiles: document.querySelectorAll('[data-hrtime]').length,
        notes: ['What a browser can and cannot see', 'Unmeasured', 'Last transition', 'Attendance % is your time',
          'Office timings, the grace period'].filter(x=>txt.indexOf(x) >= 0)};
    });
    if(r.tiles || r.notes.length) throw new Error(JSON.stringify(r));
    return 'none of the four tiles or notes';
  });

  await t.step('each card folds to its heading on its own', async () => {
    const r = await t.eval(async ()=>{
      const cards = Array.from(document.querySelectorAll('[data-hrfold]')).map(el=>el.getAttribute('data-hrfold'));
      const leave = () => document.getElementById('hrMyLeaveCard');
      hrFoldToggle('leave');
      const folded = {cls: leave().classList.contains('hr-folded'),
        body: getComputedStyle(leave().querySelector(':scope > :not(.hr-fold-head)') || leave()).display,
        head: getComputedStyle(leave().querySelector('.hr-fold-head')).display};
      navigate('hrattendance'); await new Promise(r=>setTimeout(r, 60));
      const kept = leave().classList.contains('hr-folded');
      hrFoldToggle('leave');
      return {cards, folded, kept, open: !leave().classList.contains('hr-folded')};
    });
    if(!r.cards.includes('leave') || !r.cards.includes('team')) throw new Error('cards: ' + r.cards);
    if(!r.folded.cls || r.folded.body !== 'none' || r.folded.head === 'none') throw new Error(JSON.stringify(r.folded));
    if(!r.kept || !r.open) throw new Error(JSON.stringify(r));
    return r.cards.join(', ');
  });

  await t.step('one button minimizes all, then expands all', async () => {
    const r = await t.eval(async ()=>{
      await new Promise(r=>setTimeout(r, 20));
      const label = () => document.getElementById('hrFoldAllBtn').textContent.trim();
      const before = label();
      hrFoldAll();
      const all = Array.from(document.querySelectorAll('[data-hrfold]')).every(el=>el.classList.contains('hr-folded'));
      const mid = label();
      hrFoldAll();
      const none = Array.from(document.querySelectorAll('[data-hrfold]')).every(el=>!el.classList.contains('hr-folded'));
      return {before, all, mid, none, after: label()};
    });
    if(!/Minimize all/.test(r.before) || !r.all || !/Expand all/.test(r.mid) || !r.none || !/Minimize all/.test(r.after))
      throw new Error(JSON.stringify(r));
    return r.before + ' → ' + r.mid;
  });

  await t.step('a notification about a folded card opens it', async () => {
    const r = await t.eval(async ()=>{
      hrFoldToggle('leave');
      navigate('dashboard');
      const n = await notifyUser(currentUser, {title:'Your leave was approved', view:'hrattendance', kind:'hr-leave-decided'});
      await openNotification(n.id);
      await new Promise(r=>setTimeout(r, 250));
      return {view: currentView, folded: document.getElementById('hrMyLeaveCard').classList.contains('hr-folded')};
    });
    if(r.view !== 'hrattendance' || r.folded) throw new Error(JSON.stringify(r));
    return 'My leave opened';
  });
});
