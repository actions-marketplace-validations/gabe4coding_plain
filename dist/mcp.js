import { StepKind } from './step-kind.js';
import { writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { z } from 'zod';
import { stringify } from 'yaml';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseStep, interpolate } from './spec.js';
import { openSession, startHooks, closeSharedBrowser } from './runner.js';
import { runStep, label, resolveLocators } from './steps.js';
import { snapshot, snapshotRegion, CandidateKindSchema } from './page.js';
import { snapshotView, SnapshotOptions, SNAPSHOT_MODES_DESCRIPTION } from './snapshot-view.js';
import { serialQueue } from './serial-queue.js';
// Leaf paths of `data` as `${hooks.a.b}` placeholders for the `open` response — never the values
// themselves, since leased data can be credentials. Arrays and non-object leaves are leaves.
function placeholderPaths(obj, prefix) {
    const out = [];
    for (const [k, v] of Object.entries(obj)) {
        const path = `${prefix}.${k}`;
        if (v !== null && typeof v === 'object' && !Array.isArray(v))
            out.push(...placeholderPaths(v, path));
        else
            out.push('${' + path + '}');
    }
    return out;
}
const STEP_DESCRIPTION = `Run one step in the persistent browser session (call \`open\` first).

Vocabulary, one example each:
{goto: "/login"}
{fill: {target: "the username field", value: "tomsmith"}}
{click: "the Login button"}
{hover: "the profile avatar"}
{dblclick: "the file icon"}
{rightclick: "the context menu target"}
{select: {target: "the country dropdown", value: "France"}}
{check: "the remember-me checkbox"}  (also filter chips and toggle buttons that expose their state; a no-op if already selected)
{uncheck: "the newsletter checkbox"}
{upload: {target: "the file input", files: ["/path/to/file.png"]}}
{scroll: "the footer"}  or  {scroll: bottom} / {scroll: top}  (the detail reports how far the page moved)
{wait: "the results list is visible"}
{press: "Enter"}
{drag: {source: "the first row's handle", target: "the third row"}}
{expect: ["claim 1", "claim 2"]}  (several claims = one Jev call)
{expect: {that: "a success message is visible", within: "the login form"}}

A \`css=\` prefix on any target bypasses Jev and uses that CSS selector directly.

Rules: describe ONE element with one clear answer — "the earliest available day", never "an
available day". Disambiguate siblings — "the cuisine input (not the where field)". Name things as
the accessibility tree does (heading, button, link, textbox). Expect claims are atomic, one fact
each. status is pass | fail | inconclusive | error | skipped; optional:true converts inconclusive/error
to skipped, matching YAML replay. On inconclusive the detail lists the top
guesses with probabilities — rephrase and retry.

When \`open\` was called with \`hooks\`, any string in a step may contain \`\${hooks.a.b}\` placeholders
(the \`open\` response lists the ones available); they are resolved right before the step runs and
kept as written when \`save\` writes the spec, so the saved spec stays dataset-driven. \${env.*} is
not available in this session — add it to the YAML yourself after saving.`;
export async function serveMcp(opts) {
    let session = null;
    const sessionOpts = { ...opts, handleSignals: false }; // `open {headed}` may flip headed per session
    const spec = { name: 'plainwright session', url: '', dir: process.cwd(), dialogs: 'accept', steps: [] };
    const transcript = [];
    let totalTokens = 0;
    const track = (tokens) => void (totalTokens += tokens);
    // Hooks child leased by `open {hooks}` — released by runTeardown on the next `open {hooks}` or on shutdown.
    let hooksRunner = null;
    let hooksFile = null;
    let data = {};
    const results = []; // every step result, pass or not, in order — teardown sees the full run
    const server = new McpServer({ name: 'plainwright', version: '1.0.0' });
    // Candidate IDs, token accounting and the recording belong to one browser session. Reads and
    // other actions must not interleave with a batch (or with another individual tool call).
    const queue = serialQueue();
    function ok(data) {
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
    // Releases the current hooks lease: called when the session ends, or when `open` loads a new
    // hooks module while one is already active. Errors propagate — a teardown failure must not be silent.
    async function runTeardown() {
        if (hooksRunner) {
            const runner = hooksRunner;
            if (runner.has.teardown) {
                await runner.teardown({ spec, data, result: { status: results.at(-1)?.status ?? 'pass', steps: results } });
            }
            runner.close();
        }
        hooksRunner = null;
        hooksFile = null;
        data = {};
    }
    server.registerTool('open', {
        description: "Open the persistent browser session (first call) or navigate it to a new URL. `hooks`: optional path " +
            "(relative to the server's working directory) of a setup/teardown module, as in a spec's `hooks` key; " +
            'setup runs now, before the navigation, and its result is available to steps as ${hooks.*}. Teardown runs ' +
            'when the session ends or when `open` is called again with `hooks`. `headed`: true shows the browser window ' +
            '(when the user wants to watch), false hides it; default is how the server was started. Changing it on a ' +
            'later call relaunches the browser, so cookies and logins of the current session are lost. Ignored when ' +
            'attached to a running Chrome (--cdp).',
        inputSchema: { url: z.string(), hooks: z.string().optional(), headed: z.boolean().optional() },
    }, ({ url, hooks: hooksPath, headed }) => queue(async () => {
        const notes = [];
        if (session && headed !== undefined && headed !== sessionOpts.headed && !sessionOpts.cdp) {
            await session.close();
            session = null;
            notes.push(`browser relaunched ${headed ? 'headed' : 'headless'}; the previous session's cookies are gone`);
        }
        if (!session) {
            if (headed !== undefined)
                sessionOpts.headed = headed;
            session = await openSession(spec, sessionOpts, track);
            spec.url = url;
        }
        if (hooksPath) {
            const file = resolve(spec.dir, hooksPath);
            if (hooksFile)
                await runTeardown(); // an agent opening a second flow releases the first lease
            let runner = null;
            try {
                runner = await startHooks(file);
                if (runner.has.setup)
                    data = await runner.setup(spec);
                hooksRunner = runner;
                hooksFile = file;
            }
            catch (err) {
                runner?.close(); // whatever got started (or nothing, if the fork itself failed) never lingers
                hooksRunner = null;
                hooksFile = null;
                data = {}; // nothing loaded — nothing for teardown to release
                throw err;
            }
        }
        const result = await runStep(session.ctx, { kind: StepKind.goto, url });
        if (result.status === 'error')
            throw new Error(result.detail ?? 'goto failed');
        transcript.push({ goto: url }); // so `save` replays the navigation too
        const title = await session.ctx.page.title();
        const response = { url: session.ctx.page.url(), title, notes: [...notes, ...session.drainNotes()] };
        if (hooksFile)
            response.placeholders = placeholderPaths(data, 'hooks');
        return ok(response);
    }));
    async function execute(step, parsed) {
        if (!session)
            throw new Error('call open first');
        const before = totalTokens;
        let result;
        try {
            const resolved = interpolate(parsed, { env: {}, hooks: data }, 'mcp'); // ${hooks.*} placeholders, resolved just before running
            result = await runStep(session.ctx, resolved);
        }
        catch (err) {
            result = { step: label(parsed), status: 'error', detail: err instanceof Error ? err.message : String(err) };
        }
        if (parsed.optional && (result.status === 'inconclusive' || result.status === 'error')) {
            result = { ...result, status: 'skipped' };
        }
        results.push(result);
        if (result.status === 'pass')
            transcript.push(step); // failed attempts are exploration, not spec — placeholders kept intact for `save`
        return { status: result.status, detail: result.detail, notes: session.drainNotes(), url: session.ctx.page.url(), jevTokens: totalTokens - before };
    }
    server.registerTool('step', { description: STEP_DESCRIPTION, inputSchema: { step: z.record(z.string(), z.unknown()) } }, ({ step }) => queue(async () => {
        if (!session)
            throw new Error('call open first');
        return ok(await execute(step, parseStep('mcp', transcript.length, step)));
    }));
    server.registerTool('batch', {
        description: 'Run 1–16 already-known steps in order in one browser tool call (call open first). ' +
            'Use the same one-action objects as step, e.g. {steps:[{fill:{target:"the Name field",value:"Alex"}},' +
            '{fill:{target:"the Email field",value:"alex@example.test"}},{click:"Save"}]}. ' +
            'All syntax and hook placeholders are checked before acting. Each action resolves fresh targets after the previous action. ' +
            'Stops on the first non-pass, including optional steps returning skipped; later steps are not attempted. ' +
            'Returns status, indexed results with per-step tokens/URL/notes, completed (passing steps), remaining, stoppedAt (zero-based or null), and total jevTokens. ' +
            'Passing steps are recorded individually for save; completed actions are not rolled back. ' +
            'Batch only actions whose targets and values are already known. When the next action depends on reading a result, end the batch and inspect it first.',
        inputSchema: { steps: z.array(z.record(z.string(), z.unknown())).min(1).max(16) },
    }, ({ steps }) => queue(async () => {
        if (!session)
            throw new Error('call open first');
        const parsed = steps.map((step, i) => parseStep('mcp batch', i, step));
        // Preflight every placeholder too: a bad later step must not partially execute the batch.
        for (const step of parsed)
            interpolate(step, { env: {}, hooks: data }, 'mcp batch');
        const before = totalTokens;
        const outcomes = [];
        for (const [index, step] of steps.entries()) {
            const result = await execute(step, parsed[index]);
            outcomes.push({ index, ...result });
            if (result.status !== 'pass')
                break;
        }
        const last = outcomes.at(-1);
        return ok({ status: last.status, results: outcomes, completed: outcomes.filter(r => r.status === 'pass').length,
            remaining: steps.length - outcomes.length, stoppedAt: last.status === 'pass' ? null : last.index,
            url: session.ctx.page.url(), jevTokens: totalTokens - before });
    }));
    server.registerTool('find', {
        description: "Dry run of a step target: tells you what Jev would pick, without acting.",
        inputSchema: { kind: CandidateKindSchema, target: z.string() },
    }, ({ kind, target }) => queue(async () => {
        if (!session)
            throw new Error('call open first');
        target = interpolate(target, { env: {}, hooks: data }, 'mcp');
        const before = totalTokens;
        const [r] = await resolveLocators(session.ctx, kind, [target]);
        if (r.usedJev)
            track(r.tokens);
        return ok({ found: r.locator !== null, detail: r.detail, confidence: r.confidence, jevTokens: totalTokens - before });
    }));
    server.registerTool('snapshot', {
        description: 'Accessibility tree of the current page (url, title, aria), or of one region of it when `within` names one ' +
            '("the results list", "the hotel table", or css=...). Reading data: prefer `within` so you get the table or list ' +
            'and not the whole page, or `evaluate` when you want clean JSON. Debugging: only when a step came back ' +
            'inconclusive and rephrasing did not help.' + SNAPSHOT_MODES_DESCRIPTION,
        inputSchema: { ...SnapshotOptions, within: z.string().optional() },
    }, ({ maxChars, within, mode, intent }) => queue(async () => {
        if (!session)
            throw new Error('call open first');
        const started = performance.now();
        const before = totalTokens;
        let region;
        let snap;
        if (within) {
            const [r] = await resolveLocators(session.ctx, 'region', [interpolate(within, { env: {}, hooks: data }, 'mcp')]);
            if (r.usedJev)
                track(r.tokens);
            if (!r.locator)
                return ok({ found: false, detail: r.detail, jevTokens: totalTokens - before });
            region = r.detail;
            snap = await snapshotRegion(session.ctx.page, r.locator);
        }
        else {
            snap = await snapshot(session.ctx.page);
        }
        const view = await snapshotView(snap, { maxChars, mode, intent });
        if ('jevTokens' in view && view.jevTokens !== null)
            track(view.jevTokens);
        return ok({ ...view, region, ...(mode !== 'raw' ? {
                jevTokens: 'jevTokens' in view && view.jevTokens === null ? null : totalTokens - before,
                ms: { ...('ms' in view ? view.ms : {}), total: performance.now() - started },
            } : {}) });
    }));
    server.registerTool('evaluate', {
        description: 'Run a JavaScript expression in the page and return its JSON value: the raw escape hatch for pulling data ' +
            'once the flow got there, e.g. `[...document.querySelectorAll("article")].map(a => ({ name: a.querySelector("h3")?.innerText, price: a.querySelector("[data-testid=price]")?.innerText }))`. ' +
            'The expression may be async (a promise is awaited). Read-only by convention: it is not a step, so `save` does not record it.',
        inputSchema: { js: z.string() },
    }, ({ js }) => queue(async () => {
        if (!session)
            throw new Error('call open first');
        const value = await session.ctx.page.evaluate(js);
        return ok({ value: value === undefined ? null : value, url: session.ctx.page.url() });
    }));
    server.registerTool('save', {
        description: 'Save the steps that passed so far in this session as a YAML spec the batch runner can replay (failed or ' +
            'inconclusive attempts are left out). The `hooks` module given to `open` is written as a relative path, ' +
            'and ${hooks.*} placeholders are kept as written.',
        inputSchema: { path: z.string(), name: z.string().optional() },
    }, ({ path, name }) => queue(async () => {
        const filePath = resolve(path);
        const doc = { name: name ?? spec.name, url: spec.url };
        if (hooksFile) {
            let rel = relative(dirname(filePath), hooksFile);
            if (!rel.startsWith('.'))
                rel = './' + rel;
            doc.hooks = rel;
        }
        doc.steps = transcript;
        writeFileSync(filePath, stringify(doc));
        return ok({ path: filePath, steps: transcript.length });
    }));
    const transport = new StdioServerTransport();
    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        let code = 0;
        try {
            await runTeardown();
        }
        catch (err) {
            code = 1;
            console.error(`plainwright: teardown failed: ${err}`);
        }
        try {
            await session?.close();
        }
        catch (err) {
            code = 1;
            console.error(`plainwright: session cleanup failed: ${err}`);
        }
        finally {
            await closeSharedBrowser();
        }
        process.exit(code);
    };
    // connect() owns transport.onclose; register with the server so EOF reaches our cleanup.
    server.server.onclose = () => { void shutdown(); };
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGHUP', () => { void shutdown(); });
    await server.connect(transport);
}
