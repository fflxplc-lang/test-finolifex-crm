/* REMINDERS THE SERVER SENDS, AND THE ONE THE PAGE GOT WRONG.

   The punch-in reminder used to be worked out at page load as whoever was
   first in the team list — the firm's own Admin account, which never
   punches — so everybody was told on every reload that they had not
   punched in. It is now worked out as the person who signed in, against
   what the server holds for them today.

   The rest is the server's own timer, run here at chosen times through
   the test-only /api/reminders/run (the suites start the server with
   CRM_REMINDERS=manual and CRM_BUSINESS_TZ=UTC):
     09:15 not punched in       -> email (and push, where a device allowed it)
     18:00 still punched in     -> a BOSS notification
     19:00 still punched in     -> email
     a DWT meeting / activity reaching its start time -> a BOSS notification
   each once, and never for somebody on leave, punched in already, or for
   an activity that was moved, cancelled or completed. */
const {suite} = require('../lib/harness');

suite({mail: true}, async t => {
  const today = await t.eval(() => hrToday());
  const at = hhmm => today + 'T' + hhmm + ':00Z';
  const run = hhmm => t.eval(async (when) => {
    const r = await fetch('/api/reminders/run', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({at: when})});
    return (await r.json()).log;
  }, at(hhmm));
  const notes = () => t.eval(async () => {
    const r = await fetch('/api/storage/notifications'); const j = await r.json();
    return JSON.parse(j.value || '[]');
  });

  t.section('the people');
  const ids = await t.eval(async () => {
    const mk = (name, email) => ({id: uid('USR'), name, email, role: 'Relationship Manager', status: 'Active',
      perms: fullPerms(true), adminFlags: fullAdminFlags(true), documents: [], notes: [], createdAt: new Date().toISOString()});
    const me = mk('ZZ Me', 'test@finowise.test');
    const late = mk('ZZ Late', 'zz.late@example.com');
    const open = mk('ZZ Open', 'zz.open@example.com');
    const away = mk('ZZ Away', 'zz.away@example.com');
    DB.team = DB.team.filter(x => !/^ZZ /.test(x.name || '')).concat([me, late, open, away]);
    await save('team');
    DB.hrConfig = Object.assign({}, DB.hrConfig, {location: {required: false, note: ''},
      activity: {enabled: false, idleMinutes: '', beatSeconds: 30, saveSeconds: 120},
      reminders: {enabled: true, inAfter: '00:00', outAfter: '23:58', repeatMinutes: 30,
        inEmailAt: '09:15', outNotifyAt: '18:00', outEmailAt: '19:00'},
      weeklyOff: [], holidays: [],
      day: Object.assign({}, (DB.hrConfig || {}).day, {punchInFrom: '00:00', punchOutUntil: '23:59'})});
    await save('hrConfig');
    const d = hrToday();
    DB.hrLeave = [{id: uid('LV'), userId: away.id, type: 'Casual Leave', from: d, to: d, status: 'Approved'}];
    await save('hrLeave');
    const inAt = new Date(Date.now() - 3 * 3600000).toISOString();
    DB.hrAttendance = [{id: uid('HRA'), userId: open.id, date: d, sessions: [{in: inAt, out: null, inBy: open.id}],
      createdAt: inAt, createdBy: open.id}];
    await save('hrAttendance');
    return {me: me.id, late: late.id, open: open.id, away: away.id};
  });

  t.section('the wrong reminder on every reload');

  await t.step('a reload is the person who signed in, and is reminded only for them', async () => {
    await t.home();
    await t.wait(2500);
    const r = await t.eval(() => ({cur: currentUser, on: document.getElementById('hrNudge').classList.contains('on'),
      key: document.getElementById('hrNudge').getAttribute('data-key')}));
    if(r.cur !== ids.me) throw new Error('the page is ' + r.cur + ', not the signed-in member');
    if(!r.on || r.key !== 'in') throw new Error('somebody with no punch was not reminded: ' + JSON.stringify(r));
    return 'not punched in -> reminded, as ZZ Me';
  });

  await t.step('punched in, then reloaded: no "you have not punched in"', async () => {
    const ok = await t.eval(async () => { await hrPunchIn(); return !!hrFirstIn(hrAttendanceOf(currentUser, hrToday())); });
    if(!ok) throw new Error('the punch did not land');
    for(let i = 0; i < 2; i++){
      await t.home();
      await t.wait(2500);
      const r = await t.eval(() => ({on: document.getElementById('hrNudge').classList.contains('on'),
        txt: document.getElementById('hrNudge').textContent}));
      if(r.on && /not punched in/i.test(r.txt)) throw new Error('reminded after punching in, reload ' + (i + 1));
    }
    return 'two reloads, no reminder';
  });

  await t.step('the server cannot be reached: Retry, not "you have not punched in"', async () => {
    t.expectConsole(/attendance check|Failed to fetch|500/);
    const r = await t.eval(async () => {
      const real = window.fetch;
      window.fetch = (u, o) => String(u).indexOf('/api/attendance/today') >= 0 ? Promise.reject(new TypeError('Failed to fetch')) : real(u, o);
      hrNudgeState.verified = ''; hrNudgeState.error = '';
      await hrNudgeVerify(); hrNudgeClear();
      const el = document.getElementById('hrNudge');
      const out = {key: el.getAttribute('data-key'), txt: el.textContent.replace(/\s+/g, ' ')};
      window.fetch = real;
      await hrNudgeRetry();
      out.after = el.classList.contains('on') ? el.getAttribute('data-key') : 'none';
      return out;
    });
    if(r.key !== 'err' || !/Retry/.test(r.txt)) throw new Error(JSON.stringify(r));
    if(r.after === 'in') throw new Error('after Retry it claimed no punch in');
    return 'error card with Retry; cleared after it';
  });

  t.section('the punch clock, enforced by the server');

  await t.step('a punch on an approved leave day is refused by the server', async () => {
    t.expectConsole(/409/);
    const r = await t.eval(async (away) => {
      const d = hrToday(), was = DB.hrAttendance.slice();
      DB.hrAttendance = was.concat([{id: uid('HRA'), userId: away, date: d,
        sessions: [{in: new Date().toISOString(), out: null, inBy: away}], createdAt: new Date().toISOString()}]);
      const wrote = await save('hrAttendance');
      DB.hrAttendance = was;
      return wrote;
    }, ids.away);
    if(r !== false) throw new Error('the server accepted it');
    const said = t.dialogs.splice(0).join(' | ');
    if(!/approved leave/i.test(said)) throw new Error('reason not given: ' + said);
    return said;
  });

  await t.step('and the buttons say the same on the page', async () => {
    const r = await t.eval((away) => { const was = currentUser; currentUser = away;
      const out = hrPunchRules(null); currentUser = was; return out; }, ids.away);
    if(r.inOk || r.outOk) throw new Error(JSON.stringify(r));
    return r.inWhy;
  });

  t.section('attendance reminders from the server');

  await t.step('09:15 — an email to the one who has not punched in, and nobody else', async () => {
    t.mail.clear();
    await run('09:16');
    await t.wait(400);
    const to = t.mail.received.map(m => m.to.join(','));
    if(!to.some(x => /zz\.late@/.test(x))) throw new Error('ZZ Late got nothing: ' + to.join(' ; '));
    if(to.some(x => /zz\.away@|test@finowise/.test(x))) throw new Error('somebody on leave or punched in was mailed: ' + to.join(' ; '));
    return to.length + ' email(s): ' + to.join(' ; ');
  });

  await t.step('and only once, however often the timer ticks', async () => {
    t.mail.clear();
    await run('09:20'); await run('10:05');
    await t.wait(300);
    if(t.mail.received.some(m => /zz\.late@/.test(m.to.join(',')))) throw new Error('mailed again');
    return 'no second email';
  });

  await t.step('18:00 — a BOSS notification for the one still punched in', async () => {
    await run('18:01');
    const n = (await notes()).filter(x => x.kind === 'hr-reminder');
    if(!n.some(x => x.userId === ids.open)) throw new Error('ZZ Open has no notification');
    if(n.some(x => x.userId === ids.late)) throw new Error('somebody never punched in was told to punch out');
    return n.length + ' notification(s), "' + n[0].title + '"';
  });

  await t.step('19:00 — the email, checked again first', async () => {
    t.mail.clear();
    await run('19:01');
    await t.wait(300);
    const to = t.mail.received.map(m => m.to.join(','));
    if(!to.some(x => /zz\.open@/.test(x))) throw new Error('ZZ Open was not mailed: ' + to.join(' ; '));
    return to.join(' ; ');
  });

  await t.step('every send is written down, with how it went', async () => {
    const r = await t.eval(async () => (await (await fetch('/api/reminders/log')).json()).rows);
    const kinds = new Set(r.map(x => x.kind + '/' + x.channel));
    ['punch-in/email', 'punch-out/in-app', 'punch-out/email'].forEach(k => { if(!kinds.has(k)) throw new Error('no ' + k + ' in ' + [...kinds]); });
    const push = r.find(x => x.channel === 'push');
    return r.length + ' rows' + (push ? '; push without a device says "' + push.message + '"' : '');
  });

  t.section('DWT: a scheduled start time');

  const plan = await t.eval(async (me) => {
    const d = hrToday();
    const act = {id: uid('WA'), date: d, status: 'Planned', userId: me, activityType: 'Client Servicing',
      title: 'Follow up with client', plannedStart: '11:00', plannedEnd: '11:30', days: [], repeatWeekly: false,
      sourceType: 'manual', createdAt: new Date().toISOString(), createdBy: me};
    act.sourceId = act.id;
    const done = Object.assign({}, act, {id: uid('WA'), title: 'Already done', status: 'Completed', completedOn: d});
    const mtg = {id: uid('MTG'), subject: 'Client Meeting', scheduledDate: d, scheduledTime: '11:00', assignTo: me,
      status: 'Scheduled', meetingType: 'Client Meeting', withName: 'Ravi Kumar', meetingLink: 'meet.example.com/abc',
      createdAt: new Date().toISOString(), createdBy: me};
    DB.workActivities = (DB.workActivities || []).concat([act, done]); await save('workActivities');
    DB.meetings = (DB.meetings || []).concat([mtg]); await save('meetings');
    return {act: act.id, mtg: mtg.id};
  }, ids.me);

  await t.step('nothing before the time', async () => {
    await run('10:59');
    const n = (await notes()).filter(x => x.kind === 'dwt-reminder');
    if(n.length) throw new Error(n.length + ' reminder(s) early');
    return 'none at 10:59';
  });

  await t.step('at 11:00 the meeting and the activity, with their details; not the completed one', async () => {
    await run('11:00');
    const n = (await notes()).filter(x => x.kind === 'dwt-reminder');
    const m = n.find(x => x.meta && x.meta.id === plan.mtg), a = n.find(x => x.meta && x.meta.id === plan.act);
    if(!m || !a) throw new Error('missing: ' + JSON.stringify(n.map(x => x.title)));
    if(n.length !== 2) throw new Error(n.length + ' reminders, expected 2');
    if(!/scheduled to start now/.test(m.body) || !/Ravi Kumar/.test(m.body) || !/meet\.example\.com/.test(m.body))
      throw new Error('meeting body: ' + m.body);
    if(!/due to start now/.test(a.body)) throw new Error('activity body: ' + a.body);
    return m.body.split('\n')[0];
  });

  await t.step('a second tick sends nothing more', async () => {
    await run('11:02');
    const n = (await notes()).filter(x => x.kind === 'dwt-reminder');
    if(n.length !== 2) throw new Error(n.length + ' reminders now');
    return 'still 2';
  });

  await t.step('moved to 11:45: reminded at the new time, never the old one', async () => {
    await t.eval(async (id) => { const a = DB.workActivities.find(x => x.id === id); a.plannedStart = '11:45'; a.plannedEnd = '12:15';
      DB.notifications = JSON.parse((await (await fetch('/api/storage/notifications')).json()).value);
      await save('workActivities'); }, plan.act);
    await run('11:30');
    let n = (await notes()).filter(x => x.kind === 'dwt-reminder' && x.meta.id === plan.act);
    if(n.length !== 1) throw new Error('reminded before the new time');
    await run('11:45');
    n = (await notes()).filter(x => x.kind === 'dwt-reminder' && x.meta.id === plan.act);
    if(n.length !== 2 || n[1].meta.time !== '11:45') throw new Error(JSON.stringify(n.map(x => x.meta.time)));
    return 'reminded at ' + n.map(x => x.meta.time).join(' then ');
  });

  await t.step('a cancelled meeting is not reminded', async () => {
    await t.eval(async (id) => {
      const m = DB.meetings.find(x => x.id === id);
      DB.meetings.push(Object.assign({}, m, {id: uid('MTG'), subject: 'Cancelled one', scheduledTime: '12:00', status: 'Cancelled'}));
      await save('meetings'); }, plan.mtg);
    await run('12:00');
    const n = (await notes()).filter(x => x.kind === 'dwt-reminder' && /Cancelled one/.test(x.title));
    if(n.length) throw new Error('reminded');
    return 'none';
  });

  t.section('the reminder on screen');

  await t.step('cards with View Activity, Mark as Started and Dismiss', async () => {
    await t.home();
    await t.wait(800);
    const r = await t.eval(() => [...document.querySelectorAll('#remStack .rem-card')].map(c => c.textContent.replace(/\s+/g, ' '))
      .filter(x => /^\s*(Scheduled|Meeting):/.test(x)));
    if(r.length < 2) throw new Error(r.length + ' card(s)');
    if(!r.every(x => /View Activity/.test(x) && /Mark as Started/.test(x) && /Dismiss/.test(x))) throw new Error(r.join(' || '));
    if(!r.some(x => /Join/.test(x))) throw new Error('the meeting link is not offered');
    return r.length + ' cards';
  });

  await t.step('Mark as Started records it, and the card goes', async () => {
    const r = await t.eval(async (actId) => {
      const n = DB.notifications.find(x => x.kind === 'dwt-reminder' && !x.readAt && x.meta && x.meta.id === actId);
      await reminderStarted(n.id);
      const a = DB.workActivities.find(x => x.id === actId);
      return {status: a.status, started: Object.keys(a.startedOn || {}), read: !!n.readAt,
        cards: document.querySelectorAll('#remStack .rem-card').length};
    }, plan.act);
    if(r.status !== 'In Progress' || !r.read) throw new Error(JSON.stringify(r));
    return JSON.stringify(r);
  });

  await t.step('Dismiss leaves the meeting as it was', async () => {
    const r = await t.eval(async (mtgId) => {
      const n = DB.notifications.find(x => x.kind === 'dwt-reminder' && !x.readAt && x.meta && x.meta.id === mtgId);
      await reminderDismiss(n.id);
      const m = DB.meetings.find(x => x.id === mtgId);
      return {status: m.status, read: !!n.readAt, left: document.querySelectorAll('#remStack .rem-card').length};
    }, plan.mtg);
    if(r.status !== 'Scheduled' || !r.read) throw new Error(JSON.stringify(r));
    return JSON.stringify(r);
  });

  await t.step('View Activity opens the activity on its week', async () => {
    const r = await t.eval(async (actId) => {
      await run11 ();
      async function run11(){}
      const n = DB.notifications.find(x => x.kind === 'dwt-reminder' && x.meta && x.meta.id === actId);
      n.readAt = null;
      await reminderView(n.id);
      await new Promise(r => setTimeout(r, 300));
      return {view: currentView, modal: (document.querySelector('.modal h3, .modal-title') || {}).textContent || ''};
    }, plan.act);
    if(r.view !== 'dwt') throw new Error(JSON.stringify(r));
    return JSON.stringify(r);
  });

  t.section('rules, settings');

  await t.step('Daily Attendance Rules & Regulations opens with the punch clock’s own times', async () => {
    const r = await t.eval(async () => {
      DB.hrConfig.day.punchInFrom = '08:45'; DB.hrConfig.day.punchOutUntil = '20:45';
      navigate('hrattendance'); await new Promise(r => setTimeout(r, 200));
      const b = [...document.querySelectorAll('button')].find(x => /Daily Attendance Rules/.test(x.textContent));
      if(!b) return {err: 'no button'};
      b.click();
      const txt = (document.querySelector('.modal') || document.body).textContent.replace(/\s+/g, ' ');
      closeModal();
      return {txt};
    });
    if(r.err) throw new Error(r.err);
    ['08:45', '20:45', '9 hours', 'Regularize', 'Punch-Out Missing', 'Sundays'].forEach(w => {
      if(r.txt.indexOf(w) < 0) throw new Error('missing "' + w + '"');
    });
    return 'all sections present';
  });

  await t.step('reminder settings are on the profile and on DWT', async () => {
    const r = await t.eval(async () => {
      navigate('profile'); await new Promise(r => setTimeout(r, 150));
      const onProfile = !!document.getElementById('reminderPrefs');
      await reminderPrefSet('advanceMinutes', 10);
      dwtReminderSettings();
      const inModal = !!document.querySelector('.modal #reminderPrefs');
      closeModal();
      return {onProfile, inModal, saved: reminderPrefsOf(me()).advanceMinutes};
    });
    if(!r.onProfile || !r.inModal || r.saved !== 10) throw new Error(JSON.stringify(r));
    return JSON.stringify(r);
  });

  await t.step('with 10 minutes ahead asked for: a reminder at 12:50 for a 13:00 meeting, and one at 13:00', async () => {
    await t.eval(async (me) => {
      DB.meetings.push({id: uid('MTG'), subject: 'One o’clock', scheduledDate: hrToday(), scheduledTime: '1:00 PM', assignTo: me,
        status: 'Scheduled', meetingType: 'Client Meeting', createdAt: new Date().toISOString(), createdBy: me});
      await save('meetings'); }, ids.me);
    await run('12:50');
    await run('13:00');
    const n = (await notes()).filter(x => x.kind === 'dwt-reminder' && /One o’clock/.test(x.title));
    const which = n.map(x => x.meta.which).join(',');
    if(which !== 'pre,start') throw new Error(which);
    return n.map(x => x.body.split('\n')[0]).join(' / ');
  });

  t.dialogs.splice(0);
});
