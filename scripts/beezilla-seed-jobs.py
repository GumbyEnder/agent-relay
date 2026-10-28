#!/usr/bin/env python3
"""Drive 6 realistic BeeZilla jobs through discovery -> a completed draft,
and persist each as a durable job (buzzy_jobs) with a unique id.

Re-seed: deletes the previous readable-slug jobs (and any earlier copy of
these same titles) first, then creates fresh jobs with random ids so
deep-links are unguessable. Each job is marked Done with the real draft
in `data.draft`, which the Library renders.
"""
import json
import secrets
import time
import urllib.error
import urllib.request

B = "https://beezilla-demo-production-c069.up.railway.app"

# Cookie values are stored URL-encoded. Send them as-is.
# Skip only "# " comment lines — "#HttpOnly_" rows are real cookies.
jar = open("/tmp/bz_cookies.txt").read()
ck = {}
for ln in jar.splitlines():
    if not ln or ln.startswith("# "):
        continue
    p = ln.split("\t")
    if len(p) >= 7:
        ck[p[5]] = p[6]
if "agent-relay.session_token" not in ck:
    raise SystemExit("no session cookie in /tmp/bz_cookies.txt — sign in again")
cookie = "; ".join(f"{k}={v}" for k, v in ck.items())

OLD_SLUGS = {
    "job_foodtruck",
    "job_demandletter",
    "job_candles",
    "job_tutoring",
    "job_roomrental",
    "job_cloudstorage",
}

# (template, title, opening problem, one follow-up that states the four
# decisions in plain language so a missed extraction still completes).
JOBS = [
    (
        "Marketing",
        "Win back my food-truck regulars",
        "I run a food truck with my brother. Sales fell 30% this summer after a competing truck set up two blocks away. We can't match their lower prices without losing money. I want a simple marketing plan to win our regulars back before Labor Day.",
        "The challenge is sales are down about 30% since a competing truck opened two blocks away. What's hard is we can't cut prices without losing money. Who's involved is me, my brother, and our regulars. Done right is a simple marketing plan that brings our regulars back before Labor Day. Please write the full draft document now.",
    ),
    (
        "Legal",
        "Final demand letter — landscaping client",
        "I own a landscaping business. A homeowner owes me $4,200 for a patio we finished in June and has stopped answering. I've already sent two polite reminders with no reply. I need a firm final demand letter so I can move to small-claims court.",
        "The challenge is a homeowner owes my landscaping business $4,200 for a patio finished in June and has stopped answering. What's hard is two polite reminders got no reply, and I may need small-claims court. Who's involved is me and that homeowner. Done right is a firm final demand letter I can send before filing. Please write the full draft letter now.",
    ),
    (
        "Creative writing",
        "Boutique product descriptions — candles",
        "My wife and I make soy candles in our garage. We just got shelf space in two local boutiques but have no product descriptions. We're not writers and we have 14 scents to describe. I need warm, honest descriptions ready for the shop signs by next weekend.",
        "The challenge is we have shelf space in two boutiques and no product descriptions for our soy candles. What's hard is there are 14 scents and we aren't writers. Who's involved is me, my wife, and the two boutique shops. Done right is warm, honest descriptions ready for the shop signs by next weekend. Please write the full draft now.",
    ),
    (
        "Technical",
        "Parent welcome packet — tutoring",
        "I run a small tutoring business. New families often ghost me after the first session, so I keep losing them. I haven't had time to write onboarding materials. I need a parent welcome packet that sets clear expectations and keeps families enrolled.",
        "The challenge is new families ghost me after the first tutoring session. What's hard is I haven't had time to write onboarding, so expectations stay fuzzy. Who's involved is me and the parents of new students. Done right is a parent welcome packet that sets clear expectations and keeps families enrolled. Please write the full draft now.",
    ),
    (
        "Legal",
        "Month-to-month room rental agreement",
        "I own a house in town and want to rent out a spare bedroom for extra income. I've never been a landlord and I'm worried about deposits and notice rules. I need a simple month-to-month room rental agreement that protects me.",
        "The challenge is I want to rent a spare bedroom and I've never been a landlord. What's hard is I don't know the deposit and notice rules and I'm worried about getting them wrong. Who's involved is me and the person who would rent the room. Done right is a simple month-to-month room rental agreement that protects me. Please write the full draft agreement now.",
    ),
    (
        "Technical",
        "Secure cloud-storage plan — dental office",
        "I manage the office for a 4-person dental practice. Patient records are piling up on a shared desktop and we're out of space. We're not technical and we worry about privacy and losing data. I need a plain-English plan for moving to secure cloud storage.",
        "The challenge is patient records are piling up on one shared desktop and we're out of space. What's hard is we aren't technical and we're worried about privacy and losing data. Who's involved is me and the 4-person dental practice. Done right is a plain-English plan for moving to secure cloud storage. Please write the full draft plan now.",
    ),
]

DONE_STEPS = [
    "Understood the job",
    "Wrote the draft",
    "You approved it",
    "Document is in your Library",
]


def req(method, path, body=None, timeout=120):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        B + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json", "Accept": "application/json", "Cookie": cookie},
    )
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"{method} {path} -> {e.code} {detail}") from None


def looks_like_doc(text):
    t = (text or "").strip()
    return len(t) >= 500


def converse(jid, title, template, problem, follow):
    """Up to three turns. Stop once the reply is a real draft."""
    turns = [problem, follow, "Write the complete draft document now, in plain language. Do not ask another question."]
    messages = []
    slots = {}
    best = ""
    for msg in turns:
        chat = req("POST", "/api/buzzy/chat", {
            "jobId": jid,
            "sessionId": jid,
            "message": msg,
            "jobContext": {
                "title": title,
                "template": template,
                "problem": problem,
                "status": "Working",
            },
        })
        reply = (chat.get("reply") or "").strip()
        messages.append({"who": "me", "text": msg})
        if reply:
            messages.append({"who": "bee", "text": reply})
        if isinstance(chat.get("slots"), dict):
            slots.update({k: v for k, v in chat["slots"].items() if v})
        if len(reply) > len(best):
            best = reply
        flagged = bool(chat.get("draft"))
        print(f"  turn {len(messages)//2} draft={flagged} slots={sorted(slots)} reply_len={len(reply)}")
        if flagged and looks_like_doc(reply):
            best = reply
            break
        if looks_like_doc(reply) and not reply.rstrip().endswith("?"):
            best = reply
            break
    return best, messages, slots


def main():
    existing = req("GET", "/api/buzzy/jobs")
    titles = {j[1] for j in JOBS}
    for row in existing.get("jobs") or []:
        rid = row.get("id") or ""
        title = row.get("title") or ""
        if rid in OLD_SLUGS or title in titles:
            try:
                req("DELETE", "/api/buzzy/jobs/" + urllib.parse.quote(rid))
                print(f"deleted {rid}")
            except Exception as e:
                print(f"delete {rid}: {e}")

    created = []
    for template, title, problem, follow in JOBS:
        jid = "job_" + secrets.token_hex(8)
        print(f"[{jid}] {title}")
        try:
            draft, messages, slots = converse(jid, title, template, problem, follow)
        except Exception as e:
            print(f"[{jid}] ERROR {e}")
            continue
        if not looks_like_doc(draft):
            print(f"[{jid}] WARN draft still short ({len(draft)} chars) — stored anyway")
        now = int(time.time() * 1000)
        req("POST", "/api/buzzy/jobs", {
            "id": jid,
            "template": template,
            "title": title,
            "status": "Done",
            "data": {
                "id": jid,
                "title": title,
                "template": template,
                "status": "Done",
                "problem": problem,
                "messages": messages,
                "answers": slots,
                "draft": draft,
                "approved": True,
                "version": 1,
                "screen": "jobs",
                "createdAt": now,
                "updatedAt": now,
                "board": {
                    "Waiting": [],
                    "Working": [],
                    "Needs you": [],
                    "Done": DONE_STEPS,
                },
            },
        })
        created.append((jid, title, len(draft), sorted(slots)))
        print(f"[{jid}] saved draft_len={len(draft)}")

    print("--- verify ---")
    final = req("GET", "/api/buzzy/jobs")
    rows = final.get("jobs") or []
    slugs_left = [r.get("id") for r in rows if r.get("id") in OLD_SLUGS]
    print(f"jobs={len(rows)} old_slugs_left={slugs_left or 'none'}")
    for jid, title, n, slot_keys in created:
        row = next((r for r in rows if r.get("id") == jid), None)
        data = (row or {}).get("data") or {}
        print(f"  {jid} status={row and row.get('status')} stored_draft={len(data.get('draft') or '')} expect={n} slots={slot_keys}")
    print("RESEED DONE", len(created))


if __name__ == "__main__":
    import urllib.parse
    main()
