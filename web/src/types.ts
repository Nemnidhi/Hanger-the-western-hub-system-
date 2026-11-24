// The shapes the commerce API sends. Amounts are in paise.

export interface StockRow {
  locationId: string;
  onHand: number;
  reserved: number;
  available: number;
}

export interface SizeRow {
  code: string;
  size: string;
  barcode: string;
  pricePaise: number;
  stock: StockRow[];
}

export interface Attributes {
  colour?: string;
  fabric?: string;
  neckline?: string;
  sleeve?: string;
  fit?: string;
  pattern?: string;
  occasion?: string[];
}

export interface Style {
  _id: string;
  code: string;
  name: string;
  category: string;
  description: string;
  attributes: Attributes;
  images: string[];
  pricePaise: number;
  costPaise: number;
  hsn: string;
  supplierId: string | null;
  supplierStyleRef: string;
  status: "draft" | "live" | "archived";
  sizes: SizeRow[];
}

export interface Location {
  _id: string;
  code: string;
  name: string;
  kind: "store" | "warehouse";
  address: string;
  pincode: string;
  invoicePrefix: string;
  active: boolean;
}

export interface Supplier {
  _id: string;
  name: string;
  city: string;
  waId: string;
  notes: string;
}

export interface OrderLine {
  skuCode: string;
  styleCode: string;
  name: string;
  size: string;
  qty: number;
  unitPaise: number;
  gstRate: number;
  hsn: string;
}

export type OrderStatus = "draft" | "awaiting_payment" | "awaiting_confirmation" | "confirmed" | "packed" | "shipped" | "delivered" | "rto" | "returned" | "cancelled";

export interface Order {
  _id: string;
  number: number;
  channel: "whatsapp" | "website" | "store" | "phone" | "marketplace";
  conversationId: string | null;
  customer: { name: string; phone: string };
  shipTo: { name: string; address: string; pincode: string; stateCode: string; state: string; stateSure: boolean };
  locationId: string;
  lines: OrderLine[];
  totals: { itemsPaise: number; totalPaise: number };
  payment: { method: "" | "prepaid" | "cod" | "store_cash" | "store_upi" | "store_card"; status: "none" | "pending" | "paid" | "refunded"; url: string; paidAt: string | null };
  cod: { score: number | null; band: "" | "low" | "medium" | "high"; reasons: string[]; confirmedAt: string | null };
  status: OrderStatus;
  chatStep: string;
  stockState: "held" | "committed" | "released";
  holdUntil: string | null;
  confirmedAt: string | null;
  shipment: {
    courier: string;
    awb: string;
    shippedAt: string | null;
    deliveredAt: string | null;
    rtoAt: string | null;
    provider?: "" | "shiprocket";
    providerOrderId?: string;
    chargePaise?: number | null;
    weightGrams?: number | null;
    labelUrl?: string;
    pickupNote?: string;
    bookedAt?: string | null;
    trackingStatus?: string;
    trackedAt?: string | null;
    outForDeliveryAt?: string | null;
    rtoStartedAt?: string | null;
    events?: { at: string; status: string; activity: string; location: string }[];
  };
  invoiceId: string | null;
  creditNoteId: string | null;
  cancelReason: string;
  history?: { at: string; by: string; event: string; note: string }[];
  createdAt: string;
}

export interface InvoiceLine {
  description: string;
  hsn: string;
  qty: number;
  unitPaise: number;
  rate: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
}

export interface Invoice {
  _id: string;
  kind: "invoice" | "credit_note";
  number: string;
  fy: string;
  date: string;
  orderId: string;
  againstInvoiceId: string | null;
  seller: { legalName: string; gstin: string; address: string; stateCode: string };
  buyer: { name: string; address: string };
  placeOfSupply: { stateCode: string; state: string };
  interState: boolean;
  lines: InvoiceLine[];
  totals: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number };
}

export interface Settings {
  brandName: string;
  legalName: string;
  gstin: string;
  registeredAddress: string;
  stateCode: string;
  orderPrefix: string;
  onlineLocationCode: string;
  defaultHsn: string;
  paymentHoldMinutes: number;
  cod: { enabled: boolean; maxOrderPaise: number; lowBelow: number; highFrom: number; confirmHours: number };
  templates: { orderUpdate: { name: string; language: string } };
  shipping: { pickupLocation: string; weightGrams: number; lengthCm: number; breadthCm: number; heightCm: number };
}

export interface CourierRate {
  courierId: number;
  name: string;
  ratePaise: number | null;
  codChargePaise: number;
  days: string;
  etd: string;
  rating: number | null;
  surface: boolean;
  recommended: boolean;
}

export interface Summary {
  byStatus: Partial<Record<OrderStatus, number>>;
  today: { storePaise: number; onlinePaise: number; returnsPaise: number; invoices: number };
  lowStock: number;
  needsState: number;
  prefix: string;
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  draft: "Waiting for address",
  awaiting_payment: "Waiting for payment",
  awaiting_confirmation: "COD to confirm",
  confirmed: "To pack",
  packed: "Packed, to ship",
  shipped: "Shipped",
  delivered: "Delivered",
  rto: "Came back (RTO)",
  returned: "Returned",
  cancelled: "Cancelled",
};

export const STATUS_TONE: Partial<Record<OrderStatus, string>> = {
  awaiting_confirmation: "warn",
  confirmed: "accent",
  packed: "accent",
  rto: "danger",
  cancelled: "",
};

export const PAYMENT_LABEL: Record<string, string> = {
  "": "Not chosen",
  prepaid: "Paid online",
  cod: "Cash on delivery",
  store_cash: "Cash",
  store_upi: "UPI",
  store_card: "Card",
};

export const CHANNEL_LABEL: Record<string, string> = { whatsapp: "WhatsApp", website: "Website", store: "Store", phone: "Phone", marketplace: "Marketplace" };

export const GST_STATES: Record<string, string> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands",
  "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
};
