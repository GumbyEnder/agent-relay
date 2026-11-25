@AGENTS.md

## Claude Code in this repo

From Anthropic's late-2026 guidance for long runs (Opus 5.5 / Fable 5.2), as practised here:

- **Models.** Start on Opus 5.5. Move to Fable only for big multi-part jobs, 3D and game work,
  the hardest problems, or to lead and judge other agents. Searches and log reading go to a
  cheap subagent; simple, clear tasks to a mid model; harder building to Opus.
- **Subagents cost real money** (each re-reads its context). Start one only for work that can
  run at the same time; a job that fits in one session stays in one session.
- **Effort.** A lead left running alone works on high — lower stops early, higher adds little
  for many more tokens.
- **Don't stop while you still owe work.** Finish, or say exactly what blocks you; don't end on
  a list of what's left or ask whether to continue.
- **Ask before** deleting files or doing anything that can't be undone. Anything reversible in
  this repo, your worktree, the fork and local servers just goes ahead.
- **Final reports are for someone who never watched:** most important first, plain words, the
  real results (screenshots, test output), and what you did not verify.
- **Change models at a task boundary** (fresh session or compact first): the cache and the
  previous model's thinking don't carry over.
