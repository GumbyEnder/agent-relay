/**
 * Human-readable HTML shell for public agent docs (client guide, skill).
 * Agents still get raw markdown from the same URLs when they ask for it.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Minimal GFM-ish markdown → HTML (no dependency). Good enough for our guides. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  let inUl = false;
  let inOl = false;
  let inTable = false;
  let tableHeaderDone = false;

  const closeLists = () => {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      out.push("</ol>");
      inOl = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      out.push("</tbody></table>");
      inTable = false;
      tableHeaderDone = false;
    }
  };

  const inline = (text: string): string => {
    let t = escapeHtml(text);
    // links [text](url)
    t = t.replace(
      /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" rel="noopener noreferrer">$1</a>',
    );
    // bare URLs in backticks already escaped; inline code
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    // bold
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // italic
    t = t.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
    return t;
  };

  while (i < lines.length) {
    const line = lines[i]!;

    // fenced code
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      closeLists();
      closeTable();
      if (!inCode) {
        inCode = true;
        codeLang = fence[1] || "";
        codeBuf = [];
      } else {
        out.push(
          `<pre class="code"><code class="lang-${escapeHtml(codeLang)}">${escapeHtml(codeBuf.join("\n"))}</code></pre>`,
        );
        inCode = false;
        codeLang = "";
        codeBuf = [];
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }

    // table rows
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      closeLists();
      const cells = line
        .trim()
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      // separator |---|---|
      if (cells.every((c) => /^:?-+:?$/.test(c))) {
        i++;
        continue;
      }
      if (!inTable) {
        out.push('<div class="table-wrap"><table><thead><tr>');
        for (const c of cells) out.push(`<th>${inline(c)}</th>`);
        out.push("</tr></thead><tbody>");
        inTable = true;
        tableHeaderDone = true;
      } else {
        out.push("<tr>");
        for (const c of cells) out.push(`<td>${inline(c)}</td>`);
        out.push("</tr>");
      }
      i++;
      continue;
    } else {
      closeTable();
    }

    // headings
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      closeLists();
      const level = h[1]!.length;
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
      i++;
      continue;
    }

    // hr
    if (/^---+$/.test(line.trim())) {
      closeLists();
      out.push("<hr />");
      i++;
      continue;
    }

    // ul
    const ul = line.match(/^[-*]\s+(.+)$/);
    if (ul) {
      if (inOl) {
        out.push("</ol>");
        inOl = false;
      }
      if (!inUl) {
        out.push("<ul>");
        inUl = true;
      }
      out.push(`<li>${inline(ul[1]!)}</li>`);
      i++;
      continue;
    }

    // ol
    const ol = line.match(/^\d+\.\s+(.+)$/);
    if (ol) {
      if (inUl) {
        out.push("</ul>");
        inUl = false;
      }
      if (!inOl) {
        out.push("<ol>");
        inOl = true;
      }
      out.push(`<li>${inline(ol[1]!)}</li>`);
      i++;
      continue;
    }

    closeLists();

    if (!line.trim()) {
      i++;
      continue;
    }

    // paragraph (merge consecutive non-empty)
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^#{1,3}\s/.test(lines[i]!) &&
      !/^[-*]\s/.test(lines[i]!) &&
      !/^\d+\.\s/.test(lines[i]!) &&
      !/^```/.test(lines[i]!) &&
      !/^---+$/.test(lines[i]!.trim()) &&
      !(lines[i]!.trim().startsWith("|") && lines[i]!.trim().endsWith("|"))
    ) {
      para.push(lines[i]!);
      i++;
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }

  closeLists();
  closeTable();
  if (inCode) {
    out.push(
      `<pre class="code"><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`,
    );
  }

  return out.join("\n");
}

export function renderDocsHtmlPage(opts: {
  title: string;
  subtitle?: string;
  markdown: string;
  rawPath: string;
  baseUrl: string;
}): string {
  const base = opts.baseUrl.replace(/\/$/, "");
  const body = markdownToHtml(opts.markdown);
  const rawUrl = opts.rawPath.startsWith("http")
    ? opts.rawPath
    : `${base}${opts.rawPath.startsWith("/") ? "" : "/"}${opts.rawPath}`;
  const rawMdUrl = rawUrl.includes("?")
    ? `${rawUrl}&format=md`
    : `${rawUrl}${rawUrl.includes("/api/") ? (rawUrl.includes("?") ? "&" : "?") + "format=md" : "?format=md"}`;
  // Prefer clean raw path with format=md
  const agentRaw =
    opts.rawPath.includes("/api/")
      ? `${base}${opts.rawPath.split("?")[0]}?format=md`
      : `${base}${opts.rawPath}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)} · Dev Boards</title>
  <meta name="description" content="${escapeHtml(opts.subtitle ?? opts.title)}" />
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0c0f;
      --bg-elev: #12141a;
      --fg: #e8eaef;
      --muted: #9aa3b2;
      --subtle: #6b7380;
      --border: #242833;
      --accent: #6ee7b7;
      --accent-dim: color-mix(in oklab, var(--accent) 18%, transparent);
      --code-bg: #0a0b0e;
      --radius: 12px;
      --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--font);
      background: var(--bg);
      color: var(--fg);
      line-height: 1.6;
      font-size: 16px;
    }
    a { color: var(--accent); text-underline-offset: 3px; }
    a:hover { text-decoration: underline; }
    .top {
      position: sticky; top: 0; z-index: 10;
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;
      padding: 12px 20px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in oklab, var(--bg-elev) 92%, transparent);
      backdrop-filter: blur(10px);
    }
    .brand { display: flex; align-items: center; gap: 10px; text-decoration: none; color: var(--fg); }
    .brand-mark {
      width: 28px; height: 28px; border-radius: 8px;
      background: var(--accent); color: #0a0a0b;
      display: grid; place-items: center; font-weight: 700; font-size: 13px;
    }
    .brand span { font-weight: 600; letter-spacing: -0.02em; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .btn {
      appearance: none; border: 1px solid var(--border); background: var(--bg-elev);
      color: var(--fg); border-radius: 8px; padding: 7px 12px; font-size: 13px;
      font-family: inherit; cursor: pointer; text-decoration: none;
    }
    .btn:hover { border-color: color-mix(in oklab, var(--accent) 40%, var(--border)); }
    .btn-primary { background: var(--accent-dim); border-color: color-mix(in oklab, var(--accent) 35%, var(--border)); color: var(--fg); }
    .wrap { max-width: 760px; margin: 0 auto; padding: 28px 20px 80px; }
    .hero { margin-bottom: 28px; }
    .hero .eyebrow {
      font-family: var(--mono); font-size: 11px; letter-spacing: 0.12em;
      text-transform: uppercase; color: var(--accent); margin: 0 0 8px;
    }
    .hero h1 {
      font-size: clamp(1.6rem, 3vw, 2rem); letter-spacing: -0.03em;
      margin: 0 0 8px; font-weight: 650; line-height: 1.2;
    }
    .hero p { margin: 0; color: var(--muted); font-size: 15px; }
    .callout {
      margin: 0 0 28px; padding: 14px 16px; border-radius: var(--radius);
      border: 1px solid var(--border); background: var(--bg-elev);
      color: var(--muted); font-size: 14px;
    }
    .callout strong { color: var(--fg); }
    .doc h1 { font-size: 1.5rem; margin: 1.6em 0 0.5em; letter-spacing: -0.02em; }
    .doc h2 { font-size: 1.2rem; margin: 1.5em 0 0.45em; letter-spacing: -0.02em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
    .doc h3 { font-size: 1.05rem; margin: 1.25em 0 0.4em; color: var(--fg); }
    .doc p { margin: 0.65em 0; color: var(--fg); }
    .doc ul, .doc ol { margin: 0.5em 0 0.8em; padding-left: 1.35em; color: var(--fg); }
    .doc li { margin: 0.25em 0; }
    .doc hr { border: 0; border-top: 1px solid var(--border); margin: 2em 0; }
    .doc code {
      font-family: var(--mono); font-size: 0.88em;
      background: var(--code-bg); border: 1px solid var(--border);
      border-radius: 5px; padding: 0.1em 0.35em;
    }
    .doc pre.code {
      overflow-x: auto; padding: 14px 16px; border-radius: var(--radius);
      background: var(--code-bg); border: 1px solid var(--border);
      margin: 1em 0;
    }
    .doc pre.code code {
      border: 0; background: transparent; padding: 0; font-size: 13px;
      line-height: 1.5; color: #d5d9e2;
    }
    .doc .table-wrap { overflow-x: auto; margin: 1em 0; }
    .doc table { width: 100%; border-collapse: collapse; font-size: 14px; }
    .doc th, .doc td {
      border: 1px solid var(--border); padding: 8px 10px; text-align: left;
    }
    .doc th { background: var(--bg-elev); color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
    .footer {
      margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--border);
      color: var(--subtle); font-size: 13px;
    }
    .toast {
      position: fixed; bottom: 20px; right: 20px; padding: 10px 14px;
      background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px;
      font-size: 13px; opacity: 0; pointer-events: none; transition: opacity .2s;
    }
    .toast.show { opacity: 1; }
  </style>
</head>
<body>
  <header class="top">
    <a class="brand" href="${escapeHtml(base)}/">
      <div class="brand-mark">DB</div>
      <span>Dev Boards</span>
    </a>
    <div class="actions">
      <button type="button" class="btn btn-primary" id="copy-raw">Copy markdown for agents</button>
      <a class="btn" href="${escapeHtml(agentRaw)}" rel="noopener">Raw markdown</a>
      <a class="btn" href="${escapeHtml(base)}/login">Open app</a>
    </div>
  </header>
  <main class="wrap">
    <div class="hero">
      <p class="eyebrow">Docs</p>
      <h1>${escapeHtml(opts.title)}</h1>
      ${opts.subtitle ? `<p>${escapeHtml(opts.subtitle)}</p>` : ""}
    </div>
    <div class="callout">
      <strong>For people:</strong> read this page.
      <strong>For agents:</strong> use the raw markdown URL
      (<code style="font-family:var(--mono);font-size:12px">${escapeHtml(agentRaw)}</code>)
      or click <em>Copy markdown for agents</em>.
    </div>
    <article class="doc">
${body}
    </article>
    <p class="footer">
      Dev Boards · mission control for AI agents and the operators who run them ·
      <a href="${escapeHtml(base)}/">app</a>
    </p>
  </main>
  <div class="toast" id="toast">Markdown copied</div>
  <script type="application/json" id="raw-md">${JSON.stringify(opts.markdown)}</script>
  <script>
    (function () {
      var btn = document.getElementById("copy-raw");
      var toast = document.getElementById("toast");
      var rawEl = document.getElementById("raw-md");
      if (!btn || !rawEl) return;
      var md = JSON.parse(rawEl.textContent || '""');
      btn.addEventListener("click", function () {
        navigator.clipboard.writeText(md).then(function () {
          toast.classList.add("show");
          setTimeout(function () { toast.classList.remove("show"); }, 1600);
        }).catch(function () {
          toast.textContent = "Copy failed — use Raw markdown";
          toast.classList.add("show");
        });
      });
    })();
  </script>
</body>
</html>`;
}

/** Prefer HTML for browsers; markdown for agents/curl. */
export function wantsHtmlDocs(req: Request, url: URL): boolean {
  const fmt = (url.searchParams.get("format") ?? "").toLowerCase();
  if (fmt === "md" || fmt === "markdown" || fmt === "raw") return false;
  if (fmt === "html") return true;
  if (fmt === "json") return false;
  const accept = (req.headers.get("accept") ?? "").toLowerCase();
  // Explicit markdown wins
  if (accept.includes("text/markdown") && !accept.includes("text/html")) return false;
  // Browsers send text/html first
  if (accept.includes("text/html")) return true;
  // No Accept / */* → markdown (agent-friendly default)
  return false;
}
