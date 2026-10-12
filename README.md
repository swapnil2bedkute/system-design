# System Design Journey

System design notes and examples for the YouTube playlist, Season 1.

This is not an app. There is no root build, lint, or test command. Each video topic lives in its own folder.

## Topics

| Path | Topic | Video |
|---|---|---|
| `season-1/1.compressions/` | Compressions | [Session 1](https://www.youtube.com/watch?v=DCYaJb8Bzdk) |
| `season-1/2.vertical-vs-horizontal-scaling/` | Vertical vs horizontal scaling | [Session 2](https://www.youtube.com/watch?v=PMD1fat6QdY) |

### Video references

- Session 1: https://www.youtube.com/watch?v=DCYaJb8Bzdk
- Session 2: https://www.youtube.com/watch?v=PMD1fat6QdY
- Session 3: https://www.youtube.com/watch?v=pgLHXxW3Mg0

New topic path: `season-1/<number>.<topic-name>/`.

## How to work

- Keep a topic's notes and code inside that topic folder.
- Do not edit another topic's files.
- If a topic has its own project, work inside that folder and follow its config.

## Agent rules

Edit `rules/always/`, then run `scripts/sync-agent-rules.sh`. That rebuilds `AGENTS.md`. Do not edit `AGENTS.md` by hand.

Scoped contracts stay in `rules/scoped/` and load only when a matching path is open.

| File | Who reads it |
|---|---|
| `AGENTS.md` | Codex, Claude (`CLAUDE.md`), Antigravity (`GEMINI.md`) |
| `.cursor/rules/` | Cursor |
| `.qoder/rules/` | Qoder |
| `.agents/rules/` | Antigravity |

## Safety hook

`hooks/block-dangerous.sh` runs before agent shell commands in Cursor and Claude. It blocks database writes, `rm -rf`, process kills, and git rewrites. Check it with `bash hooks/self-check.sh`.

Git rejects a non-fast-forward push when this repo uses `.githooks`. One-time setup, this repo only:

```bash
git config core.hooksPath .githooks
```
