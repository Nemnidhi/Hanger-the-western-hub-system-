// Turns Meta's message object into what we store: a type, readable text, and media or structured data.
export function readInboundMessage(message) {
  const type = String(message?.type || "unsupported");
  const at = message?.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date();
  const base = { type, text: "", media: undefined, data: null, at };

  switch (type) {
    case "text":
      return { ...base, text: String(message.text?.body || "") };
    case "image":
    case "document":
    case "audio":
    case "video":
    case "sticker": {
      const media = message[type] || {};
      return {
        ...base,
        // A voice note is audio with voice: true; kept as its own type so it can be transcribed.
        type: type === "audio" && media.voice ? "voice" : type,
        text: String(media.caption || ""),
        media: { id: String(media.id || ""), mimeType: String(media.mime_type || ""), caption: String(media.caption || ""), filename: String(media.filename || "") },
      };
    }
    case "location":
      return {
        ...base,
        text: [message.location?.name, message.location?.address].filter(Boolean).join(", "),
        data: { latitude: message.location?.latitude, longitude: message.location?.longitude, name: message.location?.name || "", address: message.location?.address || "" },
      };
    case "interactive": {
      const reply = message.interactive?.button_reply || message.interactive?.list_reply || null;
      return { ...base, text: String(reply?.title || ""), data: reply ? { id: reply.id, title: reply.title, kind: message.interactive?.type } : message.interactive || null };
    }
    case "order": {
      // A cart sent from the WhatsApp catalogue. product_retailer_id is our SKU code (the catalogue sync
      // uses it as the retailer id), so the cart comes back in our own codes. Meta's prices are ignored:
      // the order is always priced from our own catalogue.
      const order = message.order || {};
      const items = (Array.isArray(order.product_items) ? order.product_items : [])
        .map((item) => ({ skuCode: String(item?.product_retailer_id || "").toUpperCase(), qty: Number(item?.quantity) || 0 }))
        .filter((item) => item.skuCode && item.qty > 0);
      return { ...base, text: String(order.text || ""), data: { catalogId: String(order.catalog_id || ""), items } };
    }
    case "button":
      // A tap on a template's quick-reply button (e.g. "YES" on a refill reminder).
      return { ...base, text: String(message.button?.text || ""), data: { payload: message.button?.payload || "", text: message.button?.text || "" } };
    default:
      return { ...base, type: "unsupported", data: { originalType: type } };
  }
}
