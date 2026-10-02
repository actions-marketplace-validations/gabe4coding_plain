#!/usr/bin/env node
// Repository/npm entrypoint. The standalone plugin ships its own launcher and module graph.
await import('../dist/computer/cli.js');
