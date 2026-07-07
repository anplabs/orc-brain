/** `orc` CLI — a thin client over the orc-brain HTTP API. */

import { Command } from "commander";

/** Builds the `orc` command tree. Commands are stubbed pending the spec. */
export function buildCli(): Command {
  const program = new Command();

  program
    .name("orc")
    .description("Local orchestrator brain for Claude Code sub-agents")
    .version("1.0.0");

  program
    .command("status")
    .description("Show orchestrator status")
    .action(() => {
      // TODO: call the HTTP API and render status.
      throw new Error("TODO: implement `orc status`");
    });

  return program;
}
