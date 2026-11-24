# The Hanger platform

The Hanger Western Hub's own commerce system, built in-house, with Meta (WhatsApp, Instagram, the
commerce catalogue) used directly as tech partner. No Shopify. Phase 1: the server and the staff web app.

## What works now

- **Catalogue**: styles with sizes (one SKU per size, code `STYLE-SIZE`), photos, attributes, supplier.
  A style is a draft until it has a photo and is put live. Price changes go to every size.
- **Stock by location**: store(s) and the online stock room. Receive from a supplier, count (with a
  reason), transfer. Every change is a stock move. Carts hold stock; nothing is sold twice.
- **WhatsApp ordering**: the customer sends a cart from the WhatsApp catalogue, then the address, then
  picks prepaid (Razorpay link) or cash on delivery. An unpaid / unconfirmed cart gives its stock
  back when its hold runs out (30 minutes by default).
- **COD check**: a graded 0-1 risk score with reasons (customer's record, pincode's record, value,
  pieces, address, time). Low: confirmed at once. Medium: the customer confirms first. High: prepaid
  only. The bands are the owner's settings.
- **GST invoices**: clothing at 5% up to Rs 2,500 a piece (before tax), 18% above, prices GST-inclusive.
  CGST + SGST inside Madhya Pradesh, IGST elsewhere (state from the pincode; staff confirm when unsure).
  One series per location per financial year (`IN1/2627/00001`); cancellations after invoicing get a
  credit note. Invoices are never edited.
- **Courier booking (Shiprocket, the brand's own account)**: for a packed order, rates from every
  courier that serves the pincode (cheapest first, Shiprocket's pick marked, COD charge included),
  book one, pickup requested, label PDF to print. Tracking updates (webhook, plus an hourly check in
  case one is missed) move the order to Shipped, Out for delivery (the customer is told), Delivered
  (COD counted as paid) or RTO (restocked, credit note). Cancel a booking before pickup and rebook.
  Without Shiprocket set up, staff type the courier and tracking number by hand.
- **Store counter sale** (POS API): cash / UPI / card, invoice in the store's own series.
- **Outfit picks**: for the pieces a customer is trying, every live piece in stock at that location
  gets a graded score out of 100 from six reasons (her size in stock, staff "goes with" pairings,
  colours, occasion, her taste and usual spend, new / slow stock), weighted by the owner. Pieces that
  complete the look come first, then swaps. Her size comes from her past orders or what staff save
  (one up / down for styles that run small / large; the nearest size left when hers is gone). Bought
  pieces are left out, returned ones score nothing on taste. Only a piece with no size left is cut.
- **Picks on WhatsApp**: only to customers who agreed (staff can record "she agreed just now" in the
  store). Inside 24 hours of her last message: a product list from the Meta catalogue in her sizes,
  which she can put in a cart. Outside it: the owner's approved picks template, else a clear refusal.
  Automatic picks after a website look (delay and a once-in-N-days gap) are built and off by default;
  they start working when the website storefront calls `schedulePicksFollowUp` (not built yet).
- **Meta catalogue sync**: stock and price changes reach WhatsApp / Instagram within about 5 minutes.
- **Staff sign-in**: roles owner / manager / staff / packer; two-step login required for owner and manager.
- The shared WhatsApp inbox, delivery reports, retries and SMS backup (from the platform core).

## Staff web app (`web/`)

React + Vite, served by the API in production (`WEB_DIST_DIR`). Screens by role:

- **Today**: sales today (store / online / returns), what is waiting (COD to confirm, to pack, to ship,
  on the way, carts), last-piece sizes.
- **Chats**: the shared WhatsApp inbox, with each chat's order.
- **Orders**: list by what needs doing, search by number / phone / name; the order page shows the next
  step (confirm COD, set the GST state, print invoice, pack, book the courier and print the label,
  delivered / RTO / returned, cancel), the courier's scans, items with GST rate, customer, the COD risk score with its reasons, invoices and history.
- **Counter**: billing at the store; scan a barcode (or type a size code / name), UPI / cash / card,
  print the invoice.
- **Trial room**: scan what she is trying and type her number; the screen lists what to bring next
  from this store's rail with the size to bring, pieces left, score and the reasons behind it. Tick
  the picks, save her sizes, and send them to her WhatsApp.
- **Catalogue**: styles with photos (uploaded from phone or computer), sizes and stock at each
  location; add / edit, put live, archive, barcodes per size; for picks, the part of an outfit, how
  the sizes run, and the styles it goes with.
- **Stock**: receive from a supplier by scanning, count with a reason, move between locations, history.
- **Invoice**: printable GST invoice / credit note (A4 or 80 mm counter printer), amount in words.
- **Settings** (owner): business and GST details, COD bands, shipping (Shiprocket pickup address,
  usual parcel weight and box), outfit picks (weights, new / slow days, picks template, automatic
  picks), locations, suppliers. Plus Templates,
  Team and My account.

## Not yet

Website storefront, Instagram DMs, WhatsApp Flows,
reports, the stylist and buying tools (see the plan doc, "Future system").

## Run it

Needs Node 22+ and MongoDB as a replica set (transactions). Development replica set on port 27027:

```
mongod --replSet rs0 --port 27027 --dbpath C:\data\rs0
mongosh --port 27027 --eval "rs.initiate()"
```

```
npm install
npm test                         # 36 tests on a real replica set
node server/src/scripts/demo.js  # one WhatsApp order start to finish, printed
```

Demo shop for a local look (wipes a database named *dev* / *demo* only):

```
node server/src/scripts/seedDemo.js   # prints the demo sign-ins
npm run build                          # staff app into web/dist
server\dev.bat                         # http://localhost:4200
node server/src/scripts/demoCode.js    # the demo owner's two-step code
```

Copy `server/.env.example` to `server/.env`, fill in the brand's Meta, Razorpay and key settings, then
`node server/src/scripts/createOwner.js --name "..." --email ...` and `server/dev.bat`.

## API (staff app)

All under `/api`, signed-in, with the `x-hanger-app: 1` header on changes.

| | |
|---|---|
| `GET/POST /locations`, `GET/POST /suppliers` | set-up |
| `GET/POST /styles`, `PATCH /styles/:id`, `PATCH /skus/:code` | catalogue (barcode on a size) |
| `POST /stock/receive`, `/stock/count`, `/stock/transfer`, `GET /stock/moves` | stock |
| `GET /orders`, `GET /orders/:id` | orders with their invoices |
| `POST /orders/:id/{confirm,cancel,payment-choice,state,pack,ship,deliver,rto,return}` | order steps |
| `GET /orders/:id/courier-rates?weight=`, `POST /orders/:id/{book-courier,courier-label,cancel-courier}` | courier booking |
| `GET /shipping/pickup-locations` | pickup addresses saved in Shiprocket |
| `POST /store-sales` | counter sale |
| `POST /picks` `{pieces, phone?, size?, waist?, location?}` | outfit picks for what she is trying |
| `POST /picks/send` `{phone, pieces, styleCodes?, consentNow?}`, `POST /customers/sizes` | send picks to her WhatsApp; save her sizes |
| `GET /invoices/:id`, `GET/PATCH /settings`, `GET /summary` | |
| `POST /uploads` (image body) | product photo, served at `/media/...` |

Webhooks: `/webhooks/whatsapp` (Meta, signed), `/webhooks/razorpay` (signed),
`/webhooks/courier-updates` (Shiprocket tracking, `x-api-key` token; the URL must not contain
"shiprocket", "sr" or "kr", Shiprocket's rule).

### Outfit picks template

Picks sent more than 24 hours after her last message need a Meta-approved **marketing** template
with three body blanks: her first name, the piece she looked at, and the picks list. For example:
`Hi {{1}}! These go with the {{2}} you tried: {{3}}. Reply with the ones you'd like and we'll keep
them aside.` Put its name and language in Settings > Outfit picks. The product list (inside 24 hours)
needs `META_CATALOG_ID` and the catalogue synced; without it, picks go as a plain text list.

### Shiprocket set-up

1. In the brand's Shiprocket account: Settings > API > create an API user (an email other than the
   main login). Put it in `SHIPROCKET_EMAIL` / `SHIPROCKET_PASSWORD` and set `SHIPPING_PROVIDER=shiprocket`.
2. Settings > API > Webhooks: URL `https://<server>/webhooks/courier-updates`, security token =
   `SHIPROCKET_WEBHOOK_TOKEN` (16+ random characters), switch it on.
3. In the staff app, Settings > Shipping: choose the pickup address and the usual parcel size.

For a demo without an account, `.env` can point at the stand-in courier (`src/scripts/fakeCourier.js`,
started by `dev.bat`); move a parcel on with `POST http://127.0.0.1:4299/_demo/push {"awb","status"}`.
