export interface GearItem {
  itemId: string;
  slot: "weapon" | "armor";
  name: string;
  /** Weapon: added to attack damage. Armor: added to max HP. */
  power: number;
}

/** Equippable items — a subset of all items, looked up by inventory itemId. */
export const GEAR_CATALOG: Record<string, GearItem> = {
  iron_dagger: { itemId: "iron_dagger", slot: "weapon", name: "Iron Dagger", power: 8 },
  leather_armor: { itemId: "leather_armor", slot: "armor", name: "Leather Armor", power: 20 },
};
