import Phaser from "phaser";
import { Client, getStateCallbacks, type InputHandle } from "@colyseus/sdk";
import heroUrl from "./assets/hero.png";

const ARENA_WIDTH = 800;
const ARENA_HEIGHT = 600;
const SERVER_URL = "ws://localhost:2567";

// MoveInput fields mirror server's src/rooms/schema/MyRoomState.ts
type MoveInput = { moveX: -1 | 0 | 1; moveY: -1 | 0 | 1 };

// Mirrors server's shared/items.ts ITEM_TABLE — display names/colors only,
// the server is the source of truth for what items exist and what they mean.
// Fixed order keeps HUD slots from jumping around as items are picked up.
const ITEM_ORDER = ["wolf_pelt", "iron_ore", "gold_coin", "health_potion", "iron_dagger", "leather_armor"];
const ITEM_NAMES: Record<string, string> = {
  wolf_pelt: "Wolf Pelt",
  iron_ore: "Iron Ore",
  gold_coin: "Gold Coin",
  health_potion: "Health Potion",
  iron_dagger: "Iron Dagger",
  leather_armor: "Leather Armor",
};
const ITEM_COLORS: Record<string, number> = {
  wolf_pelt: 0x8b5a2b,
  iron_ore: 0x9ca3af,
  gold_coin: 0xfbbf24,
  health_potion: 0xf87171,
  iron_dagger: 0xd1d5db,
  leather_armor: 0xa16207,
};

// Mirrors server's shared/economy.ts — display data only, the server is the
// source of truth for prices/recipes and validates every buy/craft/use.
const SHOP_CURRENCY_ITEM = "gold_coin";
const SHOP_CATALOG: { itemId: string; price: number }[] = [
  { itemId: "health_potion", price: 10 },
  { itemId: "iron_ore", price: 5 },
  { itemId: "leather_armor", price: 20 },
];
const RECIPES: { id: string; name: string; inputs: Record<string, number> }[] = [
  { id: "iron_dagger", name: "Iron Dagger", inputs: { iron_ore: 2, wolf_pelt: 1 } },
];
const CONSUMABLE_ITEMS = new Set(["health_potion"]);

// Mirrors server's shared/gear.ts — display data only, the server validates
// every equip/unequip and is the source of truth for slot/power values.
const GEAR_CATALOG: Record<string, { slot: "weapon" | "armor"; name: string; power: number }> = {
  iron_dagger: { slot: "weapon", name: "Iron Dagger", power: 8 },
  leather_armor: { slot: "armor", name: "Leather Armor", power: 20 },
};

// How far auto-attack will look for a new target after a kill, from the
// player's current position, before giving up and going idle.
const AUTO_ATTACK_LEASH_RADIUS = 200;

// Mirrors server's shared/mobTypes.ts — display names/colors only.
const MOB_TYPE_INFO: Record<string, { name: string; color: number }> = {
  rat: { name: "Rat", color: 0x9ca3af },
  slime: { name: "Slime", color: 0x38bdf8 },
  wolf: { name: "Wolf", color: 0x78350f },
};
const DEFAULT_MOB_COLOR = 0xff4444;
const TARGETED_MOB_COLOR = 0xffff88;

// Mirrors server's QUEST_KILL_TARGET (shared/constants.ts).
const QUEST_KILL_TARGET = 10;

// Mirrors server's XP_PER_LEVEL / xpToNextLevel (shared/constants.ts).
const XP_PER_LEVEL = 50;
function xpToNextLevel(level: number): number {
  return level * XP_PER_LEVEL;
}

// Width of the XP bar drawn in the portrait panel, below the HP bar.
const XP_BAR_WIDTH = 158;

// Mirrors server's ZONE_START (shared/constants.ts) — the zone every fresh
// session starts in, and this client's default until told otherwise.
const ZONE_START = "start";

// Below this distance to the click target we consider ourselves "arrived"
// and stop sending movement input.
const ARRIVE_THRESHOLD = 4;

// Mirrors server's MOB_ATTACK_RANGE (shared/constants.ts) — close enough to
// land a hit. Kept in sync manually; client and server are separate bundles.
const MOB_ATTACK_RANGE = 40;

// How far from a click a mob sprite still counts as "clicked on".
const MOB_PICK_RADIUS = 24;

// Client-side throttle on attack sends — the server is the real cooldown authority.
const ATTACK_SEND_INTERVAL_MS = 350;

interface MobView { x: number; y: number; hp: number; maxHp: number; alive: boolean; type: string; zone: string; }
interface PlayerView { x: number; y: number; hp: number; maxHp: number; level: number; xp: number; zone: string; equippedWeapon: string; equippedArmor: string; }

class WorldScene extends Phaser.Scene {
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: { W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key; S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key };
  private sprites = new Map<string, Phaser.GameObjects.Image>();
  private labels = new Map<string, Phaser.GameObjects.Text>();
  private statusText!: Phaser.GameObjects.Text;
  private myInput?: InputHandle<MoveInput>;
  private mySessionId?: string;
  private clickTarget?: { x: number; y: number };
  private targetMarker?: Phaser.GameObjects.Arc;

  private room?: any;
  private mobs = new Map<string, MobView>();
  private mobSprites = new Map<string, Phaser.GameObjects.Image>();
  private mobHpBars = new Map<string, { bg: Phaser.GameObjects.Rectangle; fill: Phaser.GameObjects.Rectangle }>();
  private attackTargetId?: string;
  private lastAttackSentAt = 0;
  private rangeIndicator!: Phaser.GameObjects.Arc;

  private hpText!: Phaser.GameObjects.Text;
  private hpBarFill!: Phaser.GameObjects.Rectangle;
  private levelText!: Phaser.GameObjects.Text;
  private xpBarFill!: Phaser.GameObjects.Rectangle;
  private powerText!: Phaser.GameObjects.Text;
  private inventorySlots = new Map<string, {
    icon: Phaser.GameObjects.Rectangle;
    nameText: Phaser.GameObjects.Text;
    qtyText: Phaser.GameObjects.Text;
    useButton?: Phaser.GameObjects.Rectangle;
    useButtonLabel?: Phaser.GameObjects.Text;
    equipButton?: Phaser.GameObjects.Rectangle;
    equipButtonLabel?: Phaser.GameObjects.Text;
  }>();
  private playerHpBars = new Map<string, { bg: Phaser.GameObjects.Rectangle; fill: Phaser.GameObjects.Rectangle }>();
  private players = new Map<string, PlayerView>();

  private backgroundGraphics!: Phaser.GameObjects.Graphics;

  // Bag, Shop, and Craft all occupy the same on-screen slot — only one is
  // ever open at a time, radio-button style, so their panels don't overlap.
  private activePanel: "none" | "bag" | "shop" | "craft" = "none";
  private bagPanel!: Phaser.GameObjects.Graphics;
  private bagPanelBounds!: { x: number; y: number; w: number; h: number };
  private bagToggleBounds!: { x: number; y: number; w: number; h: number };
  private refreshBagDisplay: (() => void) | null = null;

  private shopPanel!: Phaser.GameObjects.Graphics;
  private shopPanelBounds!: { x: number; y: number; w: number; h: number };
  private shopToggleBounds!: { x: number; y: number; w: number; h: number };
  private shopRows: Phaser.GameObjects.GameObject[] = [];

  private craftPanel!: Phaser.GameObjects.Graphics;
  private craftPanelBounds!: { x: number; y: number; w: number; h: number };
  private craftToggleBounds!: { x: number; y: number; w: number; h: number };
  private craftRows: Phaser.GameObjects.GameObject[] = [];

  private settingsOpen = false;
  private settingsPanel!: Phaser.GameObjects.Graphics;
  private settingsText!: Phaser.GameObjects.Text;
  private settingsPanelBounds!: { x: number; y: number; w: number; h: number };
  private settingsToggleBounds!: { x: number; y: number; w: number; h: number };

  // The zone we render — only mobs/players sharing it are shown. Same
  // coordinate space is reused across zones, so visibility (not position)
  // is what actually separates them on screen.
  private myZone: string = ZONE_START;
  private mobVisibility = new Map<string, () => void>();
  private playerVisibility = new Map<string, () => void>();

  private questText!: Phaser.GameObjects.Text;
  // Toasts stack vertically (up to MAX_VISIBLE_TOASTS at once) instead of a
  // single shared slot — each occupies its own row and fades out on its own
  // timer, so a loot toast and a bestiary toast firing close together can
  // both be visible simultaneously rather than strictly serialized.
  private static readonly MAX_VISIBLE_TOASTS = 3;
  private static readonly TOAST_BASE_Y = 100;
  private static readonly TOAST_LINE_HEIGHT = 22;
  private toastSlots: (Phaser.GameObjects.Text | null)[] = new Array(WorldScene.MAX_VISIBLE_TOASTS).fill(null);
  private toastQueue: { text: string; color: string }[] = [];

  private deathOverlayBg!: Phaser.GameObjects.Rectangle;
  private deathOverlayTitle!: Phaser.GameObjects.Text;
  private deathOverlaySubtitle!: Phaser.GameObjects.Text;

  preload() {
    this.load.image("hero", heroUrl);
  }

  create() {
    this.cameras.main.setBackgroundColor("#101018");

    this.backgroundGraphics = this.add.graphics().setDepth(0);
    this.drawBackground();

    this.add.rectangle(ARENA_WIDTH / 2, ARENA_HEIGHT / 2, ARENA_WIDTH, ARENA_HEIGHT)
      .setStrokeStyle(2, 0x3a3a55)
      .setDepth(0);

    // --- Portrait panel: connection status + HP bar ---
    const portraitPanel = this.add.graphics().setDepth(1);
    portraitPanel.fillStyle(0x0a0a12, 0.75);
    portraitPanel.fillRoundedRect(8, 8, 210, 62, 6);
    portraitPanel.lineStyle(1, 0x4b5563, 1);
    portraitPanel.strokeRoundedRect(8, 8, 210, 62, 6);

    this.statusText = this.add.text(18, 14, "connecting...", {
      fontFamily: "monospace",
      fontSize: "11px",
      color: "#8888ff",
    }).setDepth(2);

    const hpBarBg = this.add.rectangle(18, 36, 194, 14, 0x1f2937).setOrigin(0, 0).setDepth(2);
    this.hpBarFill = this.add.rectangle(18, 36, 194, 14, 0xf87171).setOrigin(0, 0).setDepth(2);
    hpBarBg.setStrokeStyle(1, 0x000000);

    this.hpText = this.add.text(18 + 97, 36 + 7, "", {
      fontFamily: "monospace",
      fontSize: "11px",
      color: "#ffffff",
      fontStyle: "bold",
    }).setOrigin(0.5).setDepth(3)
      .setStroke("#000000", 3);

    // --- Level + XP bar, same portrait panel, below the HP bar ---
    this.levelText = this.add.text(18, 58, "Lv 1", {
      fontFamily: "monospace",
      fontSize: "10px",
      color: "#a5b4fc",
      fontStyle: "bold",
    }).setOrigin(0, 0.5).setDepth(2);

    const xpBarX = 54;
    const xpBarY = 54;
    const xpBarBg = this.add.rectangle(xpBarX, xpBarY, XP_BAR_WIDTH, 8, 0x1f2937).setOrigin(0, 0).setDepth(2);
    this.xpBarFill = this.add.rectangle(xpBarX, xpBarY, XP_BAR_WIDTH, 8, 0x60a5fa).setOrigin(0, 0).setDepth(2);
    xpBarBg.setStrokeStyle(1, 0x000000);

    // Sum of currently-equipped gear power (weapon attack bonus + armor HP
    // bonus) — a single legible number for "how strong is my gear right now".
    this.powerText = this.add.text(216, 14, "Power 0", {
      fontFamily: "monospace",
      fontSize: "10px",
      color: "#fbbf24",
      fontStyle: "bold",
    }).setOrigin(1, 0).setDepth(2);

    // --- Quest panel ---
    const questPanel = this.add.graphics().setDepth(1);
    questPanel.fillStyle(0x0a0a12, 0.75);
    questPanel.fillRoundedRect(ARENA_WIDTH - 220, 8, 212, 30, 6);
    questPanel.lineStyle(1, 0x4b5563, 1);
    questPanel.strokeRoundedRect(ARENA_WIDTH - 220, 8, 212, 30, 6);

    this.questText = this.add.text(ARENA_WIDTH - 16, 23, "", {
      fontFamily: "monospace",
      fontSize: "12px",
      color: "#facc15",
      align: "right",
    }).setOrigin(1, 0.5).setDepth(2);

    // --- Bag / Shop / Craft: one toggle row, one shared panel slot ---
    // Only one of the three is ever open — clicking a toggle (or its key)
    // opens that one and closes whichever else was open, so their panels
    // never need to coexist on screen.
    const panelSlotY = 106;
    const panelSlotWidth = 220;

    this.bagToggleBounds = { x: 8, y: 78, w: 66, h: 24 };
    const bagToggle = this.add.rectangle(
      this.bagToggleBounds.x, this.bagToggleBounds.y, this.bagToggleBounds.w, this.bagToggleBounds.h, 0x0a0a12, 0.85,
    ).setOrigin(0, 0).setStrokeStyle(1, 0x4b5563).setDepth(1).setInteractive({ useHandCursor: true });
    this.add.text(
      this.bagToggleBounds.x + this.bagToggleBounds.w / 2, this.bagToggleBounds.y + this.bagToggleBounds.h / 2, "Bag [I]",
      { fontFamily: "monospace", fontSize: "10px", color: "#e5e7eb" },
    ).setOrigin(0.5).setDepth(2);

    this.shopToggleBounds = { x: 78, y: 78, w: 66, h: 24 };
    const shopToggle = this.add.rectangle(
      this.shopToggleBounds.x, this.shopToggleBounds.y, this.shopToggleBounds.w, this.shopToggleBounds.h, 0x0a0a12, 0.85,
    ).setOrigin(0, 0).setStrokeStyle(1, 0x4b5563).setDepth(1).setInteractive({ useHandCursor: true });
    this.add.text(
      this.shopToggleBounds.x + this.shopToggleBounds.w / 2, this.shopToggleBounds.y + this.shopToggleBounds.h / 2, "Shop [O]",
      { fontFamily: "monospace", fontSize: "10px", color: "#e5e7eb" },
    ).setOrigin(0.5).setDepth(2);

    this.craftToggleBounds = { x: 148, y: 78, w: 74, h: 24 };
    const craftToggle = this.add.rectangle(
      this.craftToggleBounds.x, this.craftToggleBounds.y, this.craftToggleBounds.w, this.craftToggleBounds.h, 0x0a0a12, 0.85,
    ).setOrigin(0, 0).setStrokeStyle(1, 0x4b5563).setDepth(1).setInteractive({ useHandCursor: true });
    this.add.text(
      this.craftToggleBounds.x + this.craftToggleBounds.w / 2, this.craftToggleBounds.y + this.craftToggleBounds.h / 2, "Craft [C]",
      { fontFamily: "monospace", fontSize: "10px", color: "#e5e7eb" },
    ).setOrigin(0.5).setDepth(2);

    // --- Bag panel ---
    const bagRowHeight = 28;
    this.bagPanelBounds = { x: 8, y: panelSlotY, w: panelSlotWidth, h: ITEM_ORDER.length * bagRowHeight + 10 };
    this.bagPanel = this.add.graphics().setDepth(1).setVisible(false);
    this.bagPanel.fillStyle(0x0a0a12, 0.9);
    this.bagPanel.fillRoundedRect(this.bagPanelBounds.x, this.bagPanelBounds.y, this.bagPanelBounds.w, this.bagPanelBounds.h, 6);
    this.bagPanel.lineStyle(1, 0x4b5563, 1);
    this.bagPanel.strokeRoundedRect(this.bagPanelBounds.x, this.bagPanelBounds.y, this.bagPanelBounds.w, this.bagPanelBounds.h, 6);

    ITEM_ORDER.forEach((itemId, i) => {
      const rowY = this.bagPanelBounds.y + 5 + i * bagRowHeight;
      const icon = this.add.rectangle(this.bagPanelBounds.x + 8, rowY, 22, 22, ITEM_COLORS[itemId])
        .setOrigin(0, 0).setStrokeStyle(1, 0x000000).setDepth(2).setVisible(false);
      const nameText = this.add.text(this.bagPanelBounds.x + 38, rowY + 11, ITEM_NAMES[itemId] ?? itemId, {
        fontFamily: "monospace", fontSize: "11px", color: "#e5e7eb",
      }).setOrigin(0, 0.5).setDepth(2).setVisible(false);
      const gear = GEAR_CATALOG[itemId];
      const qtyX = this.bagPanelBounds.x + this.bagPanelBounds.w - (CONSUMABLE_ITEMS.has(itemId) || gear ? 60 : 10);
      const qtyText = this.add.text(qtyX, rowY + 11, "", {
        fontFamily: "monospace", fontSize: "11px", color: "#facc15", fontStyle: "bold",
      }).setOrigin(1, 0.5).setDepth(2).setVisible(false);

      let useButton: Phaser.GameObjects.Rectangle | undefined;
      let useButtonLabel: Phaser.GameObjects.Text | undefined;
      if (CONSUMABLE_ITEMS.has(itemId)) {
        useButton = this.add.rectangle(this.bagPanelBounds.x + this.bagPanelBounds.w - 46, rowY, 38, 22, 0x2563eb)
          .setOrigin(0, 0).setStrokeStyle(1, 0x000000).setDepth(2).setVisible(false)
          .setInteractive({ useHandCursor: true })
          .on("pointerdown", () => this.room?.send("use", { itemId }));
        useButtonLabel = this.add.text(this.bagPanelBounds.x + this.bagPanelBounds.w - 27, rowY + 11, "Use", {
          fontFamily: "monospace", fontSize: "10px", color: "#ffffff", fontStyle: "bold",
        }).setOrigin(0.5).setDepth(3).setVisible(false);
      }

      let equipButton: Phaser.GameObjects.Rectangle | undefined;
      let equipButtonLabel: Phaser.GameObjects.Text | undefined;
      if (gear) {
        equipButton = this.add.rectangle(this.bagPanelBounds.x + this.bagPanelBounds.w - 46, rowY, 38, 22, 0x2563eb)
          .setOrigin(0, 0).setStrokeStyle(1, 0x000000).setDepth(2).setVisible(false)
          .setInteractive({ useHandCursor: true })
          .on("pointerdown", () => {
            const me = this.mySessionId && this.players.get(this.mySessionId);
            const isEquipped = me && (gear.slot === "weapon" ? me.equippedWeapon : me.equippedArmor) === itemId;
            if (isEquipped) {
              this.room?.send("unequip", { slot: gear.slot });
            } else {
              this.room?.send("equip", { itemId });
            }
          });
        equipButtonLabel = this.add.text(this.bagPanelBounds.x + this.bagPanelBounds.w - 27, rowY + 11, "Equip", {
          fontFamily: "monospace", fontSize: "9px", color: "#ffffff", fontStyle: "bold",
        }).setOrigin(0.5).setDepth(3).setVisible(false);
      }
      this.inventorySlots.set(itemId, { icon, nameText, qtyText, useButton, useButtonLabel, equipButton, equipButtonLabel });
    });

    // --- Shop panel ---
    const shopRowHeight = 28;
    const shopHeaderHeight = 20;
    this.shopPanelBounds = { x: 8, y: panelSlotY, w: panelSlotWidth, h: SHOP_CATALOG.length * shopRowHeight + shopHeaderHeight + 10 };
    this.shopPanel = this.add.graphics().setDepth(1).setVisible(false);
    this.shopPanel.fillStyle(0x0a0a12, 0.9);
    this.shopPanel.fillRoundedRect(this.shopPanelBounds.x, this.shopPanelBounds.y, this.shopPanelBounds.w, this.shopPanelBounds.h, 6);
    this.shopPanel.lineStyle(1, 0x4b5563, 1);
    this.shopPanel.strokeRoundedRect(this.shopPanelBounds.x, this.shopPanelBounds.y, this.shopPanelBounds.w, this.shopPanelBounds.h, 6);

    const shopHeader = this.add.text(this.shopPanelBounds.x + 8, this.shopPanelBounds.y + 6, `Pay with ${ITEM_NAMES[SHOP_CURRENCY_ITEM] ?? SHOP_CURRENCY_ITEM}`, {
      fontFamily: "monospace", fontSize: "10px", color: "#9ca3af",
    }).setOrigin(0, 0).setDepth(2).setVisible(false);
    this.shopRows.push(shopHeader);

    SHOP_CATALOG.forEach((entry, i) => {
      const rowY = this.shopPanelBounds.y + shopHeaderHeight + 5 + i * shopRowHeight;
      const icon = this.add.rectangle(this.shopPanelBounds.x + 8, rowY, 22, 22, ITEM_COLORS[entry.itemId])
        .setOrigin(0, 0).setStrokeStyle(1, 0x000000).setDepth(2).setVisible(false);
      const nameText = this.add.text(this.shopPanelBounds.x + 38, rowY + 11, `${ITEM_NAMES[entry.itemId] ?? entry.itemId} (${entry.price}g)`, {
        fontFamily: "monospace", fontSize: "10px", color: "#e5e7eb",
      }).setOrigin(0, 0.5).setDepth(2).setVisible(false);
      const buyButton = this.add.rectangle(this.shopPanelBounds.x + this.shopPanelBounds.w - 46, rowY, 38, 22, 0x16a34a)
        .setOrigin(0, 0).setStrokeStyle(1, 0x000000).setDepth(2).setVisible(false)
        .setInteractive({ useHandCursor: true })
        .on("pointerdown", () => this.room?.send("buy", { itemId: entry.itemId }));
      const buyLabel = this.add.text(this.shopPanelBounds.x + this.shopPanelBounds.w - 27, rowY + 11, "Buy", {
        fontFamily: "monospace", fontSize: "10px", color: "#ffffff", fontStyle: "bold",
      }).setOrigin(0.5).setDepth(3).setVisible(false);
      this.shopRows.push(icon, nameText, buyButton, buyLabel);
    });

    const showShopRows = (visible: boolean) => { for (const obj of this.shopRows) { (obj as any).setVisible(visible); } };

    // --- Craft panel ---
    const craftRowHeight = 40;
    this.craftPanelBounds = { x: 8, y: panelSlotY, w: panelSlotWidth, h: RECIPES.length * craftRowHeight + 10 };
    this.craftPanel = this.add.graphics().setDepth(1).setVisible(false);
    this.craftPanel.fillStyle(0x0a0a12, 0.9);
    this.craftPanel.fillRoundedRect(this.craftPanelBounds.x, this.craftPanelBounds.y, this.craftPanelBounds.w, this.craftPanelBounds.h, 6);
    this.craftPanel.lineStyle(1, 0x4b5563, 1);
    this.craftPanel.strokeRoundedRect(this.craftPanelBounds.x, this.craftPanelBounds.y, this.craftPanelBounds.w, this.craftPanelBounds.h, 6);

    RECIPES.forEach((recipe, i) => {
      const rowY = this.craftPanelBounds.y + 5 + i * craftRowHeight;
      const reqText = Object.entries(recipe.inputs)
        .map(([itemId, qty]) => `${qty}x ${ITEM_NAMES[itemId] ?? itemId}`)
        .join(", ");
      const nameText = this.add.text(this.craftPanelBounds.x + 8, rowY + 4, recipe.name, {
        fontFamily: "monospace", fontSize: "11px", color: "#e5e7eb", fontStyle: "bold",
      }).setOrigin(0, 0).setDepth(2).setVisible(false);
      const reqDisplay = this.add.text(this.craftPanelBounds.x + 8, rowY + 20, reqText, {
        fontFamily: "monospace", fontSize: "10px", color: "#9ca3af",
      }).setOrigin(0, 0).setDepth(2).setVisible(false);
      const craftButton = this.add.rectangle(this.craftPanelBounds.x + this.craftPanelBounds.w - 50, rowY + 5, 42, 22, 0x9333ea)
        .setOrigin(0, 0).setStrokeStyle(1, 0x000000).setDepth(2).setVisible(false)
        .setInteractive({ useHandCursor: true })
        .on("pointerdown", () => this.room?.send("craft", { recipeId: recipe.id }));
      const craftLabel = this.add.text(this.craftPanelBounds.x + this.craftPanelBounds.w - 29, rowY + 16, "Craft", {
        fontFamily: "monospace", fontSize: "10px", color: "#ffffff", fontStyle: "bold",
      }).setOrigin(0.5).setDepth(3).setVisible(false);
      this.craftRows.push(nameText, reqDisplay, craftButton, craftLabel);
    });

    const showCraftRows = (visible: boolean) => { for (const obj of this.craftRows) { (obj as any).setVisible(visible); } };

    const setActivePanel = (panel: "none" | "bag" | "shop" | "craft") => {
      this.activePanel = this.activePanel === panel ? "none" : panel;
      this.bagPanel.setVisible(this.activePanel === "bag");
      this.shopPanel.setVisible(this.activePanel === "shop");
      this.craftPanel.setVisible(this.activePanel === "craft");
      showShopRows(this.activePanel === "shop");
      showCraftRows(this.activePanel === "craft");
      this.refreshBagDisplay?.();
    };
    bagToggle.on("pointerdown", () => setActivePanel("bag"));
    shopToggle.on("pointerdown", () => setActivePanel("shop"));
    craftToggle.on("pointerdown", () => setActivePanel("craft"));
    this.input.keyboard!.on("keydown-I", () => setActivePanel("bag"));
    this.input.keyboard!.on("keydown-O", () => setActivePanel("shop"));
    this.input.keyboard!.on("keydown-C", () => setActivePanel("craft"));

    // --- Settings: toggleable controls reference ---
    this.settingsToggleBounds = { x: ARENA_WIDTH - 90, y: 44, w: 82, h: 22 };
    const settingsToggle = this.add.rectangle(
      this.settingsToggleBounds.x, this.settingsToggleBounds.y, this.settingsToggleBounds.w, this.settingsToggleBounds.h, 0x0a0a12, 0.85,
    ).setOrigin(0, 0).setStrokeStyle(1, 0x4b5563).setDepth(1).setInteractive({ useHandCursor: true });
    this.add.text(
      this.settingsToggleBounds.x + this.settingsToggleBounds.w / 2, this.settingsToggleBounds.y + this.settingsToggleBounds.h / 2, "Settings",
      { fontFamily: "monospace", fontSize: "11px", color: "#e5e7eb" },
    ).setOrigin(0.5).setDepth(2);

    this.settingsPanelBounds = {
      x: ARENA_WIDTH - 8 - 220, y: this.settingsToggleBounds.y + this.settingsToggleBounds.h + 4,
      w: 220, h: 148,
    };
    this.settingsPanel = this.add.graphics().setDepth(1).setVisible(false);
    this.settingsPanel.fillStyle(0x0a0a12, 0.92);
    this.settingsPanel.fillRoundedRect(this.settingsPanelBounds.x, this.settingsPanelBounds.y, this.settingsPanelBounds.w, this.settingsPanelBounds.h, 6);
    this.settingsPanel.lineStyle(1, 0x4b5563, 1);
    this.settingsPanel.strokeRoundedRect(this.settingsPanelBounds.x, this.settingsPanelBounds.y, this.settingsPanelBounds.w, this.settingsPanelBounds.h, 6);

    this.settingsText = this.add.text(
      this.settingsPanelBounds.x + 10, this.settingsPanelBounds.y + 10,
      "How to play\n\nMove: WASD / arrows,\n  or click the ground\nAttack: click a monster\n  (auto-continues to the\n  next one nearby)\nBag: I    Shop: O\nCraft: C    Settings: Esc",
      { fontFamily: "monospace", fontSize: "11px", color: "#e5e7eb", lineSpacing: 4 },
    ).setDepth(2).setVisible(false);

    const toggleSettings = () => {
      this.settingsOpen = !this.settingsOpen;
      this.settingsPanel.setVisible(this.settingsOpen);
      this.settingsText.setVisible(this.settingsOpen);
    };
    settingsToggle.on("pointerdown", toggleSettings);
    this.input.keyboard!.on("keydown-ESC", toggleSettings);

    // --- "You Died" overlay: full-screen dim + centered text, hidden until local death ---
    this.deathOverlayBg = this.add.rectangle(ARENA_WIDTH / 2, ARENA_HEIGHT / 2, ARENA_WIDTH, ARENA_HEIGHT, 0x000000, 0.6)
      .setVisible(false)
      .setDepth(20);

    this.deathOverlayTitle = this.add.text(ARENA_WIDTH / 2, ARENA_HEIGHT / 2 - 24, "YOU DIED", {
      fontFamily: "monospace",
      fontSize: "48px",
      color: "#f87171",
      fontStyle: "bold",
    }).setOrigin(0.5).setStroke("#000000", 6).setVisible(false).setDepth(21);

    this.deathOverlaySubtitle = this.add.text(ARENA_WIDTH / 2, ARENA_HEIGHT / 2 + 36, "Respawning...", {
      fontFamily: "monospace",
      fontSize: "16px",
      color: "#e5e7eb",
    }).setOrigin(0.5).setStroke("#000000", 3).setVisible(false).setDepth(21);

    // --- Attack range indicator: a ring around the player, shown while engaging a target ---
    this.rangeIndicator = this.add.circle(0, 0, MOB_ATTACK_RANGE, 0xffff88, 0.08)
      .setStrokeStyle(1, 0xffff88, 0.6)
      .setVisible(false)
      .setDepth(4);

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = this.input.keyboard!.addKeys("W,A,S,D") as typeof this.wasd;

    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (this.isPointerOverUI(pointer.x, pointer.y)) return;

      const mobId = this.mobAt(pointer.worldX, pointer.worldY);
      if (mobId) {
        this.setAttackTarget(mobId);
      } else {
        this.clearAttackTarget();
        this.setClickTarget(pointer.worldX, pointer.worldY);
      }
    });

    this.connect();
  }

  private setClickTarget(x: number, y: number) {
    this.clickTarget = {
      x: Phaser.Math.Clamp(x, 0, ARENA_WIDTH),
      y: Phaser.Math.Clamp(y, 0, ARENA_HEIGHT),
    };
    this.targetMarker?.destroy();
    this.targetMarker = this.add.circle(this.clickTarget.x, this.clickTarget.y, 5, 0x4ade80, 0.8);
  }

  private clearClickTarget() {
    this.clickTarget = undefined;
    this.targetMarker?.destroy();
    this.targetMarker = undefined;
  }

  private mobAt(x: number, y: number): string | undefined {
    for (const [mobId, mob] of this.mobs) {
      if (!mob.alive) continue;
      if (Math.hypot(x - mob.x, y - mob.y) <= MOB_PICK_RADIUS) return mobId;
    }
    return undefined;
  }

  private setAttackTarget(mobId: string) {
    this.clearClickTarget();
    this.attackTargetId = mobId;
    this.mobSprites.get(mobId)?.setTint(TARGETED_MOB_COLOR);
  }

  private clearAttackTarget() {
    if (this.attackTargetId) {
      const mob = this.mobs.get(this.attackTargetId);
      const baseColor = mob ? (MOB_TYPE_INFO[mob.type]?.color ?? DEFAULT_MOB_COLOR) : DEFAULT_MOB_COLOR;
      this.mobSprites.get(this.attackTargetId)?.setTint(baseColor);
    }
    this.attackTargetId = undefined;
  }

  /**
   * Auto-attack continuation: after a kill, look for the nearest living mob
   * in our own zone within AUTO_ATTACK_LEASH_RADIUS of (x, y) and keep
   * fighting, instead of going idle and waiting for a re-click.
   */
  private tryAutoRetarget(x: number, y: number) {
    this.clearAttackTarget();

    let nearestId: string | undefined;
    let nearestDist = AUTO_ATTACK_LEASH_RADIUS;
    for (const [mobId, mob] of this.mobs) {
      if (!mob.alive || mob.zone !== this.myZone) continue;
      const dist = Math.hypot(mob.x - x, mob.y - y);
      if (dist <= nearestDist) { nearestDist = dist; nearestId = mobId; }
    }
    if (nearestId) { this.setAttackTarget(nearestId); }
  }

  /** Re-applies show/hide to every tracked mob and other player after our own zone changes. */
  private refreshZoneVisibility() {
    for (const sync of this.mobVisibility.values()) { sync(); }
    for (const sync of this.playerVisibility.values()) { sync(); }
  }

  /** A tiled floor pattern, retinted per zone so "forest" reads visually distinct from "start". */
  private drawBackground() {
    this.backgroundGraphics.clear();
    const tile = 40;
    const inForest = this.myZone !== ZONE_START;
    const colorA = inForest ? 0x16241a : 0x1a1a24;
    const colorB = inForest ? 0x1c2c20 : 0x20202c;
    for (let y = 0; y < ARENA_HEIGHT; y += tile) {
      for (let x = 0; x < ARENA_WIDTH; x += tile) {
        const even = ((x / tile) + (y / tile)) % 2 === 0;
        this.backgroundGraphics.fillStyle(even ? colorA : colorB, 1);
        this.backgroundGraphics.fillRect(x, y, tile, tile);
      }
    }
  }

  /** Screen-space hit test so world clicks (move/attack) don't fire through open HUD panels. */
  private isPointerOverUI(x: number, y: number): boolean {
    const inBounds = (b: { x: number; y: number; w: number; h: number }) =>
      x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

    if (inBounds(this.bagToggleBounds) || inBounds(this.shopToggleBounds) || inBounds(this.craftToggleBounds)) return true;
    if (this.activePanel === "bag" && inBounds(this.bagPanelBounds)) return true;
    if (this.activePanel === "shop" && inBounds(this.shopPanelBounds)) return true;
    if (this.activePanel === "craft" && inBounds(this.craftPanelBounds)) return true;
    if (inBounds(this.settingsToggleBounds)) return true;
    if (this.settingsOpen && inBounds(this.settingsPanelBounds)) return true;
    return false;
  }

  private updateHpBar(hp: number, maxHp: number) {
    const ratio = Phaser.Math.Clamp(hp / maxHp, 0, 1);
    this.hpBarFill.width = 194 * ratio;
    this.hpBarFill.setFillStyle(ratio > 0.5 ? 0x4ade80 : ratio > 0.25 ? 0xfbbf24 : 0xf87171);
  }

  private updateXpBar(level: number, xp: number) {
    this.levelText.setText(`Lv ${level}`);
    const ratio = Phaser.Math.Clamp(xp / xpToNextLevel(level), 0, 1);
    this.xpBarFill.width = XP_BAR_WIDTH * ratio;
  }

  private updatePowerText(equippedWeapon: string, equippedArmor: string) {
    const power = (GEAR_CATALOG[equippedWeapon]?.power ?? 0) + (GEAR_CATALOG[equippedArmor]?.power ?? 0);
    this.powerText.setText(`Power ${power}`);
  }

  private spawnFloatingText(x: number, y: number, text: string, color: string) {
    // Small random horizontal jitter so back-to-back hits on the same target
    // don't spawn their numbers on top of each other and smear into mush.
    const jitterX = x + Phaser.Math.Between(-12, 12);

    const label = this.add.text(jitterX, y, text, {
      fontFamily: "monospace",
      fontSize: "16px",
      color,
      fontStyle: "bold",
    }).setOrigin(0.5).setDepth(5).setStroke("#000000", 4);

    this.tweens.add({
      targets: label,
      y: y - 30,
      alpha: 0,
      duration: 800,
      ease: "Cubic.easeOut",
      onComplete: () => label.destroy(),
    });
  }

  private queueToast(text: string, color: string) {
    this.toastQueue.push({ text, color });
    this.drainToastQueue();
  }

  private drainToastQueue() {
    for (let slot = 0; slot < WorldScene.MAX_VISIBLE_TOASTS; slot++) {
      if (this.toastSlots[slot]) continue;
      const next = this.toastQueue.shift();
      if (!next) return;

      const y = WorldScene.TOAST_BASE_Y + slot * WorldScene.TOAST_LINE_HEIGHT;
      const toast = this.add.text(ARENA_WIDTH / 2, y, next.text, {
        fontFamily: "monospace",
        fontSize: "13px",
        color: next.color,
        backgroundColor: "#000000aa",
        padding: { x: 8, y: 4 },
      }).setOrigin(0.5).setDepth(10);
      this.toastSlots[slot] = toast;

      // Each toast fades out on its own independent timer, so one slot
      // freeing up doesn't affect the fade timing of the others.
      this.time.delayedCall(1200, () => {
        this.tweens.add({
          targets: toast,
          alpha: 0,
          duration: 300,
          onComplete: () => {
            toast.destroy();
            if (this.toastSlots[slot] === toast) this.toastSlots[slot] = null;
            this.drainToastQueue();
          },
        });
      });
    }
  }

  private async connect() {
    const client = new Client(SERVER_URL);
    try {
      const room = await client.joinOrCreate("my_room");
      this.room = room;
      this.myInput = room.input<MoveInput>({ mode: "unreliable" });
      this.mySessionId = room.sessionId;
      this.statusText.setText(`● connected`);

      const $ = getStateCallbacks(room);

      $(room.state).mobs.onAdd((mob, mobId) => {
        this.mobs.set(mobId, { x: mob.x, y: mob.y, hp: mob.hp, maxHp: mob.maxHp, alive: mob.alive, type: mob.type, zone: mob.zone });
        const baseColor = MOB_TYPE_INFO[mob.type]?.color ?? DEFAULT_MOB_COLOR;

        const sprite = this.add.image(mob.x, mob.y, "hero")
          .setDisplaySize(36, 50)
          .setTint(baseColor)
          .setInteractive({ useHandCursor: true });
        this.mobSprites.set(mobId, sprite);

        const nameLabel = this.add.text(mob.x, mob.y - 46, MOB_TYPE_INFO[mob.type]?.name ?? mob.type, {
          fontFamily: "monospace",
          fontSize: "10px",
          color: "#e5e7eb",
        }).setOrigin(0.5).setStroke("#000000", 3);

        const barWidth = 32;
        const hpBg = this.add.rectangle(mob.x, mob.y - 34, barWidth, 5, 0x222222).setOrigin(0.5);
        const hpFill = this.add.rectangle(mob.x - barWidth / 2, mob.y - 34, barWidth, 5, 0x4ade80).setOrigin(0, 0.5);
        this.mobHpBars.set(mobId, { bg: hpBg, fill: hpFill });

        // Only render mobs that share our current zone — same numeric
        // coordinate space is reused across zones, so this is the only thing
        // that actually keeps them visually separated.
        const syncVisibility = () => {
          const visible = mob.alive && mob.zone === this.myZone;
          sprite.setVisible(visible);
          nameLabel.setVisible(visible);
          hpBg.setVisible(visible);
          hpFill.setVisible(visible);
        };
        this.mobVisibility.set(mobId, syncVisibility);
        syncVisibility();

        $(mob).onChange(() => {
          const view = this.mobs.get(mobId);
          const prevHp = view?.hp ?? mob.hp;
          if (view) { view.x = mob.x; view.y = mob.y; view.hp = mob.hp; view.maxHp = mob.maxHp; view.alive = mob.alive; view.type = mob.type; view.zone = mob.zone; }

          const dmg = prevHp - mob.hp;
          if (dmg > 0) { this.spawnFloatingText(mob.x, mob.y - 20, `-${dmg}`, "#ffffff"); }

          const tint = this.attackTargetId === mobId ? TARGETED_MOB_COLOR : baseColor;
          sprite.setPosition(mob.x, mob.y).setTint(tint);
          nameLabel.setPosition(mob.x, mob.y - 46);
          hpBg.setPosition(mob.x, mob.y - 34);
          hpFill.setPosition(mob.x - barWidth / 2, mob.y - 34);
          hpFill.width = barWidth * Phaser.Math.Clamp(mob.hp / mob.maxHp, 0, 1);
          syncVisibility();
          // Death/retarget handling lives entirely in update() now, so it can
          // pick a new nearby target instead of just clearing (auto-attack).
        });
      });

      $(room.state).players.onAdd((player, sessionId) => {
        const isMe = sessionId === room.sessionId;
        this.players.set(sessionId, { x: player.x, y: player.y, hp: player.hp, maxHp: player.maxHp, level: player.level, xp: player.xp, zone: player.zone, equippedWeapon: player.equippedWeapon, equippedArmor: player.equippedArmor });

        const avatar = this.add.image(player.x, player.y, "hero")
          .setDisplaySize(40, 56)
          .setTint(isMe ? 0xffffff : 0xffb380);
        this.sprites.set(sessionId, avatar);

        const label = this.add.text(player.x, player.y - 38, sessionId.slice(0, 4), {
          fontFamily: "monospace",
          fontSize: "11px",
          color: isMe ? "#4ade80" : "#f97316",
        }).setOrigin(0.5).setStroke("#000000", 3);
        this.labels.set(sessionId, label);

        const barWidth = 36;
        const hpBg = this.add.rectangle(player.x, player.y - 46, barWidth, 5, 0x222222).setOrigin(0.5);
        const hpFill = this.add.rectangle(player.x - barWidth / 2, player.y - 46, barWidth, 5, 0xf87171).setOrigin(0, 0.5);
        this.playerHpBars.set(sessionId, { bg: hpBg, fill: hpFill });

        // We always render ourselves; other players only render while they
        // share our current zone.
        const syncVisibility = () => {
          const visible = isMe || player.zone === this.myZone;
          avatar.setVisible(visible);
          label.setVisible(visible);
          hpBg.setVisible(visible);
          hpFill.setVisible(visible);
        };
        this.playerVisibility.set(sessionId, syncVisibility);
        syncVisibility();

        $(player).onChange(() => {
          const view = this.players.get(sessionId);
          const prevHp = view?.hp ?? player.hp;
          const prevLevel = view?.level ?? player.level;
          if (view) {
            view.x = player.x; view.y = player.y; view.hp = player.hp; view.maxHp = player.maxHp;
            view.level = player.level; view.xp = player.xp; view.zone = player.zone;
            view.equippedWeapon = player.equippedWeapon; view.equippedArmor = player.equippedArmor;
          }

          if (isMe && player.zone !== this.myZone) {
            this.myZone = player.zone;
            this.refreshZoneVisibility();
            this.drawBackground();
          }

          const dmg = prevHp - player.hp;
          if (dmg > 0) { this.spawnFloatingText(player.x, player.y - 30, `-${dmg}`, "#f87171"); }

          const alive = player.hp > 0;
          avatar.setPosition(player.x, player.y).setAlpha(alive ? 1 : 0.3);
          label.setPosition(player.x, player.y - 38);
          hpBg.setPosition(player.x, player.y - 46);
          hpFill.setPosition(player.x - barWidth / 2, player.y - 46);
          hpFill.width = barWidth * Phaser.Math.Clamp(player.hp / player.maxHp, 0, 1);
          syncVisibility();

          if (isMe) {
            this.hpText.setText(alive ? `${player.hp}/${player.maxHp}` : "respawning...");
            this.updateHpBar(player.hp, player.maxHp);
            this.updateXpBar(player.level, player.xp);
            this.updatePowerText(player.equippedWeapon, player.equippedArmor);
            if (player.level > prevLevel) { this.queueToast(`Level up! Lv ${player.level}`, "#a5b4fc"); }
            if (!alive) { this.clearAttackTarget(); this.clearClickTarget(); }

            const showDeathOverlay = !alive;
            this.deathOverlayBg.setVisible(showDeathOverlay);
            this.deathOverlayTitle.setVisible(showDeathOverlay);
            this.deathOverlaySubtitle.setVisible(showDeathOverlay);

            const questLine = player.questComplete
              ? "Cull the Vermin — complete!"
              : `Cull the Vermin  ${player.questKills}/${QUEST_KILL_TARGET}`;
            this.questText.setText(questLine);
          }
        });

        if (isMe) {
          this.myZone = player.zone;
          this.hpText.setText(`${player.hp}/${player.maxHp}`);
          this.updateHpBar(player.hp, player.maxHp);
          this.updateXpBar(player.level, player.xp);
          this.updatePowerText(player.equippedWeapon, player.equippedArmor);
          this.questText.setText(player.questComplete
            ? "Cull the Vermin — complete!"
            : `Cull the Vermin  ${player.questKills}/${QUEST_KILL_TARGET}`);

          let invInitialized = false;
          const lastInv = new Map<string, number>();
          const refreshInventory = () => {
            ITEM_ORDER.forEach((itemId) => {
              const qty = player.inventory.get(itemId) ?? 0;
              const gear = GEAR_CATALOG[itemId];
              const isEquipped = !!gear && (gear.slot === "weapon" ? player.equippedWeapon : player.equippedArmor) === itemId;
              const slot = this.inventorySlots.get(itemId)!;
              const show = this.activePanel === "bag" && (qty > 0 || isEquipped);
              slot.icon.setVisible(show);
              slot.nameText.setVisible(show);
              slot.qtyText.setVisible(show);
              slot.qtyText.setText(qty > 0 ? `x${qty}` : "");
              slot.useButton?.setVisible(show);
              slot.useButtonLabel?.setVisible(show);
              slot.equipButton?.setVisible(show).setFillStyle(isEquipped ? 0x6b7280 : 0x2563eb);
              slot.equipButtonLabel?.setVisible(show).setText(isEquipped ? "Unequip" : "Equip").setFontSize(isEquipped ? 8 : 9);

              if (invInitialized) {
                const prev = lastInv.get(itemId) ?? 0;
                if (qty > prev) {
                  this.queueToast(`+${qty - prev} ${ITEM_NAMES[itemId] ?? itemId}`, "#eab308");
                }
              }
              lastInv.set(itemId, qty);
            });
          };
          this.refreshBagDisplay = refreshInventory;
          $(player.inventory).onAdd(refreshInventory);
          $(player.inventory).onChange(refreshInventory);
          refreshInventory();
          invInitialized = true;

          let bestiaryReady = false;
          const announceDiscovery = (_discovered: boolean, mobType: string) => {
            if (!bestiaryReady) { return; }
            const name = MOB_TYPE_INFO[mobType]?.name ?? mobType;
            this.queueToast(`New monster discovered: ${name}!`, "#facc15");
          };
          $(player.bestiary).onAdd(announceDiscovery);
          this.time.delayedCall(500, () => { bestiaryReady = true; });
        }
      });

      $(room.state).players.onRemove((_player, sessionId) => {
        this.sprites.get(sessionId)?.destroy();
        this.labels.get(sessionId)?.destroy();
        this.sprites.delete(sessionId);
        this.labels.delete(sessionId);
        this.playerVisibility.delete(sessionId);
      });

      room.onLeave((code) => {
        this.statusText.setText(`disconnected (code ${code})`);
      });
    } catch (err) {
      this.statusText.setText(`connection failed: ${(err as Error).message}`);
      console.error(err);
    }
  }

  update() {
    if (!this.myInput) return;

    const me = this.mySessionId && this.players.get(this.mySessionId);
    if (me && me.hp <= 0) {
      // Dead — server ignores our input anyway; don't bother steering.
      this.rangeIndicator.setVisible(false);
      this.myInput.data.moveX = 0;
      this.myInput.data.moveY = 0;
      this.myInput.send();
      return;
    }

    if (me) {
      this.rangeIndicator.setPosition(me.x, me.y).setVisible(!!this.attackTargetId);
    }

    const left = this.cursors.left.isDown || this.wasd.A.isDown;
    const right = this.cursors.right.isDown || this.wasd.D.isDown;
    const up = this.cursors.up.isDown || this.wasd.W.isDown;
    const down = this.cursors.down.isDown || this.wasd.S.isDown;
    const keyboardActive = left || right || up || down;

    let moveX: -1 | 0 | 1 = 0;
    let moveY: -1 | 0 | 1 = 0;

    if (keyboardActive) {
      // Keyboard always wins and cancels any pending click-to-move/attack order.
      this.clearClickTarget();
      this.clearAttackTarget();
      moveX = ((right ? 1 : 0) - (left ? 1 : 0)) as -1 | 0 | 1;
      moveY = ((down ? 1 : 0) - (up ? 1 : 0)) as -1 | 0 | 1;
    } else if (this.attackTargetId) {
      const mob = this.mobs.get(this.attackTargetId);
      const me = this.mySessionId && this.sprites.get(this.mySessionId);
      if (!mob || !mob.alive) {
        // Target died — auto-attack keeps going by picking up the nearest
        // living mob instead of just stopping, so kills don't require a
        // re-click every time.
        if (me) { this.tryAutoRetarget(me.x, me.y); } else { this.clearAttackTarget(); }
      } else if (!me) {
        this.clearAttackTarget();
      } else {
        const dx = mob.x - me.x;
        const dy = mob.y - me.y;
        if (Math.hypot(dx, dy) > MOB_ATTACK_RANGE) {
          moveX = Math.sign(dx) as -1 | 0 | 1;
          moveY = Math.sign(dy) as -1 | 0 | 1;
        } else {
          const now = this.time.now;
          if (this.room && now - this.lastAttackSentAt >= ATTACK_SEND_INTERVAL_MS) {
            this.lastAttackSentAt = now;
            this.room.send("attack", { mobId: this.attackTargetId });
          }
        }
      }
    } else if (this.clickTarget) {
      const me = this.mySessionId && this.sprites.get(this.mySessionId);
      if (me) {
        const dx = this.clickTarget.x - me.x;
        const dy = this.clickTarget.y - me.y;
        if (Math.hypot(dx, dy) <= ARRIVE_THRESHOLD) {
          this.clearClickTarget();
        } else {
          moveX = Math.sign(dx) as -1 | 0 | 1;
          moveY = Math.sign(dy) as -1 | 0 | 1;
        }
      }
    }

    this.myInput.data.moveX = moveX;
    this.myInput.data.moveY = moveY;
    this.myInput.send();
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  width: ARENA_WIDTH,
  height: ARENA_HEIGHT,
  parent: "app",
  backgroundColor: "#000000",
  scene: WorldScene,
});
