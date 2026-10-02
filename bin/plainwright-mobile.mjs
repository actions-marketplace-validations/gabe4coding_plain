#!/usr/bin/env node
// Repository/npm entrypoint; the standalone plugin packages the same module graph.
import { ensureDependencies } from './install-deps.mjs';
ensureDependencies('plainwright-mobile', ['yaml', 'webdriverio']);
await import('../dist/mobile/cli.js');
