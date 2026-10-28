/* ALL EMPLOYEES' ATTENDANCE FOR A MONTH, ON THE HR DASHBOARD.

   Administrators and HR see every active employee's month in one place:
   working days (Sundays and holidays out), present, absent, leave, late,
   hours and attendance %, as a summary or a day-by-day grid, filtered by
   month, branch and search, and exportable. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.step('a past month adds up per person and shows in both views', async () => {
    const r = await t.eval(async () => {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
      const month = hrDateKey(d).slice(0, 7);
      const days = hrMbDates(month);
      const work = days.filter(x => !hrMbClosed(x));
      const id = 'USR-HMB';
      DB.team = DB.team.filter(x => x.id !== id).concat([{id, name: 'ZZ Month', email: 'hmb@example.com', role: defaultRole(),
        status: 'Active', branch: 'ZZ Branch', documents: [], notes: [], perms: {}, adminFlags: {}}]);
      const sess = date => ({in: new Date(date + 'T09:00:00').toISOString(), out: new Date(date + 'T18:00:00').toISOString()});
      DB.hrAttendance = (DB.hrAttendance || []).filter(x => x.userId !== id).concat(
        work.slice(0, 3).map((date, i) => ({id: 'ATT-HMB' + i, userId: id, date, sessions: [sess(date)]})));
      DB.hrLeave = (DB.hrLeave || []).filter(x => x.userId !== id).concat([
        {id: 'HRL-HMB', userId: id, from: work[3], to: work[3], type: 'Casual Leave', unit: 'full', status: 'Approved', reason: 'x'}]);
      window._hmb = {month, branch: 'ZZ Branch', q: '', view: 'summary', sort: 'name', dir: 1};
      navigate('hrdashboard');
      await new Promise(r => setTimeout(r, 150));
      const row = document.querySelector('#hmbTable tr[data-hmb="USR-HMB"]');
      const D = hrMbData();
      const me = D.rows.find(x => x.p.id === id) || {};
      hrMbSet('view', 'grid');
      await new Promise(r => setTimeout(r, 80));
      const grid = document.getElementById('hmbGrid');
      const cells = grid ? [...grid.querySelectorAll('tbody tr')[0].querySelectorAll('td.hmb-c')].map(c => c.textContent) : [];
      hrMbSet('q', 'nobody-like-this');
      await new Promise(r => setTimeout(r, 50));
      const empty = /Nobody matches/.test((document.getElementById('hrMonthBoard') || {}).textContent || '');
      window._hmb = null;
      return {row: !!row, working: D.working.length, expected: work.length, rows: D.rows.length,
        present: me.present, credit: me.credit, own: hrMonthDays(id, month).days, leave: me.leave, absent: me.absent, pct: me.pct, cells: cells.length, days: days.length,
        sundays: cells.filter(c => c === 'S').length, P: cells.filter(c => c === 'P').length, empty};
    });
    if(!r.row) throw new Error('the employee is not on the board: ' + JSON.stringify(r));
    if(r.working !== r.expected || r.rows !== 1) throw new Error(JSON.stringify(r));
    if(r.present !== 3 || r.leave !== 1 || r.absent !== r.working - 4) throw new Error('totals wrong: ' + JSON.stringify(r));
    if(r.credit !== r.own) throw new Error('days worked differ from the person\'s own page: ' + JSON.stringify(r));
    if(r.cells !== r.days || r.P !== 3 || r.sundays < 4) throw new Error('grid wrong: ' + JSON.stringify(r));
    if(!r.empty) throw new Error('search does not narrow the board');
    return r.working + ' working days; 3 present, 1 leave, ' + r.absent + ' absent, ' + r.pct + '%';
  });

  await t.step('somebody without HR access does not get the board', async () => {
    const r = await t.eval(async () => {
      const real = window.hrIsStaff;
      window.hrIsStaff = () => false;
      const html = hrMonthBoardHtml();
      window.hrIsStaff = real;
      return html;
    });
    if(r) throw new Error('drawn for a non-HR account');
    return 'not drawn';
  });

  await t.step('the leave application form is the firm’s Zoho form, and the approver sees it', async () => {
    const r = await t.eval(async () => {
      const u = me();
      if(!DB.team.some(x => x.id === 'USR-HMBA')) DB.team.push({id: 'USR-HMBA', name: 'ZZ Approver', email: 'appr@example.com', role: ADMIN_ROLE,
        status: 'Active', branch: u.branch, documents: [], notes: [], perms: fullPerms(true), adminFlags: fullAdminFlags(true)});
      u.parentUserId = 'USR-HMBA';
      if(!hrApproverFor(u.id)) return {noApprover: true};
      hrOpenLeaveRequest();
      const body = document.getElementById('modalBody').textContent;
      const missing = ['Name', 'First Name', 'Last Name', 'Email', 'Leave Type', 'Start Date', 'End Date', 'Duration',
        'Have you Delegate your Pending Task?', 'To Whom?', 'Delegated Person Email', 'Delegated Task #1', 'Delegated Task #2',
        'Delegated Task #3'].filter(x => body.indexOf(x) < 0);
      const g = id => document.getElementById(id);
      const types = [...g('f_hrReqType').options].map(o => o.value).filter(Boolean);
      const said = []; const al = window.alert; window.alert = m => said.push(String(m));
      g('f_hrReqType').value = 'Sick Leave'; g('f_hrReqDuration').value = 'Half Day (Second Half)';
      g('f_hrReqDelegated').value = 'Yes'; hrLeaveDelegateShow();
      const boxShown = g('hrReqDelegateBox').style.display !== 'none';
      g('f_hrReqHandover').value = 'USR-HMBA'; hrLeaveDelegateShow();
      const autofill = [g('f_hrReqDelFirst').value, g('f_hrReqDelLast').value, g('f_hrReqDelEmail').value];
      g('f_hrReqTask1').value = 'ZZ call Mr Gupta'; g('f_hrReqTask2').value = 'ZZ SIP form';
      g('f_hrReqReason').value = 'ZZ zoho form';
      await hrSubmitLeaveRequest();
      const refused = !(DB.hrLeave || []).some(l => l.reason === 'ZZ zoho form');
      g('f_hrReqTask3').value = 'ZZ review deck';
      await hrSubmitLeaveRequest();
      window.alert = al;
      const row = (DB.hrLeave || []).find(l => l.reason === 'ZZ zoho form') || {};
      return {missing, types, boxShown, autofill, refused, said,
        row: {type: row.type, unit: row.unit, session: row.session, to: row.handoverTo, email: row.delegateEmail, tasks: (row.delegatedTasks || []).length},
        extra: /ZZ review deck/.test(hrLeaveExtraHtml(row))};
    });
    t.dialogs.splice(0);
    if(r.noApprover) throw new Error('no approver for the test account');
    if(r.missing.length) throw new Error('the form is missing: ' + r.missing.join(', '));
    if(r.types[0] !== 'Sick Leave' || r.types[1] !== 'Casual Leave') throw new Error('leave types: ' + r.types.join(', '));
    if(!r.boxShown || r.autofill.join('|') !== 'ZZ|Approver|appr@example.com') throw new Error(JSON.stringify(r));
    if(!r.refused || !/Delegated Task #3/.test(r.said.join(' '))) throw new Error('a missing task was accepted: ' + r.said.join(' | '));
    if(r.row.type !== 'Sick Leave' || r.row.unit !== 'half' || r.row.session !== 'Second Half' || r.row.to !== 'USR-HMBA'
      || r.row.email !== 'appr@example.com' || r.row.tasks !== 3 || !r.extra) throw new Error(JSON.stringify(r.row));
    return 'every Zoho field asked, delegation required when Yes, stored and shown to the approver';
  });
});
