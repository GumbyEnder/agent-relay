# Chrome injection anchors — the one place the reasons live

`src/lib/buzzy/pages.nitro.ts` rewrites every `/buzzy/*` HTML response at serve time.
Two anchors are load-bearing and they do **not** simplify together. Their reasons are
already written in the code as comments; this file exists so that every reader —
agent skill, human, review walk — points at the code instead of retyping it.

## Primary source of truth

`src/lib/buzzy/pages.nitro.ts`, the comment block at **lines 144–147** plus the code
at **:178–184**, landed in `0447105` (`fix(chrome): a skeleton instead of 'Sign in',
and one header box (BZ-15, BZ-11 residual)`).

Read it with:

    git show 0447105 -- src/lib/buzzy/pages.nitro.ts
    git show HEAD:src/lib/buzzy/pages.nitro.ts | sed -n '144,184p'

## The two anchors

1. **Nav row — first `</nav>`, not last.**
   `page.replace(/(<nav id="bzNav"[^>]*>)[\s\S]*?(<\/nav>)/, …)` — the regex is
   non-greedy (`[\s\S]*?`) and has no `g` flag, so it stops at the **first** `</nav>`
   after the `#bzNav` open tag. A "last `</nav>`" reading changes the shipped bytes.

2. **Script tag — last `</body>`, not first.**
   `page.lastIndexOf("</body>")`. At `20843c2`, `public/buzzy/talk.html` contains
   **two** `</body>`:

   - **line 4375** — inside a Word-export JS string literal:
     `var full = '<html …><body>' + mdToWordHtml(text) + "</body></html>";`
   - **line 5774** — the real document close.

   Replacing the first match injects `<script src="/buzzy/nav.js" defer></script>`
   into a JavaScript string → `Invalid or unexpected token` → every later script on
   the page is dead → Talk and Library render blank while the HTML still looks
   plausible. `vite build` and a `new Function` check on the **source** file both pass
   straight through it, because neither executes the injected page.

## Do not restate the byte and line numbers in prose

They are assertions that go stale in a week. Derive them:

    git show 20843c2:public/buzzy/talk.html | md5sum
    git show 20843c2:public/buzzy/talk.html | wc -c      # 243827
    git show 20843c2:public/buzzy/talk.html | grep -n '</body>'

Measured for this file's own writing: `243827` bytes, md5 `0fa02322abc84f83e8ce8a7a6f941aec`,
`</body>` at 4375 and 5774, one `<nav` and one `</nav>`.

## Why this file and not the skill

`agent-chat-bus` is a per-profile skill; it has no shared storage and it has already
diverged across profiles. A paragraph copied into each copy is a fifth copy waiting to
go stale. Point the skill at this file and at the code comment; keep the skill's job
to *routing the reader here*.
