export interface Size {
  code: string;
  size: string;
  pricePaise: number;
  inStock: boolean;
  few: boolean;
}

export interface Style {
  code: string;
  slug: string;
  name: string;
  category: string;
  description: string;
  highlights: string[];
  imageAlt: string;
  images: string[];
  colour: string;
  fabric: string;
  fit: string;
  pattern: string;
  occasion: string[];
  sizing: "true" | "runs_small" | "runs_large";
  pairsWith: string[];
  pricePaise: number;
  listPaise: number;
  offPct: number;
  isNew: boolean;
  inStock: boolean;
  sizes: Size[];
  liveAt: string | null;
}

export interface SizeChart {
  name: string;
  categories: string[];
  unit: string;
  columns: string[];
  rows: string[][];
  note: string;
}

export interface Facets {
  categories: string[];
  sizes: string[];
  occasions: string[];
  sale: boolean;
}

export interface ShopInfo {
  brandName: string;
  legalName: string;
  address: string;
  gstin: string;
  orderPrefix: string;
  cod: { enabled: boolean; maxOrderPaise: number };
  prepaid: boolean;
  shippingNote: string;
  returnsNote: string;
  whatsapp: string;
  instagram: string;
  sizeCharts: SizeChart[];
  loyalty: { enabled: boolean; pointValuePaise: number; tiers: { name: string; minSpendPaise: number; multiplier: number; perk?: string }[] };
}

export interface Account {
  name: string;
  phone: string;
  usualSize: string;
  waist: string;
  offers: boolean;
  points: number;
  pointValuePaise: number;
  tier: { name: string; multiplier: number; perk: string; next: { name: string; needPaise: number } | null };
  spendPaise: number;
  referralCode: string;
  lastAddress: { name: string; address: string; pincode: string } | null;
}

export interface BagLine {
  skuCode: string;
  slug: string;
  name: string;
  size: string;
  colour: string;
  image: string;
  pricePaise: number;
  qty: number;
}

export interface Quote {
  lines: { skuCode: string; name: string; size: string; qty: number; unitPaise: number }[];
  listPaise: number;
  memberSavingPaise: number;
  quote: { code: { kind: string; code: string; label: string; pct: number; paise: number } | null; points: { used: number; paise: number; available: number; max: number }; totalPaise: number };
  totalPaise: number;
  codAllowed: boolean;
  prepaidAllowed: boolean;
}

export interface CustomerOrder {
  _id: string;
  label: string;
  status: string;
  statusWords: string;
  placedAt: string;
  lines: { skuCode: string; slug: string; name: string; size: string; qty: number; unitPaise: number; returnedQty: number }[];
  totalPaise: number;
  discount: { code: string; codePaise: number; pointsUsed: number; pointsPaise: number } | null;
  payment: { method: string; status: string; url: string };
  cod: { band: string; needsConfirm: boolean; prepayOnly: boolean } | null;
  holdUntil: string | null;
  shipTo: { name: string; address: string; pincode: string };
  shipment: { courier: string; awb: string; trackingUrl: string };
}
