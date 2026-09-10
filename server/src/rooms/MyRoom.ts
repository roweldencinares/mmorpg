import { Room, Client, CloseCode, validate, type StepContext } from "colyseus";
import { z } from "zod";
import { MyRoomState, Player, Mob, MoveInput } from "./schema/MyRoomState.js";
import { rollDrop } from "../shared/items.js";
import { MOB_TYPES } from "../shared/mobTypes.js";
import { stepEntity } from "../shared/movement.js";
import {
  TICK_RATE, ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF,
  MOB_ATTACK_RANGE, MOB_ATTACK_DAMAGE, MOB_ATTACK_COOLDOWN_MS, MOB_RESPAWN_MS,
  PLAYER_MAX_HP, MOB_DAMAGE_TO_PLAYER, MOB_ATTACK_INTERVAL_MS, PLAYER_RESPAWN_MS,
  QUEST_KILL_TARGET, QUEST_REWARD_ITEM, QUEST_REWARD_QTY,
  ZONE_START, ZONE_FOREST, ZONE_TRANSITION_INSET,
} from "../shared/constants.js";

/**
 * Fixed spawn points for the first pass — no wandering AI yet. Two zones
 * share the same 0-800/0-600 coordinate space; `zone` is what actually keeps
 * them apart, both here and everywhere else mobs/players are compared.
 */
const MOB_SPAWNS = [
  { x: 200, y: 150, type: "rat", zone: ZONE_START },
  { x: 600, y: 150, type: "rat", zone: ZONE_START },
  { x: 200, y: 450, type: "slime", zone: ZONE_START },
  { x: 600, y: 450, type: "slime", zone: ZONE_START },
  { x: 400, y: 300, type: "wolf", zone: ZONE_START },
  // Second zone, reachable by walking off the right edge of the start arena.
  { x: 200, y: 150, type: "wolf", zone: ZONE_FOREST },
  { x: 600, y: 450, type: "wolf", zone: ZONE_FOREST },
  { x: 400, y: 300, type: "slime", zone: ZONE_FOREST },
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
      const maxHp = MOB_TYPES[pos.type].maxHp;
      this.state.mobs.set(`mob-${i}`, new Mob({
        x: pos.x, y: pos.y, zone: pos.zone, hp: maxHp, maxHp, alive: true, type: pos.type,
      }));
    });
  }

  private handleAttack(client: Client, mobId: string) {
    const player = this.state.players.get(client.sessionId);
    const mob = this.state.mobs.get(mobId);
    if (!player || player.hp <= 0 || !mob || !mob.alive) { return; }
    if (player.zone !== mob.zone) { return; } // never allow cross-zone combat

    const now = this.clock.currentTime;
    const last = this.lastAttackAt.get(client.sessionId) ?? 0;
    if (now - last < MOB_ATTACK_COOLDOWN_MS) { return; }

    if (Math.hypot(mob.x - player.x, mob.y - player.y) > MOB_ATTACK_RANGE) { return; }

    this.lastAttackAt.set(client.sessionId, now);
    mob.hp = Math.max(0, mob.hp - MOB_ATTACK_DAMAGE);

    if (mob.hp === 0) {
      mob.alive = false;
      this.clock.setTimeout(() => {
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
      zone: ZONE_START,
      hp: PLAYER_MAX_HP,
      maxHp: PLAYER_MAX_HP,
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

      this.maybeTransitionZone(player);
    }

    this.stepMobAttacks();
  }

  /**
   * Zones are logically separate but numerically share the 0-800/0-600
   * space, so a transition is just: pin against the far wall of your
   * current zone, pop out just inside the near wall of the other one.
   */
  private maybeTransitionZone(player: Player) {
    if (player.zone === ZONE_START && player.x >= ARENA_WIDTH - PLAYER_HALF) {
      player.zone = ZONE_FOREST;
      player.x = PLAYER_HALF + ZONE_TRANSITION_INSET;
    } else if (player.zone === ZONE_FOREST && player.x <= PLAYER_HALF) {
      player.zone = ZONE_START;
      player.x = ARENA_WIDTH - PLAYER_HALF - ZONE_TRANSITION_INSET;
    }
  }

  /**
   * Mobs hit back: any living mob whose cooldown is up deals damage to the
   * first living player found in range. One target per mob per cooldown —
   * no cleave, no aggro persistence, first pass only.
   */
  private stepMobAttacks() {
    const now = this.clock.currentTime;

    for (const [mobId, mob] of this.state.mobs) {
      if (!mob.alive) { continue; }

      const lastAttack = this.lastMobAttackAt.get(mobId) ?? 0;
      if (now - lastAttack < MOB_ATTACK_INTERVAL_MS) { continue; }

      for (const [sessionId, player] of this.state.players) {
        if (player.hp <= 0) { continue; }
        if (player.zone !== mob.zone) { continue; } // never allow cross-zone combat
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
