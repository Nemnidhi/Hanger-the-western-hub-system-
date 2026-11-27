import mongoose from "mongoose";
import { CreatorPayout, Invoice, Order } from "../models/index.js";

// Creator codes: what each creator's code sold in a month (value before GST, less pieces that came
// back), her commission, tax deducted, and whether it was paid.

const trusted = (filter) => mongoose.trusted(filter);
const IST = 330 * 60_000;
const monthStart = (month) => {
  const [year, mon] = month.split("-").map(Number);
  return new Date(Date.UTC(year, mon - 1, 1) - IST);
};
const nextMonth = (month) => {
  const [year, mon] = month.split("-").map(Number);
  return mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, "0")}`;
};

/** A creator's month: orders on her code, net sales before GST, commission, TDS, payable, and any payout. */
export async function creatorStatement({ tenantId, creator, month }) {
  const start = monthStart(month);
  const end = monthStart(nextMonth(month));
  const orders = await Order.find({ tenantId, "discount.creatorId": creator._id }, { _id: 1, number: 1, customer: 1, createdAt: 1 }).lean();
  const invoices = orders.length ? await Invoice.find({ tenantId, orderId: trusted({ $in: orders.map((order) => order._id) }), date: trusted({ $gte: start, $lt: end }) }, { kind: 1, orderId: 1, totals: 1, number: 1, date: 1 }).lean() : [];
  const byOrder = new Map();
  for (const invoice of invoices) {
    const sign = invoice.kind === "invoice" ? 1 : -1;
    const row = byOrder.get(String(invoice.orderId)) || { netPaise: 0, invoice: "" };
    row.netPaise += sign * invoice.totals.taxablePaise;
    if (sign > 0) row.invoice = invoice.number;
    byOrder.set(String(invoice.orderId), row);
  }
  const lines = orders
    .filter((order) => byOrder.has(String(order._id)))
    .map((order) => ({ orderId: order._id, number: order.number, invoice: byOrder.get(String(order._id)).invoice, customer: order.customer?.name || "", netPaise: byOrder.get(String(order._id)).netPaise, at: order.createdAt }));
  const netSalesPaise = lines.reduce((sum, line) => sum + line.netPaise, 0);
  const commissionPaise = Math.max(0, Math.round((netSalesPaise * creator.commissionPct) / 100));
  const tdsPaise = Math.round((commissionPaise * (creator.tdsPct || 0)) / 100);
  const payout = await CreatorPayout.findOne({ tenantId, creatorId: creator._id, month }).lean();
  return { month, orders: lines.filter((line) => line.invoice).length, lines, netSalesPaise, commissionPaise, tdsPaise, payablePaise: commissionPaise - tdsPaise, payout };
}
