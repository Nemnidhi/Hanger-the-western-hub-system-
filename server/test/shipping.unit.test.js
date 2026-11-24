import test from "node:test";
import assert from "node:assert/strict";
import { classify, parseCourierTime } from "../src/shipping/tracking.js";
import { courierRates } from "../src/shipping/courier.js";
import { isValidWebhookToken } from "../src/shipping/shiprocket.js";

test("courier statuses: words first, Shiprocket's numbers when there are no words", () => {
  const cases = {
    "PICKED UP": "in_transit",
    "In Transit": "in_transit",
    "REACHED AT DESTINATION HUB": "in_transit",
    "OUT FOR DELIVERY": "out_for_delivery",
    DELIVERED: "delivered",
    UNDELIVERED: "undelivered",
    "RTO INITIATED": "rto_started",
    "RTO IN TRANSIT": "rto_started",
    RTO_DELIVERED: "rto_delivered",
    "RTO ACKNOWLEDGED": "rto_delivered",
    CANCELED: "cancelled",
    "OUT FOR PICKUP": "booked",
    "AWB ASSIGNED": "booked",
    LOST: "other",
  };
  for (const [status, kind] of Object.entries(cases)) assert.equal(classify({ status }), kind, status);
  assert.equal(classify({ statusId: 7 }), "delivered");
  assert.equal(classify({ statusId: 10 }), "rto_delivered");
  assert.equal(classify({ statusId: 17 }), "out_for_delivery");
  assert.equal(classify({}), "other");
});

test("courier times are India time in either of Shiprocket's two formats", () => {
  assert.equal(parseCourierTime("2023-05-19 11:59:16").toISOString(), "2023-05-19T06:29:16.000Z");
  assert.equal(parseCourierTime("23 05 2023 11:43:52").toISOString(), "2023-05-23T06:13:52.000Z");
  assert.equal(parseCourierTime("NA"), null);
});

test("without a courier account, booking says so; the webhook token check is strict", async () => {
  await assert.rejects(courierRates({ tenantId: "t", order: {}, courier: null }), (error) => error.status === 409 && error.code === "COURIER_OFF");
  assert.equal(isValidWebhookToken("a-token-of-16-chars", "a-token-of-16-chars"), true);
  assert.equal(isValidWebhookToken("a-token-of-16-charX", "a-token-of-16-chars"), false);
  assert.equal(isValidWebhookToken(undefined, "a-token-of-16-chars"), false);
  assert.equal(isValidWebhookToken("x", undefined), false);
});
