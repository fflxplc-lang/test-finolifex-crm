/* THE SEARCH CLOSES ON A CLICK OUTSIDE IT.

   Opening the search and clicking anywhere outside the box closes it and
   clears what was typed. Esc does the same. A form in the same modal host
   does not close on an outside click. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.step('a click outside closes the search and clears the text', async () => {
    await t.eval(()=>{ navigate('dashboard'); openCommandPalette(''); });
    await t.wait(100);
    await t.page.fill('#cmdkInput', 'jhdjfj');
    await t.page.mouse.click(30, 600);
    await t.wait(150);
    const r = await t.eval(()=>({open: document.getElementById('overlay').classList.contains('show'),
      text: (document.getElementById('cmdkInput') || {}).value || ''}));
    if(r.open || r.text) throw new Error(JSON.stringify(r));
    await t.eval(()=>openCommandPalette('')); await t.wait(80);
    const again = await t.eval(()=>document.getElementById('cmdkInput').value);
    if(again) throw new Error('reopened with "' + again + '"');
    return 'closed, and reopened empty';
  });

  await t.step('Esc closes it too', async () => {
    await t.page.fill('#cmdkInput', 'abc');
    await t.page.keyboard.press('Escape');
    await t.wait(100);
    const open = await t.eval(()=>document.getElementById('overlay').classList.contains('show'));
    if(open) throw new Error('still open');
    return 'closed';
  });

  await t.step('a form does not close on a click outside it', async () => {
    await t.eval(()=>openModal('ZZ form', '<input id="zzf">', ''));
    await t.wait(80);
    await t.page.mouse.click(30, 600);
    await t.wait(100);
    const open = await t.eval(()=>document.getElementById('overlay').classList.contains('show'));
    await t.eval(()=>closeModal());
    if(!open) throw new Error('the form closed');
    return 'the form stayed open';
  });
});
