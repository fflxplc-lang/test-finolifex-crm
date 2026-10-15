/* A YEAR IS FOUR DIGITS, AND IT IS ONE RULE.

   "26" typed into a date of birth is the year 26. The box takes it, the
   save takes it, and from then on every age, ageing report, reminder
   and renewal worked out from that record is wrong — quietly, until
   somebody checks. A spreadsheet is worse: new Date('12/05/26') is a
   real date, so two thousand rows of it import clean and nobody sees a
   thing.

   So there is one rule, written once: a year is between 1900 and 3000.
   Wide at the top on purpose — a follow-up, a meeting, a review due
   date and a goal twenty years out are all meant to be in the future,
   and capping those at this year would stop the work rather than catch
   the typo.

   What this holds to: that the rule is one function and not fifteen;
   that every date box in the system carries it, on every screen and in
   every dialog, including boxes nobody wrote it on; that a form save
   refuses a bad year even when the value never went through a box;
   that an import refuses to guess the century of a two-digit year and
   says so on the row; that the connectors cannot walk one in either;
   and that dates already on file, and the dates people actually type,
   are untouched. */
const {suite} = require('../lib/harness');

const VIEWS = ['dashboard','lms','cms','rms','dst','meetings','calls','arc','business',
  'transactions','projects','teammembers','profile','reports'];

const FEED = `async (srcId, rows) => {
  window._mapImpSrc = srcId;
  const bytes = xlsxWrite([{name:'Sheet1', rows}]);
  const file = new File([bytes], 'sheet.xlsx',
    {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const inp = document.createElement('input');
  Object.defineProperty(inp, 'files', {value: [file]});
  await mapImpPick(inp);
  return mapImpBuild();
}`;

suite(async t => {
  await t.home();

  t.section('one rule');

  await t.step('the range is 1900 to 3000, and it is one function', async () => {
    const r = await t.eval(()=>{
      const cases = [
        ['1900-01-01', true], ['3000-12-31', true], ['2026-10-14', true],
        ['1975-06-01', true], ['2045-03-20', true],      // a goal twenty years out is fine
        ['', true], [null, true], [undefined, true],     // empty is not invalid; req is a separate rule
        ['0026-05-12', false], ['0001-01-01', false], ['1899-12-31', false],
        ['3001-01-01', false], ['9999-09-09', false],
        ['12/05/26', false], ['not a date', false],
      ];
      return {min: DATE_YEAR_MIN, max: DATE_YEAR_MAX,
        wrong: cases.filter(c=>dateInRange(c[0]) !== c[1]).map(c=>String(c[0])),
        /* and it says why, in words somebody can act on */
        says: dateRangeProblem('Date of Birth', '0026-05-12'),
        saysJunk: dateRangeProblem('Date of Birth', 'tomorrow'),
        silent: dateRangeProblem('Date of Birth', '1975-06-01')};
    });
    if(r.min !== 1900 || r.max !== 3000) throw new Error('the range is ' + r.min + '–' + r.max);
    if(r.wrong.length) throw new Error('judged wrongly: ' + r.wrong.join(', '));
    if(!/four digits/.test(r.says) || !/26/.test(r.says))
      throw new Error('the message does not explain itself: ' + r.says);
    if(!/not a date BOSS can read/.test(r.saysJunk))
      throw new Error('junk is not explained: ' + r.saysJunk);
    if(r.silent) throw new Error('a good date was refused: ' + r.silent);
    return '1900–3000, empty allowed, and a refusal that says "' + r.says.slice(0, 60) + '…"';
  });

  t.section('every box, on every screen');

  await t.step('each date input carries the bounds, on all ' + VIEWS.length + ' screens', async () => {
    const r = await t.eval(async (views)=>{
      const bad = [], seen = {};
      for(const v of views){
        navigate(v);
        await new Promise(res=>setTimeout(res, 20));
        const boxes = document.querySelectorAll('#content input[type="date"]');
        seen[v] = boxes.length;
        boxes.forEach(el=>{
          if(el.getAttribute('min') !== DATE_BOUND_MIN || el.getAttribute('max') !== DATE_BOUND_MAX)
            bad.push(v + ': ' + (el.id || el.className || 'a box') + ' min=' + el.getAttribute('min')
              + ' max=' + el.getAttribute('max'));
        });
      }
      navigate('dashboard');
      return {bad, total: Object.values(seen).reduce((a, b)=>a + b, 0), seen};
    }, VIEWS);
    if(r.bad.length) throw new Error('unbounded: ' + r.bad.slice(0, 4).join(' | '));
    if(r.total < 6) throw new Error('only ' + r.total + ' date boxes were drawn — nothing was checked');
    return r.total + ' date box(es) across the screens, every one of them 1900–3000';
  });

  await t.step('and so does one in a dialog, and one drawn after the paint', async () => {
    const r = await t.eval(()=>{
      openModal('ZZ', '<div class="field"><label>When</label><input type="date" id="f_zzWhen"></div>', '');
      const inModal = document.getElementById('f_zzWhen');
      const modal = {min: inModal.getAttribute('min'), max: inModal.getAttribute('max')};
      closeModal();
      /* a box put on the page by a partial redraw, which no paint pass saw */
      const box = document.createElement('div');
      box.innerHTML = '<input type="date" id="f_zzLate">';
      document.body.appendChild(box);
      const late = document.getElementById('f_zzLate');
      const before = {min: late.getAttribute('min')};
      late.dispatchEvent(new FocusEvent('focusin', {bubbles: true}));
      const after = {min: late.getAttribute('min'), max: late.getAttribute('max')};
      box.remove();
      return {modal, before, after,
        /* and the field renderer writes them into the markup itself */
        markup: fieldInput({k:'zzMarkup', l:'When', t:'date'}, '')};
    });
    if(r.modal.min !== '1900-01-01' || r.modal.max !== '3000-12-31')
      throw new Error('a dialog box is unbounded: ' + JSON.stringify(r.modal));
    if(r.before.min) throw new Error('the fixture was already bounded, so nothing was proved');
    if(r.after.min !== '1900-01-01' || r.after.max !== '3000-12-31')
      throw new Error('a late box stayed unbounded: ' + JSON.stringify(r.after));
    if(!/min="1900-01-01"/.test(r.markup) || !/max="3000-12-31"/.test(r.markup))
      throw new Error('the field renderer leaves them out: ' + r.markup);
    return 'the dialog, the late box and the field renderer all carry 1900–3000';
  });

  t.section('typing one in');

  await t.step('a year of 26 is refused at the box and not kept', async () => {
    const r = await t.eval(()=>{
      openModal('ZZ', '<div class="field"><label>Date of Birth</label><input type="date" id="f_zzDob"></div>', '');
      const el = document.getElementById('f_zzDob');
      el.value = '0026-05-12';
      el.dispatchEvent(new Event('change', {bubbles: true}));
      const after = {value: el.value,
        said: (el.closest('.field').querySelector('.field-error') || {}).textContent || '',
        marked: el.classList.contains('is-invalid')};
      /* and a good one is left exactly as typed */
      el.value = '1975-06-01';
      el.dispatchEvent(new Event('change', {bubbles: true}));
      const good = {value: el.value,
        said: (el.closest('.field').querySelector('.field-error') || {}).textContent || ''};
      closeModal();
      return {after, good};
    });
    if(r.after.value) throw new Error('the bad year is still in the box: ' + r.after.value);
    if(!/four digits/.test(r.after.said)) throw new Error('it did not say why: ' + r.after.said);
    if(!r.after.marked) throw new Error('the box is not marked');
    if(r.good.value !== '1975-06-01') throw new Error('a good date was cleared: ' + r.good.value);
    if(r.good.said) throw new Error('a good date was complained about: ' + r.good.said);
    return 'the box empties itself and says why; 1975-06-01 goes in untouched';
  });

  await t.step('and a form save refuses one that never went through a box', async () => {
    const r = await t.eval(()=>{
      const fields = [{k:'zzName', l:'Name', t:'text', req:1}, {k:'zzDob', l:'Date of Birth', t:'date'}];
      return {
        bad:  validateRequired(fields, {zzName:'A', zzDob:'0026-05-12'}),
        far:  validateRequired(fields, {zzName:'A', zzDob:'3500-01-01'}),
        old:  validateRequired(fields, {zzName:'A', zzDob:'1899-12-31'}),
        good: validateRequired(fields, {zzName:'A', zzDob:'1975-06-01'}),
        future: validateRequired(fields, {zzName:'A', zzDob:'2045-03-20'}),
        empty: validateRequired(fields, {zzName:'A', zzDob:''}),
      };
    });
    if(r.bad || r.far || r.old) throw new Error('a save took a bad year');
    if(!r.good || !r.empty) throw new Error('a save refused a good date or an empty one');
    if(!r.future) throw new Error('a save refused a future date — follow-ups and goals would be dead');
    if(!t.dialogs.some(d=>/four digits/.test(String(d))))
      throw new Error('the save said nothing: ' + t.dialogs.join(' | ').slice(0, 120));
    return 'the three bad years refused with the reason; 1975, 2045 and empty all saved';
  });

  t.section('a spreadsheet full of them');

  await t.step('a two-digit year fails the row rather than being guessed at', async () => {
    const r = await t.eval(async (a)=>{
      const build = await eval('(' + a.FEED + ')')('leads', [
        ['Lead Name', 'Mobile', 'Date of Birth'],
        ['ZZ Good Year', '9800000001', '1975-06-01'],
        ['ZZ Two Digits', '9800000002', '12/05/26'],
        ['ZZ Ancient', '9800000003', '1800-01-01'],
        ['ZZ Far Off', '9800000004', '3500-01-01'],
      ]);
      /* keyed on the mobile, because that is the column the leads source
         actually owns — the name on this sheet maps to nothing */
      const names = {'9800000001':'ZZ Good Year', '9800000002':'ZZ Two Digits',
                     '9800000003':'ZZ Ancient', '9800000004':'ZZ Far Off'};
      const by = {};
      (build.rows || []).forEach(r=>{
        by[names[(r.rec && r.rec.mobile) || ''] || '?'] = {verdict: r.verdict, note: r.note, dob: r.rec && r.rec.dob};
      });
      return {by, mapped: mapImp && mapImp.map};
    }, {FEED});
    const g = r.by['ZZ Good Year'], two = r.by['ZZ Two Digits'],
          old = r.by['ZZ Ancient'], far = r.by['ZZ Far Off'];
    if(!g || g.verdict === 'fail') throw new Error('a four-digit year was refused: ' + (g && g.note));
    if(!two || two.verdict !== 'fail') throw new Error('12/05/26 was imported, not refused');
    if(!/two digits/.test(two.note) || !/century/.test(two.note))
      throw new Error('it did not say why: ' + two.note);
    if(!old || old.verdict !== 'fail') throw new Error('the year 1800 was imported');
    if(!far || far.verdict !== 'fail') throw new Error('the year 3500 was imported');
    if(!/1900/.test(old.note)) throw new Error('the 1800 row did not name the range: ' + old.note);
    if(two.dob !== '12/05/26') throw new Error('the two-digit year was rewritten to ' + two.dob);
    if(g.dob !== '1975-06-01') throw new Error('a good date was rewritten to ' + g.dob);
    return 'four rows: 1975 in, "12/05/26" refused as a two-digit year, 1800 and 3500 refused by range';
  });

  t.section('the other doors, and what must not change');

  await t.step('a connector cannot walk one in either', async () => {
    const r = await t.eval(()=>({
      good: apiTransform('isoDate', '1975-06-01'),
      dmy:  apiTransform('isoDate', '01/06/1975'),
      far:  apiTransform('isoDate', '3500-01-01'),
      old:  apiTransform('isoDate', '1700-01-01'),
    }));
    if(r.good !== '1975-06-01') throw new Error('a good ISO date came back ' + r.good);
    if(r.dmy !== '1975-06-01') throw new Error('day-first reading changed: ' + r.dmy);
    if(r.far || r.old) throw new Error('an out-of-range year came through a connector: ' + r.far + ' / ' + r.old);
    return 'the connector keeps its day-first reading and drops a year outside the range';
  });

  await t.step('every configured format writes four digits, and existing dates are untouched', async () => {
    const r = await t.eval(async ()=>{
      const was = DB.settings['general.dateFormat'];
      const out = {};
      for(const f of ['DD Mon YYYY','DD/MM/YYYY','MM/DD/YYYY','YYYY-MM-DD']){
        DB.settings['general.dateFormat'] = {value: f};
        out[f] = fmtDate('1975-06-01');
      }
      if(was === undefined) delete DB.settings['general.dateFormat'];
      else DB.settings['general.dateFormat'] = was;
      /* and a record that already holds a date keeps it, to the character */
      const l = {id:uid('LEAD'), leadName:'ZZ Old Date', mobile:'9800000009', dob:'1975-06-01',
        createdAt:new Date().toISOString()};
      initState('LMS', l); DB.leads.push(l); await save('leads');
      const back = (await sget('leads') || []).find(x=>x.id === l.id) || {};
      return {out, stored: back.dob};
    });
    const bad = Object.entries(r.out).filter(([, v])=>!/\b1975\b/.test(v) || /\b75\b/.test(v.replace('1975','')));
    if(bad.length) throw new Error('no four-digit year in: ' + bad.map(x=>x[0] + ' → ' + x[1]).join(', '));
    if(new Set(Object.values(r.out)).size < 4)
      throw new Error('the four formats did not actually differ: ' + JSON.stringify(r.out));
    if(r.stored !== '1975-06-01') throw new Error('an existing date was rewritten to ' + r.stored);
    return Object.values(r.out).join(' · ') + ' — and 1975-06-01 is still 1975-06-01 on the server';
  });
});
