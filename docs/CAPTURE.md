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
4. **Nothing to label in the receiver.** The script forwards everything in the receiver's inbox and then archives it (label `hk/sent`). Do not use a `to:me` filter: forwarded mail keeps the original recipient in `To`.
5. **Install the forwarder.** Signed in as the receiver: script.google.com → New project → paste the contents of `tools/receiver-apps-script.gs`. Project Settings (gear) → Script properties → add:
   - `HK_URL` = `https://hearthkeeper.net`
   - `HK_TOKEN_LABEL` = `receiver-mailbox`
   - `HK_SECRET` = the `receiver-mailbox` secret from the tokens command
6. **Authorize it once.** Select `forwardNewMail` → Run. Google will warn that the app is unverified (it is your own script): Advanced → Go to project → Allow.
7. **Schedule it.** Triggers (clock icon) → Add trigger → function `forwardNewMail`, event source *Time-driven*, *Minutes timer*, every 5 minutes.
8. **Check.** The run also sends a signed heartbeat, so Ingest health shows `receiver-mailbox` seen within five minutes even before a real alert arrives. When a real Chase alert lands, it appears on Home / Backlog as a pending ("provisional") transaction; the bank CSV later turns it into the posted one.
If an alert shows as *unrecognized* on Ingest health, the email wording differs from the SMS wording the parser was written against. Send me a copy with your name and card digits removed and I will add the shape and replay it.

## 3b. Wells Fargo, Venmo, PayPal and Amazon emails → receiver mailbox

These four are parsed from real sample emails (the same receiver mailbox and Apps Script as Chase; `HK_DISABLE_RECEIPT_PARSERS=1` turns the receipt ones off). In Gmail, add a forwarding filter on each real mailbox for the senders below, so the mail reaches the receiver mailbox (the Apps Script labels and posts it):

| Sender | What it becomes |
|---|---|
| `notify.wellsfargo.com` — "Your account update is here" (daily rundown: withdrawals, and deposits if you have them) | A provisional transaction on the Wells Fargo account whose last 4 digits match. **First set the last 4 for each Wells Fargo account in Settings**; until then these emails wait (an error on the Data page) and are parsed when you save the digits and replay. The bank CSV later replaces them, keeping any category/note you set. |
| `venmo.com` — "You paid X $N" / "X paid you $N" | A note (memo, person, amount, date) that the matcher attaches to the matching bank/card charge. |
| `paypal.com` — "Receipt for your PayPal payment", and merchant payment confirmations ("Hulu: $13.65 USD") | A note with the merchant (and items when listed). |
| `amazon.com` — "Ordered N items: …" | One note per order, with the order's total and its category summary ("pet supplies,skin care"). Amazon's email does not name products, so the note is only as specific as that. |

Gmail filter searches (Settings → Filters → *Forward it to* the receiver), taken from the sample emails:
- Wells Fargo: `from:alerts@notify.wellsfargo.com subject:"Your account update is here"`
- Venmo: `from:venmo@venmo.com (subject:"paid you" OR subject:"You paid")`
- PayPal: `from:service@paypal.com (subject:"Receipt for your PayPal payment" OR subject:"USD")`
- Amazon: `from:auto-confirm@amazon.com subject:Ordered`

After updating the Apps Script (paste the new `tools/receiver-apps-script.gs` over the old one and save), re-run it once: older versions marked every message `email_unknown`.

**Forwarding one by hand** (testing, or back-filling old emails): a message you forward yourself arrives from *you*, not the bank. The server treats it as the original sender's mail when you are a known household member (the emails on the sign-in list), the forward itself is authenticated as you, and the quoted original sender is a trusted domain; it does this when the message is parsed, so **Replay unparsed** on the Data page fixes ones that arrived earlier. Use Gmail's inline *Forward*, not "as attachment". Nothing needs configuring in the receiver script (the optional `HK_FORWARDERS` property only adds extra addresses). The trust check also now requires DKIM (or DMARC) to pass *for the sender's own domain*; SPF alone no longer counts.

Not handled (left as "unrecognized" on purpose): shipping/delivery mail, Venmo requests, PayPal refunds, and balance-only Wells Fargo alerts. Uploading a bank CSV later is always safe: rows already created from an alert are replaced by the posted row, not duplicated.

## 4. What "working" looks like after a day
- Ingest health: both sources seen recently, nothing pending or failed.
- Home: new purchases appear within minutes, each with a clear reason it needs you.
- You get one push per new unknown purchase; the first of you to answer closes the other's prompt.
- If a source goes quiet longer than its normal gap, you get a "silent source" push.
