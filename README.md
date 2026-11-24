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
- **Store counter sale** (POS API): cash / UPI / card, invoice in the store's own series.
- **Meta catalogue sync**: stock and price changes reach WhatsApp / Instagram within about 5 minutes.
- **Staff sign-in**: roles owner / manager / staff / packer; two-step login required for owner and manager.
- The shared WhatsApp inbox, delivery reports, retries and SMS backup (from the platform core).

## Staff web app (`web/`)

React + Vite, served by the API in production (`WEB_DIST_DIR`). Screens by role:

- **Today**: sales today (store / online / returns), what is waiting (COD to confirm, to pack, to ship,
  on the way, carts), last-piece sizes.
- **Chats**: the shared WhatsApp inbox, with each chat's order.
- **Orders**: list by what needs doing, search by number / phone / name; the order page shows the next
  step (confirm COD, set the GST state, print invoice, pack, add tracking, delivered / RTO / returned,
  cancel), items with GST rate, customer, the COD risk score with its reasons, invoices and history.
- **Counter**: billing at the store; scan a barcode (or type a size code / name), UPI / cash / card,
  print the invoice.
- **Catalogue**: styles with photos (uploaded from phone or computer), sizes and stock at each
  location; add / edit, put live, archive, barcodes per size.
- **Stock**: receive from a supplier by scanning, count with a reason, move between locations, history.
- **Invoice**: printable GST invoice / credit note (A4 or 80 mm counter printer), amount in words.
- **Settings** (owner): business and GST details, COD bands, locations, suppliers. Plus Templates,
  Team and My account.

## Not yet

Website storefront, courier booking and tracking, Instagram DMs, WhatsApp Flows,
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
| `POST /store-sales` | counter sale |
| `GET /invoices/:id`, `GET/PATCH /settings`, `GET /summary` | |
| `POST /uploads` (image body) | product photo, served at `/media/...` |

Webhooks: `/webhooks/whatsapp` (Meta, signed), `/webhooks/razorpay` (signed).
