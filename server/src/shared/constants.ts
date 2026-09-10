/** Simulation rate in Hz. One input advances exactly one step at this rate. */
export const TICK_RATE = 30;

export const ARENA_WIDTH = 800;
export const ARENA_HEIGHT = 600;

/** Half-extent of a player square, used for wall clamping. */
export const PLAYER_HALF = 12;

/** Units per second at full stick. */
export const PLAYER_SPEED = 260;

export const MOB_MAX_HP = 30;

/** How close a player must be to a mob to land a hit. */
export const MOB_ATTACK_RANGE = 40;

export const MOB_ATTACK_DAMAGE = 10;

/** Minimum time between attacks landed by the same player, server-enforced. */
export const MOB_ATTACK_COOLDOWN_MS = 600;

/** Time a dead mob stays down before respawning at full health. */
export const MOB_RESPAWN_MS = 5000;

export const PLAYER_MAX_HP = 100;

/** Damage a mob deals to a player standing in its range, once per interval. */
export const MOB_DAMAGE_TO_PLAYER = 5;
export const MOB_ATTACK_INTERVAL_MS = 1000;

/** Time a dead player waits before respawning at full health at the arena center. */
export const PLAYER_RESPAWN_MS = 3000;

/** First-pass starter quest: kill any N mobs, turn in automatically. */
export const QUEST_KILL_TARGET = 10;
export const QUEST_REWARD_ITEM = "gold_coin";
export const QUEST_REWARD_QTY = 10;
