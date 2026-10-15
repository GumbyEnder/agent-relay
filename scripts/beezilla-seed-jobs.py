#!/usr/bin/env python3
"""Drive 6 realistic BeeZilla jobs through discovery -> completed draft, and
persist each as a durable job (buzzy_jobs) with a UNIQUE id.

Re-seed: deletes the previous readable-slug jobs first, then creates fresh
jobs with random ids so deep-links are unguessable (dogfood: unique ids)."""
import json, urllib.request, urllib.parse, time, secrets

B = "https://beezilla-demo-production-c069.up.railway.app"

# read cookie jar (send cookie values as-is; they're URL-encoded)
jar = open("/tmp/bz_cookies.txt").read()
ck = {}
for ln in jar.splitlines():
    if not ln or ln.startswith("# "):
        continue
    p = ln.split("\t")
    if len(p) >= 7:
        ck[p[5]] = p[6]
cookie = "; ".join(f"{k}={v}" for k, v in ck.items())

OLD_SLUGS = [
    "job_foodtruck", "job_demandletter", "job_candles",
    "job_tutoring", "job_roomrental", "job_cloudstorage",
]

JOBS = [
    ("Marketing", "Win back my food-truck regulars",
     "I run a food truck with my brother. Sales fell 30% this summer after a competing truck set up two blocks away. We can't match their lower prices without losing money. I want a simple marketing plan to win our regulars back before Labor Day."),
    ("Legal", "Final demand letter — landscaping client",
     "I own a landscaping business. A homeowner owes me $4,200 for a patio we finished in June and has stopped answering. I've already sent two polite reminders with no reply. I need a firm final demand letter so I can move to small-claims court."),
    ("Creative writing", "Boutique product descriptions — candles",
     "My wife and I make soy candles in our garage. We just got shelf space in two local boutiques but have no product descriptions. We're not writers and we have 14 scents to describe. I need warm, honest descriptions ready for the shop signs by next weekend."),
    ("Technical", "Parent welcome packet — tutoring",
     "I run a small tutoring business. New families often ghost me after the first session, so I keep losing them. I haven't had time to write onboarding materials. I need a parent welcome packet that sets clear expectations and keeps families enrolled."),
    ("Legal", "Month-to-month room rental agreement",
     "I own a house in town and want to rent out a spare bedroom for extra income. I've never been a landlord and I'm worried about deposits and notice rules. I need a simple month-to-month room rental agreement that protects me."),
    ("Technical", "Secure cloud-storage plan — dental office",
     "I manage the office for a 4-person dental practice. Patient records are piling up on a shared desktop and we're out of space. We're not technical and we worry about privacy and losing data. I need a plain-English plan for moving to secure cloud storage."),
]


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(B + path, data=data, method=method,
                               headers={"Content-Type": "application/json", "Cookie": cookie})
    with urllib.request.urlopen(r, timeout=90) as resp:
        return json.loads(resp.read())


# 1. Delete the previous readable-slug jobs.
for slug in OLD_SLUGS:
    try:
        req("DELETE", "/api/buzzy/jobs/" + slug)
        print(f"deleted {slug}")
    except Exception as e:
        print(f"delete {slug}: {str(e)[:80]}")

# 2. Create fresh jobs with unique ids.
for tmpl, title, msg in JOBS:
    jid = "job_" + secrets.token_hex(8)  # unguessable
    try:
        chat = req("POST", "/api/buzzy/chat", {
            "jobId": jid, "sessionId": jid, "message": msg,
        })
        reply = (chat.get("reply") or "").strip()
        slots = chat.get("slots") or {}
        draft = bool(chat.get("draft"))
        req("POST", "/api/buzzy/jobs", {
            "id": jid, "template": tmpl, "title": title, "status": "Done",
            "data": {
                "id": jid, "template": tmpl, "problem": msg,
                "messages": [{"who": "me", "text": msg}, {"who": "bee", "text": reply}],
                "answers": slots,
                "draft": reply[:1500], "approved": True, "version": 1,
                "updatedAt": int(time.time() * 1000),
            },
        })
        print(f"[{jid}] slots={list(slots.keys())} draft={draft}")
    except Exception as e:
        print(f"[{jid}] ERROR {str(e)[:120]}")

print("RESEED DONE")