import { errorMessage } from '../core/results.js';
import { loadEnvFiles } from '../jev/provider.js';
import { warmUp } from '../jev/ask.js';
import { parseSuiteArgs, UsageError } from '../suite/options.js';
import { checkSpecTimeoutFlag } from '../suite/spec-timeout.js';
import { runSuite } from '../suite/run-suite.js';
import { printValidation } from '../suite/validate.js';
/** The desktop and mobile CLI: `mcp`, `validate`, or spec files run one after another (one input device). */
export async function nativeCli(bin, usage, engineName, platform) {
    loadEnvFiles();
    try {
        const { command, opts, flags } = parseSuiteArgs(process.argv.slice(2), engineName);
        checkSpecTimeoutFlag(opts.specTimeout);
        const values = { server: flags.server };
        const timeout = Number(flags.timeout);
        if (command === 'mcp') {
            warmUp();
            return await platform.serve(timeout, values);
        }
        const engine = {
            engine: engineName,
            load: platform.load,
            meta: platform.meta,
            run: (spec, observer, info) => platform.run(spec, timeout, values, observer, info, opts.specTimeout),
            maxWorkers: 1,
        };
        if (command === 'validate')
            process.exitCode = printValidation(engine, opts.files);
        else
            process.exitCode = (await runSuite(engine, opts)).status === 'pass' ? 0 : 1;
    }
    catch (error) {
        const message = error instanceof UsageError
            ? `usage: ${bin} [--timeout 15000] ${usage}[suite options] mcp | validate <files...> | <spec.yaml|dir|glob> [more ...]`
            : errorMessage(error);
        console.error(`${bin}: ${message}`);
        process.exitCode = 2;
    }
}
