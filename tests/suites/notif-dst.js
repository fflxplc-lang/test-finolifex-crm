/* NOTIFICATION COUNT AND DST REASSIGNMENT.

   The bell counts exactly what its panel lists: nothing when the panel
   says "Nothing new". A reassigned DST task tells its new holder who
   passed it on and who first gave it, shows the whole chain, and has its
   own filter; Completed counts a task once, for whoever completed it; and
   every DST card follows the filters and opens the tasks it counts. */
const {suite} = require('../lib/harness');

const TEAM = `(() => {
  const mk = (id, name, parent, extra) => Object.assign({id, name, email: id.toLowerCase() + '@example.in', role: 'Executive',
    status: 'Active', branch: 'Varanasi', parentUserId: parent, scope: 'own', perms: fullPerms(true), adminFlags: fullAdminFlags(false),
    documents: [], notes: []}, extra || {});
  DB.team = DB.team.filter(t => !/^ZN/.test(t.id)).concat([
    mk('ZN1', 'ZZ Bhuvan', null), mk('ZN2', 'ZZ Anand', 'ZN1'), mk('ZN3', 'ZZ Prajval', 'ZN2')]);
})()`;

suite(async t => {
  await t.step('the bell shows no count when the panel has nothing new', async () => {
    const r = await t.eval(async () => {
      DB.notifications = (DB.notifications || []).filter(n => n.userId !== currentUser);
      DB.tasks = (DB.tasks || []).filter(x => x.assignTo !== currentUser);
      await save('notifications'); await save('tasks');
      window._notifOpen = true; render();
      const badge = document.querySelector('.notif-badge .count');
      const panel = document.querySelector('.notif-panel').textContent;
      window._notifOpen = false; render();
      return {count: pendingNotificationCount(), badge: badge ? badge.textContent : '', empty: /Nothing new/.test(panel)};
    });
    if(r.count || r.badge || !r.empty) throw new Error(JSON.stringify(r));
    return 'no badge, panel says Nothing new';
  });

  await t.step('each thing counted is listed, and reading one takes it off at once', async () => {
    const r = await t.eval(async () => {
      DB.config.general = Object.assign({}, DB.config.general, {notifyOverdueTasks: true});
      const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
      DB.tasks.push({id: 'DST-ZNOD', taskType: 'ZZ Overdue', assignTo: currentUser, createdBy: currentUser,
        assignedDate: past, dueDate: past, overallStatus: 'Not Started'});
      await save('tasks');
      const n = await notifyUser(currentUser, {title: 'ZZ hello', body: 'unread'});
      const look = () => { window._notifOpen = true; render();
        const b = document.querySelector('.notif-badge .count');
        const rows = document.querySelectorAll('.notif-panel .notif-row').length;
        const empty = /Nothing new/.test(document.querySelector('.notif-panel').textContent);
        return {badge: b ? b.textContent : '', rows, empty}; };
      const both = look();
      await openNotification(n.id);
      const one = look();
      DB.tasks = DB.tasks.filter(x => x.id !== 'DST-ZNOD'); await save('tasks');
      const none = look();
      window._notifOpen = false; render();
      return {both, one, none};
    });
    if(r.both.badge !== '2' || r.both.rows !== 2) throw new Error('two: ' + JSON.stringify(r.both));
    if(r.one.badge !== '1' || r.one.rows !== 1) throw new Error('after reading: ' + JSON.stringify(r.one));
    if(r.none.badge || r.none.rows || !r.none.empty) throw new Error('none: ' + JSON.stringify(r.none));
    return 'badge 2 with 2 rows, 1 after reading, gone when nothing is left';
  });

  await t.step('a reassigned task tells the new holder, shows the chain, and has its own filter', async () => {
    const r = await t.eval(async (a) => {
      eval(a.TEAM); await save('team');
      const today = hrDateKey(new Date());
      DB.tasks = DB.tasks.filter(x => !/^DST-ZN/.test(x.id)).concat([{id: 'DST-ZNR', taskType: 'ZZ Nominee', assignTo: 'ZN2', createdBy: 'ZN1',
        createdAt: new Date().toISOString(), assignedDate: today, dueDate: today, overallStatus: 'Not Started', urgencyLevel: 'High'},
        {id: 'DST-ZNF', taskType: 'ZZ Fresh', assignTo: 'ZN2', createdBy: 'ZN1', createdAt: new Date().toISOString(),
        assignedDate: today, dueDate: today, overallStatus: 'Not Started'}]);
      await save('tasks');
      const was = currentUser;
      currentUser = 'ZN2';
      const task = DB.tasks.find(x => x.id === 'DST-ZNR');
      task.assignTo = 'ZN3'; await save('tasks');
      currentUser = was;
      const note = DB.notifications.find(n => n.userId === 'ZN3' && n.kind === 'dst-reassigned' && n.arg === 'DST-ZNR') || {};
      window._dstScope = 'reassigned'; window._dstStatus = ''; window._dstTeam = ''; window._dstBranch = '';
      navigate('dst');
      await new Promise(r => setTimeout(r, 100));
      const ids = [...document.querySelectorAll('#dstTable tbody tr')].map(tr => tr.textContent);
      const badge = !!document.querySelector('#dstTable .dst-reassigned');
      window._dstScope = 'all';
      navigate('dst', 'DST-ZNR');
      await new Promise(r => setTimeout(r, 120));
      const chain = (document.getElementById('dstChain') || {}).textContent || '';
      return {title: note.title || '', body: note.body || '', rows: ids.filter(x => /ZZ Nominee/.test(x)).length,
        fresh: ids.filter(x => /ZZ Fresh/.test(x)).length, badge, chain, urgency: task.urgencyLevel, due: task.dueDate === today};
    }, {TEAM});
    if(!/reassigned to you/i.test(r.title) || !/Reassigned by ZZ Anand, originally assigned by ZZ Bhuvan/.test(r.body)) throw new Error('notice: ' + JSON.stringify(r));
    if(!/ZZ Bhuvan → ZZ Anand → ZZ Prajval/.test(r.body) || !/ZZ Bhuvan → ZZ Anand → ZZ Prajval/.test(r.chain)) throw new Error('chain: ' + JSON.stringify(r));
    if(r.rows !== 1 || r.fresh || !r.badge) throw new Error('filter: ' + JSON.stringify(r));
    if(r.urgency !== 'High' || !r.due) throw new Error('details changed');
    return 'Prajval told "' + r.body.slice(0, 70) + '…"; filter shows only the reassigned task';
  });

  await t.step('Completed counts once, for whoever completed it', async () => {
    const r = await t.eval(async () => {
      const task = DB.tasks.find(x => x.id === 'DST-ZNR');
      const was = currentUser;
      currentUser = 'ZN3'; task.overallStatus = 'Completed'; await save('tasks');
      currentUser = was;
      const out = {};
      window._dstScope = 'all'; window._dstStatus = '';
      for(const who of ['ZN1', 'ZN2', 'ZN3']){
        window._dstTeam = who;
        navigate('dst'); await new Promise(r => setTimeout(r, 60));
        const cards = [...document.querySelectorAll('#dstKpis .mkpi')];
        out[who] = (cards.find(c => /Completed/.test(c.textContent)).querySelector('.mkpi-num') || {}).textContent;
      }
      // As Anand himself, who passed it on: it is visible but not his completion.
      window._dstTeam = '';
      currentUser = 'ZN2';
      out.anandOwn = dstVisible(DB.tasks).filter(t => dstKpiMatch(t, 'completed', dstCompletedCredit()) && t.id === 'DST-ZNR').length;
      currentUser = 'ZN3';
      out.prajvalOwn = dstVisible(DB.tasks).filter(t => dstKpiMatch(t, 'completed', dstCompletedCredit()) && t.id === 'DST-ZNR').length;
      currentUser = was;
      return out;
    });
    if(r.ZN3 !== '1' || r.ZN2 !== '0' || r.ZN1 !== '0' || r.anandOwn || r.prajvalOwn !== 1) throw new Error(JSON.stringify(r));
    return 'Prajval 1, Anand 0, Bhuvan 0';
  });

  await t.step('every card follows the filters and opens exactly what it counts', async () => {
    const r = await t.eval(async () => {
      window._dstTeam = ''; window._dstScope = 'all'; window._dstStatus = '';
      const out = [];
      const read = () => [...document.querySelectorAll('#dstKpis .mkpi')].map(c => [c.querySelector('.mkpi-lbl').textContent.trim(), Number(c.querySelector('.mkpi-num').textContent)]);
      const rows = () => [...document.querySelectorAll('#dstTable tbody tr')].filter(tr => !tr.querySelector('.empty')).length;
      for(const scope of ['all', 'mine', 'reassigned']){
        window._dstScope = scope; window._dstStatus = '';
        navigate('dst'); await new Promise(r => setTimeout(r, 60));
        const cards = read();
        for(let i = 0; i < cards.length; i++){
          document.querySelectorAll('#dstKpis .mkpi')[i].click();
          await new Promise(r => setTimeout(r, 40));
          const n = rows();
          if(n !== cards[i][1]) out.push(scope + '/' + cards[i][0] + ': card ' + cards[i][1] + ', list ' + n);
        }
      }
      // A person filter changes the numbers.
      window._dstScope = 'all'; window._dstStatus = ''; window._dstTeam = 'ZN3';
      navigate('dst'); await new Promise(r => setTimeout(r, 60));
      const total = read()[0][1];
      window._dstTeam = ''; window._dstStatus = ''; render();
      return {bad: out, total};
    });
    if(r.bad.length) throw new Error(r.bad.join('; '));
    if(r.total !== 1) throw new Error('team filter Total ' + r.total);
    return 'all cards match their lists on All, My and Reassigned; a person filter narrows the Total';
  });
});
