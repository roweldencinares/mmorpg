# Backlog

Small, independently-shippable next steps for the MMORPG prototype (Colyseus server + Phaser client). Check items off as they're completed via PR. Scope stays deliberately narrow — no crypto/market, no multi-faction/war, no NPC dialogue/LLM systems, no new external art — until the core farm/combat loop is proven fun.

- [x] Mob wander/aggro AI — mobs currently stand frozen at their spawn point; give them simple random wandering within a radius, and have them notice + approach a nearby player instead of only fighting back when already in range.
- [ ] Player leveling/XP — kills currently only feed the bestiary/quest counters and drop loot; add a level + XP bar with a small stat bump per level (e.g. +maxHp).
- [ ] Full "You Died" overlay — death currently just swaps the HP HUD text to "respawning..."; add a full-screen dim + centered "You Died" text that clears on respawn.
- [ ] Toast/floating-text polish — simultaneous loot toasts queue awkwardly and floating damage numbers from rapid hits can visually overlap; smooth this out (e.g. stack toasts, offset overlapping floating text).
- [ ] A second connected zone — everything currently lives in one 800x600 arena; add a second arena reachable via an edge transition (server tracks which room/zone a player is in).

## Notes for an autonomous run

- This repo has no CI and no automated tests beyond `server/test/MyRoom.test.ts`. Before opening a PR, run `npx tsc --noEmit` in both `server/` and `client/` (after `npm install` in each) and make sure both are clean — that's the only automated correctness signal available.
- The sandbox this runs in cannot reach the local Postgres/Redis/dev servers this project normally runs against, so live/manual testing isn't possible here. Say so explicitly in the PR description, and keep changes conservative and easy to review for that reason.
- Check `gh pr list` before starting — skip any backlog item that already has an open PR.
- Never push directly to `master`. Always work on a branch (`agent/<short-slug>`) and open a PR.
- Check the box for the item you completed as part of the PR diff.
