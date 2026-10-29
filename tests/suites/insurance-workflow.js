/* THE INSURANCE JOURNEY (CMS), AS THE FIRM'S SOP HAS IT.

   Walked end to end through the stage buttons' own boxes, with the suite's
   own mail server, so "emailed" means a letter arrived:
   1 intake, category, the company BEFORE the type, plan, and the benefit
     illustration emailed with the insurer's PDF attached; a revised one;
   2 proposal form submitted, the CIF requested (and the gate holding until
     it is back and validated), proposal updated and premium paid;
   3 pre-underwriting scrub, medical (tele / physical / home), underwriting
     sign-off with a loading;
   4 policy data entered with the number and two dates typed twice, the
     client emailed, original received and confirmed;
   5 renewals: the server emails from T-30 (once per step), the RM gets a
     follow-up task, a payment moves the due date on and sends a receipt.
   Also: a client on the old parked stage, under an edited journey, walks on. */
const {suite} = require('../lib/harness');

const waitForMail = async (t, re, ms) => {
  const until = Date.now() + (ms || 6000);
  while(Date.now() < until){
    const hit = t.mail.matching(re);
    if(hit.length) return hit[hit.length - 1];
    await t.wait(200);
  }
  return null;
};

suite({mail: true}, async t => {
  /* Press a step the way the stage does: open its box, fill it, save. */
  const step = async (id, fill, opts) => t.eval(async (a) => {
    const c = DB.clients.find(x => x.id === 'CMS-ZINW');
    const handler = STAGE_FORM_HANDLERS[a.id];
    const said = []; const al = window.alert; window.alert = m => said.push(String(m));
    try {
      if(handler === 'openInsuranceStepModal') {
        openInsuranceStepModal('CMS', c.id, a.id);
        await new Promise(r => setTimeout(r, 30));
        if(said.length) return {said};
        for(const [k, v] of Object.entries(a.fill || {})){
          const el = document.getElementById('f_' + k);
          if(!el) throw new Error('no box for ' + k + ' on ' + a.id);
          el.value = v; el.dispatchEvent(new Event('change', {bubbles: true}));
        }
        const box = document.getElementById('f_insMail');
        if(box) box.checked = !!a.opts.mail;
        if(a.opts.attach) composeAttachments.push({filename: a.opts.attach, contentType: 'application/pdf', content: btoa('%PDF-1.4 illustration')});
        await submitInsuranceStep(c.id, a.id);
      } else await doTransition('CMS', c.id, a.id);
    } finally { window.alert = al; }
    if(said.length) return {said};
    const r = DB.clients.find(x => x.id === 'CMS-ZINW');
    return {stage: stateOf('CMS', r), r: JSON.parse(JSON.stringify(r))};
  }, {id, fill, opts: opts || {}});

  await t.step('Insurance opens Phase 1, and the box asks for the company before the type', async () => {
    const r = await t.eval(async () => {
      const c = {id: 'CMS-ZINW', cmsName: 'ZZ Insured Walk', email: 'zzinw@example.com', mobile: '9800111333',
        createdAt: new Date().toISOString(), assignedTo: me().id, rmName: me().id};
      initState('CMS', c); DB.clients = DB.clients.filter(x => x.id !== c.id).concat([c]); await save('clients');
      await doTransition('CMS', c.id, 'toInsurance');
      navigate('cms', c.id); await new Promise(r => setTimeout(r, 150));
      const buttons = [...document.querySelectorAll('button')].map(b => b.textContent.trim());
      openInsuranceStepModal('CMS', c.id, 'insIllustrationSentT');
      const order = [...document.querySelectorAll('#insStepForm select, #insStepForm input')].map(x => x.id.replace('f_', ''));
      closeModal();
      return {st: stateOf('CMS', c), send: buttons.some(b => /Send Illustration to Client/.test(b)), back: buttons.some(b => /Change Product Category/.test(b)),
        company: order.indexOf('insCompany'), type: order.indexOf('insLifeType'), category: order.indexOf('insCategory')};
    });
    if(r.st !== 'insurancePending' || !r.send || !r.back) throw new Error(JSON.stringify(r));
    if(!(r.category < r.company && r.company < r.type)) throw new Error('order: ' + JSON.stringify(r));
    return 'Category → Company → Type; Send Illustration and Back offered';
  });

  await t.step('the illustration is emailed with the insurer’s PDF attached', async () => {
    const miss = await step('insIllustrationSentT', {insCategory: 'Life Insurance', insCompany: 'TATA', insPremium: '25000'});
    if(!miss.said || !/Life Plan Type/.test(miss.said[0]) || /General/.test(miss.said[0])) throw new Error(JSON.stringify(miss));
    await t.eval(() => closeModal());
    const r = await step('insIllustrationSentT', {insCategory: 'Life Insurance', insCompany: 'TATA', insLifeType: 'Term Insurance',
      insPlanName: 'Sampoorna Raksha', insSumAssured: '10000000', insPremium: '25000', insPremiumFrequency: 'Yearly', insRiders: 'Accidental death'},
      {mail: true, attach: 'illustration.pdf'});
    if(r.said) throw new Error(r.said.join(' | '));
    const m = await waitForMail(t, /Sampoorna Raksha/);
    if(r.stage !== 'insIllustration' || !m) throw new Error('stage ' + r.stage + ', mail ' + !!m);
    if(!/illustration\.pdf/.test(m.body)) throw new Error('the PDF was not attached');
    if(!/Accidental death/.test(m.text || m.body)) throw new Error('the riders are not in the letter');
    return 'stage moved; “' + m.subject + '” arrived with illustration.pdf';
  });

  await t.step('a revised illustration is emailed, then accepted', async () => {
    const a = await step('insIllustrationRevised', {insRevisionReason: 'Premium too high', insCompany: 'MAX', insPlanName: 'Smart Term', insPremium: '21000'}, {mail: true});
    const m = await waitForMail(t, /revised insurance illustration/i);
    if(a.stage !== 'insIllustration' || a.r.insIllustrations.length !== 2 || !m || !/Premium too high/.test(m.text || m.body)) throw new Error(JSON.stringify({s: a.stage, m: !!m}));
    const b = await step('insIllustrationAccepted');
    if(b.stage !== 'insProposal') throw new Error(b.stage);
    return 'v2 MAX › Smart Term emailed; accepted';
  });

  await t.step('proposal form, then the CIF gate holds until the CIF is back', async () => {
    const a = await step('insProposalSubmitted', {insProposalNo: 'PRP-123'});
    if(a.stage !== 'insCif') throw new Error(a.stage);
    const held = await step('insCifValidated');
    if(!held.said || !/has not come back/.test(held.said[0])) throw new Error('the gate did not hold: ' + JSON.stringify(held));
    const sent = await t.eval(async () => {
      const c = DB.clients.find(x => x.id === 'CMS-ZINW');
      const forms = activeFormsInCategory('CIF').filter(t => formQuestionCount(t));
      const al = window.alert, cf = window.confirm; window.alert = () => {}; window.confirm = () => true;
      openSendCifModal('CMS', c.id, 'insCifSend');
      if(forms.length) await submitSendCif('CMS', c.id, 'insCifSend'); else await new Promise(r => setTimeout(r, 100));
      window.alert = al; window.confirm = cf;
      return {forms: forms.length, stage: stateOf('CMS', c), asked: !!c.insCifRequestedAt, token: c.cifDocToken || ''};
    });
    if(sent.stage !== 'insCif' || !sent.asked) throw new Error(JSON.stringify(sent));
    const cif = sent.forms ? await waitForMail(t, /onboarding|CIF|Client Information/i) : true;
    await t.eval(async () => { window.confirm = () => true; await insRecordPaperCif('CMS-ZINW'); });
    const notOk = await step('insCifValidated', {insCifIncomeOk: 'No', insCifKycOk: 'Yes'});
    if(!notOk.said || !/cannot be completed/.test(notOk.said[0])) throw new Error('a CIF with income not matching went through');
    await t.eval(() => closeModal());
    const ok = await step('insCifValidated', {insCifIncomeOk: 'Yes', insCifKycOk: 'Yes'});
    if(ok.stage !== 'insDocsCheck') throw new Error(ok.stage);
    return 'gate held, CIF ' + (sent.forms ? 'emailed (' + (cif ? 'arrived' : 'not seen') + ')' : 'requested') + ', recorded, validated → Documents Verification';
  });

  await t.step('after the CIF: the documents checklist, then KYC Status, then the proposal update and premium', async () => {
    const r = await t.eval(async () => {
      const c = DB.clients.find(x => x.id === 'CMS-ZINW');
      navigate('cms', c.id); await new Promise(r => setTimeout(r, 150));
      const panel = !!document.querySelector('#insPanel') && /Name Verification|Documents Verification/.test(document.body.innerText);
      const said = []; const al = window.alert; window.alert = m => said.push(String(m));
      await doTransition('CMS', c.id, 'insDocsCheckedT');
      const held = stateOf('CMS', c);
      for(const i of docsVerifyItems()) await setDocsVerifyAnswer(c.id, i.id, 'v', 'Yes');
      await submitDocsVerify(c.id);
      await doTransition('CMS', c.id, 'insDocsCheckedT');
      const atKyc = stateOf('CMS', c);
      await doTransition('CMS', c.id, 'insKycRegistered');
      const task = !!(DB.tasks || []).find(x => x.clientId === c.id && x.taskType === 'Validate KYC' && x.overallStatus !== 'Completed');
      const kyc1 = c.kycStatus;
      await doTransition('CMS', c.id, 'insKycValidated');
      window.alert = al;
      const closed = (DB.tasks || []).find(x => x.clientId === c.id && x.taskType === 'Validate KYC').overallStatus;
      return {panel, held, said: said[0] || '', atKyc, task, kyc1, kyc: c.kycStatus, closed, stage: stateOf('CMS', c)};
    });
    if(!r.panel) throw new Error('the documents checklist is not on the stage');
    if(r.held !== 'insDocsCheck' || !/not been verified|submit the verification/.test(r.said)) throw new Error('the checklist gate did not hold: ' + JSON.stringify(r));
    if(r.atKyc !== 'insKyc' || !r.task || r.kyc1 !== 'Registered' || r.kyc !== 'Validated' || r.closed !== 'Completed' || r.stage !== 'insProposalUpdate') throw new Error(JSON.stringify(r));
    const paid = await step('insProposalDone', {insPaymentMode: 'UPI', insPaymentRef: 'UPI-9'});
    if(paid.stage !== 'insDocsVerification' || paid.r.insuranceStatus !== 'Applied') throw new Error(JSON.stringify(paid.r.insuranceStatus));
    return 'checklist held until submitted → KYC Registered (task) → Validated → proposal updated, premium paid, Applied';
  });

  await t.step('scrub, tele-medical, underwriting with a loading', async () => {
    const d = new Date(); d.setDate(d.getDate() + 3);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const a = await step('insDocsVerified', {insScrubDisclosureOk: 'Yes', insScrubDocsOk: 'Yes'});
    const b = await step('insMedicalYes', {insMedicalType: 'Tele-medical', insMedicalDate: key});
    const c = await step('insMedicalDone', {insMedicalReportsUploaded: 'Yes'});
    const e = await step('insUwMore', {insUwNote: 'Loading of 25% for BMI'});
    const f = await step('insUwApproved', {insUwOutcome: 'Accepted with loading', insUwTerms: '25% extra premium'});
    const path = [a, b, c, e, f].map(x => x.stage || JSON.stringify(x.said)).join(' → ');
    if(path !== 'insMedical → insMedicalCheckup → insUnderwriting → insUnderwriting → insPolicyIssuance') throw new Error(path);
    return path;
  });

  await t.step('policy data: the number and dates must be typed twice; the client is emailed', async () => {
    const base = {insPolicyNo: 'POL-777', insCommencementDate: '2026-01-15', insCommencementCheck: '2026-01-15', insPremium: '26250',
      insPremiumFrequency: 'Yearly', insFinalPremiumDate: '2045-01-15', insFinalPremiumCheck: '2045-01-15', insMaturityDate: '2066-01-15',
      insNomineeName: 'Asha Walk', insNomineeRelation: 'Spouse'};
    const bad = await step('insPolicyEntered', Object.assign({}, base, {insPolicyNoCheck: 'POL-771'}));
    if(!bad.said || !/do not match/.test(bad.said[0])) throw new Error('a mistyped policy number went through');
    await t.eval(() => closeModal());
    const r = await step('insPolicyEntered', Object.assign({}, base, {insPolicyNoCheck: 'POL-777'}), {mail: true});
    const m = await waitForMail(t, /POL-777 has been issued/);
    if(r.stage !== 'insPolicyDelivery' || r.r.insNextDueDate !== '2027-01-15' || r.r.insPolicyNoCheck || !m) throw new Error(JSON.stringify({s: r.stage, d: r.r.insNextDueDate, m: !!m}));
    if(!/Asha Walk/.test(m.text || m.body)) throw new Error('the nominee is not in the letter');
    return 'mismatch refused; next premium ' + r.r.insNextDueDate + '; “' + m.subject + '”';
  });

  await t.step('original received and confirmed: in force, RM follow-up 30 days before', async () => {
    const r = await step('insPolicyConfirmed');
    const task = await t.eval(() => (DB.tasks || []).find(x => x.clientId === 'CMS-ZINW' && x.taskType === INS_RENEWAL_TASK && x.overallStatus !== 'Completed'));
    if(r.stage !== 'insActive' || r.r.insuranceStatus !== 'Active' || !task) throw new Error(JSON.stringify({s: r.stage, st: r.r.insuranceStatus, task}));
    return 'Active; follow-up due ' + task.dueDate;
  });

  await t.step('the server emails the renewal reminder at T-30, once, and again at T-7', async () => {
    const run = async (at) => t.eval(async (at) => {
      const res = await fetch('/api/reminders/run', {method: 'POST', headers: Object.assign({'Content-Type': 'application/json'}, apiHeaders()),
        body: JSON.stringify({at})});
      return (await res.json()).log.filter(x => x.kind === 'insurance-renewal');
    }, at);
    const due = '2027-01-15';
    const first = await run('2026-12-16T10:30:00Z');
    const again = await run('2026-12-16T15:00:00Z');
    const m = await waitForMail(t, /Premium due on 15 Jan 2027/);
    const later = await run('2027-01-08T10:30:00Z');
    const early = await run('2026-12-16T09:00:00Z');
    const back = await t.eval(async () => {
      DB.clients = await sget('clients'); DB.communications = await sget('communications');
      const c = DB.clients.find(x => x.id === 'CMS-ZINW');
      return {hist: (c.insHistory || []).filter(h => h.step === 'insRenewalAuto').map(h => h.label),
        comm: (DB.communications || []).filter(x => x.clientId === 'CMS-ZINW' && /Renewal Reminder/.test(x.label || '')).length};
    });
    if(first.length !== 1 || !first[0].ok || again.length !== 1) throw new Error(JSON.stringify({first, again}));
    if(!m || m.to.indexOf('zzinw@example.com') < 0) throw new Error('no reminder arrived');
    if(later.length !== 2 || later[1].step !== 7 || early.length !== 2) throw new Error(JSON.stringify(later));
    if(back.hist.length !== 2 || back.comm !== 2) throw new Error(JSON.stringify(back));
    return '“' + m.subject + '”; ' + back.hist.join(', ') + '; on Sent Mail twice';
  });

  await t.step('a payment moves the due date a year on, records the fund value and emails a receipt', async () => {
    const b = await step('insRenewalPaid', {insRenewalPaidOn: '2027-01-10', insRenewalAmount: '26250', insRenewalReceiptRef: 'RCPT-1', insFundValue: '30000'}, {mail: true});
    const m = await waitForMail(t, /Premium received — policy POL-777/);
    const tasks = await t.eval(() => (DB.tasks || []).filter(x => x.clientId === 'CMS-ZINW' && x.taskType === INS_RENEWAL_TASK).map(x => x.overallStatus + ':' + x.dueDate));
    if(b.stage !== 'insActive' || b.r.insNextDueDate !== '2028-01-15' || b.r.insFundValue !== '30000' && b.r.insFundValue !== 30000) throw new Error(JSON.stringify(b.r.insNextDueDate));
    if(!m || !/RCPT-1/.test(m.text || m.body)) throw new Error('no receipt letter');
    if(tasks.length !== 2 || !/^Completed/.test(tasks[0])) throw new Error(tasks.join(', '));
    return 'next due ' + b.r.insNextDueDate + '; “' + m.subject + '”; tasks ' + tasks.join(', ');
  });

  await t.step('the policy closes, and a new application can start on the same client', async () => {
    const a = await step('insPolicyEnded', {insClosureReason: 'Surrendered'});
    const b = await step('insReopen');
    if(a.stage !== 'insClosed' || a.r.insuranceStatus !== 'Expired') throw new Error(JSON.stringify(a.r.insuranceStatus));
    if(b.stage !== 'insurancePending' || b.r.insPolicyNo || (b.r.insPastPolicies || []).length !== 1) throw new Error(JSON.stringify(b.r));
    return 'closed (Surrendered); reopened with POL-777 kept as a past policy';
  });

  await t.step('a client on the old parked stage, under an edited journey, walks on', async () => {
    const r = await t.eval(async () => {
      const old = JSON.parse(JSON.stringify(BLUEPRINTS.CMS));
      old.states = old.states.filter(s => !/^ins[A-Z]/.test(s.id));
      old.states.find(s => s.id === 'insurancePending').label = 'Insurance — Workflow Not Yet Defined (Pending)';
      old.states.find(s => s.id === 'insurancePending').terminal = true;
      old.transitions = old.transitions.filter(x => !/^ins[A-Z]/.test(x.id));
      DB.config.blueprints = DB.config.blueprints || {};
      const keep = DB.config.blueprints.CMS;
      DB.config.blueprints.CMS = old;
      const bp = getBlueprint('CMS');
      const out = {label: stateLabel('CMS', 'insurancePending'), terminal: !!stateMeta('CMS', 'insurancePending').terminal,
        states: bp.states.filter(s => /^ins[A-Z]/.test(s.id)).length, steps: bp.transitions.filter(x => x.from === 'insCif').map(x => x.id)};
      DB.config.blueprints.CMS = keep;
      return out;
    });
    if(r.terminal || r.states !== 14 || r.steps.indexOf('insCifValidated') < 0) throw new Error(JSON.stringify(r));
    return r.label + ', ' + r.states + ' stages added';
  });

  await t.step('the five letters are in Setup, editable', async () => {
    const r = await t.eval(() => ['insIllustration', 'insIllustrationRevised', 'insPolicyIssued', 'insRenewalReminder', 'insRenewalReceived']
      .map(k => !!mailTemplateMeta(k) && !!mailTemplateOf(k).subject));
    if(!r.every(Boolean)) throw new Error(JSON.stringify(r));
    return 'all five listed under Insurance';
  });
});
