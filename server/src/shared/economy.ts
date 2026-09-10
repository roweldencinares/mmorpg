export interface ShopEntry {
  itemId: string;
  price: number;
}

/** Currency item used for all buying/selling — just a regular inventory item. */
export const SHOP_CURRENCY_ITEM = "gold_coin";

export const SHOP_CATALOG: ShopEntry[] = [
  { itemId: "health_potion", price: 10 },
  { itemId: "iron_ore", price: 5 },
];

export interface Recipe {
  id: string;
  name: string;
  inputs: Record<string, number>;
  outputQty: number;
}

export const RECIPES: Record<string, Recipe> = {
  iron_dagger: {
    id: "iron_dagger",
    name: "Iron Dagger",
    inputs: { iron_ore: 2, wolf_pelt: 1 },
    outputQty: 1,
  },
};

/** Items that can be consumed via the "use" message, and what they do. */
export const CONSUMABLES: Record<string, { healAmount: number }> = {
  health_potion: { healAmount: 30 },
};
