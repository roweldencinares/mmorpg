import { schema, t, type SchemaType } from "@colyseus/schema";

/**
 * One input frame, consumed by `Room.defineInput()`. Flat primitives only, and
 * deliberately minimal:
 *   - no `seq`  — the engine's input counter is the sequence
 *   - no `dt`   — fixed timestep: one input advances exactly one step
 *   - no time   — the SDK stamps lag-comp timing on the wire envelope
 *
 * `int8<-1 | 0 | 1>` narrows the type for your code; the room's `sanitize`
 * clamp is what actually enforces it against a modified client.
 */
export const MoveInput = schema({
  moveX: t.int8<-1 | 0 | 1>(),
  moveY: t.int8<-1 | 0 | 1>(),
});
export type MoveInput = SchemaType<typeof MoveInput>;

export const Player = schema({
  x: t.number(),
  y: t.number(),
  vx: t.number(),
  vy: t.number(),
  hp: t.number(),
  maxHp: t.number(),
  level: t.number(),
  xp: t.number(),
  /** itemId -> quantity */
  inventory: t.map("number"),
  /** mobType -> discovered (true once killed at least once) */
  bestiary: t.map("boolean"),
  questKills: t.number(),
  questComplete: t.boolean(),
});
export type Player = SchemaType<typeof Player>;

export const Mob = schema({
  x: t.number(),
  y: t.number(),
  hp: t.number(),
  maxHp: t.number(),
  alive: t.boolean(),
  type: t.string(),
});
export type Mob = SchemaType<typeof Mob>;

export const MyRoomState = schema({

  players: t.map(Player),
  mobs: t.map(Mob),

});
export type MyRoomState = SchemaType<typeof MyRoomState>;
