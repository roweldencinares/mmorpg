export interface MobTypeDef {
  id: string;
  maxHp: number;
}

export const MOB_TYPES: Record<string, MobTypeDef> = {
  rat: { id: "rat", maxHp: 20 },
  slime: { id: "slime", maxHp: 30 },
  wolf: { id: "wolf", maxHp: 45 },
};
