/**
 * HearthKeeper receiver mailbox forwarder (design §8.5).
 * Install ONLY in the dedicated receiver Gmail account (never in a main mailbox).
 *
 * Setup:
 *  1. Script properties: HK_URL (e.g. https://hearth.example.com), HK_TOKEN_LABEL (receiver-mailbox), HK_SECRET (from `npm run hk -- init`).
 *  Sender checks: only mail whose From domain AND Authentication-Results (dkim=pass or spf=pass) match are labelled with a trusted source.
 *  2. In Gmail create a label "hk/new"; add a filter in the receiver: apply "hk/new" to all incoming mail.
 *  3. Add a time-driven trigger: run `forwardNewMail` every 5 minutes.
 *
 * It POSTs every message raw (capture first, parse later): source is only a hint from the sender domain.
 * Original recipient is preserved from Delivered-To / X-Forwarded-For / To so owner detection can work (VERIFY on a real forwarded sample).
 */
function forwardNewMail() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('HK_URL') + '/ingest/email';
  var label = props.getProperty('HK_TOKEN_LABEL'), secret = props.getProperty('HK_SECRET');
  var newLabel = GmailApp.getUserLabelByName('hk/new'), doneLabel = GmailApp.getUserLabelByName('hk/sent') || GmailApp.createLabel('hk/sent');
  if (!newLabel) throw new Error('Create label hk/new first');
  ['HK_URL', 'HK_TOKEN_LABEL', 'HK_SECRET'].forEach(function (k) { if (!props.getProperty(k)) throw new Error('Script property ' + k + ' is not set (Project Settings → Script properties; get the values from `sudo make tokens`)'); });
  var threads = newLabel.getThreads(0, 50);
  threads.forEach(function (thread) {
    var ok = true;
    thread.getMessages().forEach(function (m) {
      var raw = m.getRawContent();
      var headers = {};
      // Only the header block, with folded continuation lines joined: Authentication-Results is folded over several lines and its
      // "dkim=pass" is on the later ones. The first occurrence is the one this mailbox's own Gmail added.
      var headBlock = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
      ['Delivered-To', 'X-Forwarded-For', 'X-Forwarded-To', 'To', 'From', 'Subject', 'Date', 'Message-ID', 'Reply-To', 'Authentication-Results'].forEach(function (h) {
        var mm = new RegExp('^' + h + ':\\s*(.+)$', 'mi').exec(headBlock);
        if (mm) headers[h] = mm[1].trim();
      });
      var body = JSON.stringify({ source: guessSource(m.getFrom(), headers['Authentication-Results']), messageId: m.getId(), text: m.getPlainBody() || stripHtml(m.getBody()), headers: headers, html: m.getBody().length < 200000 ? m.getBody() : null });
      var res = post(url, label, secret, body);
      if (res.getResponseCode() !== 200) { ok = false; console.error(res.getResponseCode() + ' ' + res.getContentText()); }
    });
    if (ok) { thread.removeLabel(newLabel); thread.addLabel(doneLabel); }
  });
  // heartbeat so silence alerts work even when no mail arrives (signed like ingest: no secret ever appears in a URL)
  var hts = String(Math.floor(Date.now() / 1000)), hn = Utilities.getUuid();
  UrlFetchApp.fetch(props.getProperty('HK_URL') + '/ingest/heartbeat', { method: 'post', muteHttpExceptions: true,
    headers: { 'x-hk-token': label, 'x-hk-timestamp': hts, 'x-hk-nonce': hn, 'x-hk-signature': hex(Utilities.computeHmacSha256Signature(hts + '.' + hn + '.', secret)) } });
}
// Exact sender-domain match (never a substring: "purchases@" contains "chase"). The display name is ignored. DKIM/SPF must pass.
var SENDERS = [[/@([a-z0-9-]+\.)*chase\.com$/, 'chase_alert'], [/@([a-z0-9-]+\.)*amazon\.com$/, 'amazon_receipt'], [/@([a-z0-9-]+\.)*venmo\.com$/, 'venmo_receipt'],
  [/@([a-z0-9-]+\.)*paypal\.com$/, 'paypal_receipt'], [/@([a-z0-9-]+\.)*wellsfargo\.com$/, 'wf_notice']];
/**
 * POST a signed body. The signature and the request both use the SAME explicit UTF-8 bytes, so non-ASCII text (curly quotes, emoji)
 * cannot make the signed bytes differ from the sent bytes.
 */
function post(url, label, secret, body) {
  var bytes = Utilities.newBlob(body).getBytes();                 // UTF-8
  var ts = String(Math.floor(Date.now() / 1000)), nonce = Utilities.getUuid();
  var signed = Utilities.newBlob(ts + '.' + nonce + '.').getBytes().concat(bytes);
  var sig = hex(Utilities.computeHmacSha256Signature(signed, Utilities.newBlob(secret).getBytes()));
  return UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: bytes, muteHttpExceptions: true,
    headers: { 'x-hk-token': label, 'x-hk-timestamp': ts, 'x-hk-nonce': nonce, 'x-hk-signature': sig } });
}
/** Run this once by hand: sends a tiny ASCII message. 200 = URL, label and secret are right (then any later 401 is about the message text, not your settings). */
function selfTest() {
  var props = PropertiesService.getScriptProperties();
  var res = post(props.getProperty('HK_URL') + '/ingest/email', props.getProperty('HK_TOKEN_LABEL'), props.getProperty('HK_SECRET'), JSON.stringify({ source: 'email_unknown', messageId: 'selftest-' + Date.now(), text: 'hearthkeeper selftest' }));
  console.log('ASCII test: ' + res.getResponseCode() + ' ' + res.getContentText());
  var res2 = post(props.getProperty('HK_URL') + '/ingest/email', props.getProperty('HK_TOKEN_LABEL'), props.getProperty('HK_SECRET'), JSON.stringify({ source: 'email_unknown', messageId: 'selftest2-' + Date.now(), text: 'curly \u2019 quote \u00a9 and emoji \ud83d\ude00' }));
  console.log('Non-ASCII test: ' + res2.getResponseCode() + ' ' + res2.getContentText());
}
function guessSource(from, authResults) {
  var addr = (/<([^>]+)>/.exec(from) || [null, from])[1].trim().toLowerCase();
  var verified = /dkim=pass|spf=pass/i.test(authResults || '');
  if (!verified) return 'email_unknown';
  for (var i = 0; i < SENDERS.length; i++) if (SENDERS[i][0].test(addr)) return SENDERS[i][1];
  return 'email_unknown';
}
function stripHtml(h) { return h.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function hex(bytes) { return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join(''); }
