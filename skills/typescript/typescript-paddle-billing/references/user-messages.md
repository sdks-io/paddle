# Fixed wording for the user

*Read this when you must send the user one of these messages: before the first Paddle call, before build step 6, and after step 6 passes.*

Send these verbatim at the moment named.

- **Before any Paddle call (API key):** "To connect Paddle I need an API key. Please create it yourself; don't paste it here.
  1. Sign in to the Paddle **sandbox** dashboard at https://sandbox-vendors.paddle.com (create a free sandbox account there if you don't have one).
  2. Go to **Developer tools > Authentication** (in some accounts: **My account > Settings > Authentication**) and create a new API key.
  3. Name it `<app name> server` and tick these permissions: `<permission list from references/credentials.md for the recipes in scope>`.
  4. Copy the key (it starts with `pdl_sdbx_apikey_`; Paddle shows it only once).
  5. Add it to this project's secrets as **`PADDLE_API_KEY`** `<platform-specific: the hosting platform's secret store, named in references/adapters.md for that platform; local: the git-ignored .env file>`.
  Reply "done" when it's saved. I'll check that it works without seeing it."
- **Before step 6 (default payment link):** "Paddle needs a default payment link before it can open checkouts. In the Paddle sandbox dashboard: 1. Add `<domain>` under **Checkout > Website approval** (in some dashboards **My account > Settings > Website approval**); sandbox approves it at once. 2. Under **Checkout > Checkout settings**, set **Default payment link** to `https://<domain>/pay` and save. Reply "done" when it's saved."

- **After step 6 passes (sandbox checkout works):** "Paddle is connected in **sandbox** (test mode). Test card: `4242 4242 4242 4242`, any future expiry, CVC `100`. Nothing is charged for real. Access is granted by Paddle's webhook, shortly after payment. To take real payments, tell me when you are ready to go live; Paddle must approve your domain first (often automatic, otherwise 5–7 business days), and your site needs visible pricing, terms, a refund policy and a privacy policy."
- **When the user asks for live payments:** "Going live needs a separate Paddle live account with business verification, domain approval for `<domain>`, payout details, and a live API key, client token and webhook destination. Here is the checklist: `references/go-live.md`. I can prepare everything except the steps only you can do in the Paddle dashboard."
- **When the user asks for usage-based billing:** "Paddle does not meter usage itself. I can bill usage as seats (quantity), as a one-off charge for overage, as an extra line on the next renewal, or as prepaid credit packs tracked in your app. Which fits?"
- **When a refund is requested on live:** "Refunds on live go to Paddle for approval unless they are small and the account is verified. Your customer receives the money and a credit note from Paddle once approved; I will update the app when `adjustment.updated` arrives."
