/* A C&T FORM WITH GOOD MOBILE NUMBERS GOES THROUGH.

   A client filled the C&T form with two people, each with a valid
   10-digit number, left the third row empty, pressed Submit and was told
   "Please enter a valid 10-digit mobile number." Nothing was saved.

   A number with a space after it (a phone adds one when it autofills),
   spaces inside it or +91 in front is still that ten-digit number, so it
   is taken and stored as ten digits. A number that is not ten digits is
   still refused, and the page now names the row. */
const {suite} = require('../lib/harness');
const ready = require('../lib/ready');

suite(async t => {
  let token = '';
  await t.step('a C&T link for a client', async () => {
    token = await t.eval(async ()=>{
      const c = {id:'CMS-ZZCT1', cmsName:'ZZ Ct Client', mobile:'9800000071', email:'zzct@zz.in',
        rmName: currentUser, branch:'Varanasi', createdAt:new Date().toISOString()};
      initState('CMS', c); DB.clients.push(c); await save('clients');
      const type = activeFormsInCategory('C&T')[0] || 'CT';
      return await createDocLink(c.id, type, {recordModule:'CMS', recordId:c.id});
    });
    if(!token) throw new Error('no link');
    return 'link made';
  });

  await t.step('two people with good numbers, third row empty: submitted', async () => {
    t.dialogs.length = 0;
    await t.page.goto(t.base + '/?doc=' + token, {waitUntil:'domcontentloaded'});
    await t.page.waitForSelector('#f_ct_references_r0_name', {timeout:15000});
    await t.page.evaluate(()=>{
      const set = (id, v)=>{ const el = document.getElementById(id); if(el){ el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); } };
      set('f_ct_date', new Date().toISOString().slice(0,10));
      const ta = document.getElementById('f_ct_testimonial'); if(ta) ta.value = 'ZZ good service';
      const yes = document.querySelector('input[name="f_ct_consent"][value="Yes"]') || document.querySelector('[id^="f_ct_consent"][value="Yes"]');
      if(yes) yes.checked = true;
      set('f_ct_references_r0_name', 'ZZ Tushar'); set('f_ct_references_r0_mobile', '8887982965 '); set('f_ct_references_r0_email', 'tushar@zz.in');
      set('f_ct_references_r1_name', 'ZZ Asfcd'); set('f_ct_references_r1_mobile', '+91 88879 82966'); set('f_ct_references_r1_email', 'abc@zz.in');
    });
    const btn = await t.page.$('button:has-text("Submit")');
    await btn.click();
    await t.page.waitForTimeout(3000);
    const text = await t.page.evaluate(()=>document.body.innerText.slice(0, 400));
    const bad = t.dialogs.find(d=>/could not be saved|valid 10-digit/i.test(d));
    if(bad) throw new Error('refused: ' + bad.replace(/\s+/g,' '));
    return 'submitted — ' + text.replace(/\s+/g,' ').slice(0, 60);
  });

  await t.step('the people named arrive as leads with ten-digit numbers', async () => {
    await t.page.goto(t.base + '/', {waitUntil:'domcontentloaded'});
    await ready(t.page);
    const got = await t.eval(()=>DB.leads.filter(l=>/^ZZ (Tushar|Asfcd)/.test(l.firstName+' '+l.lastName)).map(l=>l.mobile).sort());
    if(got.join(',') !== '8887982965,8887982966') throw new Error('the leads hold ' + JSON.stringify(got));
    return got.join(' · ');
  });

  await t.step('a number that is not ten digits is refused on the page, naming the row', async () => {
    const r = await t.eval(()=>{
      const f = {k:'ct_references', t:'table', rowLabel:'Person', cols:[{k:'name',l:'Name'},{k:'mobile',l:'Contact No.'}]};
      const vals = {ct_references:[{name:'A', mobile:'98765'}, {name:'B', mobile:'98765 43210'}]};
      const w = validationErrors([f], vals);
      return {w: w.map(x=>x.label + ': ' + x.message), second: vals.ct_references[1].mobile};
    });
    if(r.w.length !== 1 || !/Person 1, Contact No\./.test(r.w[0])) throw new Error(JSON.stringify(r));
    if(r.second !== '9876543210') throw new Error('the good number was kept as ' + r.second);
    return r.w[0];
  });
});
