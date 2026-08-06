/**
 * Human docs HTML: browsers get HTML; agents still get markdown.
 */
import { markdownToHtml, wantsHtmlDocs } from "../src/lib/docs-html";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

const html = markdownToHtml(`# Hello

This is **bold** and \`code\`.

- one
- two

\`\`\`bash
echo hi
\`\`\`
`);
assert(html.includes("<h1>"), "h1");
assert(html.includes("<strong>bold</strong>"), "bold");
assert(html.includes("<code>code</code>"), "inline code");
assert(html.includes("<ul>"), "list");
assert(html.includes("<pre class=\"code\">"), "fence");
assert(!html.includes("<script>"), "no raw script from md");

const browser = new Request("https://app.devboards.ai/api/agent/client-guide", {
  headers: { accept: "text/html,application/xhtml+xml" },
});
assert(
  wantsHtmlDocs(browser, new URL(browser.url)),
  "browser wants html",
);

const agent = new Request("https://app.devboards.ai/api/agent/client-guide", {
  headers: { accept: "*/*" },
});
assert(!wantsHtmlDocs(agent, new URL(agent.url)), "agent default markdown");

const forcedMd = new Request(
  "https://app.devboards.ai/api/agent/client-guide?format=md",
  { headers: { accept: "text/html" } },
);
assert(
  !wantsHtmlDocs(forcedMd, new URL(forcedMd.url)),
  "format=md forces markdown",
);

console.log("test-docs-html: ok");
