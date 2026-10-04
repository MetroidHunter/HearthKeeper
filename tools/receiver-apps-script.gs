/**
 * HearthKeeper receiver mailbox forwarder (design §8.5).
 * Install ONLY in the dedicated receiver Gmail account (never in a main mailbox).
 *
 * Setup:
 *  1. Script properties: HK_URL (e.g. https://hearth.example.com), HK_TOKEN_LABEL (receiver-mailbox), HK_SECRET (from `npm run hk -- init`).
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
  var threads = newLabel.getThreads(0, 50);
  threads.forEach(function (thread) {
    var ok = true;
    thread.getMessages().forEach(function (m) {
      var raw = m.getRawContent();
      var headers = {};
      ['Delivered-To', 'X-Forwarded-For', 'X-Forwarded-To', 'To', 'From', 'Subject', 'Date', 'Message-ID', 'Reply-To'].forEach(function (h) {
        var mm = new RegExp('^' + h + ':\\s*(.+)$', 'mi').exec(raw);
        if (mm) headers[h] = mm[1].trim();
      });
      var body = JSON.stringify({ source: guessSource(m.getFrom()), messageId: m.getId(), text: m.getPlainBody() || stripHtml(m.getBody()), headers: headers, html: m.getBody().length < 200000 ? m.getBody() : null });
      var ts = String(Math.floor(Date.now() / 1000)), nonce = Utilities.getUuid();
      var sig = hex(Utilities.computeHmacSha256Signature(ts + '.' + nonce + '.' + body, secret));
      var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: body, muteHttpExceptions: true,
        headers: { 'x-hk-token': label, 'x-hk-timestamp': ts, 'x-hk-nonce': nonce, 'x-hk-signature': sig } });
      if (res.getResponseCode() !== 200) { ok = false; console.error(res.getResponseCode() + ' ' + res.getContentText()); }
    });
    if (ok) { thread.removeLabel(newLabel); thread.addLabel(doneLabel); }
  });
  // heartbeat so silence alerts work even when no mail arrives
  UrlFetchApp.fetch(props.getProperty('HK_URL') + '/ingest/heartbeat?token=' + encodeURIComponent(props.getProperty('HK_HEARTBEAT_TOKEN') || ''), { muteHttpExceptions: true });
}
function guessSource(from) {
  from = from.toLowerCase();
  if (from.indexOf('chase') >= 0) return 'chase_alert';
  if (from.indexOf('amazon') >= 0) return 'amazon_receipt';
  if (from.indexOf('venmo') >= 0) return 'venmo_receipt';
  if (from.indexOf('paypal') >= 0) return 'paypal_receipt';
  if (from.indexOf('wellsfargo') >= 0) return 'wf_notice';
  return 'email_unknown';
}
function stripHtml(h) { return h.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function hex(bytes) { return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join(''); }
