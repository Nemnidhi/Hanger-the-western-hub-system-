import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, ApiError, can, type Conversation, type Me, type Message, type TeamMember } from "../api";
import { clockTime, phone, shortTime, timeLeft } from "../format";
import { TemplatePicker } from "./TemplatePicker";

type Filter = "all" | "unread" | "mine" | "open" | "waiting" | "closed";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "mine", label: "Mine" },
  { id: "open", label: "Open" },
  { id: "waiting", label: "Waiting" },
  { id: "closed", label: "Closed" },
];

function selectedFromHash() {
  const [, id] = window.location.hash.replace(/^#\/?/, "").split("/");
  return id || "";
}

function listQuery(filter: Filter, q: string) {
  const params = new URLSearchParams();
  if (filter === "unread") params.set("unread", "1");
  else if (filter === "mine") params.set("mine", "1");
  else if (filter !== "all") params.set("status", filter);
  if (q.trim()) params.set("q", q.trim());
  return params.toString();
}

/** Calls fn at most once per `ms`, after the last call. */
function useDebounced(fn: () => void, ms: number) {
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => latest.current(), ms);
  }, [ms]);
}

export function Inbox({ me }: { me: Me }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [chats, setChats] = useState<Conversation[]>([]);
  const [listError, setListError] = useState("");
  const [selectedId, setSelectedId] = useState(selectedFromHash());
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [live, setLive] = useState(true);
  const [, setTick] = useState(0);
  const messagesReload = useRef<() => void>(() => undefined);

  const loadList = useCallback(async () => {
    try {
      const result = await api<{ data: Conversation[] }>(`/api/conversations?${listQuery(filter, q)}`);
      setChats(result.data);
      setListError("");
    } catch (error) {
      setListError(error instanceof ApiError ? error.message : "Could not load chats.");
    }
  }, [filter, q]);
  const reloadListSoon = useDebounced(loadList, 300);

  useEffect(() => {
    reloadListSoon();
  }, [filter, q, reloadListSoon]);

  useEffect(() => {
    api<{ data: TeamMember[] }>("/api/team").then((result) => setTeam(result.data)).catch(() => undefined);
    const onHash = () => setSelectedId(selectedFromHash());
    window.addEventListener("hashchange", onHash);
    // The "free reply" countdown stays current.
    const clock = window.setInterval(() => setTick((value) => value + 1), 60_000);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.clearInterval(clock);
    };
  }, []);

  // Live updates. The browser reconnects by itself; after a reconnect everything is reloaded, so an
  // update missed while offline is never lost.
  useEffect(() => {
    const source = new EventSource("/api/events");
    let wasDown = false;
    const onChange = (event: MessageEvent) => {
      const data = JSON.parse(event.data) as { conversationId: string };
      reloadListSoon();
      if (data.conversationId === selectedFromHash()) messagesReload.current();
    };
    source.addEventListener("message", onChange);
    source.addEventListener("conversation", onChange);
    source.onerror = () => {
      wasDown = true;
      setLive(false);
    };
    source.onopen = () => {
      setLive(true);
      if (wasDown) {
        wasDown = false;
        reloadListSoon();
        messagesReload.current();
      }
    };
    return () => source.close();
  }, [reloadListSoon]);

  const selected = chats.find((chat) => chat.id === selectedId) || null;

  return (
    <div className={`inbox ${selectedId ? "has-chat" : ""}`}>
      <section className="chat-list" aria-label="Chats">
        <div className="tools">
          <input className="input" type="search" placeholder="Search name or number" value={q} onChange={(event) => setQ(event.target.value)} aria-label="Search chats" />
          <div className="filters" role="group" aria-label="Show">
            {FILTERS.map((item) => (
              <button key={item.id} className={filter === item.id ? "on" : ""} onClick={() => setFilter(item.id)} aria-pressed={filter === item.id}>
                {item.label}
              </button>
            ))}
          </div>
          {!live && <div className="notice warn" style={{ margin: 0 }}>Reconnecting… new messages will appear when the connection is back.</div>}
        </div>
        <div className="chat-items">
          {listError && <div className="notice error" style={{ margin: 12 }}>{listError}</div>}
          {!listError && chats.length === 0 && <div className="empty">No chats here yet.</div>}
          {chats.map((chat) => (
            <button key={chat.id} className={`chat-item ${chat.id === selectedId ? "selected" : ""}`} onClick={() => (window.location.hash = `#inbox/${chat.id}`)}>
              <span className="name">{chat.contact?.name || phone(chat.contact?.waId)}</span>
              <span className="muted" style={{ fontSize: 12 }}>{shortTime(chat.lastMessageAt)}</span>
              <span className="preview">
                {chat.lastMessage?.direction === "out" ? "You: " : ""}
                {chat.lastMessage?.text || (chat.lastMessage ? `[${chat.lastMessage.type}]` : "")}
              </span>
              {chat.unread > 0 ? <span className="count" aria-label={`${chat.unread} unread`}>{chat.unread}</span> : <span />}
            </button>
          ))}
        </div>
      </section>
      <section className="chat" aria-label="Chat">
        {selectedId ? (
          <ChatView key={selectedId} conversationId={selectedId} summary={selected} me={me} team={team} registerReload={(fn) => (messagesReload.current = fn)} onChanged={reloadListSoon} />
        ) : (
          <div className="empty">Choose a chat on the left.</div>
        )}
      </section>
    </div>
  );
}

function ChatView({
  conversationId,
  summary,
  me,
  team,
  registerReload,
  onChanged,
}: {
  conversationId: string;
  summary: Conversation | null;
  me: Me;
  team: TeamMember[];
  registerReload: (fn: () => void) => void;
  onChanged: () => void;
}) {
  const [chat, setChat] = useState<Conversation | null>(summary);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [picking, setPicking] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const writable = can(me, "inbox:write");

  const load = useCallback(async () => {
    try {
      const [detail, thread] = await Promise.all([
        api<{ data: Conversation }>(`/api/conversations/${conversationId}`),
        api<{ data: Message[] }>(`/api/conversations/${conversationId}/messages?limit=100`),
      ]);
      setChat(detail.data);
      setMessages(thread.data);
      setError("");
      if (detail.data.unread > 0) {
        await api(`/api/conversations/${conversationId}/read`, { method: "POST", body: {} });
        onChanged();
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not load this chat.");
    }
  }, [conversationId, onChanged]);

  useEffect(() => {
    registerReload(load);
    load();
  }, [load, registerReload]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError("");
    try {
      const result = await api<{ data: Message }>(`/api/conversations/${conversationId}/messages`, { method: "POST", body: { text: body } });
      setMessages((current) => [...current, result.data]);
      setText("");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not send.");
      if (caught instanceof ApiError && caught.code === "WINDOW_CLOSED") load();
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  async function update(changes: { status?: string; assignedTo?: string; stylist?: "on" | "off" }) {
    try {
      const result = await api<{ data: Conversation }>(`/api/conversations/${conversationId}`, { method: "PATCH", body: changes });
      setChat(result.data);
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save.");
    }
  }

  const windowOpen = Boolean(chat?.window.open);
  const stylistHere = messages.some((message) => message.purpose === "stylist") || Boolean(chat?.stylistOffUntil);
  const name = chat?.contact?.name || phone(chat?.contact?.waId);

  return (
    <>
      <header className="chat-head">
        <button className="btn small back-button" onClick={() => (window.location.hash = "#inbox")} aria-label="Back to chats">
          ←
        </button>
        <div className="title">
          <strong>{name}</strong>
          <span className="muted">{phone(chat?.contact?.waId)}</span>
        </div>
        {chat && (windowOpen ? <span className="badge accent">Free replies: {timeLeft(chat.window.closesAt)}</span> : <span className="badge warn">Template only</span>)}
        {can(me, "orders:read") && chat && <OrderChip conversationId={conversationId} />}
        {writable && chat && (
          <>
            <select className="input" style={{ width: "auto" }} value={chat.assignedTo} onChange={(event) => update({ assignedTo: event.target.value })} aria-label="Assigned to">
              <option value="">Unassigned</option>
              {team.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
            {stylistHere && (
              <button className="btn small" onClick={() => update({ stylist: chat.stylistOffUntil ? "on" : "off" })} title="The AI stylist answers questions about the stock in this chat">
                {chat.stylistOffUntil ? "Let the stylist answer" : "Stylist off here"}
              </button>
            )}
            <select className="input" style={{ width: "auto" }} value={chat.status} onChange={(event) => update({ status: event.target.value })} aria-label="Status">
              <option value="open">Open</option>
              <option value="waiting">Waiting</option>
              <option value="closed">Closed</option>
            </select>
          </>
        )}
      </header>

      {chat?.stylistNote && (
        <div className="notice warn" style={{ margin: "8px 12px 0" }}>
          The stylist stepped back from this chat ({chat.stylistNote}). It stays quiet until {shortTime(chat.stylistOffUntil || null)}.
        </div>
      )}
      <div className="messages" aria-live="polite">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        <div ref={bottom} />
      </div>

      {writable && (
        <div className="composer">
          {error && <div className="notice error" style={{ margin: 0 }} role="alert">{error}</div>}
          {!windowOpen && chat && (
            <div className="notice warn" style={{ margin: 0 }}>
              No message from this customer in the last 24 hours, so WhatsApp only allows an approved template until they write again.
            </div>
          )}
          <div className="composer-row">
            <textarea
              className="input"
              rows={2}
              placeholder={windowOpen ? "Write a reply… (Enter to send, Shift+Enter for a new line)" : "Free replies are closed for this chat"}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKeyDown}
              disabled={!windowOpen}
              aria-label="Reply"
            />
            <button className="btn" onClick={() => setPicking(true)}>
              Template
            </button>
            <button className="btn primary" onClick={send} disabled={!windowOpen || sending || !text.trim()}>
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      )}
      {picking && chat && (
        <TemplatePicker
          customerName={chat.contact?.name || ""}
          onClose={() => setPicking(false)}
          onSend={async (template) => {
            const result = await api<{ data: Message }>(`/api/conversations/${conversationId}/messages`, { method: "POST", body: { template } });
            setMessages((current) => [...current, result.data]);
            setPicking(false);
          }}
        />
      )}
    </>
  );
}

const STATUS_LABEL: Record<string, string> = { queued: "Sending…", sending: "Sending…", sent: "✓", delivered: "✓✓", read: "✓✓ Read" };

function MessageBubble({ message }: { message: Message }) {
  const mediaUrl = `/api/messages/${message.id}/media`;
  const body = useMemo(() => {
    switch (message.type) {
      case "image":
      case "sticker":
        return (
          <a href={mediaUrl} target="_blank" rel="noreferrer">
            <img src={mediaUrl} alt={message.media?.caption || "Photo from the customer"} loading="lazy" />
          </a>
        );
      case "voice":
      case "audio":
        return (
          <>
            <audio controls preload="none" src={mediaUrl} aria-label="Voice note" />
            {message.transcript && (
              <div className="muted" style={{ fontSize: 12 }}>
                {message.transcript === "done" ? "Written out automatically; check against the recording:" : message.transcript === "too_long" ? "Too long to write out automatically; please listen." : "Could not be written out; please listen."}
              </div>
            )}
          </>
        );
      case "video":
        return <video controls preload="none" src={mediaUrl} style={{ maxWidth: "100%" }} />;
      case "document":
        return (
          <a href={mediaUrl} target="_blank" rel="noreferrer">
            Open {message.media?.filename || "document"}
          </a>
        );
      case "location":
        return message.location ? (
          <a href={`https://maps.google.com/?q=${message.location.latitude},${message.location.longitude}`} target="_blank" rel="noreferrer">
            Location: {message.text || `${message.location.latitude}, ${message.location.longitude}`}
          </a>
        ) : null;
      case "template":
        return <span className="muted">Template: {message.template?.name}</span>;
      case "products":
        return <span className="muted">Product list from the catalogue</span>;
      case "unsupported":
        return <span className="muted">This kind of message can't be shown here yet.</span>;
      default:
        return null;
    }
  }, [message, mediaUrl]);

  const showText = message.text && !["location"].includes(message.type);
  return (
    <div className={`bubble ${message.direction}`}>
      {message.purpose === "stylist" && <div className="muted small-text">Stylist (AI)</div>}
      {body}
      {showText && <div>{message.text}</div>}
      {message.status === "failed" && message.error && (
        <div className="failed" role="status">
          Not delivered: {message.error.text.replace(/[.\s]*$/, ".")}
          {message.error.action ? ` ${message.error.action}` : ""}
        </div>
      )}
      <span className="meta">
        {clockTime(message.at)}
        {message.direction === "out" && message.status !== "failed" ? ` · ${STATUS_LABEL[message.status] || message.status}` : ""}
      </span>
    </div>
  );
}

/** The chat's latest order, if any. Customers order by sending a cart from the WhatsApp catalogue. */
function OrderChip({ conversationId }: { conversationId: string }) {
  const [order, setOrder] = useState<{ id: string; label: string; status: string } | null | undefined>(undefined);
  useEffect(() => {
    api<{ prefix: string; orders: { _id: string; number: number; status: string }[] }>(`/api/orders?conversationId=${conversationId}`)
      .then((result) => {
        const latest = result.orders[0];
        setOrder(latest ? { id: latest._id, label: `${result.prefix}-${latest.number}`, status: latest.status } : null);
      })
      .catch(() => setOrder(null));
  }, [conversationId]);
  if (!order) return null;
  return (
    <a className="btn small" href={`#orders/${order.id}`}>
      {order.label} · {order.status.replace(/_/g, " ")}
    </a>
  );
}
