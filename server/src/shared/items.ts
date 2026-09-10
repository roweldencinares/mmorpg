export interface ItemDef {
  id: string;
  name: string;
}

/** First-pass drop table — every mob drops one random item from this list. */
export const ITEM_TABLE: ItemDef[] = [
  { id: "wolf_pelt", name: "Wolf Pelt" },
  { id: "iron_ore", name: "Iron Ore" },
  { id: "gold_coin", name: "Gold Coin" },
];

export function rollDrop(): ItemDef {
  return ITEM_TABLE[Math.floor(Math.random() * ITEM_TABLE.length)];
}
