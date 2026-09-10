import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { MyRoomState, type MoveInput } from "../src/rooms/schema/MyRoomState.js";
import { PLAYER_SPEED, TICK_RATE } from "../src/shared/constants.js";

describe("testing your Colyseus app", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => colyseus = await boot(appConfig));
  after(async () => colyseus.shutdown());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  it("advances a player from its buffered input", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room);

    const player = room.state.players.get(client1.sessionId);
    assert.ok(player, "a Player is created on join");
    const startX = player.x;

    const input = client1.input<MoveInput>({ mode: "reliable" });
    input.data.moveX = 1;
    input.data.moveY = 0;
    input.send();

    await room.waitForNextMessage();  // the input reaches the server
    await room.waitForNextTimestep(); // the step that consumes it runs

    assert.ok(player.x > startX, "the buffered input advanced the player");
  });

  it("clamps input that is out of range", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room);

    const player = room.state.players.get(client1.sessionId);
    const startX = player.x;

    // A modified client claiming a huge axis value: sanitize clamps it to 1.
    const input = client1.input<MoveInput>({ mode: "reliable" });
    input.data.moveX = 100 as any;
    input.send();

    await room.waitForNextMessage();
    await room.waitForNextTimestep();

    // The room steps once per received input, so one input is exactly one step
    // of travel — at moveX clamped to 1, not the 100 the client asked for.
    assert.strictEqual(player.x, startX + PLAYER_SPEED * (1 / TICK_RATE));
  });

  it("equips a weapon from the bag, consuming it and boosting attack damage", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room);

    const player = room.state.players.get(client1.sessionId);
    player.inventory.set("iron_dagger", 1);

    client1.send("equip", { itemId: "iron_dagger" });
    await room.waitForNextMessage();

    assert.strictEqual(player.equippedWeapon, "iron_dagger");
    assert.strictEqual(player.inventory.get("iron_dagger") ?? 0, 0, "the equipped copy leaves the bag");

    // Stand on top of mob-0 (a rat, spawned at 200,150 in the "start" zone)
    // so the attack lands regardless of MOB_ATTACK_RANGE.
    const mob = room.state.mobs.get("mob-0");
    player.x = mob.x;
    player.y = mob.y;
    const startHp = mob.hp;

    client1.send("attack", { mobId: "mob-0" });
    await room.waitForNextMessage();

    // Iron Dagger power (8) stacks on top of the base MOB_ATTACK_DAMAGE (10).
    assert.strictEqual(startHp - mob.hp, 18);
  });

  it("equips armor for a maxHp/hp boost, and unequip reverts it and returns the item", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room);

    const player = room.state.players.get(client1.sessionId);
    player.inventory.set("leather_armor", 1);
    const startMaxHp = player.maxHp;
    const startHp = player.hp;

    client1.send("equip", { itemId: "leather_armor" });
    await room.waitForNextMessage();

    assert.strictEqual(player.equippedArmor, "leather_armor");
    assert.strictEqual(player.inventory.get("leather_armor") ?? 0, 0);
    assert.strictEqual(player.maxHp, startMaxHp + 20);
    assert.strictEqual(player.hp, startHp + 20, "equipping armor heals by the same amount it adds to max HP");

    client1.send("unequip", { slot: "armor" });
    await room.waitForNextMessage();

    assert.strictEqual(player.equippedArmor, "");
    assert.strictEqual(player.inventory.get("leather_armor") ?? 0, 1, "unequipping returns the item to the bag");
    assert.strictEqual(player.maxHp, startMaxHp);
    assert.strictEqual(player.hp, startMaxHp, "hp is clamped back down to the reverted max");
  });

  it("rejects equipping gear the player doesn't own, and rejects unknown items", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room);

    const player = room.state.players.get(client1.sessionId);

    client1.send("equip", { itemId: "iron_dagger" }); // 0 in bag
    await room.waitForNextMessage();
    assert.strictEqual(player.equippedWeapon, "", "can't equip gear you don't have");

    client1.send("equip", { itemId: "wolf_pelt" }); // owned material, but not gear
    await room.waitForNextMessage();
    assert.strictEqual(player.equippedWeapon, "", "non-gear items are never equippable");
  });

  it("power_strike deals bonus damage and spends mana, respecting its own cooldown", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room);

    const player = room.state.players.get(client1.sessionId);
    // mob-4 is a wolf (45 max hp) — tough enough that the hit doesn't clamp
    // at 0 and mask the actual damage dealt, unlike the 20-hp rat (mob-0).
    const mob = room.state.mobs.get("mob-4");
    player.x = mob.x;
    player.y = mob.y;
    const startMana = player.mana;
    const startHp = mob.hp;

    client1.send("useSkill", { skillId: "power_strike", targetMobId: "mob-4" });
    await room.waitForNextMessage();

    // Base MOB_ATTACK_DAMAGE (10) + power_strike's power (15), no weapon equipped.
    assert.strictEqual(startHp - mob.hp, 25);
    assert.strictEqual(player.mana, startMana - 8);

    // Cooldown blocks an immediate second cast even with enough mana left.
    const hpAfterFirst = mob.hp;
    client1.send("useSkill", { skillId: "power_strike", targetMobId: "mob-4" });
    await room.waitForNextMessage();
    assert.strictEqual(mob.hp, hpAfterFirst, "still on cooldown — second cast is a no-op");
  });

  it("heal is a no-op at full hp (and doesn't start its cooldown)", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room);

    const player = room.state.players.get(client1.sessionId);

    client1.send("useSkill", { skillId: "heal" });
    await room.waitForNextMessage();
    assert.strictEqual(player.mana, 50, "heal at full hp spends no mana");
  });

  it("heal restores its power and spends mana", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room);

    const player = room.state.players.get(client1.sessionId);
    player.hp = 50;

    client1.send("useSkill", { skillId: "heal" });
    await room.waitForNextMessage();
    assert.strictEqual(player.hp, 80, "heal restores its power (30)");
    assert.strictEqual(player.mana, 35, "heal's mana cost (15) is spent");
  });

  it("heal is rejected without enough mana", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room);

    const player = room.state.players.get(client1.sessionId);
    player.hp = 50;
    player.mana = 0;

    client1.send("useSkill", { skillId: "heal" });
    await room.waitForNextMessage();
    assert.strictEqual(player.hp, 50, "no mana — heal is rejected");
  });
});
