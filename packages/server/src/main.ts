/** Dev/prod entrypoint: boots the Fastify server and listens. */

import { createServer } from "./index.js";

const app = createServer();
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
