import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, ApiError, can, type Me } from "../api";
import { clockTime, phone, rupees, shortTime, timeLeft, when } from "../format";
import { Notice, useLoad } from "../ui";

// Instagram direct messages and comments. Instagram allows replies within 24 hours of her last
// message; after that, reply from the Instagram app. A thread can be linked to a customer by her
// phone, so her orders show here. Comments that matched a keyword rule (Settings > Instagram) got a
// private reply on their own.

interface Thread {
  id: string;
  username: string;
  name: string;
  phone: string;
  contactId: string | null;
  status: "open" | "closed";
  unread: number;
  lastMessageAt: string | null;
  windowOpen: boolean;
  windowEndsAt: string | null;
  last: { direction: "in" | "out"; text: string; kind: string } | null;
}
interface IgMessage { id: string; direction: "in" | "out"; kind: string; text: string; attachments: { type: string; url: string }[]; status: string; error: string; sentBy: string; at: string }
interface ThreadView { connected: boolean; thread: Thread; messages: IgMessage[]; orders: { id: string; number: number; status: string; totalPaise: number; at: string; channel: string }[] }
interface Comment { id: string; username: string; text: string; at: string; keyword: string; privateReply: { status: string; error: string }; publicReply: { status: string; error: string } }

const KIND: Record<string, string> = { comment_reply: "Reply to a comment", story_reply: "Replied to your story", story_mention: "Mentioned you in a story" };
const selectedFromHash = () => window.location.hash.replace(/^#\/?/, "").split("/")[1] || "";
const who = (thread: Thread) => (thread.username ? `@${thread.username}` : thread.name || "Instagram user");

export function Instagram({ me }: { me: Me }) {
  const [tab, setTab] = useState<"open" | "closed" | "comments">("open");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [connected, setConnected] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(selectedFromHash());

  const load = useCallback(async () => {
    if (tab === "comments") return;
    try {
      const result = await api<{ connected: boolean; threads: Thread[] }>(`/api/instagram/threads?status=${tab}`);
      setThreads(result.threads);
      setConnected(result.connected);
      setError("");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not load Instagram messages.");
    }
  }, [tab]);

  useEffect(() => {
    load();
    // No live connection for Instagram: the list refreshes every 20 seconds.
    const timer = window.setInterval(load, 20_000);
    const onHash = () => setSelectedId(selectedFromHash());
    window.addEventListener("hashchange", onHash);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("hashchange", onHash);
    };
  }, [load]);

  return (
    <div className={`inbox ${selectedId && tab !== "comments" ? "has-chat" : ""}`}>
      <section className="chat-list" aria-label="Instagram threads">
        <div className="tools">
          <div className="filters" role="group" aria-label="Show">
            {(["open", "closed", "comments"] as const).map((id) => (
              <button key={id} className={tab === id ? "on" : ""} aria-pressed={tab === id} onClick={() => setTab(id)}>
                {id === "open" ? "Open" : id === "closed" ? "Closed" : "Comments"}
              </button>
            ))}
          </div>
          {!connected && <div className="notice warn" style={{ margin: 0 }}>Instagram is not connected on the server yet (INSTAGRAM_ACCOUNT_ID and INSTAGRAM_ACCESS_TOKEN).</div>}
        </div>
        {tab !== "comments" && (
          <div className="chat-items">
            {error && <div className="notice error" style={{ margin: 12 }}>{error}</div>}
            {!error && threads.length === 0 && <div className="empty">No Instagram messages here yet.</div>}
            {threads.map((thread) => (
              <button key={thread.id} className={`chat-item ${thread.id === selectedId ? "selected" : ""}`} onClick={() => (window.location.hash = `#instagram/${thread.id}`)}>
                <span className="name">{who(thread)}</span>
                <span className="muted" style={{ fontSize: 12 }}>{shortTime(thread.lastMessageAt)}</span>
                <span className="preview">
                  {thread.last?.direction === "out" ? "You: " : ""}
                  {thread.last?.text}
                </span>
                {thread.unread > 0 ? <span className="count" aria-label={`${thread.unread} unread`}>{thread.unread}</span> : <span />}
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="chat" aria-label={tab === "comments" ? "Comments" : "Thread"}>
        {tab === "comments" ? <Comments /> : selectedId ? <ThreadPane key={selectedId} id={selectedId} me={me} onChanged={load} /> : <div className="empty">Choose a thread on the left.</div>}
      </section>
    </div>
  );
}

function ThreadPane({ id, me, onChanged }: { id: string; me: Me; onChanged: () => void }) {
  const [view, setView] = useState<ThreadView | null>(null);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [linking, setLinking] = useState(false);
  const [phoneText, setPhoneText] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const writable = can(me, "inbox:write");

  const load = useCallback(async () => {
    try {
      const result = await api<ThreadView>(`/api/instagram/threads/${id}`);
      setView(result);
      setError("");
      if (result.thread.unread > 0) {
        await api(`/api/instagram/threads/${id}/read`, { method: "POST", body: {} });
        onChanged();
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not load this thread.");
    }
  }, [id, onChanged]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [view?.messages.length]);

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError("");
    try {
      await api(`/api/instagram/threads/${id}/messages`, { method: "POST", body: { text: body } });
      setText("");
      load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not send.");
    } finally {
      setSending(false);
    }
  }
  async function patch(body: { status?: string; phone?: string }) {
    try {
      await api(`/api/instagram/threads/${id}`, { method: "PATCH", body });
      setLinking(false);
      load();
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save.");
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  if (!view) return error ? <Notice>{error}</Notice> : <div className="empty">Loading…</div>;
  const { thread } = view;
  return (
    <>
      <header className="chat-head">
        <button className="btn small back-button" onClick={() => (window.location.hash = "#instagram")} aria-label="Back to threads">
          ←
        </button>
        <div className="title">
          <strong>{who(thread)}</strong>
          <span className="muted">{thread.name && thread.username ? thread.name : ""}{thread.phone ? ` · ${phone(thread.phone)}` : ""}</span>
        </div>
        {thread.windowOpen ? <span className="badge accent">Replies open: {timeLeft(thread.windowEndsAt)}</span> : <span className="badge warn">Reply from the Instagram app</span>}
        {view.orders.map((order) => (
          <a key={order.id} className="btn small" href={`#orders/${order.id}`}>
            #{order.number} · {order.status.replace(/_/g, " ")} · {rupees(order.totalPaise)}
          </a>
        ))}
        {writable && (
          <>
            <button className="btn small" onClick={() => (setPhoneText(thread.phone ? thread.phone.replace(/^91/, "") : ""), setLinking(!linking))}>
              {thread.phone ? "Change customer" : "Link to a customer"}
            </button>
            <button className="btn small" onClick={() => patch({ status: thread.status === "open" ? "closed" : "open" })}>
              {thread.status === "open" ? "Close" : "Reopen"}
            </button>
          </>
        )}
      </header>
      {linking && (
        <form className="composer-row" style={{ padding: "8px 12px" }} onSubmit={(event) => (event.preventDefault(), patch({ phone: phoneText }))}>
          <input className="input" inputMode="tel" placeholder="Her mobile number" value={phoneText} onChange={(event) => setPhoneText(event.target.value)} aria-label="Her mobile number" />
          <button className="btn primary">Link</button>
          {thread.phone && (
            <button type="button" className="btn" onClick={() => patch({ phone: "" })}>
              Unlink
            </button>
          )}
        </form>
      )}
      <div className="messages" aria-live="polite">
        {view.messages.map((message) => (
          <div key={message.id} className={`bubble ${message.direction}`}>
            {KIND[message.kind] && <div className="muted small-text">{KIND[message.kind]}</div>}
            {message.attachments.map((attachment, index) =>
              attachment.type === "image" && attachment.url ? (
                <a key={index} href={attachment.url} target="_blank" rel="noreferrer">
                  <img src={attachment.url} alt="Photo she sent" loading="lazy" />
                </a>
              ) : (
                <div key={index} className="muted">
                  [{attachment.type.replace(/_/g, " ")}]
                </div>
              ),
            )}
            {message.text && <div>{message.text}</div>}
            {message.status === "failed" && <div className="failed">Not sent: {message.error}</div>}
            <span className="meta">
              {clockTime(message.at)}
              {message.direction === "out" ? ` · ${message.status === "queued" ? "Sending…" : message.status === "sent" ? "✓" : message.status}${message.sentBy ? ` · ${message.sentBy}` : ""}` : ""}
            </span>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      {writable && (
        <div className="composer">
          {error && <div className="notice error" style={{ margin: 0 }} role="alert">{error}</div>}
          {!thread.windowOpen && <div className="notice warn" style={{ margin: 0 }}>More than 24 hours since her last message: Instagram only allows a reply from the Instagram app now.</div>}
          <div className="composer-row">
            <textarea className="input" rows={2} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} disabled={!thread.windowOpen || !view.connected} placeholder={thread.windowOpen ? "Write a reply… (Enter to send)" : "Replies are closed here"} aria-label="Reply" />
            <button className="btn primary" onClick={send} disabled={!thread.windowOpen || !view.connected || sending || !text.trim()}>
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

const REPLY: Record<string, string> = { queued: "sending", sent: "sent", failed: "failed" };

function Comments() {
  const loaded = useLoad<{ connected: boolean; comments: Comment[] }>("/api/instagram/comments");
  return (
    <div className="page" style={{ overflow: "auto" }}>
      <h2 className="section-title">Recent comments</h2>
      <p className="muted small-text">A comment with one of your keywords (Settings &gt; Instagram) gets a private reply in her messages, and the short public reply if you set one.</p>
      <Notice>{loaded.error}</Notice>
      {loaded.data && (loaded.data.comments.length ? (
        <div className="table-scroll">
          <table className="table plain">
            <thead>
              <tr>
                <th>From</th>
                <th>Comment</th>
                <th>Keyword</th>
                <th>Replies</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {loaded.data.comments.map((comment) => (
                <tr key={comment.id}>
                  <td>{comment.username ? `@${comment.username}` : "–"}</td>
                  <td>{comment.text}</td>
                  <td>{comment.keyword || <span className="muted">–</span>}</td>
                  <td>
                    {comment.privateReply.status ? `DM ${REPLY[comment.privateReply.status] || comment.privateReply.status}` : <span className="muted">none</span>}
                    {comment.publicReply.status ? ` · public ${REPLY[comment.publicReply.status] || comment.publicReply.status}` : ""}
                    {(comment.privateReply.error || comment.publicReply.error) && <div className="muted small-text">{comment.privateReply.error || comment.publicReply.error}</div>}
                  </td>
                  <td className="muted">{when(comment.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No comments yet.</p>
      ))}
    </div>
  );
}
