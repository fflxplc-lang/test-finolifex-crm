/* THE 9 O'CLOCK DJT EMAIL.

   At 09:00 each person is emailed their own day from the Daily Job Tracker:
   yesterday's list with what got done and what is still open, their
   reflection, and today's list — with a BOSS notification beside it. Only
   their own work, once a day, never before nine, and not at all when the
   firm switches it off. Run through the test-only /api/reminders/run
   (CRM_REMINDERS=manual, CRM_BUSINESS_TZ=UTC). */
const {suite} = require('../lib/harness');

suite({mail: true}, async t => {
  const today = await t.eval(() => new Date().toISOString().slice(0, 10));
  const run = hhmm => t.eval(async when => {
    const r = await fetch('/api/reminders/run', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({at: when})});
    return (await r.json()).log;
  }, today + 'T' + hhmm + ':00Z');

  const ids = await t.eval(async () => {
    const mk = (name, email) => ({id: uid('USR'), name, email, role: 'Relationship Manager', status: 'Active',
      perms: fullPerms(true), adminFlags: fullAdminFlags(false), documents: [], notes: [], createdAt: new Date().toISOString()});
    const a = mk('ZZ Asha Rao', 'zz.asha@example.com'), b = mk('ZZ Bala Iyer', 'zz.bala@example.com'), idle = mk('ZZ Idle', 'zz.idle@example.com');
    DB.team = DB.team.filter(x => !/^ZZ /.test(x.name || '')).concat([a, b, idle]);
    await save('team');
    const d = new Date().toISOString().slice(0, 10);
    const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const task = (who, due, title, st) => ({id: uid('DST'), taskType: 'ZZ Type', description: title, assignTo: who, assignedDate: y, dueDate: due,
      overallStatus: st, urgencyLevel: 'Medium', createdBy: who, createdAt: new Date().toISOString()});
    DB.tasks = (DB.tasks || []).filter(x => !/^ZZ /.test(x.description || '')).concat([
      task(a.id, y, 'ZZ Done yesterday', 'Completed'), task(a.id, y, 'ZZ Left open', 'In Progress'),
      task(a.id, d, 'ZZ Due today', 'Not Started'), task(b.id, d, 'ZZ Bala only', 'Not Started')]);
    await save('tasks');
    DB.djtEntries = (DB.djtEntries || []).concat([{id: uid('DJT'), userId: a.id, date: y, learning: 'ZZ learned the NAV file', breakdown: '', breakthrough: 'ZZ closed two SIPs'}]);
    await save('djtEntries');
    DB.config.general = Object.assign({}, DB.config.general, {djtDailyEmail: true});
    await save('config');
    return {a: a.id, b: b.id, idle: idle.id};
  });

  await t.step('nothing goes out before nine', async () => {
    t.mail.clear();
    await run('08:59');
    await t.wait(300);
    if(t.mail.received.some(m => /Your day/.test(m.subject))) throw new Error('sent early');
    return 'nothing at 08:59';
  });

  await t.step('at nine each person gets their own day, and nobody else\'s', async () => {
    t.mail.clear();
    await run('09:00');
    await t.wait(800);
    const to = who => t.mail.received.find(m => m.to.join(',').includes(who));
    const a = to('zz.asha@'), b = to('zz.bala@');
    if(!a || !b) throw new Error('not mailed: ' + t.mail.received.map(m => m.to.join(',')).join(' ; '));
    if(to('zz.idle@')) throw new Error('somebody with an empty day was mailed');
    const txt = a.text || a.body;
    if(!/1 of 2 done/.test(a.subject) || !/1 job today/.test(a.subject)) throw new Error(a.subject);
    for(const re of [/ZZ Done yesterday/, /ZZ Left open/, /carry these forward/i, /ZZ Due today/, /ZZ learned the NAV file/, /ZZ closed two SIPs/])
      if(!re.test(txt)) throw new Error('missing ' + re + ' in:\n' + txt.slice(0, 900));
    if(/ZZ Bala only/.test(txt) || /ZZ Due today/.test(b.text || b.body)) throw new Error('someone else\'s work in the letter');
    const note = await t.eval(async id => { const r = await fetch('/api/storage/notifications'); const j = await r.json();
      return JSON.parse(j.value || '[]').filter(n => n.userId === id && n.kind === 'djt-daily').length; }, ids.a);
    if(note !== 1) throw new Error('BOSS notification count ' + note);
    return '"' + a.subject + '" to Asha, with a notification; Bala gets only his';
  });

  await t.step('once a day: the next tick sends nothing', async () => {
    t.mail.clear();
    await run('09:30');
    await t.wait(300);
    if(t.mail.received.some(m => /Your day/.test(m.subject))) throw new Error('sent twice');
    return 'not repeated';
  });

  await t.step('the firm can switch it off', async () => {
    const r = await t.eval(() => { const s = settingDefs().find(x => x.key === 'general.djtDailyEmail'); return s ? s.def : null; });
    if(r !== true) throw new Error('setting missing: ' + r);
    await t.eval(async () => { DB.config.general = Object.assign({}, DB.config.general, {djtDailyEmail: false}); await save('config'); });
    t.mail.clear();
    await t.eval(async () => { const r = await fetch('/api/reminders/run', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({at: new Date(Date.now() + 86400000).toISOString().slice(0, 10) + 'T09:05:00Z'})}); return r.ok; });
    await t.wait(400);
    if(t.mail.received.some(m => /Your day/.test(m.subject))) throw new Error('sent while switched off');
    return 'Setup › General › DJT: Daily Email at 9 AM, on by default; off means nothing goes out';
  });
});
