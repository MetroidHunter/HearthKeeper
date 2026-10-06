/**
 * HearthKeeper receiver mailbox forwarder (design §8.5).
 * Install ONLY in the dedicated receiver Gmail account (never in a main mailbox).
 *
 * Setup:
 *  0. Optional, for forwarding a message by hand (testing, back-filling): script property HK_FORWARDERS = your own address(es), comma separated.
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
      var source = guessSource(m.getFrom(), headers['Authentication-Results']);
      var plain = m.getPlainBody();
      if (source === 'email_unknown') { // a household member forwarded it by hand: trust the inner sender only if the forwarder is on the list and really sent it
        var inner = forwardedInnerSender(m.getFrom(), headers['Authentication-Results'], plain, props.getProperty('HK_FORWARDERS'));
        if (inner) { source = inner.source; headers['X-HK-Original-From'] = inner.from; }
      }
      var body = JSON.stringify({ source: source, messageId: m.getId(), text: plain || stripHtml(m.getBody()), headers: headers, html: m.getBody().length < 200000 ? m.getBody() : null });
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
function addrOf(from) { return (/<([^>]+)>/.exec(from) || [null, from])[1].trim().toLowerCase(); }
/** DKIM must pass for the SAME domain as the From address (or its parent), or DMARC must pass for it: a message signed by evil.com that says "From: chase.com" does not qualify. */
function authenticated(addr, authResults) {
  var domain = addr.split('@')[1] || '', ar = authResults || '', m, re = /dkim=pass[^;]*?header\.[id]=@?([a-z0-9.-]+)/ig;
  if (!domain) return false;
  while ((m = re.exec(ar))) { var d = m[1].toLowerCase(); if (domain === d || domain.slice(-d.length - 1) === '.' + d) return true; }
  var dm = /dmarc=pass[^;]*?header\.from=([a-z0-9.-]+)/i.exec(ar);
  return !!dm && (domain === dm[1].toLowerCase() || domain.slice(-dm[1].length - 1) === '.' + dm[1].toLowerCase());
}
function sourceOfSender(addr) {
  for (var i = 0; i < SENDERS.length; i++) if (SENDERS[i][0].test(addr)) return SENDERS[i][1];
  return 'email_unknown';
}
function guessSource(from, authResults) {
  var addr = addrOf(from);
  return authenticated(addr, authResults) ? sourceOfSender(addr) : 'email_unknown';
}
/**
 * Hand-forwarded mail ("---------- Forwarded message ---------- From: Wells Fargo <...>") arrives from a person, not the bank. It is accepted only when
 * that person's address is in the script property HK_FORWARDERS (comma separated) AND the forward itself is authenticated as theirs.
 */
function forwardedInnerSender(outerFrom, authResults, plain, forwarders) {
  var outer = addrOf(outerFrom);
  var allowed = (forwarders || '').toLowerCase().split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  if (allowed.indexOf(outer) < 0 || !authenticated(outer, authResults)) return null;
  var at = /-{5,}\s*Forwarded message\s*-{5,}/i.exec(plain || ''); if (!at) return null;
  var fm = /^From:\s*(.+)$/mi.exec((plain || '').slice(at.index)); if (!fm) return null;
  var src = sourceOfSender(addrOf(fm[1]));
  return src === 'email_unknown' ? null : { source: src, from: fm[1].trim() };
}
function stripHtml(h) { return h.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function hex(bytes) { return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join(''); }
