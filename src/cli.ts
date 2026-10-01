#!/usr/bin/env node
import { loadSpec } from './spec.js';
import { runSpec, closeSharedBrowser, type RunOptions } from './runner.js';
import { provider, warmUp, loadEnvFiles, MODEL_BY_PROVIDER } from './jev.js';
import { parseSuiteArgs, UsageError } from './options.js';
import { runSuite } from './suite.js';
import { validate } from './validate.js';
import { checkSpecTimeoutFlag } from './spec-features.js';
import type { SuiteEngine } from './suite-types.js';

loadEnvFiles();
try {
  const { command, opts, flags } = parseSuiteArgs(process.argv.slice(2), 'browser');
  checkSpecTimeoutFlag(opts.specTimeout);
  const runOpts: RunOptions = { headed: !flags.headless, timeout: Number(flags.timeout),
    profile: flags.profile as string | undefined, cdp: flags.cdp as string | undefined,
    channel: flags.channel as string | undefined, specTimeout: opts.specTimeout };
  if (command === 'mcp') {
    try {
      const p = provider();
      console.error(`plainwright: Jev via ${p} (${MODEL_BY_PROVIDER[p]})`);
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
    warmUp();
    await (await import('./mcp.js')).serveMcp(runOpts);
  } else {
    const engine: SuiteEngine<ReturnType<typeof loadSpec>> = { engine: 'browser', load: loadSpec,
      meta: (spec) => ({ name: spec.name, tags: spec.tags ?? [], timeoutMs: spec.timeout }),
      run: (spec, observer, info) => runSpec(spec, runOpts, observer, info),
      maxWorkers: Infinity, close: closeSharedBrowser };
    if (command === 'validate') {
      const results = validate(engine, opts.files);
      for (const result of results) {
        for (const warning of result.warnings) console.error(`${result.file}: ${warning}`);
        if (result.error) console.error(`${result.file}: ${result.error}`);
      }
      process.exitCode = results.some((result) => result.error) ? 1 : 0;
    } else process.exitCode = (await runSuite(engine, opts)).status === 'pass' ? 0 : 1;
  }
} catch (error) {
  console.error(error instanceof UsageError
    ? 'usage: plainwright [--headless] [--timeout <ms>] [--profile <dir>] [--cdp <url>] [--channel chrome] [--timing] [--workers N] [suite options] <spec.yaml|dir|glob> [more ...] | validate <files...> | mcp'
    : error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
