/** Fastify HTTP API + SSE server that also serves the orc-brain SPA. */

import Fastify, { type FastifyInstance } from "fastify";

/**
 * Builds the orc-brain HTTP server. Only a liveness route is wired today; the
 * API surface, SSE event stream, and SPA static hosting land with the spec.
 */
export function createServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ status: "ok" }));

  // TODO: orchestration API routes, SSE event stream, and SPA static serving.
  return app;
}
