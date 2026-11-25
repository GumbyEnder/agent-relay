/**
 * The server browser (src/lib/buzzy/remoteBrowser.ts), driven for real.
 *
 * It needs a real browser to talk to, so it is not part of test:ci. Give it the DevTools
 * address of any Chromium (the windowless one from the AI-screen helper is fine):
 *
 *   BZ_TEST_CDP=http://127.0.0.1:9354 npx tsx scripts/probe-remote-browser.ts
 *
 * What it checks, against a small page of its own on 127.0.0.1:
 *   1. a browser opens, streams pictures, and says where it runs;
 *   2. a recording: a click on a link, a line typed into a box, a password typed into a
 *      password box (passed on, never written down), a choice from a list, Enter, a scroll;
 *   3. the steps come out in plain words, with what is needed to find each thing again;
 *   4. "Watch it run" plays them back and lands on the same page, with the typed words;
 *   5. a changed page: the same steps still find a button that moved (by its name);
 *   6. a link that opens a new window opens in the same one; a file: address is refused;
 *   7. closing it closes the browser and reports the seconds;
 *   8. the cloud provider's calls (a session with no proxy, stopped on close) against a stand-in.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

const cdp = process.env.BZ_TEST_CDP;
if (!cdp) {
  console.log("skipped: set BZ_TEST_CDP to a DevTools address (see the top of this file)");
  process.exit(0);
}
process.env.BZ_BROWSER_CDP_URL = cdp;
process.env.BZ_BROWSER_PROVIDER = "cdp";
// The pages below are on 127.0.0.1, which the browser refuses unless told it may (tests only).
process.env.BZ_BROWSER_ALLOW_PRIVATE = "1";

const { openBrowserSession, closeAllBrowserSessions } = await import("../src/lib/buzzy/remoteBrowser");
const { CdpConnection } = await import("../src/lib/buzzy/cdp");
type Session = Awaited<ReturnType<typeof openBrowserSession>>;
type Ev = Parameters<Parameters<Session["subscribe"]>[0]>[0];

let pass = 0, fail = 0;
const ok = (name: string, cond: unknown, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await wait(60);
  }
}

// ── A page of our own, laid out at known places ───────────────────────────
const page1 = `<!doctype html><meta charset=utf-8><title>Library desk</title>
<style>body{margin:0;font:18px system-ui} .a{position:absolute}</style>
<h1 class=a style="left:20px;top:10px;margin:0">Library desk</h1>
<a class=a id=next href="/two" style="left:20px;top:80px;font-size:24px">Next page</a>
<label class=a for=nm style="left:20px;top:140px">Your name</label>
<input class=a id=nm name=nm style="left:20px;top:170px;width:300px;height:30px">
<label class=a for=pw style="left:20px;top:220px">Password</label>
<input class=a id=pw type=password style="left:20px;top:250px;width:300px;height:30px">
<select class=a id=color aria-label="Colour" style="left:20px;top:310px;width:200px;height:30px"><option>Red</option><option>Green</option><option>Blue</option></select>
<button class=a id=go style="left:20px;top:370px;width:200px;height:40px" onclick="document.getElementById('out').textContent='Hello '+document.getElementById('nm').value+' / '+document.getElementById('color').value">Say hello</button>
<p class=a id=out style="left:20px;top:430px;margin:0">…</p>
<a class=a id=pop href="/two" target="_blank" style="left:20px;top:500px">Open in a new window</a>
<div class=a style="left:20px;top:1500px">far below</div>`;
const page2 = `<!doctype html><meta charset=utf-8><title>Second page</title><h1>Second page</h1><p>You made it. <a id=back href="/">Back to the desk</a></p>`;
// The same page, with the button moved: names must still find it.
const page1b = page1.replace("left:20px;top:370px;width:200px;height:40px", "left:300px;top:600px;width:200px;height:40px");
const tamper = `<!doctype html><meta charset=utf-8><title>Tamper</title>
<script>String.prototype.slice=function(){return "x"};Element.prototype.getAttribute=function(){return ""};Object.defineProperty(document,"elementFromPoint",{value:function(){return document.body}});</script>
<input id=pw type=password aria-label="Password" style="position:absolute;left:20px;top:100px;width:300px;height:30px">
<button id=ok style="position:absolute;left:20px;top:160px;width:200px;height:40px">Fine</button>`;
const split = `<!doctype html><meta charset=utf-8><title>Split</title>
<input id=mm maxlength=2 aria-label="Month" style="position:absolute;left:20px;top:100px;width:80px;height:30px">
<input id=cvc aria-label="Security code" style="position:absolute;left:120px;top:100px;width:80px;height:30px">
<script>mm.addEventListener("input",function(){ if(mm.value.length>=2) cvc.focus(); })</script>`;
const chat = `<!doctype html><meta charset=utf-8><title>Chat</title>
<textarea id=t aria-label="Message" style="position:absolute;left:20px;top:100px;width:400px;height:100px"></textarea><div id=sent style="position:absolute;left:20px;top:230px"></div>
<script>t.addEventListener("keydown",function(e){ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); sent.textContent="SENT"; } }); document.addEventListener("paste",function(){ document.title="PASTED"; });</script>`;
const confirmPage = `<!doctype html><meta charset=utf-8><title>Confirm</title>
<button id=b style="position:absolute;left:20px;top:100px;width:200px;height:40px" onclick="document.title = confirm('Delete everything?') ? 'deleted' : 'kept'">Delete</button>`;
const popupPage = `<!doctype html><meta charset=utf-8><title>Popup</title>
<a id=p href="/two2" target=_blank style="position:absolute;left:20px;top:100px;font-size:24px">Open the other page</a>`;
const page2back = `<!doctype html><meta charset=utf-8><title>Second page</title><h1>Second page</h1>
<a id=back href="/popup" style="position:absolute;left:20px;top:100px;font-size:24px">Back to the start</a>`;
const cookiePage = `<!doctype html><meta charset=utf-8><title>Cookies</title><p>cookie page</p>`;
let variant = 1;
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (req.url === "/tamper") { res.end(tamper); return; }
  if (req.url === "/split") { res.end(split); return; }
  if (req.url === "/chat") { res.end(chat); return; }
  if (req.url === "/confirm") { res.end(confirmPage); return; }
  if (req.url === "/popup") { res.end(popupPage); return; }
  if (req.url === "/cookies") { res.end(cookiePage); return; }
  if (req.url === "/two2") { res.end(page2back); return; }
  if (req.url === "/two") { res.end(page2); return; }
  res.end(variant === 1 ? page1 : page1b);
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const events: Ev[] = [];
function watch(s: Session) { s.subscribe((e) => events.push(e)); }
const click = (x: number, y: number) => [{ type: "mouse", action: "down", x, y, button: "left", clickCount: 1 }, { type: "mouse", action: "up", x, y, button: "left", clickCount: 1 }] as const;
const typeText = (s: string) => [...s].flatMap((ch) => [{ type: "key", action: "down", key: ch, code: "Key" + ch.toUpperCase() }, { type: "key", action: "up", key: ch, code: "Key" + ch.toUpperCase() }] as const);

try {
  console.log("Opening a browser");
  const s = await openBrowserSession("probe-user", { startUrl: base + "/" });
  watch(s);
  ok("a browser opened and shows the page", await until("the page title", () => s.title === "Library desk" || undefined));
  const frame = await until("a picture", async () => (await s.currentFrame()) as Extract<Ev, { type: "frame" }> | null);
  ok("it streams pictures (a jpeg of the 1280×800 window)", frame.b64.length > 1000 && frame.w === 1280 && frame.h === 800, `${frame.w}x${frame.h} ${frame.b64.length}`);
  ok("it says where it runs", !!s.where && s.where.line.length > 10, JSON.stringify(s.where));
  console.log(`       (${s.where?.line})`);

  console.log("Recording");
  await s.setRecording(true);
  ok("recording starts with going to the open page", s.steps.length === 1 && s.steps[0]!.t === "goto", JSON.stringify(s.steps));
  await s.input([...click(60, 90)] as never);   // the link
  await until("the second page", () => s.title === "Second page" || undefined);
  ok("a click on a link is a step in words", s.steps.some((x) => x.t === "click" && /link “Next page”/.test(x.say)), JSON.stringify(s.steps.map((x) => x.say)));
  await s.history("back");
  await until("back at the desk", () => s.title === "Library desk" || undefined);
  ok("going back is a step", s.steps.some((x) => x.t === "back"), JSON.stringify(s.steps.map((x) => x.t)));

  await s.input([...click(100, 185)] as never);               // the name box
  await s.input(typeText("Ada") as never);
  await s.input([...click(100, 265)] as never);               // the password box: flushes the name
  await s.input(typeText("hunter22") as never);
  await s.input([{ type: "key", action: "down", key: "Tab", code: "Tab" }, { type: "key", action: "up", key: "Tab", code: "Tab" }] as never);
  const typed = await until("the name step", () => s.steps.find((x) => x.t === "type" && x.on?.name === "Your name"));
  ok("the line typed becomes one step with its value", typed.v === "Ada", JSON.stringify(typed));
  ok("the click that only put the cursor there is folded into the typing", !s.steps.some((x) => x.t === "click" && x.on?.sel === "#nm"), JSON.stringify(s.steps.map((x) => x.say)));
  const pw = s.steps.find((x) => x.t === "type" && x.secret);
  ok("a password is a step, with its value NOT written down", !!pw && pw.v === undefined && !JSON.stringify(s.steps).includes("hunter22"), JSON.stringify(pw));
  ok("the password step says to enter it yourself", !!pw && /not recorded/.test(pw.say), pw?.say);
  ok("Tab is a step", s.steps.some((x) => x.t === "key" && x.key === "Tab"));

  // The list: its choices are offered in the window, then chosen.
  await s.input([...click(100, 325)] as never);
  const pick = await until("the list's choices", () => events.find((e) => e.type === "pick") as Extract<Ev, { type: "pick" }> | undefined);
  ok("a list offers its choices", pick.options.map((o) => o.text).join() === "Red,Green,Blue", JSON.stringify(pick.options));
  await s.input([{ type: "choose", x: pick.x, y: pick.y, index: 2 }] as never);
  await until("the choice step", () => s.steps.find((x) => x.t === "select"));
  ok("a choice from a list is a step with the choice", s.steps.find((x) => x.t === "select")?.v === "Blue");

  await s.input([...click(100, 390)] as never);               // Say hello
  await wait(500);
  ok("the real page reacted to the real click", (await (async () => { const f = await s.currentFrame(); return f; })()) !== null);
  await s.input([{ type: "wheel", x: 600, y: 400, dy: 300 }] as never);
  await until("the scroll step", () => s.steps.find((x) => x.t === "scroll"), 3000);
  await s.setRecording(false);
  ok("recording stopped", !s.recording);
  console.log("       steps:\n         " + s.steps.map((x, i) => `${i + 1}. ${x.say}${x.v ? ` [${x.v}]` : ""}${x.secret ? " [secret]" : ""}`).join("\n         "));
  ok("every step has plain words, no emoji", s.steps.every((x) => x.say.length > 2 && !/[\u{1F300}-\u{1FAFF}]/u.test(x.say)));

  console.log("Watching it run");
  const mark = events.length;
  await s.history("reload");
  await s.replay(s.steps);
  const done = await until("the replay to finish", () => events.slice(mark).find((e) => e.type === "replay-done") as Extract<Ev, { type: "replay-done" }> | undefined, 40_000);
  ok("the replay says it played every step", done.ok, JSON.stringify(done));
  ok("a step left to the person (the password) is named, not typed", /left for you/.test(done.note), done.note);
  ok("it ends on the same page, with what was typed", /Hello Ada/.test(done.text) && /Blue/.test(done.text), done.text);

  console.log("A page that changed");
  variant = 2;
  const mark2 = events.length;
  await s.replay(s.steps);
  const done2 = await until("the second replay", () => events.slice(mark2).find((e) => e.type === "replay-done") as Extract<Ev, { type: "replay-done" }> | undefined, 40_000);
  ok("the same steps find a button that moved, by its name", done2.ok && /Hello Ada/.test(done2.text), JSON.stringify(done2));

  console.log("Safety");
  const bad = await s.goto("file:///etc/hosts");
  ok("a file: address is refused", !bad.ok, JSON.stringify(bad));
  const bad2 = await s.goto("javascript:alert(1)");
  ok("a javascript: address is refused", !bad2.ok);
  variant = 1;
  await s.goto(base + "/");
  await until("the desk again", () => s.title === "Library desk" || undefined);
  await wait(400);
  await s.input([...click(40, 510)] as never);                // the target=_blank link
  await until("the new window's page in this window", () => s.title === "Second page" || undefined, 10_000);
  ok("a link that opens a new window opens in the same one", s.title === "Second page", s.title);

  console.log("Closing");
  let closed: { seconds: number; reason: string } | undefined;
  s.onClosed = (i) => { closed = i; };
  await closeAllBrowserSessions();
  ok("closing reports the seconds it was open", !!closed && closed.seconds >= 1, JSON.stringify(closed));
  ok("the stream is told it ended", events.some((e) => e.type === "ended"));

  // ── What the review found ───────────────────────────────────────────────
  console.log("What the review found");
  const browserWs = (await (await fetch(cdp.replace(/\/+$/, "") + "/json/version")).json() as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
  const peek = await CdpConnection.connect(browserWs);
  /** Run something in a page of the test browser (by part of its address), as a bystander. */
  async function inPage(part: string, expression: string): Promise<unknown> {
    const list = await peek.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
    const t = list.targetInfos.find((x) => x.type === "page" && x.url.includes(part));
    if (!t) return undefined;
    const sid = (await peek.send<{ sessionId: string }>("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
    const r = await peek.send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression, returnByValue: true }, sid);
    await peek.send("Target.detachFromTarget", { sessionId: sid }).catch(() => {});
    return r.result?.value;
  }
  const open = async (user: string, path: string, extra: Record<string, unknown> = {}) => {
    const x = await openBrowserSession(user, { startUrl: base + path, ...extra });
    const seenEvents: Ev[] = [];
    x.subscribe((e) => seenEvents.push(e));
    await wait(700);
    return { x, seenEvents };
  };
  const key = (k: string, mods = 0) => [{ type: "key", action: "down", key: k, code: k, mods }, { type: "key", action: "up", key: k, code: k, mods }] as const;

  // 1. Two people on one browser never share a login.
  {
    const a = await open("alice", "/cookies");
    await inPage("/cookies", `document.cookie = "who=alice; path=/"; localStorage.setItem("who","alice"); 1`);
    const b = await open("bob", "/cookies");
    // Bob's page is the other /cookies tab: ask every /cookies page what it holds.
    const list = await peek.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
    const pages = list.targetInfos.filter((t) => t.type === "page" && t.url.includes("/cookies"));
    const holds: string[] = [];
    for (const t of pages) {
      const sid = (await peek.send<{ sessionId: string }>("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
      const r = await peek.send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression: "document.cookie + '|' + (localStorage.getItem('who') || '')", returnByValue: true }, sid);
      holds.push(String(r.result?.value)); await peek.send("Target.detachFromTarget", { sessionId: sid }).catch(() => {});
    }
    ok("two people on one browser each get their own: one page holds the login, the other nothing", pages.length === 2 && holds.filter((h) => h.includes("alice")).length === 1 && holds.filter((h) => h === "|").length === 1, JSON.stringify(holds));
    await a.x.close("closed"); await b.x.close("closed");
  }

  // 2. A page that tampers with the page's own tools cannot hide a password box.
  {
    const { x } = await open("carol", "/tamper");
    await x.setRecording(true);
    await x.input([...click(100, 115)] as never);
    await x.input(typeText("hunter22") as never);
    await x.input([...click(100, 180)] as never);
    await wait(500);
    const pw = x.steps.find((st) => st.t === "type");
    ok("a page that replaces String, getAttribute and elementFromPoint still can't pass a password off as a plain box", !!pw && pw.secret === true && pw.v === undefined && !JSON.stringify(x.steps).includes("hunter22"), JSON.stringify(x.steps));
    ok("…and the click on the button is still named by what the page shows", x.steps.some((st) => st.t === "click" && st.on?.name === "Fine"), JSON.stringify(x.steps.map((st) => st.say)));
    await x.close("closed");
  }

  // 3. A cursor that jumps on by itself: what was typed is not written down.
  {
    const { x, seenEvents } = await open("dave", "/split");
    await x.setRecording(true);
    await x.input([...click(60, 115)] as never);
    await x.input(typeText("1234") as never);
    await wait(1900);
    await x.setRecording(false);
    ok("an expiry that jumps to the security code leaves nothing recorded from either box", !JSON.stringify(x.steps).includes("34") && !x.steps.some((st) => st.t === "type" && st.v), JSON.stringify(x.steps));
    ok("…and says why", seenEvents.some((e) => e.type === "notice" && /moved on by itself/.test((e as { text: string }).text)));
    await x.close("closed");
  }

  // 4. Shift+Enter is not Enter.
  {
    const { x } = await open("erin", "/chat");
    await x.setRecording(true);
    await x.input([...click(100, 150)] as never);
    await x.input(typeText("hi") as never);
    await x.input(key("Enter", 8) as never);
    await wait(500);
    await x.setRecording(false);
    const k = x.steps.find((st) => st.t === "key");
    ok("Shift+Enter is recorded as Shift+Enter", k?.key === "Shift+Enter" && /Shift\+Enter/.test(k.say), JSON.stringify(x.steps.map((st) => st.say)));
    const mark = events.length;
    watch(x);
    await x.history("reload");
    await wait(600);
    await x.replay(x.steps);
    await until("the replay", () => events.slice(mark).find((e) => e.type === "replay-done"), 30_000);
    const after = await inPage("/chat", `JSON.stringify({ v: document.getElementById("t").value, sent: document.getElementById("sent").textContent })`);
    const st = JSON.parse(String(after));
    ok("played back, it breaks the line and does not send", st.v === "hi\n" && st.sent === "", String(after));
    await x.close("closed");
  }

  // 5. A page's own question is answered No, never OK.
  {
    const { x, seenEvents } = await open("fay", "/confirm");
    await x.input([...click(100, 120)] as never);
    await wait(1000);
    const title = await inPage("/confirm", "document.title");
    ok("a page that asks 'Delete everything?' is told No", title === "kept", String(title));
    ok("…and the person is told it was answered", seenEvents.some((e) => e.type === "notice" && /answered No/.test((e as { text: string }).text)));
    await x.close("closed");
  }

  // 6. A link that opens a window is followed while playing, too.
  {
    const { x } = await open("gus", "/popup");
    await x.setRecording(true);
    await x.input([...click(100, 115)] as never);
    await until("the other page", () => x.title === "Second page" || undefined, 10_000);
    await x.setRecording(false);
    await x.goto(base + "/popup");
    await until("the popup page again", () => x.title === "Popup" || undefined);
    const mark = events.length;
    watch(x);
    await x.replay(x.steps);
    const d = await until("the replay", () => events.slice(mark).find((e) => e.type === "replay-done") as Extract<Ev, { type: "replay-done" }> | undefined, 30_000);
    ok("a recording that went through a new window plays through it", d.ok && /Second page/.test(d.title + d.text), JSON.stringify(d));
    await x.close("closed");
  }

  // 6b. A window opened in the middle of a recording is waited for before the next step.
  {
    const { x } = await open("gus2", "/popup");
    await x.setRecording(true);
    await x.input([...click(100, 115)] as never);
    await until("the second page", () => x.title === "Second page" || undefined, 10_000);
    await x.input([...click(100, 115)] as never);                 // "Back to the start", on the new page
    await until("back at the popup page", () => x.title === "Popup" || undefined, 10_000);
    await x.setRecording(false);
    await x.goto(base + "/popup");
    await until("the popup page again", () => x.title === "Popup" || undefined);
    const mark = events.length;
    watch(x);
    await x.replay(x.steps);
    const d = await until("the replay", () => events.slice(mark).find((e) => e.type === "replay-done") as Extract<Ev, { type: "replay-done" }> | undefined, 40_000);
    ok("a step that opens a window is waited for, so the next step finds its page", d.ok && d.title === "Popup", JSON.stringify(d));
    await x.close("closed");
  }

  // 6c. The keyboard's copy / cut / paste never reach a browser that other people share.
  {
    const { x } = await open("ned", "/chat");
    await x.input([...click(100, 150)] as never);
    // A control: the same key sent straight to the page does paste (so the check below means something).
    const list = await peek.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
    const target = list.targetInfos.find((t) => t.type === "page" && t.url.includes("/chat"));
    let controlWorks = false;
    if (target) {
      const sid = (await peek.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
      await peek.send("Input.dispatchKeyEvent", { type: "keyDown", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2, commands: ["paste"] }, sid);
      await wait(300);
      controlWorks = (await inPage("/chat", "document.title")) === "PASTED";
      await inPage("/chat", "document.title = 'Chat'; 1");
      await peek.send("Target.detachFromTarget", { sessionId: sid }).catch(() => {});
    }
    await x.input(key("v", 2) as never);
    await x.input(key("x", 4) as never);
    await x.input(key("Insert", 8) as never);
    await wait(400);
    const title = await inPage("/chat", "document.title");
    ok(controlWorks ? "Ctrl+V sent to the server browser is dropped (the same key sent past it does paste)" : "Ctrl+V sent to the server browser does not paste", title !== "PASTED", String(title));
    await x.close("closed");
  }

  // 6d. A fourth window takes the place of the oldest; a person is never locked out of their own browser.
  {
    const { x } = await open("opal", "/chat");
    const dropped: number[] = [];
    for (let i = 1; i <= 4; i++) x.subscribe(() => {}, () => dropped.push(i));
    ok("the fourth window to watch a browser replaces the oldest", dropped.join() === "1" && x.streamCount() === 3, `${dropped.join()} ${x.streamCount()}`);
    await x.close("closed");
  }

  // 7. Two plays can't run at once; two batches of typing keep their order.
  {
    const { x, seenEvents } = await open("hal", "/chat");
    await x.input([...click(100, 150)] as never);
    await Promise.all([x.input(typeText("ab") as never), x.input(typeText("c") as never)]);
    await wait(500);
    ok("two batches of typing sent one straight after the other arrive in order", (await inPage("/chat", "document.getElementById('t').value")) === "abc");
    x.loadSteps([{ t: "goto", say: "Go", url: base + "/two" }, { t: "scroll", say: "Scroll", dy: 100 }]);
    await Promise.all([x.replay(x.steps), x.replay(x.steps)]);
    await wait(1500);
    ok("a second play started while one is running does nothing", seenEvents.filter((e) => e.type === "replay-done").length === 1, String(seenEvents.filter((e) => e.type === "replay-done").length));
    ok("a flood is counted (backlog and windows are known to the route)", typeof x.backlog() === "number" && x.streamCount() === 1);
    await x.close("closed");
  }

  // 8. Limits: its own time, how many at once, one opening at a time per person, billed as it goes.
  {
    const billed: number[] = [];
    let closedWhy = "";
    const t0 = Date.now();
    const x = await openBrowserSession("ida", { maxSeconds: 3, onBill: (n) => billed.push(n), onClosed: (i) => { closedWhy = i.reason; } });
    await until("its time to run out", () => closedWhy === "time" || undefined, 25_000);
    ok("a browser with 3 seconds left closes on its own, and says why", closedWhy === "time" && Date.now() - t0 < 25_000, closedWhy);
    ok("…and its seconds were counted", billed.reduce((a, b) => a + b, 0) >= 1, JSON.stringify(billed));
    void x;
    const results = await Promise.allSettled([openBrowserSession("jon", {}), openBrowserSession("jon", {})]);
    ok("two browsers opened for one person at the same moment: one opens, one is turned away", results.filter((r) => r.status === "fulfilled").length === 1 && results.some((r) => r.status === "rejected" && /already opening/.test(String((r as PromiseRejectedResult).reason?.message))), JSON.stringify(results.map((r) => r.status)));
    await closeAllBrowserSessions();
    process.env.BZ_BROWSER_MAX_SESSIONS = "1";
    const one = await openBrowserSession("kay", {});
    let busy = "";
    try { await openBrowserSession("lee", {}); } catch (e) { busy = (e as Error).message; }
    ok("when the server's browsers are all in use, the next person is told so", /all in use/.test(busy), busy);
    await one.close("closed");
    delete process.env.BZ_BROWSER_MAX_SESSIONS;
  }

  // 9. The browser doesn't open private or internal addresses (the guard, with the test allowance off).
  {
    process.env.BZ_BROWSER_ALLOW_PRIVATE = "";
    let startedAtPublic = true;
    const x = await openBrowserSession("mia", { startUrl: "https://example.com/" }).catch(() => { startedAtPublic = false; return null; });
    if (x) {
      await until("the public page", () => /example/i.test(x.title) || undefined, 15_000).catch(() => { startedAtPublic = false; });
      for (const u of ["http://127.0.0.1:1/", "http://localhost:9222/json/list", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/admin", "http://[::ffff:7f00:1]/", "http://metadata.google.internal/"]) {
        const r = await x.goto(u);
        ok(`the address bar refuses ${u}`, !r.ok, JSON.stringify(r));
      }
      if (startedAtPublic) {
        // A page that sends itself somewhere inside, the way a link or a redirect would.
        const evs: Ev[] = [];
        x.subscribe((e) => evs.push(e));
        await inPage("example.com", "location.href = 'http://127.0.0.1:1/'; 1");
        await wait(2500);
        ok("a page that sends itself to a private address is stopped on the way, and the person is told", evs.some((e) => e.type === "notice" && /private or internal/.test((e as { text: string }).text)), JSON.stringify(evs.filter((e) => e.type === "notice")));
        ok("…what loaded is the browser's own error page, not what was at that address", !/^(Example|Library)/i.test(x.title), x.title);
      } else console.log("  (no internet here: the redirect check was skipped)");
      await x.close("closed");
    }
    process.env.BZ_BROWSER_ALLOW_PRIVATE = "1";
  }
  peek.close();

  // The cloud provider, against a stand-in for its API that hands out this test browser.
  console.log("The cloud provider (against a stand-in for its API)");
  const wsUrl = (await (await fetch(cdp.replace(/\/+$/, "") + "/json/version")).json() as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
  const calls: { method: string; url: string; key?: string; body?: string }[] = [];
  const fake = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      calls.push({ method: req.method ?? "", url: req.url ?? "", key: String(req.headers["x-api-key"] ?? ""), body: Buffer.concat(chunks).toString() });
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/api/session") { res.end(JSON.stringify({ id: "sess-123", wsEndpoint: wsUrl, liveUrl: "https://example.invalid/live" })); return; }
      if (req.method === "PUT" && req.url === "/api/session/sess-123/stop") { res.end(JSON.stringify({ success: true })); return; }
      res.statusCode = 404; res.end("{}");
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => fake.once("listening", r));
  const prev = { k: process.env.BZ_HYPERBROWSER_KEY, b: process.env.BZ_HYPERBROWSER_BASE, p: process.env.BZ_BROWSER_PROVIDER };
  process.env.BZ_HYPERBROWSER_KEY = "test-key-not-real";
  process.env.BZ_HYPERBROWSER_BASE = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/api`;
  process.env.BZ_BROWSER_PROVIDER = "hyperbrowser";
  const hb = await openBrowserSession("probe-user-2", { startUrl: base + "/" });
  ok("a cloud session opens", await until("the cloud page", () => hb.title === "Library desk" || undefined));
  ok("it asked the provider for a session with no proxy, using the key", calls.some((c) => c.method === "POST" && c.url === "/api/session" && c.key === "test-key-not-real" && JSON.parse(c.body || "{}").useProxy === false), JSON.stringify(calls));
  ok("it names itself a cloud browser", /cloud browser/i.test(hb.hello().type === "hello" ? (hb.hello() as { label: string }).label : ""));
  await hb.close("closed");
  ok("closing it stops the provider's session (it stops costing money)", calls.some((c) => c.method === "PUT" && c.url === "/api/session/sess-123/stop" && c.key === "test-key-not-real"), JSON.stringify(calls));
  process.env.BZ_HYPERBROWSER_BASE = "http://127.0.0.1:9/api";
  let refused = "";
  try { await openBrowserSession("probe-user-3", {}); } catch (e) { refused = (e as Error).message; }
  ok("a provider that can't be reached is said plainly, not a crash", /couldn't reach the browser service/.test(refused), refused);
  fake.close();
  process.env.BZ_HYPERBROWSER_KEY = prev.k ?? ""; process.env.BZ_HYPERBROWSER_BASE = prev.b ?? ""; process.env.BZ_BROWSER_PROVIDER = prev.p ?? "";
} catch (e) {
  fail++;
  console.log("  FAIL " + (e as Error).message);
  console.log((e as Error).stack);
} finally {
  await closeAllBrowserSessions().catch(() => {});
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
