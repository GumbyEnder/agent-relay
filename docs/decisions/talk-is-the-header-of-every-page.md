# Talk is the header of every page

**Date:** 2026-11-20 · **Status:** decided

**Owner's words:** the Talk area "is actually just the header of the entire website", and
"never" a menu at the top of a page.

**Decision:** on every `/buzzy` page, top to bottom: the face and name, Talk to BeeZilla, the
search bar, the places row; the page opens under that row. Each visit opens blank, with the
Idea Board folded. There is no separate chat/work split: Talk is the one place to talk.

**In the code:** `#bzHead` in `public/buzzy/talk.html`, kept by `public/buzzy/nav.js`.
