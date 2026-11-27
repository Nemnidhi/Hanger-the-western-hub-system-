import express from "express";
import { InstagramComment, InstagramMessage, InstagramThread, WebhookEvent, getSettings } from "../models/index.js";
import { enqueue, RetryableError } from "../jobs/queue.js";
import { isDuplicateKeyError, withTransaction } from "../db.js";
import { isValidMetaSignature } from "../whatsapp/signature.js";

// Instagram direct messages and comments (Instagram API with Instagram Login, on the brand's own
// professional account). Meta's webhook is saved first and processed by the worker, like WhatsApp's.
// Instagram allows a reply to a DM within 24 hours of her last message, and one private reply to a
// comment (within 7 days of it).

const DAY_MS = 24 * 60 * 60 * 1000;
export const igReplyWindowOpen = (thread, now = new Date()) => Boolean(thread?.lastInboundAt && now - new Date(thread.lastInboundAt) < DAY_MS);

/** Meta's Instagram webhook body as events to store: one per message and per comment. */
export function extractInstagramEvents(body, { accountId }) {
  if (body?.object !== "instagram") return [];
  const events = [];
  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    for (const item of Array.isArray(entry.messaging) ? entry.messaging : []) {
      const message = item.message;
      if (!message?.mid || message.is_deleted) continue;
      events.push({ key: `ig:${message.mid}`, kind: "instagram", field: "messages", payload: { ...item, accountId: String(entry.id || accountId || "") } });
    }
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      if (change.field !== "comments" || !change.value?.id) continue;
      events.push({ key: `igc:${change.value.id}`, kind: "instagram", field: "comments", payload: { ...change.value, accountId: String(entry.id || accountId || "") } });
    }
  }
  return events;
}

export function createInstagramWebhookRouter({ config, logger }) {
  const router = express.Router();
  router.get("/webhooks/instagram", (req, res) => {
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && typeof token === "string" && token === config.WHATSAPP_VERIFY_TOKEN && typeof challenge === "string") return res.status(200).type("text/plain").send(challenge);
    return res.sendStatus(403);
  });
  router.post("/webhooks/instagram", express.raw({ type: () => true, limit: "2mb" }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!isValidMetaSignature(rawBody, req.get("x-hub-signature-256"), config.INSTAGRAM_APP_SECRET || config.WHATSAPP_APP_SECRET)) {
      logger?.warn({ ip: req.ip }, "instagram webhook refused: bad signature");
      return res.sendStatus(401);
    }
    let body;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.sendStatus(400);
    }
    try {
      for (const event of extractInstagramEvents(body, { accountId: config.INSTAGRAM_ACCOUNT_ID })) {
        try {
          await withTransaction(async (session) => {
            const [saved] = await WebhookEvent.create([{ tenantId: config.TENANT_ID, ...event }], { session });
            await enqueue("instagram.event", { eventId: String(saved._id) }, { session, dedupeKey: `event:${config.TENANT_ID}:${event.key}` });
          });
        } catch (error) {
          if (!isDuplicateKeyError(error)) throw error;
        }
      }
    } catch (error) {
      logger?.error({ err: { message: error?.message } }, "instagram webhook could not be stored; Meta will retry");
      return res.sendStatus(503);
    }
    return res.sendStatus(200);
  });
  return router;
}

/** Talks to the Instagram Graph API for the brand's account. */
export function createInstagramClient({ config, fetchImpl = fetch }) {
  if (!config.INSTAGRAM_ACCOUNT_ID || !config.INSTAGRAM_ACCESS_TOKEN) return null;
  const root = `${config.INSTAGRAM_GRAPH_BASE.replace(/\/$/, "")}/${config.META_GRAPH_VERSION}`;
  async function call(path, { method = "GET", body } = {}) {
    let response;
    try {
      response = await fetchImpl(`${root}/${path}`, { method, headers: { Authorization: `Bearer ${config.INSTAGRAM_ACCESS_TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new RetryableError(`Could not reach Instagram: ${error?.message || error}`);
    }
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    const message = `Instagram refused (HTTP ${response.status}${data?.error?.code ? `, code ${data.error.code}` : ""}): ${data?.error?.message || "no details"}`;
    if (response.status === 429 || response.status >= 500) throw new RetryableError(message);
    throw Object.assign(new Error(message), { permanent: true });
  }
  return {
    sendText: (recipientId, text) => call(`${config.INSTAGRAM_ACCOUNT_ID}/messages`, { method: "POST", body: { recipient: { id: recipientId }, message: { text } } }),
    privateReply: (commentId, text) => call(`${config.INSTAGRAM_ACCOUNT_ID}/messages`, { method: "POST", body: { recipient: { comment_id: commentId }, message: { text } } }),
    publicReply: (commentId, text) => call(`${encodeURIComponent(commentId)}/replies`, { method: "POST", body: { message: text } }),
    profile: (igsid) => call(`${encodeURIComponent(igsid)}?fields=name,username`),
  };
}

/** The keyword rule a comment matches: the whole word, any case ("price?" matches "price"). */
export function matchRule(text, rules) {
  const words = String(text || "").toLowerCase();
  return (rules || []).find((rule) => rule.keyword && new RegExp(`(^|[^\\p{L}\\p{N}])${rule.keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u").test(words)) || null;
}

/** Saves a reply from staff (or a private reply to a comment) with its sending job. */
export async function queueInstagramMessage({ tenantId, thread, text, kind = "dm", commentId = "", sentBy = "", session }) {
  const [message] = await InstagramMessage.create([{ tenantId, threadId: thread._id, direction: "out", kind, text, commentId, status: "queued", sentBy, at: new Date() }], { session });
  await InstagramThread.updateOne({ _id: thread._id }, { $set: { lastMessageAt: message.at } }, { session });
  await enqueue("instagram.send", { messageId: String(message._id) }, { session, dedupeKey: `igsend:${message._id}` });
  return message;
}

export function createInstagramHandlers({ config, fetchImpl = fetch, now = () => new Date() }) {
  const tenantId = config.TENANT_ID;
  const client = createInstagramClient({ config, fetchImpl });

  async function storeMessage(item) {
    const ours = String(item.accountId || config.INSTAGRAM_ACCOUNT_ID || "");
    const echo = Boolean(item.message.is_echo) || String(item.sender?.id) === ours;
    const igsid = String(echo ? item.recipient?.id : item.sender?.id);
    if (!igsid) return;
    const at = item.timestamp ? new Date(Number(item.timestamp)) : now();
    const attachments = (Array.isArray(item.message.attachments) ? item.message.attachments : []).map((attachment) => ({ type: String(attachment.type || "file"), url: String(attachment.payload?.url || "") }));
    const kind = item.message.reply_to?.story ? "story_reply" : attachments.some((attachment) => attachment.type === "story_mention") ? "story_mention" : "dm";
    try {
      await withTransaction(async (session) => {
        const update = echo ? { $max: { lastMessageAt: at } } : { $max: { lastInboundAt: at, lastMessageAt: at }, $inc: { unread: 1 }, $set: { status: "open" } };
        const thread = await InstagramThread.findOneAndUpdate({ tenantId, igsid }, update, { upsert: true, new: true, session });
        await InstagramMessage.create([{ tenantId, threadId: thread._id, direction: echo ? "out" : "in", mid: String(item.message.mid), kind, text: String(item.message.text || "").slice(0, 4000), attachments, status: echo ? "sent" : "received", sentBy: echo ? "Instagram app" : "", at }], { session });
        if (!thread.profileAt) await enqueue("instagram.profile", { threadId: String(thread._id) }, { session, dedupeKey: `igprofile:${thread._id}` });
      });
    } catch (error) {
      // Our own reply comes back as an echo with the id we already saved: nothing to add.
      if (!isDuplicateKeyError(error)) throw error;
    }
  }

  async function storeComment(value) {
    const settings = await getSettings(tenantId);
    const fromId = String(value.from?.id || "");
    if (fromId && fromId === String(value.accountId || config.INSTAGRAM_ACCOUNT_ID)) return;
    const rule = settings.instagram?.commentReplies ? matchRule(value.text, settings.instagram.rules) : null;
    try {
      await withTransaction(async (session) => {
        const [comment] = await InstagramComment.create(
          [{ tenantId, commentId: String(value.id), mediaId: String(value.media?.id || ""), fromId, username: String(value.from?.username || ""), text: String(value.text || "").slice(0, 2000), at: now(), keyword: rule?.keyword || "" }],
          { session },
        );
        if (rule && client) await enqueue("instagram.commentReply", { commentId: String(comment._id) }, { session, dedupeKey: `igcomment:${comment._id}` });
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
  }

  return {
    async "instagram.event"({ eventId }) {
      const event = await WebhookEvent.findById(eventId);
      if (!event || event.processedAt) return;
      if (event.field === "messages") await storeMessage(event.payload);
      else if (event.field === "comments") await storeComment(event.payload);
      await WebhookEvent.updateOne({ _id: event._id }, { $set: { processedAt: now() } });
    },

    async "instagram.send"({ messageId }) {
      const message = await InstagramMessage.findById(messageId);
      if (!message || message.status !== "queued") return;
      if (!client) {
        await InstagramMessage.updateOne({ _id: message._id }, { $set: { status: "failed", error: "Instagram is not connected on the server" } });
        return;
      }
      const thread = await InstagramThread.findById(message.threadId);
      const markComment = (status, error = "") =>
        message.kind === "comment_reply" ? InstagramComment.updateOne({ tenantId, commentId: message.commentId }, { $set: { privateReply: { status, at: now(), error } } }) : null;
      try {
        const result = message.kind === "comment_reply" ? await client.privateReply(message.commentId, message.text) : await client.sendText(thread.igsid, message.text);
        await InstagramMessage.updateOne({ _id: message._id }, { $set: { status: "sent", error: "", ...(result?.message_id ? { mid: String(result.message_id) } : {}) } });
        await markComment("sent");
      } catch (error) {
        if (error instanceof RetryableError) throw error;
        await InstagramMessage.updateOne({ _id: message._id }, { $set: { status: "failed", error: String(error.message).slice(0, 300) } });
        await markComment("failed", String(error.message).slice(0, 300));
      }
    },

    /** A comment with a keyword: one private reply in her DMs (and the short public reply, if set). */
    async "instagram.commentReply"({ commentId }) {
      const comment = await InstagramComment.findById(commentId);
      if (!comment || comment.privateReply?.status || !client) return;
      const settings = await getSettings(tenantId);
      const rule = (settings.instagram?.rules || []).find((entry) => entry.keyword === comment.keyword);
      if (!rule) return;
      const link = config.PUBLIC_STORE_URL ? `${config.PUBLIC_STORE_URL}/shop` : settings.shop?.instagram || "";
      const text = rule.reply.replaceAll("{link}", link).replaceAll("{name}", comment.username ? `@${comment.username}` : "").trim();
      await withTransaction(async (session) => {
        const thread = await InstagramThread.findOneAndUpdate({ tenantId, igsid: comment.fromId }, { $setOnInsert: { username: comment.username, status: "open" } }, { upsert: true, new: true, session });
        await queueInstagramMessage({ tenantId, thread, text, kind: "comment_reply", commentId: comment.commentId, sentBy: `comment rule "${rule.keyword}"`, session });
        await InstagramComment.updateOne({ _id: comment._id }, { $set: { privateReply: { status: "queued", at: now(), error: "" } } }, { session });
      });
      if (rule.publicReply) {
        try {
          await client.publicReply(comment.commentId, rule.publicReply);
          await InstagramComment.updateOne({ _id: comment._id }, { $set: { publicReply: { status: "sent", at: now(), error: "" } } });
        } catch (error) {
          await InstagramComment.updateOne({ _id: comment._id }, { $set: { publicReply: { status: "failed", at: now(), error: String(error.message).slice(0, 300) } } });
        }
      }
    },

    async "instagram.profile"({ threadId }) {
      if (!client) return;
      const thread = await InstagramThread.findById(threadId);
      if (!thread || thread.profileAt) return;
      try {
        const profile = await client.profile(thread.igsid);
        await InstagramThread.updateOne({ _id: thread._id }, { $set: { username: String(profile.username || thread.username || ""), name: String(profile.name || ""), profileAt: now() } });
      } catch (error) {
        if (error instanceof RetryableError) throw error;
        await InstagramThread.updateOne({ _id: thread._id }, { $set: { profileAt: now() } });
      }
    },
  };
}
