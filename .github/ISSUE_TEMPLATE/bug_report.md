---
name: Bug report
about: Something doesn't work the way the docs say it should.
title: ''
labels: bug
assignees: ''
---

**Environment**
- `draft --version` output:
- Node version (`node --version`):
- OS:
- Install method (`npm install -g @drbaher/draft-cli` / `npx @drbaher/draft-cli@latest` / cloned):

**What you ran**
```
$ draft ...
```

**What you expected**
A clear, short description of what should have happened.

**What actually happened**
Paste the full output (or the relevant excerpt). Include stderr — `--why`
output and any `error:` lines are usually the most useful.

**Minimal repro**
If the bug depends on a specific template, paste the smallest snippet that
reproduces it. Trim anything you can't share publicly.

**Tier**
Which detection tier was involved, if known? (bracket / mustache /
docx-highlight / heuristic / llm). The `tier` field in `--json` output or
the `tier =` line in `--why` will tell you.

**Anything else**
Workarounds you tried, related issues, etc.
