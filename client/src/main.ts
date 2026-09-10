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
const ITEM_ORDER = ["wolf_pelt", "iron_ore", "gold_coin"];
const ITEM_NAMES: Record<string, string> = {
  wolf_pelt: "Wolf Pelt",
  iron_ore: "Iron Ore",
  gold_coin: "Gold Coin",
};
const ITEM_COLORS: Record<string, number> = {
  wolf_pelt: 0x8b5a2b,
  iron_ore: 0x9ca3af,
  gold_coin: 0xfbbf24,
};

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

interface MobView { x: number; y: number; hp: number; maxHp: number; alive: boolean; type: string; }
interface PlayerView { x: number; y: number; hp: number; maxHp: number; }

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

  private hpText!: Phaser.GameObjects.Text;
  private hpBarFill!: Phaser.GameObjects.Rectangle;
  private inventorySlots = new Map<string, { icon: Phaser.GameObjects.Rectangle; qtyText: Phaser.GameObjects.Text }>();
  private playerHpBars = new Map<string, { bg: Phaser.GameObjects.Rectangle; fill: Phaser.GameObjects.Rectangle }>();
  private players = new Map<string, PlayerView>();

  private questText!: Phaser.GameObjects.Text;
  private toastText!: Phaser.GameObjects.Text;
  private toastQueue: { text: string; color: string }[] = [];
  private toastBusy = false;

  preload() {
    this.load.image("hero", heroUrl);
  }

  create() {
    this.cameras.main.setBackgroundColor("#101018");
    this.add.rectangle(ARENA_WIDTH / 2, ARENA_HEIGHT / 2, ARENA_WIDTH, ARENA_HEIGHT)
      .setStrokeStyle(2, 0x3a3a55);

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

    this.toastText = this.add.text(ARENA_WIDTH / 2, 100, "", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#ffffff",
      backgroundColor: "#000000aa",
      padding: { x: 8, y: 4 },
    }).setOrigin(0.5).setVisible(false).setDepth(10);

    const tooltip = this.add.text(0, 0, "", {
      fontFamily: "monospace",
      fontSize: "11px",
      color: "#ffffff",
      backgroundColor: "#000000cc",
      padding: { x: 4, y: 2 },
    }).setVisible(false).setDepth(10);

    // --- Inventory panel ---
    const invPanelWidth = ITEM_ORDER.length * 46 + 4;
    const invPanel = this.add.graphics().setDepth(1);
    invPanel.fillStyle(0x0a0a12, 0.75);
    invPanel.fillRoundedRect(8, 78, invPanelWidth, 44, 6);
    invPanel.lineStyle(1, 0x4b5563, 1);
    invPanel.strokeRoundedRect(8, 78, invPanelWidth, 44, 6);

    ITEM_ORDER.forEach((itemId, i) => {
      const x = 12 + i * 46;
      const y = 82;
      const icon = this.add.rectangle(x, y, 36, 36, ITEM_COLORS[itemId])
        .setOrigin(0, 0)
        .setStrokeStyle(1, 0x000000)
        .setVisible(false)
        .setDepth(2)
        .setInteractive({ useHandCursor: true })
        .on("pointerover", () => tooltip.setText(ITEM_NAMES[itemId] ?? itemId).setPosition(x, y + 40).setVisible(true))
        .on("pointerout", () => tooltip.setVisible(false));
      const qtyText = this.add.text(x + 3, y + 20, "", {
        fontFamily: "monospace",
        fontSize: "11px",
        color: "#000000",
        fontStyle: "bold",
      }).setVisible(false).setDepth(3);
      this.inventorySlots.set(itemId, { icon, qtyText });
    });

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = this.input.keyboard!.addKeys("W,A,S,D") as typeof this.wasd;

    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
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

  private updateHpBar(hp: number, maxHp: number) {
    const ratio = Phaser.Math.Clamp(hp / maxHp, 0, 1);
    this.hpBarFill.width = 194 * ratio;
    this.hpBarFill.setFillStyle(ratio > 0.5 ? 0x4ade80 : ratio > 0.25 ? 0xfbbf24 : 0xf87171);
  }

  private spawnFloatingText(x: number, y: number, text: string, color: string) {
    const label = this.add.text(x, y, text, {
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
    if (this.toastBusy || this.toastQueue.length === 0) return;
    const next = this.toastQueue.shift()!;
    this.toastBusy = true;
    this.toastText.setText(next.text).setColor(next.color).setAlpha(1).setVisible(true);

    this.time.delayedCall(1200, () => {
      this.tweens.add({
        targets: this.toastText,
        alpha: 0,
        duration: 300,
        onComplete: () => {
          this.toastText.setVisible(false);
          this.toastBusy = false;
          this.drainToastQueue();
        },
      });
    });
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
        this.mobs.set(mobId, { x: mob.x, y: mob.y, hp: mob.hp, maxHp: mob.maxHp, alive: mob.alive, type: mob.type });
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

        $(mob).onChange(() => {
          const view = this.mobs.get(mobId);
          const prevHp = view?.hp ?? mob.hp;
          if (view) { view.x = mob.x; view.y = mob.y; view.hp = mob.hp; view.maxHp = mob.maxHp; view.alive = mob.alive; view.type = mob.type; }

          const dmg = prevHp - mob.hp;
          if (dmg > 0) { this.spawnFloatingText(mob.x, mob.y - 20, `-${dmg}`, "#ffffff"); }

          const tint = this.attackTargetId === mobId ? TARGETED_MOB_COLOR : baseColor;
          sprite.setPosition(mob.x, mob.y).setVisible(mob.alive).setTint(tint);
          nameLabel.setPosition(mob.x, mob.y - 46).setVisible(mob.alive);

          hpBg.setPosition(mob.x, mob.y - 34);
          hpBg.setVisible(mob.alive);
          hpFill.setPosition(mob.x - barWidth / 2, mob.y - 34);
          hpFill.setVisible(mob.alive);
          hpFill.width = barWidth * Phaser.Math.Clamp(mob.hp / mob.maxHp, 0, 1);

          if (!mob.alive && this.attackTargetId === mobId) {
            this.clearAttackTarget();
          }
        });
      });

      $(room.state).players.onAdd((player, sessionId) => {
        const isMe = sessionId === room.sessionId;
        this.players.set(sessionId, { x: player.x, y: player.y, hp: player.hp, maxHp: player.maxHp });

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

        $(player).onChange(() => {
          const view = this.players.get(sessionId);
          const prevHp = view?.hp ?? player.hp;
          if (view) { view.x = player.x; view.y = player.y; view.hp = player.hp; view.maxHp = player.maxHp; }

          const dmg = prevHp - player.hp;
          if (dmg > 0) { this.spawnFloatingText(player.x, player.y - 30, `-${dmg}`, "#f87171"); }

          const alive = player.hp > 0;
          avatar.setPosition(player.x, player.y).setAlpha(alive ? 1 : 0.3);
          label.setPosition(player.x, player.y - 38);
          hpBg.setPosition(player.x, player.y - 46);
          hpFill.setPosition(player.x - barWidth / 2, player.y - 46);
          hpFill.width = barWidth * Phaser.Math.Clamp(player.hp / player.maxHp, 0, 1);

          if (isMe) {
            this.hpText.setText(alive ? `${player.hp}/${player.maxHp}` : "respawning...");
            this.updateHpBar(player.hp, player.maxHp);
            if (!alive) { this.clearAttackTarget(); this.clearClickTarget(); }

            const questLine = player.questComplete
              ? "Cull the Vermin — complete!"
              : `Cull the Vermin  ${player.questKills}/${QUEST_KILL_TARGET}`;
            this.questText.setText(questLine);
          }
        });

        if (isMe) {
          this.hpText.setText(`${player.hp}/${player.maxHp}`);
          this.updateHpBar(player.hp, player.maxHp);
          this.questText.setText(player.questComplete
            ? "Cull the Vermin — complete!"
            : `Cull the Vermin  ${player.questKills}/${QUEST_KILL_TARGET}`);

          let invInitialized = false;
          const lastInv = new Map<string, number>();
          const refreshInventory = () => {
            ITEM_ORDER.forEach((itemId) => {
              const qty = player.inventory.get(itemId) ?? 0;
              const slot = this.inventorySlots.get(itemId)!;
              slot.icon.setVisible(qty > 0);
              slot.qtyText.setVisible(qty > 0);
              slot.qtyText.setText(qty > 0 ? `x${qty}` : "");

              if (invInitialized) {
                const prev = lastInv.get(itemId) ?? 0;
                if (qty > prev) {
                  this.queueToast(`+${qty - prev} ${ITEM_NAMES[itemId] ?? itemId}`, "#eab308");
                }
              }
              lastInv.set(itemId, qty);
            });
          };
          $(player.inventory).onAdd(refreshInventory);
          $(player.inventory).onChange(refreshInventory);
          refreshInventory();
          invInitialized = true;

          let bestiaryReady = false;
          const announceDiscovery = (mobType: string) => {
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
      this.myInput.data.moveX = 0;
      this.myInput.data.moveY = 0;
      this.myInput.send();
      return;
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
      if (!mob || !mob.alive || !me) {
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
