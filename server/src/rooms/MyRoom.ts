import { Room, Client, CloseCode, validate, type StepContext } from "colyseus";
import { z } from "zod";
import { MyRoomState, Player, Mob, MoveInput } from "./schema/MyRoomState.js";
import { rollDrop } from "../shared/items.js";
import { MOB_TYPES } from "../shared/mobTypes.js";
import { stepEntity, moveToward } from "../shared/movement.js";
import {
  TICK_RATE, ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF,
  MOB_ATTACK_RANGE, MOB_ATTACK_DAMAGE, MOB_ATTACK_COOLDOWN_MS, MOB_RESPAWN_MS,
  PLAYER_MAX_HP, MOB_DAMAGE_TO_PLAYER, MOB_ATTACK_INTERVAL_MS, PLAYER_RESPAWN_MS,
  QUEST_KILL_TARGET, QUEST_REWARD_ITEM, QUEST_REWARD_QTY,
  LEVEL_UP_MAX_HP_BONUS, xpToNextLevel,
  MOB_NOTICE_RANGE, MOB_WANDER_SPEED, MOB_CHASE_SPEED, MOB_WANDER_RADIUS,
  MOB_WANDER_PAUSE_MIN_MS, MOB_WANDER_PAUSE_MAX_MS, MOB_WANDER_ARRIVE_DIST,
} from "../shared/constants.js";

const clamp = (value: number, min: number, max: number) =>
  (value < min ? min : value > max ? max : value);

/** Fixed spawn points — mobs wander/chase from here but always return to it. */
const MOB_SPAWNS = [
  { x: 200, y: 150, type: "rat" },
  { x: 600, y: 150, type: "rat" },
  { x: 200, y: 450, type: "slime" },
  { x: 600, y: 450, type: "slime" },
  { x: 400, y: 300, type: "wolf" },
];

export class MyRoom extends Room<{ state: MyRoomState, input: MoveInput }> {
  maxClients = 8;
  state = new MyRoomState();

  /**
   * Per-client input buffer. `sanitize` clamps every field as it is decoded —
   * never trust the wire — and the buffer holds ~2s of inputs at this tick rate
   * so a burst after a stall still replays in order.
   */
  inputs = this.defineInput(MoveInput, {
    bufferMaxSize: 64,
    sanitize: { moveX: [-1, 1], moveY: [-1, 1] },
  });

  private joinCount = 0;

  /** Per-player attack cooldown, server-side wall clock — not part of state. */
  private lastAttackAt = new Map<string, number>();

  /** Per-mob attack cooldown against players, server-side wall clock. */
  private lastMobAttackAt = new Map<string, number>();

  /** mobId -> its fixed spawn point, so wander/leash math always has a home to measure from. */
  private mobSpawns = new Map<string, { x: number; y: number }>();

  /** mobId -> current wander destination, chosen within MOB_WANDER_RADIUS of spawn. */
  private mobWanderTarget = new Map<string, { x: number; y: number }>();

  /** mobId -> wall-clock time it's allowed to pick its next wander destination. */
  private mobNextWanderAt = new Map<string, number>();

  /** mobId -> sessionId of the player it has noticed and is chasing, if any. */
  private mobAggroTarget = new Map<string, string>();

  messages = {
    // movement arrives through the input buffer above — register handlers here
    // only for things that are not inputs (chat, emotes, …).
    attack: validate(z.object({ mobId: z.string() }), function (this: MyRoom, client: Client, message: { mobId: string }) {
      this.handleAttack(client, message.mobId);
    }),
  };

  onCreate(options: any) {
    this.setFixedTimestep((ctx) => this.step(ctx), TICK_RATE);

    MOB_SPAWNS.forEach((pos, i) => {
      const mobId = `mob-${i}`;
      const maxHp = MOB_TYPES[pos.type].maxHp;
      this.state.mobs.set(mobId, new Mob({
        x: pos.x, y: pos.y, hp: maxHp, maxHp, alive: true, type: pos.type,
      }));
      this.mobSpawns.set(mobId, { x: pos.x, y: pos.y });
    });
  }

  private handleAttack(client: Client, mobId: string) {
    const player = this.state.players.get(client.sessionId);
    const mob = this.state.mobs.get(mobId);
    if (!player || player.hp <= 0 || !mob || !mob.alive) { return; }

    const now = this.clock.currentTime;
    const last = this.lastAttackAt.get(client.sessionId) ?? 0;
    if (now - last < MOB_ATTACK_COOLDOWN_MS) { return; }

    if (Math.hypot(mob.x - player.x, mob.y - player.y) > MOB_ATTACK_RANGE) { return; }

    this.lastAttackAt.set(client.sessionId, now);
    mob.hp = Math.max(0, mob.hp - MOB_ATTACK_DAMAGE);

    if (mob.hp === 0) {
      mob.alive = false;
      this.mobAggroTarget.delete(mobId); // dead mobs don't keep chasing on respawn
      this.clock.setTimeout(() => {
        const spawn = this.mobSpawns.get(mobId);
        if (spawn) { mob.x = spawn.x; mob.y = spawn.y; }
        this.mobWanderTarget.delete(mobId);
        this.mobNextWanderAt.delete(mobId);
        mob.hp = mob.maxHp;
        mob.alive = true;
      }, MOB_RESPAWN_MS);

      const drop = rollDrop();
      player.inventory.set(drop.id, (player.inventory.get(drop.id) ?? 0) + 1);

      if (!player.bestiary.get(mob.type)) {
        player.bestiary.set(mob.type, true);
      }

      if (!player.questComplete) {
        player.questKills += 1;
        if (player.questKills >= QUEST_KILL_TARGET) {
          player.questComplete = true;
          player.inventory.set(QUEST_REWARD_ITEM, (player.inventory.get(QUEST_REWARD_ITEM) ?? 0) + QUEST_REWARD_QTY);
        }
      }

      this.awardXp(player, mob.maxHp);
    }
  }

  /**
   * Grants XP for a kill and applies the leveling curve from shared/constants.ts.
   * Looped rather than a single `if` so one big kill can carry a player across
   * more than one level threshold in a single award.
   */
  private awardXp(player: Player, amount: number) {
    player.xp += amount;

    while (player.xp >= xpToNextLevel(player.level)) {
      player.xp -= xpToNextLevel(player.level);
      player.level += 1;
      player.maxHp += LEVEL_UP_MAX_HP_BONUS;
      player.hp = player.maxHp; // full heal on level-up
    }
  }

  onJoin(client: Client, options: any) {
    console.log(client.sessionId, "joined!");

    // Deterministic spawn ring, so two players never start on top of each other.
    const angle = this.joinCount++ * 2.399963;
    this.state.players.set(client.sessionId, new Player({
      x: ARENA_WIDTH / 2 + Math.cos(angle) * 80,
      y: ARENA_HEIGHT / 2 + Math.sin(angle) * 80,
      vx: 0,
      vy: 0,
      hp: PLAYER_MAX_HP,
      maxHp: PLAYER_MAX_HP,
      level: 1,
      xp: 0,
      questKills: 0,
      questComplete: false,
    }));
  }

  onLeave(client: Client, code: CloseCode) {
    console.log(client.sessionId, "left!", code);
    this.state.players.delete(client.sessionId);
    this.lastAttackAt.delete(client.sessionId);
  }

  onDispose() {
    console.log("room", this.roomId, "disposing...");
  }

  /**
   * One shared `stepEntity` per received input, so the set the client predicted
   * is exactly the set the server applied. A client that sends nothing simply
   * does not move — an empty tick advances no one.
   */
  private step(ctx: StepContext) {
    for (const [sessionId, player] of this.state.players) {
      if (player.hp <= 0) { continue; } // dead — frozen until respawn

      const channel = this.inputs.get(sessionId);
      if (!channel) { continue; }

      for (const input of channel) {
        stepEntity(player, input, ctx.dt);
      }
    }

    this.stepMobAI(ctx.dt);
    this.stepMobAttacks();
  }

  /**
   * Simple wander/aggro AI, run before attacks so a mob that just noticed or
   * caught up to a player is already in range when stepMobAttacks() checks.
   *
   * - No aggro yet: wander to random points within MOB_WANDER_RADIUS of the
   *   mob's own spawn, pausing briefly at each one, until a living player
   *   comes within MOB_NOTICE_RANGE.
   * - Aggro'd: walk straight at that player (no pathfinding) until either
   *   it's close enough for stepMobAttacks() to land hits, or the player
   *   drifts back outside MOB_NOTICE_RANGE — at which point aggro drops and
   *   the mob resumes wandering near its spawn.
   */
  private stepMobAI(dt: number) {
    const now = this.clock.currentTime;

    for (const [mobId, mob] of this.state.mobs) {
      if (!mob.alive) { continue; }
      const spawn = this.mobSpawns.get(mobId);
      if (!spawn) { continue; }

      let aggroId = this.mobAggroTarget.get(mobId);

      // Drop aggro if the target left, died, or wandered back out of notice range.
      if (aggroId) {
        const target = this.state.players.get(aggroId);
        if (!target || target.hp <= 0 || Math.hypot(target.x - mob.x, target.y - mob.y) > MOB_NOTICE_RANGE) {
          this.mobAggroTarget.delete(mobId);
          aggroId = undefined;
        }
      }

      // Not chasing anyone — see if a living player just wandered into notice range.
      if (!aggroId) {
        let nearestId: string | undefined;
        let nearestDist = MOB_NOTICE_RANGE;
        for (const [sessionId, player] of this.state.players) {
          if (player.hp <= 0) { continue; }
          const dist = Math.hypot(player.x - mob.x, player.y - mob.y);
          if (dist <= nearestDist) {
            nearestDist = dist;
            nearestId = sessionId;
          }
        }
        if (nearestId) {
          this.mobAggroTarget.set(mobId, nearestId);
          aggroId = nearestId;
        }
      }

      if (aggroId) {
        const target = this.state.players.get(aggroId)!;
        // Stop short of stacking exactly on the player once within attack range.
        if (Math.hypot(target.x - mob.x, target.y - mob.y) > MOB_ATTACK_RANGE * 0.6) {
          moveToward(mob, target.x, target.y, MOB_CHASE_SPEED, dt);
        }
        continue;
      }

      this.stepMobWander(mobId, mob, spawn, now, dt);
    }
  }

  /** Idle wandering for one mob with no current aggro target. */
  private stepMobWander(
    mobId: string,
    mob: Mob,
    spawn: { x: number; y: number },
    now: number,
    dt: number,
  ) {
    let target = this.mobWanderTarget.get(mobId);
    const arrived = !target || Math.hypot(target.x - mob.x, target.y - mob.y) <= MOB_WANDER_ARRIVE_DIST;

    if (arrived && now >= (this.mobNextWanderAt.get(mobId) ?? 0)) {
      target = this.pickWanderPoint(spawn);
      this.mobWanderTarget.set(mobId, target);
      const pause = MOB_WANDER_PAUSE_MIN_MS + Math.random() * (MOB_WANDER_PAUSE_MAX_MS - MOB_WANDER_PAUSE_MIN_MS);
      this.mobNextWanderAt.set(mobId, now + pause);
    }

    if (target && !arrived) {
      moveToward(mob, target.x, target.y, MOB_WANDER_SPEED, dt);
    }
  }

  /**
   * A random point within MOB_WANDER_RADIUS of `spawn`. Both this point and
   * the mob's current position (always inside that same disk — see above)
   * mean the straight-line walk between them never leaves it either, so a
   * wandering mob can never drift further than MOB_WANDER_RADIUS from home.
   */
  private pickWanderPoint(spawn: { x: number; y: number }): { x: number; y: number } {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * MOB_WANDER_RADIUS;
    return {
      x: clamp(spawn.x + Math.cos(angle) * radius, PLAYER_HALF, ARENA_WIDTH - PLAYER_HALF),
      y: clamp(spawn.y + Math.sin(angle) * radius, PLAYER_HALF, ARENA_HEIGHT - PLAYER_HALF),
    };
  }

  /**
   * Mobs hit back: any living mob whose cooldown is up deals damage to the
   * first living player found in range. One target per mob per cooldown —
   * no cleave. (Aggro/chase toward that range is handled by stepMobAI()
   * above; this only lands the hit once a player is already close enough.)
   */
  private stepMobAttacks() {
    const now = this.clock.currentTime;

    for (const [mobId, mob] of this.state.mobs) {
      if (!mob.alive) { continue; }

      const lastAttack = this.lastMobAttackAt.get(mobId) ?? 0;
      if (now - lastAttack < MOB_ATTACK_INTERVAL_MS) { continue; }

      for (const [sessionId, player] of this.state.players) {
        if (player.hp <= 0) { continue; }
        if (Math.hypot(player.x - mob.x, player.y - mob.y) > MOB_ATTACK_RANGE) { continue; }

        this.lastMobAttackAt.set(mobId, now);
        player.hp = Math.max(0, player.hp - MOB_DAMAGE_TO_PLAYER);

        if (player.hp === 0) {
          this.schedulePlayerRespawn(sessionId);
        }
        break;
      }
    }
  }

  private schedulePlayerRespawn(sessionId: string) {
    this.clock.setTimeout(() => {
      const player = this.state.players.get(sessionId);
      if (!player) { return; } // left in the meantime

      player.hp = player.maxHp;
      player.x = ARENA_WIDTH / 2;
      player.y = ARENA_HEIGHT / 2;
      player.vx = 0;
      player.vy = 0;
    }, PLAYER_RESPAWN_MS);
  }

  /**
   * Called on any disconnection the client did not ask for — a network blip, a
   * suspended tab, a tunnel change. Holding the seat lets the SDK retry into the
   * same session, so the player keeps their entity and their place in the room.
   */
  onDrop(client: Client, code: CloseCode) {
    // Deliberately not awaited: the framework routes the outcome to onReconnect()
    // or onLeave() by itself. The catch is only here because the promise also
    // rejects when the room is already disposing (server shutdown), which would
    // otherwise surface as an unhandled rejection.
    this.allowReconnection(client, 30).catch(() => {});
  }

  onReconnect(client: Client) {
    console.log(client.sessionId, "reconnected!");
  }
}
