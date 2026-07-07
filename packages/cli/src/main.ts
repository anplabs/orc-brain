#!/usr/bin/env node
/** CLI entrypoint. */

import { buildCli } from "./index.js";

buildCli().parse();
