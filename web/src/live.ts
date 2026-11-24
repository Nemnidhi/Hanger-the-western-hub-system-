import { useEffect, useRef, useState } from "react";

/**
 * Live updates from the server (orders, messages, chats). The browser reconnects by itself; after a
 * reconnect `onReconnect` runs, so anything missed while offline is reloaded.
 */
export function useLive(types: string[], onEvent: (type: string, data: Record<string, string>) => void, onReconnect?: () => void) {
  const [connected, setConnected] = useState(true);
  const handler = useRef(onEvent);
  const reconnect = useRef(onReconnect);
  handler.current = onEvent;
  reconnect.current = onReconnect;
  const key = types.join(",");

  useEffect(() => {
    const source = new EventSource("/api/events");
    let wasDown = false;
    const listeners = key.split(",").map((type) => {
      const listener = (event: MessageEvent) => handler.current(type, JSON.parse(event.data));
      source.addEventListener(type, listener);
      return listener;
    });
    source.onerror = () => {
      wasDown = true;
      setConnected(false);
    };
    source.onopen = () => {
      setConnected(true);
      if (wasDown) {
        wasDown = false;
        reconnect.current?.();
      }
    };
    return () => {
      void listeners;
      source.close();
    };
  }, [key]);

  return connected;
}
