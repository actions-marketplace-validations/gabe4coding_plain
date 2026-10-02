#!/usr/bin/env node
// Repository/npm entrypoint. The standalone plugin ships its own launcher and module graph.
import { ensureDependencies } from './install-deps.mjs';
ensureDependencies('plainwright-computer', ['yaml', '@typesafe-ai/sdk']);
await import('../dist/computer/cli.js');
