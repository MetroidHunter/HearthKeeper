import { expect, mount, reset, waitFor, $, text, byText, trapErrors } from './helpers.js';

describe('Not being able to reach the server', () => {
  let trap, real;
  beforeEach(async () => { await reset(); trap = trapErrors(); real = window.fetch; });
  afterEach(() => { window.fetch = real; trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('says so, instead of silently pretending you are signed in, and recovers by itself when the server answers', async () => {
    window.fetch = (u, ...r) => (String(u).includes('/auth/me') ? Promise.reject(new TypeError('Failed to fetch')) : real(u, ...r));
    await mount('/budget');
    const banner = await waitFor(() => $('.offline'), 'offline banner');
    expect(text(banner)).to.match(/Can't reach the server.*can't tell whether you're signed in/);
    window.fetch = real; // the network is back
    byText('button', /Retry now/, banner).click();
    await waitFor(() => !$('.offline'), 'banner gone once the server answers');
  });
});
