/** Dev/prod entrypoint: boots the Fastify server and listens on 127.0.0.1 (§2). */

import { createServer } from "./index.js";

const app = createServer({ stateDir: process.env.ORC_STATE_DIR });
const port = Number(process.env.PORT ?? 4173);
// Localhost binding is the access control (§2) — never expose beyond loopback.
const host = process.env.HOST ?? "127.0.0.1";

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
