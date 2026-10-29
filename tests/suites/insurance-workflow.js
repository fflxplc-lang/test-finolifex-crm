/* THE INSURANCE JOURNEY (CMS).

   The firm's Insurance Agency Process Flow, walked end to end through the
   stage buttons' own boxes: category → type → company → plan, the
   illustration (and a revised one), proposal and premium, documents
   (one asked for again), medical, underwriting, the policy entered, the
   original and the client's confirmation, and renewals — the next due
   date moving on with each payment and a follow-up raised 30 days ahead.
   Also: a client already parked on the old "Workflow Not Yet Defined"
   stage, under a firm's edited copy of the journey, is not stranded. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.home();

  /* Press a step the way the stage does: open its box, fill it, save. */
  const step = async (id, fill) => t.eval(async (a) => {
    const c = DB.clients.find(x => x.id === 'CMS-ZINW');
    const handler = STAGE_FORM_HANDLERS[a.id];
    if(handler) {
      window[handler]('CMS', c.id, a.id);
      await new Promise(r => setTimeout(r, 30));
      for(const [k, v] of Object.entries(a.fill || {})){
        const el = document.getElementById('f_' + k);
        if(!el) throw new Error('no box for ' + k + ' on ' + a.id);
        el.value = v; el.dispatchEvent(new Event('change', {bubbles: true}));
      }
      const said = []; const al = window.alert; window.alert = m => said.push(String(m));
      await submitInsuranceStep(c.id, a.id);
      window.alert = al;
      if(said.length) return {said};
    } else await doTransition('CMS', c.id, a.id);
    const r = DB.clients.find(x => x.id === 'CMS-ZINW');
    return {stage: stateOf('CMS', r), r: JSON.parse(JSON.stringify(r))};
  }, {id, fill});

  await t.step('Insurance opens Phase 1 instead of a dead end', async () => {
    const r = await t.eval(async () => {
      const c = {id: 'CMS-ZINW', cmsName: 'ZZ Insured Walk', email: 'zzinw@example.com', mobile: '9800111333',
        createdAt: new Date().toISOString(), assignedTo: me().id, rmName: me().id};
      initState('CMS', c); DB.clients = DB.clients.filter(x => x.id !== c.id).concat([c]); await save('clients');
      await doTransition('CMS', c.id, 'toInsurance');
      const st = stateOf('CMS', c);
      navigate('cms', c.id); await new Promise(r => setTimeout(r, 150));
      const buttons = [...document.querySelectorAll('button')].map(b => b.textContent.trim());
      return {st, terminal: !!stateMeta('CMS', st).terminal, label: stateLabel('CMS', st), status: c.insuranceStatus,
        send: buttons.some(b => /Send Illustration to Client/.test(b)), back: buttons.some(b => /Change Product Category/.test(b)),
        panel: !!document.getElementById('insPanel')};
    });
    if(r.st !== 'insurancePending' || r.terminal || !r.send || !r.back || !r.panel) throw new Error(JSON.stringify(r));
    return r.label + ' — Send Illustration and Back offered';
  });

  await t.step('the illustration needs the category, type, company and plan; hidden choices are not asked', async () => {
    const miss = await step('insIllustrationSentT', {insCategory: 'Life Insurance', insCompany: 'TATA', insPremium: '25000'});
    if(!miss.said || !/Life Plan Type/.test(miss.said[0]) || /General/.test(miss.said[0]) || !/Plan \/ Product Name/.test(miss.said[0]))
      throw new Error('asked: ' + JSON.stringify(miss.said));
    await t.eval(() => closeModal());
    const r = await step('insIllustrationSentT', {insCategory: 'Life Insurance', insLifeType: 'Term Insurance', insCompany: 'TATA',
      insPlanName: 'Sampoorna Raksha', insSumAssured: '10000000', insPremium: '25000', insPremiumFrequency: 'Yearly', insIllustrationVia: 'Email'});
    if(r.stage !== 'insIllustration' || r.r.insIllustrations.length !== 1 || r.r.insGeneralCategory) throw new Error(JSON.stringify(r));
    return 'refused first (' + miss.said[0].slice(0, 70) + '…); then sent: ' + r.r.insIllustrations[0].plan;
  });

  await t.step('not accepted: a revised illustration, then accepted', async () => {
    const a = await step('insIllustrationRevised', {insRevisionReason: 'Premium too high', insCompany: 'MAX', insPlanName: 'Smart Term', insPremium: '21000'});
    if(a.stage !== 'insIllustration' || a.r.insIllustrations.length !== 2 || a.r.insRevisionReason) throw new Error(JSON.stringify(a));
    const b = await step('insIllustrationAccepted');
    if(b.stage !== 'insProposal') throw new Error(b.stage);
    return 'v2 ' + a.r.insIllustrations[1].plan + ' (asked: ' + a.r.insIllustrations[1].reason + '), accepted';
  });

  await t.step('proposal and premium, documents asked for once, then verified', async () => {
    const a = await step('insProposalDone', {insProposalNo: 'PRP-123', insPaymentMode: 'UPI', insPaymentRef: 'UPI-9'});
    if(a.stage !== 'insDocsVerification' || a.r.insuranceStatus !== 'Applied') throw new Error(JSON.stringify(a));
    const b = await step('insDocsMissing', {insDocsNote: 'Income proof missing'});
    const task = await t.eval(() => (DB.tasks || []).find(x => x.clientId === 'CMS-ZINW' && x.taskType === 'Collect Missing Insurance Documents'));
    const c = await step('insDocsVerified');
    const done = await t.eval(() => (DB.tasks || []).find(x => x.clientId === 'CMS-ZINW' && x.taskType === 'Collect Missing Insurance Documents').overallStatus);
    if(b.stage !== 'insDocsVerification' || c.stage !== 'insMedical' || !task || done !== 'Completed') throw new Error(JSON.stringify({b: b.stage, c: c.stage, task, done}));
    return 'Applied; missing-documents task raised and closed on verification';
  });

  await t.step('medical required: checkup, a pending requirement, completed; underwriting asks more, then approves', async () => {
    const d = new Date(); d.setDate(d.getDate() + 3);
    const a = await step('insMedicalYes', {insMedicalDate: hrKey(d), insMedicalCentre: 'Apollo'});
    const b = await step('insMedicalPending', {insMedicalNote: 'ECG report awaited'});
    const c = await step('insMedicalDone');
    const e = await step('insUwMore', {insUwNote: 'Latest ITR'});
    const f = await step('insUwApproved');
    const path = [a, b, c, e, f].map(x => x.stage).join(' → ');
    if(path !== 'insMedicalCheckup → insMedicalCheckup → insUnderwriting → insUnderwriting → insPolicyIssuance') throw new Error(path);
    return path;
    function hrKey(x){ return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
  });

  await t.step('policy entered: the next premium is worked out from commencement', async () => {
    const r = await step('insPolicyEntered', {insPolicyNo: 'POL-777', insCommencementDate: '2026-01-15', insPremium: '21000',
      insPremiumFrequency: 'Yearly', insFinalPremiumDate: '2045-01-15', insMaturityDate: '2066-01-15'});
    if(r.stage !== 'insPolicyDelivery' || r.r.insNextDueDate !== '2027-01-15') throw new Error(JSON.stringify(r.r.insNextDueDate) + ' ' + r.stage);
    return 'POL-777 from 15 Jan 2026, next premium ' + r.r.insNextDueDate;
  });

  await t.step('original received and confirmed: in force, with a renewal follow-up 30 days before', async () => {
    const r = await step('insPolicyConfirmed');
    const task = await t.eval(() => (DB.tasks || []).find(x => x.clientId === 'CMS-ZINW' && x.taskType === INS_RENEWAL_TASK && x.overallStatus !== 'Completed'));
    if(r.stage !== 'insActive' || r.r.insuranceStatus !== 'Active' || !task) throw new Error(JSON.stringify({s: r.stage, st: r.r.insuranceStatus, task}));
    const want = await t.eval(() => insAddMonths('2027-01-15', 0) && (() => { const d = new Date(2027, 0, 15); d.setDate(d.getDate() - 30); return hrDateKey(d); })());
    if(task.dueDate !== want) throw new Error('follow-up due ' + task.dueDate + ', expected ' + want);
    return 'Active; follow-up due ' + task.dueDate;
  });

  await t.step('a follow-up, then a payment: the due date moves a year on and a new follow-up is raised', async () => {
    const a = await step('insRenewalFollowUp', {insRenewalNote: 'Client will pay next week'});
    const b = await step('insRenewalPaid', {insRenewalPaidOn: '2027-01-10', insRenewalAmount: '21000'});
    const tasks = await t.eval(() => (DB.tasks || []).filter(x => x.clientId === 'CMS-ZINW' && x.taskType === INS_RENEWAL_TASK).map(x => x.overallStatus + ':' + x.dueDate));
    if(a.stage !== 'insActive' || b.stage !== 'insActive' || b.r.insNextDueDate !== '2028-01-15' || b.r.insRenewals.length !== 1) throw new Error(JSON.stringify(b.r));
    if(tasks.length !== 2 || !/^Completed/.test(tasks[0]) || /^Completed/.test(tasks[1])) throw new Error(tasks.join(', '));
    const hist = b.r.insHistory.map(h => h.label);
    return 'next due ' + b.r.insNextDueDate + '; tasks ' + tasks.join(', ') + '; ' + hist.length + ' history lines';
  });

  await t.step('the policy closes, and a new application can start on the same client', async () => {
    const a = await step('insPolicyEnded', {insClosureReason: 'Surrendered'});
    const b = await step('insReopen');
    if(a.stage !== 'insClosed' || a.r.insuranceStatus !== 'Expired') throw new Error(JSON.stringify(a.r.insuranceStatus));
    if(b.stage !== 'insurancePending' || b.r.insPolicyNo || (b.r.insPastPolicies || []).length !== 1 || b.r.insPlanName !== 'Smart Term') throw new Error(JSON.stringify(b.r));
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
        states: bp.states.filter(s => /^ins[A-Z]/.test(s.id)).length, steps: bp.transitions.filter(x => x.from === 'insurancePending').map(x => x.id)};
      DB.config.blueprints.CMS = keep;
      return out;
    });
    if(r.terminal || r.states !== 10 || r.steps.indexOf('insIllustrationSentT') < 0) throw new Error(JSON.stringify(r));
    return r.label + ', ' + r.states + ' stages added, steps: ' + r.steps.join(', ');
  });

  await t.step('nothing was alerted', async () => {
    if(t.dialogs.length) throw new Error('alerts: ' + t.dialogs.join(' | '));
    return 'no dialogs';
  });
});
