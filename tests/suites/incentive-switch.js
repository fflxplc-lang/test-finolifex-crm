/* A PERSON MOVED ONTO THE GRID WITH A DRAFT ALREADY OPEN.

   A draft opened while somebody was non-sales kept that method after
   they were set to Sales, and the page — drawing them as Sales — read
   grid figures off a task-bank result and fell over: Incentive
   Management went blank. A draft now follows the person as they are;
   a finalised month keeps the method it was signed off on. And a task
   whose "equals" box was left empty no longer matches only records with
   an empty field. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.step('a non-sales draft, then the person set to Sales: the page draws the grid', async () => {
    const r = await t.eval(async () => {
      const id = 'USR-INCSW';
      DB.team = DB.team.filter(x => x.id !== id).concat([{id, name: 'ZZ Switch', email: 'sw@example.com', role: defaultRole(),
        status: 'Active', branch: 'Varanasi', incentiveCtc: 480000, documents: [], notes: [], perms: {}, adminFlags: {}}]);
      DB.config.incentive = Object.assign({}, DB.config.incentive, {salesRoles: [], salesDepartments: []});
      await save('team'); await save('config');
      const month = incMonthKey();
      DB.hrIncentives = (DB.hrIncentives || []).filter(x => x.userId !== id);
      await incOpenSheet(id, month);
      const sheet = incSheetFor(id, month);
      const before = sheet.kind;
      DB.team.find(x => x.id === id).incentiveCategory = 'sales';
      await save('team');
      window._incWho = id;
      let html = '', err = '';
      try { html = viewHrIncentive(); } catch(e){ err = e.message; }
      navigate('hrincentive');
      await new Promise(r => setTimeout(r, 150));
      return {before, err, grid: /qualifier baseline/i.test(html), drawn: (document.getElementById('root').textContent || '').length,
        result: !!(incResultOf(sheet) || {}).streams};
    });
    if(r.err) throw new Error('the page threw: ' + r.err);
    if(r.before !== 'nonSales' || !r.grid || !r.result) throw new Error(JSON.stringify(r));
    if(r.drawn < 500) throw new Error('the page is blank');
    return 'drafted as non-sales, now drawn on the grid';
  });

  await t.step('an empty "equals" on a task means no filter', async () => {
    const r = await t.eval(async () => {
      const id = 'USR-INCSW';
      DB.team.find(x => x.id === id).incentiveCategory = 'nonSales';
      DB.config.incentive = Object.assign({}, DB.config.incentive, {pointValue: 50,
        tasks: [{id: 'IT-SW', name: 'ZZ leads', source: 'leads', matchField: 'rmName', matchValue: '', points: 2, cap: 0, active: true, roles: [], departments: []}]});
      const pts = incTaskPoints(id, incMonthKey());
      return {rows: pts.rows.length, rate: pts.rate};
    });
    if(r.rows !== 1) throw new Error(JSON.stringify(r));
    return 'the task applies; ' + r.rate + ' a point';
  });
});
