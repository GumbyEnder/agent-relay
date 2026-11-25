/**
 * A very small Chrome DevTools Protocol client.
 *
 * The server browser (remoteBrowser.ts) drives a real Chromium that lives somewhere
 * else — a managed cloud browser, or any browser that exposes a DevTools address.
 * This file only knows how to talk to it: JSON messages over a WebSocket, a numbered
 * request with a numbered answer, and events pushed back.
 *
 * It uses the runtime's own `WebSocket` (Node 22 and later; the Docker image is
 * node:22), so it adds no dependency to the production install.
 */

const MAX_MESSAGE = 12 * 1024 * 1024;
type Params = Record<string, unknown>;
type Handler = (params: any, sessionId?: string) => void;

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export class CdpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "CdpError";
  }
}

export class CdpConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<Handler>>();
  private closers = new Set<(why: string) => void>();
  closed = false;

  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev: MessageEvent) => this.onMessage(ev.data));
    ws.addEventListener("close", () => this.shutdown("the browser connection closed"));
    ws.addEventListener("error", () => this.shutdown("the browser connection failed"));
  }

  /** Open a DevTools WebSocket (ws:// or wss://). Rejects after `timeoutMs`. */
  static connect(url: string, timeoutMs = 15_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket !== "function") {
        reject(new CdpError("this server has no WebSocket support (it needs Node 22 or later)"));
        return;
      }
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        reject(new CdpError("that browser address could not be opened"));
        return;
      }
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* already gone */ }
        reject(new CdpError("the browser did not answer in time"));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new CdpError("the browser could not be reached"));
      }, { once: true });
    });
  }

  private onMessage(raw: unknown) {
    // Nothing we ask for is this big (a screencast picture is under a megabyte): a message that is
    // has been made by something that wants us to hold it, and is let go.
    const size = typeof raw === "string" ? raw.length : (raw as ArrayBuffer | undefined)?.byteLength ?? 0;
    if (size > MAX_MESSAGE) return;
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8"));
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(String(msg.error.message || "the browser refused that"), msg.error.code));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === "string") {
      const set = this.handlers.get(msg.method);
      if (!set) return;
      for (const h of [...set]) {
        try { h(msg.params ?? {}, msg.sessionId); } catch { /* one listener must not break the others */ }
      }
    }
  }

  /** Send a command; resolves with its result. `sessionId` aims it at one attached page. */
  send<T = any>(method: string, params: Params = {}, sessionId?: string, timeoutMs = 20_000): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError("the browser connection is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`the browser took too long to answer (${method})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new CdpError("the browser connection is closed"));
      }
    });
  }

  /** Listen for an event. Returns a function that stops listening. */
  on(method: string, handler: Handler): () => void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(handler);
    return () => { set!.delete(handler); };
  }

  /** Called once when the connection ends, for any reason. */
  onClose(fn: (why: string) => void): void {
    if (this.closed) { fn("the browser connection closed"); return; }
    this.closers.add(fn);
  }

  private shutdown(why: string) {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CdpError(why));
    }
    this.pending.clear();
    for (const fn of [...this.closers]) {
      try { fn(why); } catch { /* ignore */ }
    }
    this.closers.clear();
    this.handlers.clear();
  }

  close(): void {
    this.shutdown("closed");
    try { this.ws.close(); } catch { /* already gone */ }
  }
}
