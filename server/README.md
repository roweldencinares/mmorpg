# Welcome to Colyseus!

This project was created with [⚔️ `create-colyseus-app`](https://github.com/colyseus/create-colyseus-app/).

[Documentation](https://docs.colyseus.io/)

## :crossed_swords: Usage

```
npm start
```

Then open http://localhost:2567 for the playground, or /monitor for the monitor.

## Structure

- `src/index.ts`: entry point — leave it alone if you plan to deploy to Colyseus Cloud
- `src/app.config.ts`: server configuration — rooms, HTTP routes, express middleware
- `src/rooms/MyRoom.ts`: your room handler
- `src/rooms/schema/MyRoomState.ts`: the state synchronized to every client in the room
- `test/MyRoom.test.ts`: boots the real server and connects a real client
- `loadtest/example.ts`: scriptable client for `npm run loadtest`
- `ecosystem.config.cjs`: pm2 configuration, used when deploying to Colyseus Cloud

## Scripts

- `npm start`: run the server in watch mode (`tsx watch src/index.ts`)
- `npm test`: run the mocha test suite
- `npm run build`: compile to `build/`
- `npm run loadtest`: connect N simulated clients with [`@colyseus/loadtest`](https://github.com/colyseus/colyseus-loadtest/)

## What's included

### Fixed tick + client prediction

The room advances on `setFixedTimestep()`: a framework-owned accumulator runs
`step()` a whole number of times per frame, each advancing exactly `1/TICK_RATE`
seconds. A constant `dt` is what makes the client able to replay the same steps
— with `setTimestep()`'s measured delta it could not.

`defineInput(MoveInput, …)` gives each client a server-side input buffer.
`sanitize` clamps every field as it arrives, because nothing off the wire is
trustworthy. The input schema is deliberately flat and carries no `seq`, no `dt`
and no timestamp: the engine's own counter is the sequence, one input advances
exactly one step, and the SDK stamps lag-comp timing on the wire envelope.

`src/shared/movement.ts` holds the one function both sides run. It is typed
structurally so the same code steps a server Schema instance and the client
reconciler's plain predicted copy, and it is pure — no clocks, no randomness, no
reads outside its arguments. Keep it that way, or prediction and server will
disagree.

To add client-side prediction, see the client wiring in `src/client/` (generated
when the Vite layout is chosen) or the netcode guide:

- https://docs.colyseus.io/netcode/server-input
- https://docs.colyseus.io/netcode/client-prediction

### Lobby room

A `LobbyRoom` is registered as `lobby`, and the sample room is chained with
`.enableRealtimeListing()` so the lobby receives create/update/dispose events for
it. Clients join the lobby to render a live room browser:

```ts
const lobby = await client.joinOrCreate("lobby");
lobby.onMessage("rooms", (rooms) => { /* full list on join */ });
lobby.onMessage("+", ([roomId, room]) => { /* added or updated */ });
lobby.onMessage("-", (roomId) => { /* removed */ });
```

- https://docs.colyseus.io/matchmaker/lobby

### Reconnection

`MyRoom.onDrop()` holds a dropped client's seat for 30 seconds via
`allowReconnection()`. The SDK retries automatically with exponential backoff;
`onReconnect()` fires if it gets back in time, `onLeave()` if it does not.

- https://docs.colyseus.io/room/reconnection

### Database

`@colyseus/database` gives you one typed connection behind `db.auth`, `db.saves`,
`db.leaderboards`, `db.configs` and friends, and `DatabaseDriver` reuses it for
matchmaking so there is no separate Redis to run.

The dialect is inferred from `DATABASE_URL`. `.env.development` points at a local
SQLite file (`colyseus.db`, already gitignored); set `.env.production` to a
`postgres://…` URL and `npm install postgres` before deploying — an empty value
silently falls back to SQLite, which is not what you want on a server that
scales past one process.

Migrations run at boot in `"auto"` mode: missing tables and columns are created.
Switch to `{ files: "./drizzle" }` once the schema matters.

Import `db` from `src/app.config.ts` inside your rooms:

```ts
import { db } from "../app.config.js";
```

- https://docs.colyseus.io/database
