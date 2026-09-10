import {
  defineServer,
  defineRoom,
  monitor,
  playground,
  createRouter,
  createEndpoint,
  LobbyRoom,
} from "colyseus";

import { GameDatabase } from "@colyseus/database";
import { RedisDriver } from "@colyseus/redis-driver";
import { RedisPresence } from "@colyseus/redis-presence";

/**
 * Import your Room files
 */
import { MyRoom } from "./rooms/MyRoom.js";

/**
 * Exported so rooms can `import { db } from "../app.config.js"`.
 * The dialect is inferred from the connection string — a bare path is SQLite,
 * `postgres://…` is PostgreSQL (which also needs the `postgres` package).
 */
export const db = new GameDatabase({
  connectionString: process.env.DATABASE_URL,
});

const server = defineServer({
  /**
   * Boots the database (and runs migrations) before the server listens, and
   * mounts the @colyseus/auth routes automatically.
   */
  database: db,

  /**
   * Matchmaking state + pub/sub run through Redis so the server is ready to
   * scale horizontally across multiple processes/instances.
   */
  driver: new RedisDriver(process.env.REDIS_URL),
  presence: new RedisPresence(process.env.REDIS_URL),

  /**
   * Define your room handlers:
   */
  rooms: {
    my_room: defineRoom(MyRoom).enableRealtimeListing(),
    lobby: defineRoom(LobbyRoom),
  },

  /**
   * Experimental: Define API routes. Built-in integration with the "playground" and SDK.
   *
   * Usage from SDK:
   *   client.http.get("/api/hello").then((response) => {})
   *
   */
  routes: createRouter({
    api_hello: createEndpoint("/api/hello", { method: "GET" }, async (ctx) => {
      return { message: "Hello World" };
    }),
  }),

  /**
   * Bind your custom express routes here:
   * Read more: https://expressjs.com/en/starter/basic-routing.html
   */
  express: (app) => {

    app.get("/hi", (req, res) => {
      res.send("It's time to kick ass and chew bubblegum!");
    });

    /**
     * Use @colyseus/monitor
     * If you expose it in production, make sure to protect it with a password:
     * https://docs.colyseus.io/tools/monitoring#password-protection
     */
    if (process.env.NODE_ENV !== "production") {
      app.use("/monitor", monitor());
    }

    /**
     * Use @colyseus/playground
     * (It is not recommended to expose this route in a production environment)
     */
    if (process.env.NODE_ENV !== "production") {
      app.use("/", playground());
    }
  }
});

export default server;

