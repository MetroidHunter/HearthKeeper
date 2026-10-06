# Connecting live capture

Two feeds, two tokens (both are already in your database; read them with
`sudo make tokens` on the box, from any checkout; it prints label, channel and secret).

| Feed | Token label | How it authenticates | Used by |
|---|---|---|---|
| Phone automation (IFTTT) | `greenlight-device` | secret in the URL: `?token=<secret>` | Greenlight notifications, and Chase alerts if the same automation sees them |
| Receiver mailbox (Apps Script) | `receiver-mailbox` | HMAC signature made from the secret | Chase alert emails, Amazon/Venmo/PayPal receipts |

Nothing is ever lost when a message format surprises the parser: every message is stored raw first and parsed second. Unreadable ones show on **Settings → Ingest health** and can be replayed after a parser fix.

## 1. Prove each token works (no real message needed)
```
curl -s -X POST "https://hearthkeeper.net/ingest/heartbeat?token=<greenlight-device secret>"      # -> {"ok":true}
```
Then open **Settings → Ingest health**: the source shows as seen just now. A `401` means the wrong token.

## 2. IFTTT → Greenlight (and Chase if it passes through the same automation)
1. In IFTTT, open the applet that writes Greenlight notifications to your sheet. Leave it running; add a **second applet** (or a second action) so the Sheets one keeps working during the parallel run.
2. Trigger: the same Android notification trigger you use today.
3. Action: **Make a web request** (a Webhooks action; IFTTT may require Pro for this, which is the one paid piece).
   - URL: `https://hearthkeeper.net/ingest/device?token=<greenlight-device secret>`
   - Method: `POST`
   - Content type: `text/plain`
   - Body: exactly the text your Sheets action writes into the "Full Transaction" column (the notification text followed by `on <date> at <time>`). Use the same ingredients in the same order.
4. Save, then use IFTTT's "Check now" or wait for the next real notification.
5. Check Ingest health: the message appears, parsed. A Greenlight spend shows up on Home / Backlog (Miracle's spends need a category; Marion's are ignored).
Chase alerts sent through the same automation are recognised by their wording ("Prime Visa: You made a $… transaction with …") and need no extra setup.

## 3. Chase alerts by email → receiver mailbox (the route for Chase if IFTTT does not see them)
1. **Create the receiver mailbox**: a new, dedicated Google account. Never install the script in a mailbox you actually use.
2. **Make Chase send alerts by email.** In Chase: Profile & settings → Alerts → set the card's purchase alert to Email (a small threshold such as $0.01 so every purchase sends one).
3. **Get those emails to the receiver.** In your main Gmail: Settings → Forwarding and POP/IMAP → *Add a forwarding address* (the receiver) and confirm it from the receiver; then Settings → Filters → create a filter for mail from Chase (`from:(no.reply.alerts@chase.com)` or `from:chase.com` with a subject containing "transaction") → *Forward it to* the receiver. Forwarded mail keeps its sender and its DKIM signature, which is what the script's trust check needs.
4. **Label everything in the receiver.** In the receiver: Gmail → Settings → Labels → create `hk/new`. Settings → Filters → create a filter matching all incoming mail (for example `to:me`) → *Apply the label* `hk/new`.
5. **Install the forwarder.** Signed in as the receiver: script.google.com → New project → paste the contents of `tools/receiver-apps-script.gs`. Project Settings (gear) → Script properties → add:
   - `HK_URL` = `https://hearthkeeper.net`
   - `HK_TOKEN_LABEL` = `receiver-mailbox`
   - `HK_SECRET` = the `receiver-mailbox` secret from the tokens command
6. **Authorize it once.** Select `forwardNewMail` → Run. Google will warn that the app is unverified (it is your own script): Advanced → Go to project → Allow.
7. **Schedule it.** Triggers (clock icon) → Add trigger → function `forwardNewMail`, event source *Time-driven*, *Minutes timer*, every 5 minutes.
8. **Check.** The run also sends a signed heartbeat, so Ingest health shows `receiver-mailbox` seen within five minutes even before a real alert arrives. When a real Chase alert lands, it appears on Home / Backlog as a pending ("provisional") transaction; the bank CSV later turns it into the posted one.
If an alert shows as *unrecognized* on Ingest health, the email wording differs from the SMS wording the parser was written against. Send me a copy with your name and card digits removed and I will add the shape and replay it.

## 4. What "working" looks like after a day
- Ingest health: both sources seen recently, nothing pending or failed.
- Home: new purchases appear within minutes, each with a clear reason it needs you.
- You get one push per new unknown purchase; the first of you to answer closes the other's prompt.
- If a source goes quiet longer than its normal gap, you get a "silent source" push.
