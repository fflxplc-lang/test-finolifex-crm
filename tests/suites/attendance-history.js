/* MY ATTENDANCE HISTORY — filters, totals, detail, and the bell.

   The card opens on the current month. From / To with Apply Filter set
   the range and Reset Filter puts the month back. Three totals — Absent,
   Present, Leave Taken — count each date once and open the matching
   detail when clicked. The card minimizes to its heading. Staff can pick
   another employee; a plain member cannot.

   A notification goes where it points when clicked, even if saving the
   read mark fails, and the bar shows only unread messages from the last
   seven days. */
const {suite} = require('../lib/harness');

suite(async t => {
  let who = null, days = null;

  await t.step('a member with a worked day, an absence, approved and pending leave', async () => {
    const r = await t.eval(async ()=>{
      const id = uid('TM');
      DB.team.push({id, name:'ZZ Hist Person', role: roleList().slice(-1)[0], email:'zz.hist@example.com', status:'Active',
        scope:'own', branch:'Varanasi', adminFlags: fullAdminFlags(false), perms: fullPerms(false, {view:1}),
        createdAt: new Date().toISOString()});
      await save('team');
      /* six past working days, newest first, none a Sunday or holiday */
      const out = [], d = new Date(); d.setDate(d.getDate() - 1);
      while(out.length < 6){ const k = hrDateKey(d); if(!hrClosedDayWhy(k) && !hrIsWeeklyOff(k)) out.push(k); d.setDate(d.getDate() - 1); }
      const at = (k, hm) => new Date(k + 'T' + hm + ':00').toISOString();
      DB.hrAttendance = (DB.hrAttendance || []).concat([
        {id: uid('HRA'), userId: id, date: out[0], sessions: [{in: at(out[0], '09:30'), out: at(out[0], '18:30')}]},
        {id: uid('HRA'), userId: id, date: out[1], sessions: [{in: at(out[1], '10:00'), out: at(out[1], '14:00')}]}]);
      await save('hrAttendance');
      const lv = (from, to, type, status, reason) => ({id: uid('HRL'), userId: id, from, to, type,
        unit: type === 'Half Day' ? 'half' : 'full', reason, status, requestedAt: new Date().toISOString()});
      DB.hrLeave = (DB.hrLeave || []).concat([
        lv(out[2], out[2], 'Full Day', 'Approved', 'ZZ fever'),
        lv(out[3], out[3], 'Half Day', 'Approved', 'ZZ bank work'),
        lv(out[4], out[4], 'Full Day', 'Pending', 'ZZ travel')]);
      await save('hrLeave');
      return {id, days: out};
    });
    who = r.id; days = r.days;
    return 'days ' + days.join(', ');
  });

  const view = (a) => t.eval(async (a)=>{
    const was = currentUser; currentUser = a.who;
    window._ah = null;
    try { localStorage.removeItem('boss.ahCollapsed'); } catch(e){}
    navigate('hrattendance'); await new Promise(r=>setTimeout(r, 60));
    const out = {month: Object.assign({}, hrAhState())};
    hrAhSetRange(a.from, a.to); hrAhRedraw();
    const num = k => (document.querySelector('[data-ahtile="' + k + '"] .ah-tile-num') || {}).textContent;
    out.tiles = {absent: num('absent'), present: num('present'), leave: num('leave')};
    out.rows = document.querySelectorAll('#hrAhCard tr[data-hrdate]').length;
    currentUser = was;
    return out;
  }, a);

  await t.step('it opens on the current month', async () => {
    const r = await view({who, from: '', to: ''}).catch(e=>({err: e.message}));
    const m = await t.eval(()=>hrAhMonthRange());
    if(!r.month || r.month.from !== m.from || r.month.to !== m.to) throw new Error(JSON.stringify(r));
    return m.from + ' to ' + m.to;
  });

  await t.step('the totals count each date once over the range', async () => {
    const r = await view({who, from: days[5], to: days[0]});
    /* worked: days 0, 1 · leave: 2 (1) and 3 (½) · absent: 4 (pending leave) and 5 */
    if(r.tiles.present !== '2' || r.tiles.leave !== '1.5' || r.tiles.absent !== '2') throw new Error(JSON.stringify(r.tiles));
    if(r.rows < 6) throw new Error(r.rows + ' rows');
    return 'Absent ' + r.tiles.absent + ', Present ' + r.tiles.present + ', Leave ' + r.tiles.leave;
  });

  await t.step('one day is checked by setting both dates to it', async () => {
    const r = await view({who, from: days[0], to: days[0]});
    if(r.rows !== 1 || r.tiles.present !== '1' || r.tiles.absent !== '0') throw new Error(JSON.stringify(r));
    return '1 row, Present 1';
  });

  await t.step('each total opens its own detail, latest first', async () => {
    const r = await t.eval(async (a)=>{
      const was = currentUser; currentUser = a.who;
      hrAhSetRange(a.days[5], a.days[0]); hrAhRedraw();
      const read = k => { hrAhOpenPanel(k);
        const p = document.getElementById('ahPanel');
        return {head: Array.from(p.querySelectorAll('th')).map(x=>x.textContent),
          rows: Array.from(p.querySelectorAll('tbody tr')).map(tr=>tr.textContent.replace(/\s+/g, ' ').trim())}; };
      const out = {absent: read('absent'), present: read('present'), leave: read('leave')};
      hrAhOpenPanel('leave'); out.closed = !document.getElementById('ahPanel');
      currentUser = was;
      return out;
    }, {who, days});
    if(r.absent.rows.length !== 2 || !/Leave request pending/.test(r.absent.rows[0])) throw new Error('absent ' + JSON.stringify(r.absent));
    if(r.present.rows.length !== 2 || !/In Time/.test(r.present.head.join())) throw new Error('present ' + JSON.stringify(r.present));
    if(r.leave.rows.length !== 3 || !/Approved.*ZZ fever/.test(r.leave.rows[0]) || !/Pending/.test(r.leave.rows[2])) throw new Error('leave ' + JSON.stringify(r.leave));
    if(!r.closed) throw new Error('clicking the open total again should close it');
    return 'absent 2 (reason shown), present 2, leave 3 with status';
  });

  await t.step('Reset Filter goes back to the month, and To before From is refused', async () => {
    const r = await t.eval(async (a)=>{
      const was = currentUser; currentUser = a.who;
      const said = []; const al = window.alert; window.alert = m=>said.push(m);
      document.getElementById('ahFrom').value = a.days[0]; document.getElementById('ahTo').value = a.days[5];
      hrAhApply();
      const kept = Object.assign({}, hrAhState());
      hrAhReset();
      window.alert = al; currentUser = was;
      return {said, kept, now: Object.assign({}, hrAhState()), month: hrAhMonthRange()};
    }, {who, days});
    if(!r.said.length) throw new Error('a backwards range was accepted');
    if(r.now.from !== r.month.from || r.now.to !== r.month.to) throw new Error(JSON.stringify(r.now));
    return r.said[0];
  });

  await t.step('the card minimizes to its heading and expands again', async () => {
    const r = await t.eval(()=>{
      hrAhToggle();
      const min = {tiles: !!document.querySelector('.ah-tiles'), filter: !!document.getElementById('ahFrom'),
        head: /Attendance History/.test(document.getElementById('hrAhCard').textContent)};
      hrAhToggle();
      return {min, back: !!document.querySelector('.ah-tiles') && !!document.getElementById('ahFrom')};
    });
    if(r.min.tiles || r.min.filter || !r.min.head || !r.back) throw new Error(JSON.stringify(r));
    return 'heading only when minimized';
  });

  await t.step('staff can pick the employee; a plain member has no picker', async () => {
    const r = await t.eval(async (a)=>{
      window._ah = null; navigate('hrattendance');
      const staffPicker = !!document.querySelector('.ah-who select');
      hrAhPickUser(a.who); hrAhSetRange(a.days[5], a.days[0]); hrAhRedraw();
      const title = document.querySelector('.ah-title').textContent;
      const present = document.querySelector('[data-ahtile="present"] .ah-tile-num').textContent;
      const was = currentUser; currentUser = a.who; window._ah = null; navigate('hrattendance');
      const plainPicker = !!document.querySelector('.ah-who select');
      currentUser = was; window._ah = null;
      return {staffPicker, title, present, plainPicker};
    }, {who, days});
    if(!r.staffPicker || r.plainPicker || !/ZZ Hist Person/.test(r.title) || r.present !== '2') throw new Error(JSON.stringify(r));
    return r.title;
  });

  t.section('notifications');

  await t.step('a leave decision goes to the leave card, even if saving the read mark fails', async () => {
    const r = await t.eval(async ()=>{
      navigate('dashboard');
      const n = await notifyUser(currentUser, {title:'Your leave was approved', body:'ZZ', view:'hrattendance', kind:'hr-leave-decided'});
      const real = window.save; window.save = async ()=>{ throw new Error('offline'); };
      try { await openNotification(n.id); } finally { window.save = real; }
      await new Promise(r=>setTimeout(r, 200));
      return {view: currentView, card: !!document.getElementById('hrMyLeaveCard'), read: !!n.readAt};
    });
    if(r.view !== 'hrattendance' || !r.card || !r.read) throw new Error(JSON.stringify(r));
    return 'landed on Attendance Management at My leave';
  });

  await t.step('read messages leave the bar, and unread ones after seven days', async () => {
    const r = await t.eval(async ()=>{
      const old = await notifyUser(currentUser, {title:'ZZ old', view:'dashboard'});
      old.at = new Date(Date.now() - 8 * 86400000).toISOString();
      const fresh = await notifyUser(currentUser, {title:'ZZ fresh', view:'dashboard'});
      const ids = () => myNotifications().map(n=>n.id);
      const before = {old: ids().includes(old.id), fresh: ids().includes(fresh.id)};
      await markNotificationRead(fresh.id);
      return {before, after: ids().includes(fresh.id), stored: DB.notifications.some(n=>n.id === old.id)};
    });
    if(r.before.old || !r.before.fresh || r.after || !r.stored) throw new Error(JSON.stringify(r));
    return 'an 8-day-old one hidden, a read one gone, nothing deleted';
  });
});
