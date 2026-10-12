import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, sleep } from './helpers.js';

const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hearthkeeper' }, body: JSON.stringify(body ?? {}) });

for (const [label, size] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 844 }]]) {
  describe(`Admin update (${label})`, () => {
    let trap;
    beforeEach(async () => { await reset(); trap = trapErrors(); await setViewport(size); await sleep(100); });
    afterEach(async () => { $$('dialog').forEach((d) => d.open && d.close()); trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });

    it('the admin section is only there for an admin', async () => {
      await post('/__e2e/admin', { emails: ['someone-else@example.com'] });
      await mount('/settings');
      await waitFor(() => $('h2') && /Appearance/.test(text(document.body)), 'settings');
      expect($('#admin-update')).to.not.exist;
      expect(text(document.body)).to.not.match(/Update the server/);
      await post('/__e2e/admin', { emails: ['dev'] });
      await mount('/settings');
      await waitFor(() => $('#admin-update'), 'the admin section');
    });

    it('pressing Update asks first, then requests it and shows progress through to the result', async () => {
      await mount('/settings');
      const sec = await waitFor(() => $('#admin-update'), 'the admin section');
      expect(text(sec)).to.match(/Never run|No update has run yet/);
      const btn = $('button.run-update', sec);
      expect(btn.disabled).to.equal(false);
      btn.click();
      const dlg = await waitFor(() => $$('dialog').find((d) => d.open && /Update the server/.test(text(d))), 'the confirmation');
      byText('button', /^Cancel$/, dlg).click();
      await sleep(150);
      expect(text($('#admin-update'))).to.not.match(/requested/i); // cancelling asked for nothing
      $('button.run-update').click();
      const dlg2 = await waitFor(() => $$('dialog').find((d) => d.open && /Update the server/.test(text(d))), 'the confirmation again');
      byText('button', /^(Yes|Update)/, dlg2).click();
      await waitFor(() => /requested/i.test(text($('#admin-update'))), 'the requested state');
      expect($('button.run-update').disabled, 'cannot ask twice').to.equal(true);
      // stand in for the root-owned systemd unit: it picks the request up, runs, and finishes
      await post('/__e2e/admin-log', { text: '== update started 2026-10-12T10:00:00Z\nabc1234 -> def5678\n== update finished ok 2026-10-12T10:02:00Z\n', consume: true });
      await mount('/settings');
      await waitFor(() => /succeeded/i.test(text($('#admin-update'))), 'the result');
      expect(text($('#admin-update'))).to.match(/abc1234 -> def5678/);
      expect($('button.run-update').disabled).to.equal(false);
      const r = $('#admin-update').getBoundingClientRect(); expect(r.right).to.be.at.most(window.innerWidth);
    });

    it('a failed update says so and shows why', async () => {
      await post('/__e2e/admin-log', { text: '== update started t\nuncommitted changes in /srv/hk\n== update finished failed (exit 1) t2\n' });
      await mount('/settings');
      await waitFor(() => /failed/i.test(text($('#admin-update'))), 'the failure');
      expect(text($('#admin-update'))).to.match(/uncommitted changes/);
    });

    it('when the server is not set up for it, the button is off and says what to do', async () => {
      await post('/__e2e/admin', { ready: false });
      await mount('/settings');
      const sec = await waitFor(() => $('#admin-update'), 'the admin section');
      expect($('button.run-update', sec).disabled).to.equal(true);
      expect(text(sec)).to.match(/not set up/i);
    });
  });
}
