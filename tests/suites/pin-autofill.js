/* A PIN FILLS THE COUNTRY, STATE AND CITY, WHEREVER IT IS TYPED.

   The firm asked that every form fill the country, state and city from
   the PIN, not only the two that were wired by hand. Here: the lead
   form, the client form, a form the firm built itself, and a client's
   own link. The PIN directory is a stub on the lookup port. */
const http = require('http');
const {suite} = require('../lib/harness');

const LOOKUP_PORT = Number(process.env.BOSS_PORT || 3000) + 252;
const lookups = http.createServer((req, res) => {
  const pin = /^\/pincode\/(\d{6})$/.exec(req.url);
  res.setHeader('Content-Type', 'application/json');
  if(pin && pin[1] === '560001') return res.end(JSON.stringify([{Status:'Success', PostOffice:[
    {Name:'Bangalore G.P.O.', District:'Bengaluru', State:'Karnataka', Country:'India'}]}]));
  res.end(JSON.stringify([{Status:'Error', Message:'No records found', PostOffice:null}]));
});

suite(async t => {
  await new Promise(r => lookups.listen(LOOKUP_PORT, '127.0.0.1', r));
  const type = async (sel, v) => {
    await t.page.fill(sel, '');
    await t.page.type(sel, v);
    await t.wait(900);
  };

  await t.step('the lead form: Zip Code fills City, State and Country', async () => {
    await t.eval(async ()=>{
      const l = {id:'LMS-ZZPIN', firstName:'ZZ Pin', lastName:'Lead', mobile:'9800000075', email:'zzpinl@zz.in',
        source:'Seminar', assignedTo: currentUser, createdAt:new Date().toISOString()};
      initState('LMS', l); DB.leads.push(l); await save('leads');
      closeModal(); openLeadForm(l.id);
    });
    await t.wait(300);
    await type('#f_zipCode', '560001');
    const r = await t.eval(()=>['city','state','country'].map(k=>(document.getElementById('f_'+k)||{}).value));
    if(r.join('|') !== 'Bengaluru|Karnataka|India') throw new Error('filled ' + JSON.stringify(r));
    return r.join(', ');
  });

  await t.step('the client form: Mailing Zip fills city, state and the new country box', async () => {
    await t.eval(()=>{ closeModal(); openClientForm(); });
    await t.wait(300);
    await type('#f_mailingZip', '560001');
    const r = await t.eval(()=>['mailingCity','mailingState','mailingCountry'].map(k=>(document.getElementById('f_'+k)||{}).value));
    if(r.join('|') !== 'Bengaluru|Karnataka|India') throw new Error('filled ' + JSON.stringify(r));
    return r.join(', ');
  });

  let token = '';
  await t.step('a form the firm built, on the client\'s own link', async () => {
    token = await t.eval(async ()=>{
      DB.config.customForms = DB.config.customForms || [];
      DB.config.customForms.push({id:'ZZPIN', name:'ZZ Address Form', category:'', module:'CMS', createdAt:new Date().toISOString()});
      DB.config.formTemplates = DB.config.formTemplates || {};
      DB.config.formTemplates['CUSTOM:ZZPIN'] = [
        {id:'FF1', k:'addr_pin', l:'PIN Code', t:'text'},
        {id:'FF2', k:'addr_city', l:'City', t:'text'},
        {id:'FF3', k:'addr_state', l:'State', t:'text'},
        {id:'FF4', k:'addr_country', l:'Country', t:'text'}];
      await save('config');
      const c = {id:'CMS-ZZPIN', cmsName:'ZZ Pin Client', mobile:'9800000074', email:'zzpin@zz.in',
        rmName: currentUser, branch:'Varanasi', createdAt:new Date().toISOString()};
      initState('CMS', c); DB.clients.push(c); await save('clients');
      return await createDocLink(c.id, 'CUSTOM:ZZPIN', {recordModule:'CMS', recordId:c.id});
    });
    await t.page.goto(t.base + '/?doc=' + token, {waitUntil:'domcontentloaded'});
    await t.page.waitForSelector('#f_addr_pin', {timeout:15000});
    await type('#f_addr_pin', '560001');
    const r = await t.page.evaluate(()=>['addr_city','addr_state','addr_country'].map(k=>(document.getElementById('f_'+k)||{}).value));
    if(r.join('|') !== 'Bengaluru|Karnataka|India') throw new Error('filled ' + JSON.stringify(r));
    return r.join(', ');
  });

  lookups.close();
});
