import {
  Engine, Scene, ArcRotateCamera, HemisphericLight, DirectionalLight,
  MeshBuilder, StandardMaterial, Color3, Vector3, TransformNode,
  PointerEventTypes, ShadowGenerator,
} from "@babylonjs/core";
import { Client, getStateCallbacks, type InputHandle } from "@colyseus/sdk";

const ARENA_WIDTH = 800;
const ARENA_HEIGHT = 600;
const SERVER_URL = "ws://localhost:2567";

// The server's coordinates are raw pixel values (a 800x600 arena); characters
// are sized in realistic meter-ish units (~1.6 tall). Without a scale factor
// the 3D world would be enormous relative to the characters, forcing the
// camera to either zoom in on a giant character or zoom out until everyone
// is invisible. This maps the whole arena down to a sane ~40x30 unit space.
const WORLD_SCALE = 1 / 20;

// Mirrors server's shared/mobTypes.ts — display data only.
const MOB_COLORS: Record<string, Color3> = {
  rat: new Color3(0.61, 0.64, 0.69),
  slime: new Color3(0.22, 0.74, 0.97),
  wolf: new Color3(0.47, 0.21, 0.06),
};

// 2D world (x, y) maps to the 3D ground plane (x, z), scaled down by
// WORLD_SCALE; y-up is height.
function toWorld(x: number, y: number): Vector3 {
  return new Vector3((x - ARENA_WIDTH / 2) * WORLD_SCALE, 0, (ARENA_HEIGHT / 2 - y) * WORLD_SCALE);
}

// Inverse of toWorld() for the X/Z plane — used to turn a ground click back
// into game coordinates for click-to-move.
function toGame(worldX: number, worldZ: number): { x: number; y: number } {
  return {
    x: worldX / WORLD_SCALE + ARENA_WIDTH / 2,
    y: ARENA_HEIGHT / 2 - worldZ / WORLD_SCALE,
  };
}

type MoveInput = { moveX: -1 | 0 | 1; moveY: -1 | 0 | 1 };

/** A simple original 3D "token" per entity type — primitives only, no external models. */
function buildCharacterMesh(scene: Scene, kind: "player" | "rat" | "slime" | "wolf", color: Color3): TransformNode {
  const root = new TransformNode(`char-${kind}-${Math.random()}`, scene);
  const mat = new StandardMaterial(`mat-${kind}-${Math.random()}`, scene);
  mat.diffuseColor = color;

  if (kind === "player") {
    const body = MeshBuilder.CreateCapsule("body", { height: 1.6, radius: 0.35 }, scene);
    body.position.y = 0.8;
    const head = MeshBuilder.CreateSphere("head", { diameter: 0.5 }, scene);
    head.position.y = 1.7;
    body.material = mat; head.material = mat;
    body.parent = root; head.parent = root;
  } else if (kind === "rat") {
    const body = MeshBuilder.CreateSphere("body", { diameterX: 0.6, diameterY: 0.4, diameterZ: 0.8 }, scene);
    body.position.y = 0.3;
    const earL = MeshBuilder.CreateSphere("earL", { diameter: 0.15 }, scene);
    earL.position.set(-0.15, 0.5, 0.3);
    const earR = earL.clone("earR"); earR.position.x = 0.15;
    [body, earL, earR].forEach((m) => { m.material = mat; m.parent = root; });
  } else if (kind === "slime") {
    const body = MeshBuilder.CreateSphere("body", { diameterX: 0.9, diameterY: 0.7, diameterZ: 0.9 }, scene);
    body.position.y = 0.35;
    body.material = mat;
    body.parent = root;
  } else {
    const body = MeshBuilder.CreateBox("body", { width: 0.6, height: 0.6, depth: 1.1 }, scene);
    body.position.y = 0.45;
    const earL = MeshBuilder.CreateCylinder("earL", { diameterTop: 0, diameterBottom: 0.15, height: 0.25 }, scene);
    earL.position.set(-0.15, 0.85, 0.4);
    const earR = earL.clone("earR"); earR.position.x = 0.15;
    [body, earL, earR].forEach((m) => { m.material = mat; m.parent = root; });
  }
  return root;
}

async function main() {
  const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
  const engine = new Engine(canvas, true);
  const scene = new Scene(engine);
  scene.clearColor.set(0.06, 0.06, 0.09, 1);

  const camera = new ArcRotateCamera("cam", -Math.PI / 2, 1.0, 22, Vector3.Zero(), scene);
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = 6;
  camera.upperRadiusLimit = 60;
  camera.wheelPrecision = 30;

  new HemisphericLight("sky", new Vector3(0, 1, 0), scene).intensity = 0.6;
  const sun = new DirectionalLight("sun", new Vector3(-0.5, -1, -0.3), scene);
  sun.intensity = 0.8;
  const shadows = new ShadowGenerator(1024, sun);
  shadows.usePoissonSampling = true;

  const ground = MeshBuilder.CreateGround(
    "ground",
    { width: ARENA_WIDTH * WORLD_SCALE, height: ARENA_HEIGHT * WORLD_SCALE, subdivisions: 20 },
    scene,
  );
  const groundMat = new StandardMaterial("groundMat", scene);
  groundMat.diffuseColor = new Color3(0.16, 0.18, 0.22);
  ground.material = groundMat;
  ground.receiveShadows = true;

  const players = new Map<string, { node: TransformNode; hp: number; maxHp: number }>();
  const mobs = new Map<string, { node: TransformNode; alive: boolean }>();

  const client = new Client(SERVER_URL);
  const room = await client.joinOrCreate<any>("my_room");
  const $ = getStateCallbacks(room);
  const myInput: InputHandle<MoveInput> = room.input<MoveInput>({ mode: "unreliable" });

  let mySessionId = room.sessionId;
  let clickTarget: { x: number; y: number } | null = null;

  $(room.state).mobs.onAdd((mob: any, mobId: string) => {
    const node = buildCharacterMesh(scene, mob.type, MOB_COLORS[mob.type] ?? new Color3(1, 0.3, 0.3));
    const pos = toWorld(mob.x, mob.y);
    node.position.copyFrom(pos);
    node.getChildMeshes().forEach((m) => shadows.addShadowCaster(m));
    mobs.set(mobId, { node, alive: mob.alive });

    $(mob).onChange(() => {
      const entry = mobs.get(mobId)!;
      entry.node.position.copyFrom(toWorld(mob.x, mob.y));
      entry.alive = mob.alive;
      entry.node.setEnabled(mob.alive);
    });
  });

  $(room.state).players.onAdd((player: any, sessionId: string) => {
    const isMe = sessionId === mySessionId;
    const color = isMe ? new Color3(1, 1, 1) : new Color3(1, 0.7, 0.5);
    const node = buildCharacterMesh(scene, "player", color);
    node.position.copyFrom(toWorld(player.x, player.y));
    node.getChildMeshes().forEach((m) => shadows.addShadowCaster(m));
    players.set(sessionId, { node, hp: player.hp, maxHp: player.maxHp });

    $(player).onChange(() => {
      const entry = players.get(sessionId)!;
      entry.node.position.copyFrom(toWorld(player.x, player.y));
      entry.hp = player.hp; entry.maxHp = player.maxHp;
      entry.node.setEnabled(player.hp > 0);
    });
  });

  // Click-to-move: raycast to the ground plane on a genuine click (not a camera-drag).
  scene.onPointerObservable.add((info) => {
    if (info.type !== PointerEventTypes.POINTERTAP) { return; }
    const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m === ground);
    if (pick?.hit && pick.pickedPoint) {
      const { x: wx, y: wy } = toGame(pick.pickedPoint.x, pick.pickedPoint.z);
      clickTarget = {
        x: Math.max(0, Math.min(ARENA_WIDTH, wx)),
        y: Math.max(0, Math.min(ARENA_HEIGHT, wy)),
      };
    }
  });

  scene.onBeforeRenderObservable.add(() => {
    const me = players.get(mySessionId);
    if (!me) { return; }

    // Follow the player directly (mutating .target, not calling setTarget())
    // so the camera's radius/alpha/beta framing set at creation is preserved
    // instead of being recomputed from the camera's old position.
    camera.target.copyFrom(me.node.position);

    let moveX: -1 | 0 | 1 = 0;
    let moveY: -1 | 0 | 1 = 0;
    if (clickTarget) {
      const { x: meGameX, y: meGameY } = toGame(me.node.position.x, me.node.position.z);
      const dx = clickTarget.x - meGameX;
      const dy = clickTarget.y - meGameY;
      if (Math.hypot(dx, dy) <= 4) {
        clickTarget = null;
      } else {
        moveX = Math.sign(dx) as -1 | 0 | 1;
        moveY = Math.sign(dy) as -1 | 0 | 1;
      }
    }
    myInput.data.moveX = moveX;
    myInput.data.moveY = moveY;
    myInput.send();
  });

  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());
}

main();
