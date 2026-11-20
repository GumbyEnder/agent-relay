# BeeZilla — key selling points, ad ideas and the vision

The owner asked for this on 2026-11-20: *"This should be a key selling point, and we
should put that on the repo somewhere. Key selling points like this one, you know, like
don't reinvent the wheel. Somebody's already done that."* It collects the selling points
and advertisement ideas the owner has given so far, in their own words, from the
BeeZilla brief written for the website (`BeeZillaAI.md`, the master prompt and website
instructions) and from their messages while BeeZilla was being built (2026-10-12 to
2026-11-20). Every quote below was checked word for word against those sources.

## 1. The headline: don't reinvent the wheel

> "Key selling points like this one, you know, like don't reinvent the wheel. Somebody's
> already done that." (2026-11-20)

> "by default, and this is at the core of your being, you should never seek to reinvent
> the wheel. You should always seek to say, what's already out there?" (2026-11-20)

> "Why reinventing the wheel? I'm sure somebody else has already solved this problem."
> (2026-11-09)

What it means for people using BeeZilla:

- **Most things you want have been made before.** Someone already worked out the steps,
  the skills and the prompts, and paid for the trial and error.
- **Start from their finished work, not from a blank page.** It is faster, it costs a
  fraction of the tokens, and the result is already proven: you saw what it makes before
  you used it.
- **BeeZilla says so out loud.** Before building something big from scratch it points
  out what already exists and asks whether to start from that (the owner's example:
  someone asks for a hide-and-seek game set in Chongqing; BeeZilla says a ready-made city
  already exists and asks whether to build on it or start from scratch).

## 2. The Orchestration Store (coming soon)

> "We would create a store that would allow people to see, oh, here are all the different
> things you can use or buy from other people. Orchestrations." (2026-11-20)

> "cordon off a little piece of what they do, or in an entire whiteboard of what they do,
> and be like, okay, sell this as an orchestration." (2026-11-20)

> "Trade for honey drop or honey, or open source it." (2026-11-20)

> "it should ask if it can use the different examples, the outputs you've used before, to
> help advertise it, so that when it shows up in the inspiration panel and in the recipes
> panel, we have a lot of outputs to work with as examples." (2026-11-20)

How it fits together:

1. **You build something with BeeZilla.** The Idea Board shows the whole process: the
   agent.md, each skill, what it made, and the lines between them.
2. **You cordon off the part that worked** — a small piece of the board or all of it —
   with **Make an area**.
3. **Sell this orchestration** offers three ways: **trade it for Honey Drops** (people pay
   a few each time they use it), **trade it for Honey** (people pay once for their own
   copy), or **open-source it** (free for everyone to use and build on).
4. **BeeZilla asks whether what it made can be shown as examples.** With a yes, the
   pictures, music and other results appear in **Inspiration** and **Recipes**, so people
   see real output before they choose it.
5. **Other people start from it.** In the store, every orchestration shows its examples
   and a way to start from it.

Built so far (pull request "Connect and share on the Idea Board"): the areas, the lines
that tell BeeZilla what to use, and the **Sell this orchestration** button with all
three choices and the examples question, marked *coming soon*. The choice is saved
with the board; nothing is listed or charged yet. Payments and listings reuse what
already exists: the wallet (Honey Drops) and the signed recipe shelf
(`docs/RECIPE-MARKETPLACE-PROTOCOL.md`).

Why this is different from what's out there (research, 2026-11-20, about 380
searches):

- Canvas apps such as Slashspace, Flowith and Poppy let you share, export or copy a
  **whole** board or template (Poppy: "Use Template"; Slashspace: export the canvas or
  copy single pieces). We found none that lets you cordon off **part** of your work
  and sell it.
- Workflow and prompt markets (n8n, PromptBase, ComfyUI sites, Notion and Gumroad
  templates) sell finished files. PromptBase asks every seller for **example outputs**,
  and Poppy's template gallery shows how many people have used each template.
  BeeZilla's examples come straight from the work that made the orchestration, with
  the maker's permission.

## 3. Advertisement ideas

### The Milky Way (the owner's ad, 2026-11-20)

> "Make me a representation of the Milky Way galaxy. A child says that, and they see one
> image. The dark side is like 10 billion tokens. And the other side, someone's already
> done that. Start here. Like, use it. Free. I'm thinking of that as the advertisement for
> it."

- **Shot 1.** A child says: "Make me a representation of the Milky Way galaxy."
- **Shot 2.** The screen splits. **Left, black:** the expensive way, building it from
  nothing, with a meter running up to *10 billion tokens*. **Right, white:** the same
  galaxy, already made by someone else, with one button: **Start here. Use it. Free.**
- **End line:** *Don't reinvent the wheel. Somebody's already done that.*

It follows the brand's main visual rule, the owner's dark/light split (below).

### Confusion → clarity (the website's core picture)

> "From Confusion (Dark side) -> Clairty (Light side)" (BeeZilla brief)

> "The old way is dark confusion; the new way is white clarity." (master prompt)

Black on the left, the old way: set-up, things you have to teach it, no idea what is
happening behind the scenes. White on the right, the new way, with BeeZilla pointing at
the work. The brief's line for it: *"Stop spending more time fixing than building…"*

### You're already a doctor

> "You're already a DOCTOR/LAWYER/ETC… (swap these live from a long list), let BeeZilla do
> the technical work." (BeeZilla brief)

One sentence on screen; the job title changes every half second, the rest stays.

### The board draws itself

> "You're seeing what the agent is doing in real time so that you can edit the process.
> That's the key word. That's the key thing." (2026-11-18)

Someone says what they want. The board opens; agent.md appears, then a line to each
skill as BeeZilla uses it, then the picture or song it made. They change one step, and
it does it again their way.

### One orchestrator, the whole hive

> "You speak to the orchestrator. He coordinates with the rest." (master prompt)

One person speaks; yellow routes fan out from BeeZilla to the right specialists; one
answer comes back.

### Many things become one (the brand story)

The thousands of names that became *BeeZilla*, and the hundreds of drawings that became
one character, shown collapsing into one: *"So from many things to one is what I'm trying
to demonstrate."* (BeeZilla brief)

## 4. Key selling points

| Selling point | In the owner's words |
|---|---|
| Don't reinvent the wheel: start from what someone already made | "Somebody's already done that." · "Start here. Like, use it. Free." |
| Sell, trade or open-source what you built | "sell this as an orchestration" · "Trade for honey drop or honey, or open source it." |
| Your results advertise your orchestration | "we have a lot of outputs to work with as examples" |
| Share what worked without giving away your project | "he shares what worked with the Hive without sharing anything about your project" (brief) · "Each user shares their use cases and agent teams with the Hive allowing everyone to borrow workflows" (brief) |
| One button: Talk to BeeZilla | "My initial vision had a single button you push called Talk to Gzilla." (2026-11-18) · "Keep it simple." |
| See the work as it happens, and change it | "You're seeing what the agent is doing in real time so that you can edit the process." |
| Everything can go on the board | "Everything on this website has got to be movable to the whiteboard." (2026-11-20) |
| It knows what you made together | "anything you've created with it in the same session, it should be able to see as context" (2026-11-19) |
| Pause, think, carry on | "You can click on that pause anytime, think as much as you want, and then continue" (2026-11-19) |
| Design your own orchestrations, with your own key | "even on the cloud mode, I need to be able to put in my own API key. And I need to be able to design my own orchestrations." (2026-11-18) |
| Works with what you already pay for | "Works with your existing Codex/Claude Code subscription" (brief) |
| Voice first | "Accessible: Voice chat BeeZilla and he'll work out what you need, live." (brief) |
| Builds the right thing | "BeeZilla is a smart voice agent that'll help you make sure you're building the right thing before you build it." (brief) |
| Find anything you made | "Everything you save has to be having at least 45 tags that are relevant to that item generated so that it comes up when you search." (2026-11-18) |

## 5. Words

**Use:** Talk to BeeZilla · orchestration · recipe · skill · agent.md · Idea Board ·
Inspiration · Honey / Honey Drops · start here · free · open source · what's already
out there · somebody's already done that · keep it simple · cut to the chase · see the
work as it happens.

**Avoid:**

- **"Whiteboard company" language.** *"we don't want to be a whiteboard company"*
  (2026-11-20). The board makes the work visible; it is not the product. Sell the
  results and the reuse, not the canvas.
- **Generic AI-landing-page copy.** *"If a line could appear on a generic AI landing
  page, remove it."* (master prompt)
- **Made-up process words.** Words like "signal", "mission" and "hand-off" used as
  filler steps (master prompt).
- **A chat-versus-work split.** *"We don't need to have a difference between chat and
  work."* (2026-11-18)
- **Clutter: many buttons fighting for attention.** *"It should just be one."*
  (2026-11-18)

## 6. Visual rules for ads (from the brief)

- Pure black for the old way on the left, pure white for the new way on the right, and
  the brand yellow `#ffc400`. No cream, beige or muddy gold.
- BeeZilla is always pointing at or looking at a real piece of content; *"The character
  may never float meaninglessly."*
- No bee logo on the character's chest.
- The reveal names **BeeZilla.net**.

## Sources

- The BeeZilla brief and website instructions: `BeeZillaAI.md`,
  `BEEZILLA_MASTER_PROMPT.md` and `BEEZILLA_WEBSITE_INSTRUCTIONS.md` (in the owner's
  BeeZillaAI website project; a copy of `BeeZillaAI.md` is in their Poly archive).
- The owner's messages while BeeZilla was built (2026-10-12 to 2026-11-20).
- Research on Slashspace, Flowith, Poppy and workflow marketplaces (2026-11-20): about
  380 searches (311 web, 40 Hacker News, 30 GitHub) plus the three products' own help
  pages (61 Slashspace, 33 Flowith and 59 Poppy pages).
