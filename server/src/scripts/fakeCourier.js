// Development only: a stand-in for Shiprocket on port 4299, so courier booking can be tried and shown
// without a real account. Point the server at it in .env (SHIPPING_PROVIDER=shiprocket,
// SHIPROCKET_API_BASE=http://127.0.0.1:4299, SHIPROCKET_EMAIL=api@hanger.test,
// SHIPROCKET_PASSWORD=fake-courier-pass). Move a parcel on as the courier would:
//   curl -X POST http://127.0.0.1:4299/_demo/push -H "content-type: application/json" -d "{\"awb\":\"...\",\"status\":\"PICKED UP\"}"
import { loadConfig } from "../config.js";
import { createFakeShiprocket } from "../shipping/fakeShiprocket.js";

const config = loadConfig();
const port = 4299;
if (config.NODE_ENV === "production" || !config.SHIPROCKET_API_BASE.includes(`127.0.0.1:${port}`)) {
  console.log("fake courier: not started (the server is not pointed at it).");
  process.exit(0);
}
const fake = createFakeShiprocket({
  email: config.SHIPROCKET_EMAIL,
  password: config.SHIPROCKET_PASSWORD,
  webhookUrl: `http://127.0.0.1:${config.PORT}/webhooks/courier-updates`,
  webhookToken: config.SHIPROCKET_WEBHOOK_TOKEN,
});
await fake.listen(port);
console.log(`fake courier (stand-in for Shiprocket) on ${fake.base}`);
