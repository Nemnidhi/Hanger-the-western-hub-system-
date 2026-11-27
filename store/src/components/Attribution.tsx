"use client";

import { useEffect } from "react";

// Where she came from: an ad's link carries utm_* tags and Meta adds fbclid. The latest such visit is
// kept in this browser for 30 days and sent with her order, so the Ads page can count the sale for the
// campaign (and Meta, through the Conversions API, for the ad). Nothing is sent anywhere until she orders.

const KEY = "hanger-attr-v1";
const DAYS_30 = 30 * 24 * 60 * 60 * 1000;

export interface Attribution { source: string; medium: string; campaign: string; content: string; fbclid: string; landedAt: string }

export function readAttribution(): Attribution | null {
  try {
    const saved = JSON.parse(window.localStorage.getItem(KEY) || "null") as Attribution | null;
    if (!saved || Date.now() - new Date(saved.landedAt).getTime() > DAYS_30) return null;
    return saved;
  } catch {
    return null;
  }
}

export function AttributionKeeper() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const value = (name: string, max: number) => (params.get(name) || "").trim().slice(0, max);
    const found: Attribution = {
      source: value("utm_source", 60).toLowerCase(),
      medium: value("utm_medium", 60).toLowerCase(),
      campaign: value("utm_campaign", 120),
      content: value("utm_content", 120),
      fbclid: /^[\w-]{1,500}$/.test(params.get("fbclid") || "") ? String(params.get("fbclid")) : "",
      landedAt: new Date().toISOString(),
    };
    if (!found.source && !found.campaign && !found.fbclid) return;
    if (found.fbclid && !found.source) found.source = "meta";
    try {
      window.localStorage.setItem(KEY, JSON.stringify(found));
    } catch {
      // Storage blocked (private window): the sale simply counts as direct.
    }
  }, []);
  return null;
}
