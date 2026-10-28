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
        present: me.present, leave: me.leave, absent: me.absent, pct: me.pct, cells: cells.length, days: days.length,
        sundays: cells.filter(c => c === 'S').length, P: cells.filter(c => c === 'P').length, empty};
    });
    if(!r.row) throw new Error('the employee is not on the board: ' + JSON.stringify(r));
    if(r.working !== r.expected || r.rows !== 1) throw new Error(JSON.stringify(r));
    if(r.present !== 3 || r.leave !== 1 || r.absent !== r.working - 4) throw new Error('totals wrong: ' + JSON.stringify(r));
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

  await t.step('the leave application form asks what the Zoho form asked, and the approver sees it', async () => {
    const r = await t.eval(async () => {
      const u = me();
      if(!DB.team.some(x => x.id === 'USR-HMBA')) DB.team.push({id: 'USR-HMBA', name: 'ZZ Approver', email: 'appr@example.com', role: ADMIN_ROLE,
        status: 'Active', branch: u.branch, documents: [], notes: [], perms: fullPerms(true), adminFlags: fullAdminFlags(true)});
      u.parentUserId = 'USR-HMBA';
      if(!hrApproverFor(u.id)) return {noApprover: true};
      hrOpenLeaveRequest();
      const body = document.getElementById('modalBody').textContent;
      const has = ['Employee details', 'Employee ID', 'Department', 'Reporting manager', 'Number of days',
        'Contact number during leave', 'Work handed over to', 'Address during leave', 'Supporting document'].filter(x => body.indexOf(x) < 0);
      const g = id => document.getElementById(id);
      g('f_hrReqType').value = 'Half Day'; g('f_hrReqType').dispatchEvent(new Event('change'));
      const sessionShown = g('hrReqSessionWrap').style.display !== 'none';
      const daysShown = g('f_hrReqDays').value;
      g('f_hrReqReason').value = 'ZZ zoho form';
      g('f_hrReqContact').value = '12345';
      await hrSubmitLeaveRequest();
      const refused = !(DB.hrLeave || []).some(l => l.reason === 'ZZ zoho form');
      g('f_hrReqSession').value = 'Second Half'; g('f_hrReqContact').value = '9876543210'; g('f_hrReqDeclare').checked = true;
      g('f_hrReqAddress').value = 'ZZ address';
      await hrSubmitLeaveRequest();
      const row = (DB.hrLeave || []).find(l => l.reason === 'ZZ zoho form') || {};
      return {missing: has, sessionShown, daysShown, refused, row: {session: row.session, contact: row.contactNumber,
        addr: row.addressDuringLeave, emp: (row.employee || {}).employeeId}, extra: /ZZ address/.test(hrLeaveExtraHtml(row))};
    });
    const said = t.dialogs.splice(0);
    if(r.noApprover) throw new Error('no approver for the test account');
    if(!r.missing) throw new Error(JSON.stringify(r) + ' ' + said.join(' | '));
    if(r.missing.length) throw new Error('the form is missing: ' + r.missing.join(', '));
    if(!r.sessionShown || r.daysShown !== '½ day') throw new Error(JSON.stringify(r));
    if(!r.refused) throw new Error('a bad contact number was accepted');
    if(r.row.session !== 'Second Half' || r.row.contact !== '9876543210' || r.row.addr !== 'ZZ address' || !r.row.emp || !r.extra)
      throw new Error(JSON.stringify(r.row));
    return 'all fields asked, stored and shown to the approver';
  });
});
