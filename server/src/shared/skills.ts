export interface SkillDef {
  id: string;
  name: string;
  manaCost: number;
  cooldownMs: number;
  kind: "attack" | "heal";
  /** attack: bonus damage added on top of MOB_ATTACK_DAMAGE + weapon power. heal: hp restored. */
  power: number;
  /** attack skills only — how far from the target this skill still lands, independent of melee range. */
  range?: number;
}

export const SKILLS: Record<string, SkillDef> = {
  power_strike: {
    id: "power_strike", name: "Power Strike", manaCost: 8, cooldownMs: 3000,
    kind: "attack", power: 15, range: 40,
  },
  fireball: {
    id: "fireball", name: "Fireball", manaCost: 18, cooldownMs: 5000,
    kind: "attack", power: 25, range: 240,
  },
  heal: {
    id: "heal", name: "Heal", manaCost: 15, cooldownMs: 8000,
    kind: "heal", power: 30,
  },
};
