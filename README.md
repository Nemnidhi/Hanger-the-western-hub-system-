# The Hanger platform

The Hanger Western Hub's own commerce system, built in-house, with Meta (WhatsApp, Instagram, the
commerce catalogue) used directly as tech partner. No Shopify. This is phase 1: the server.

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
- **Store counter sale** (POS API): cash / UPI / card, invoice in the store's own series.
- **Meta catalogue sync**: stock and price changes reach WhatsApp / Instagram within about 5 minutes.
- **Staff sign-in**: roles owner / manager / staff / packer; two-step login required for owner and manager.
- The shared WhatsApp inbox, delivery reports, retries and SMS backup (from the platform core).

## Not yet

Staff web app (screens), website storefront, courier booking and tracking, Instagram DMs, WhatsApp Flows,
reports, the stylist and buying tools (see the plan doc, "Future system").

## Run it

Needs Node 22+ and MongoDB as a replica set (transactions). Development replica set on port 27027:

```
mongod --replSet rs0 --port 27027 --dbpath C:\data\rs0
mongosh --port 27027 --eval "rs.initiate()"
```

```
npm install
npm test                         # 35 tests on a real replica set
node server/src/scripts/demo.js  # one WhatsApp order start to finish, printed
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
| `POST /store-sales` | counter sale |
| `GET /invoices/:id`, `GET/PATCH /settings` | |

Webhooks: `/webhooks/whatsapp` (Meta, signed), `/webhooks/razorpay` (signed).
