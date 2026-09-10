# Backlog

Small, independently-shippable next steps for the MMORPG prototype (Colyseus server + Phaser client). Check items off as they're completed via PR. Scope stays deliberately narrow — no crypto/market, no multi-faction/war, no NPC dialogue/LLM systems, no new external art — until the core farm/combat loop is proven fun.

- [x] Mob wander/aggro AI — mobs currently stand frozen at their spawn point; give them simple random wandering within a radius, and have them notice + approach a nearby player instead of only fighting back when already in range.
- [x] Player leveling/XP — kills currently only feed the bestiary/quest counters and drop loot; add a level + XP bar with a small stat bump per level (e.g. +maxHp).
- [x] Full "You Died" overlay — death currently just swaps the HP HUD text to "respawning..."; add a full-screen dim + centered "You Died" text that clears on respawn.
- [x] Toast/floating-text polish — simultaneous loot toasts queue awkwardly and floating damage numbers from rapid hits can visually overlap; smooth this out (e.g. stack toasts, offset overlapping floating text).
- [x] A second connected zone — everything currently lives in one 800x600 arena; add a second arena reachable via an edge transition (server tracks which room/zone a player is in).
- [x] Interface pass: background, bag, settings — the arena background is a flat dark rectangle with no floor texture/pattern; the inventory ("bag") panel is a fixed row of 3 icons with no way to open/close it or see full item details; there is no settings menu at all. Add: (1) a simple non-flat background using Phaser primitives only (no new external art) — e.g. a tiled grid/checkerboard floor pattern, subtle vignette, or per-zone tint if the second-zone feature has landed; (2) make the inventory panel toggleable (e.g. a bag icon or "I" key opens/closes a larger panel) with clearer per-item display (name always visible, not just on hover); (3) a settings panel (gear icon, opens/closes) with at minimum a controls/how-to-play reference (movement, click-to-attack, keybinds) — a real options system (volume, etc.) isn't needed yet since there's no audio.
- [x] Auto-attack + attack range indicator — after a kill, combat used to just stop and wait for a re-click; now it auto-retargets the nearest living mob in the same zone within a leash radius. Also added a visible ring around the player (radius = MOB_ATTACK_RANGE) shown while engaging a target, so the range is legible instead of implicit.
- [x] Shop (buy items) — a toggleable Shop panel (key O) selling a small catalog (Health Potion, Iron Ore) for Gold Coin, server-validated (`buy` message in MyRoom.ts, catalog in shared/economy.ts).
- [x] Crafting — a toggleable Craft panel (key C) with one starter recipe (Iron Dagger = 2 Iron Ore + 1 Wolf Pelt), server-validated (`craft` message, recipes in shared/economy.ts).
- [x] Health Potion — a consumable bought from the shop; "Use" button in the Bag heals a fixed amount, capped at max HP, server-validated (`use` message, consumables in shared/economy.ts).
- [x] Gear/Power growth — equippable weapon (Iron Dagger, craftable) and armor (Leather Armor, buyable) slots. Equipping consumes the item from the bag and boosts stats (weapon: attack damage, armor: max HP); unequipping returns it. A "Power" readout in the HUD shows the total from currently-equipped gear. Server-validated (`equip`/`unequip` messages, catalog in shared/gear.ts).

## Notes for an autonomous run

- This repo has no CI and no automated tests beyond `server/test/MyRoom.test.ts`. Before opening a PR, run `npx tsc --noEmit` in both `server/` and `client/` (after `npm install` in each) and make sure both are clean — that's the only automated correctness signal available.
- The sandbox this runs in cannot reach the local Postgres/Redis/dev servers this project normally runs against, so live/manual testing isn't possible here. Say so explicitly in the PR description, and keep changes conservative and easy to review for that reason.
- Check `gh pr list` before starting — skip any backlog item that already has an open PR.
- Never push directly to `master`. Always work on a branch (`agent/<short-slug>`) and open a PR.
- Check the box for the item you completed as part of the PR diff.
