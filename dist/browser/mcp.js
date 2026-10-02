import { writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { z } from 'zod';
import { stringify } from 'yaml';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StepKind } from '../core/step-kind.js';
import { parseStep } from '../core/spec.js';
import { interpolate } from '../core/interpolate.js';
import { startHooks, placeholderPaths } from '../core/hooks.js';
import { ariaChanges, CHANGES_ENABLED, CHANGES_NOTE } from '../core/aria-changes.js';
import { snapshotView, SnapshotOptions, SNAPSHOT_MODES_DESCRIPTION } from '../core/snapshot-view.js';
import { readAnswer, READ_ENABLED, READ_DESCRIPTION } from '../core/read.js';
import { serialQueue } from '../core/serial-queue.js';
import { jsonResult as ok, askResult, AskClaims, ASK_DESCRIPTION } from '../core/mcp-result.js';
import { openSession, closeSharedBrowser } from './session.js';
import { runStep, runStepSafely } from './steps.js';
import { resolveOne } from './locate.js';
import { askPage } from './judge-page.js';
import { settlePage } from './activity.js';
import { snapshot, snapshotRegion } from './page.js';
import { CandidateKindSchema } from './candidates.js';
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
const OPEN_DESCRIPTION = "Open the persistent browser session (first call) or navigate it to a new URL. `hooks`: optional path " +
    "(relative to the server's working directory) of a setup/teardown module, as in a spec's `hooks` key; " +
    'setup runs now, before the navigation, and its result is available to steps as ${hooks.*}. Teardown runs ' +
    'when the session ends or when `open` is called again with `hooks`. `headed`: true shows the browser window ' +
    '(when the user wants to watch), false hides it; default is how the server was started. Changing it on a ' +
    'later call relaunches the browser, so cookies and logins of the current session are lost. Ignored when ' +
    'attached to a running Chrome (--cdp). `goal`: what the whole flow is for, in one sentence ("read the ' +
    'discussion about F-Droid 2.0"); every later pick sees it, so a vague target ("the comments link") picks the ' +
    'element the flow is about, while the target\'s words still win when they disagree. Claims never see it. ' +
    'Kept until an `open` passes another goal; `save` writes it into the spec.';
const BATCH_DESCRIPTION = 'Run 1–16 already-known steps in order in one browser tool call (call open first). ' +
    'Use the same one-action objects as step, e.g. {steps:[{fill:{target:"the Name field",value:"Alex"}},' +
    '{fill:{target:"the Email field",value:"alex@example.test"}},{click:"Save"}]}. ' +
    'All syntax and hook placeholders are checked before acting. Each action resolves fresh targets after the previous action. ' +
    'Stops on the first non-pass, including optional steps returning skipped; later steps are not attempted. ' +
    'Returns status, indexed results with per-step tokens/URL/notes, completed (passing steps), remaining, stoppedAt (zero-based or null), and total jevTokens. ' +
    'Passing steps are recorded individually for save; completed actions are not rolled back. ' +
    'Batch only actions whose targets and values are already known. When the next action depends on reading a result, end the batch and inspect it first.' +
    CHANGES_NOTE.replace('the action', 'the whole batch');
const SNAPSHOT_DESCRIPTION = 'Accessibility tree of the current page (url, title, aria), or of one region of it when `within` names one ' +
    '("the results list", "the hotel table", or css=...). Reading a value: use `read`, not this; `evaluate` for many ' +
    'rows as JSON. Debugging: only when a step came back inconclusive and rephrasing did not help.' + SNAPSHOT_MODES_DESCRIPTION;
const EVALUATE_DESCRIPTION = 'Run a JavaScript expression in the page and return its JSON value: the raw escape hatch for pulling many rows as JSON ' +
    'once the flow got there (a single value or a few rows: use `read`), e.g. `[...document.querySelectorAll("article")].map(a => ({ name: a.querySelector("h3")?.innerText, price: a.querySelector("[data-testid=price]")?.innerText }))`. ' +
    'The expression may be async (a promise is awaited). Read-only by convention: it is not a step, so `save` does not record it.';
const SAVE_DESCRIPTION = 'Save the steps that passed so far in this session as a YAML spec the batch runner can replay (failed or ' +
    'inconclusive attempts are left out). The `hooks` module given to `open` is written as a relative path, ' +
    'and ${hooks.*} placeholders are kept as written.';
/** The browser MCP server: one persistent session, every tool call run one at a time. */
export async function serveMcp(opts) {
    let session = null;
    const sessionOpts = { ...opts, handleSignals: false };
    const spec = { name: 'plainwright session', url: '', dir: process.cwd(), dialogs: 'accept', steps: [] };
    /** The steps that passed, as written: what `save` writes. */
    const transcript = [];
    /** Every step result, pass or not: what teardown sees. */
    const results = [];
    let totalTokens = 0;
    const track = (tokens) => void (totalTokens += tokens);
    // The hooks module leased by `open {hooks}`, released on the next `open {hooks}` or at shutdown.
    let hooksRunner = null;
    let hooksFile = null;
    let data = {};
    const server = new McpServer({ name: 'plainwright', version: '1.0.0' });
    // Candidate ids, token counts and the transcript belong to one session: no two calls may interleave.
    const queue = serialQueue();
    const activeSession = () => {
        if (!session)
            throw new Error('call open first');
        return session;
    };
    /** Resolves `${hooks.*}` placeholders. `${env.*}` is not available in an MCP session. */
    const withPlaceholders = (value, where = 'mcp') => interpolate(value, { env: {}, hooks: data }, where);
    /** Releases the hooks lease. A teardown error propagates: a failing cleanup must not be silent. */
    async function runTeardown() {
        const runner = hooksRunner;
        if (runner?.has.teardown)
            await runner.teardown({ spec, data, result: { status: results.at(-1)?.status ?? 'pass', steps: results } });
        runner?.close();
        hooksRunner = null;
        hooksFile = null;
        data = {};
    }
    async function loadHooks(hooksPath) {
        const file = resolve(spec.dir, hooksPath);
        if (hooksFile)
            await runTeardown(); // a second flow releases the first lease
        let runner = null;
        try {
            runner = await startHooks(file);
            if (runner.has.setup)
                data = await runner.setup(spec);
            hooksRunner = runner;
            hooksFile = file;
        }
        catch (error) {
            runner?.close();
            hooksRunner = null;
            hooksFile = null;
            data = {};
            throw error;
        }
    }
    async function execute(step, parsed) {
        const current = activeSession();
        const before = totalTokens;
        const result = await runStepSafely(current.ctx, parsed, (resolved) => withPlaceholders(resolved));
        results.push(result);
        if (result.status === 'pass')
            transcript.push(step); // as written, placeholders kept for `save`
        return {
            status: result.status,
            detail: result.detail,
            notes: current.drainNotes(),
            url: current.ctx.page.url(),
            jevTokens: totalTokens - before,
        };
    }
    /** The page before an action, for `changed`; null when that is off or the page cannot be read. */
    async function look() {
        if (!CHANGES_ENABLED || !session)
            return null;
        return snapshot(session.ctx.page).catch(() => null);
    }
    async function changesSince(before) {
        if (!before || !session)
            return {};
        await settlePage(session.ctx.page).catch(() => null);
        const after = await snapshot(session.ctx.page).catch(() => null);
        return after ? { changed: ariaChanges(before, after) } : {};
    }
    /** The whole page, or the region `within` names; `missing` when Jev finds no region. */
    async function capture(within) {
        const current = activeSession();
        if (!within)
            return { snap: await snapshot(current.ctx.page) };
        const resolved = await resolveOne(current.ctx, 'region', withPlaceholders(within));
        if (!resolved.element)
            return { missing: resolved.detail };
        return { snap: await snapshotRegion(current.ctx.page, resolved.element), region: resolved.detail };
    }
    server.registerTool('open', {
        description: OPEN_DESCRIPTION,
        inputSchema: { url: z.string(), hooks: z.string().optional(), headed: z.boolean().optional(), goal: z.string().min(1).optional() },
    }, ({ url, hooks: hooksPath, headed, goal }) => queue(async () => {
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
        if (goal)
            spec.goal = goal;
        if (hooksPath)
            await loadHooks(hooksPath);
        const result = await runStep(session.ctx, { kind: StepKind.goto, url });
        if (result.status === 'error')
            throw new Error(result.detail ?? 'goto failed');
        transcript.push({ goto: url }); // so `save` replays the navigation too
        const title = await session.ctx.page.title();
        const response = { url: session.ctx.page.url(), title, notes: [...notes, ...session.drainNotes()] };
        if (hooksFile)
            response.placeholders = placeholderPaths(data);
        return ok(response);
    }));
    server.registerTool('step', {
        description: STEP_DESCRIPTION + CHANGES_NOTE,
        inputSchema: { step: z.record(z.string(), z.unknown()) },
    }, ({ step }) => queue(async () => {
        activeSession();
        const parsed = parseStep('mcp', transcript.length, step);
        const before = await look();
        const result = await execute(step, parsed);
        return ok({ ...result, ...(await changesSince(before)) });
    }));
    server.registerTool('batch', {
        description: BATCH_DESCRIPTION,
        inputSchema: { steps: z.array(z.record(z.string(), z.unknown())).min(1).max(16) },
    }, ({ steps }, { signal }) => queue(async () => {
        signal.throwIfAborted();
        const current = activeSession();
        const parsed = steps.map((step, i) => parseStep('mcp batch', i, step));
        // Every placeholder is checked first: a bad later step must not leave the batch half done.
        for (const step of parsed)
            withPlaceholders(step, 'mcp batch');
        const before = totalTokens;
        const page = await look();
        const outcomes = [];
        for (const [index, step] of steps.entries()) {
            signal.throwIfAborted(); // an action in flight may finish; cancellation stops the later ones
            const result = await execute(step, parsed[index]);
            outcomes.push({ index, ...result });
            if (result.status !== 'pass')
                break;
        }
        const last = outcomes.at(-1);
        return ok({
            status: last.status,
            results: outcomes,
            completed: outcomes.filter((outcome) => outcome.status === 'pass').length,
            remaining: steps.length - outcomes.length,
            stoppedAt: last.status === 'pass' ? null : last.index,
            url: current.ctx.page.url(),
            jevTokens: totalTokens - before,
            ...(await changesSince(page)),
        });
    }));
    server.registerTool('find', {
        description: 'Dry run of a step target: tells you what Jev would pick, without acting.',
        inputSchema: { kind: CandidateKindSchema, target: z.string() },
    }, ({ kind, target }) => queue(async () => {
        const current = activeSession();
        const before = totalTokens;
        const resolved = await resolveOne(current.ctx, kind, withPlaceholders(target));
        return ok({ found: resolved.element !== null, detail: resolved.detail, confidence: resolved.confidence, jevTokens: totalTokens - before });
    }));
    server.registerTool('snapshot', {
        description: SNAPSHOT_DESCRIPTION,
        inputSchema: { ...SnapshotOptions, within: z.string().optional() },
    }, ({ maxChars, within, mode, intent }) => queue(async () => {
        activeSession();
        const started = performance.now();
        const before = totalTokens;
        const captured = await capture(within);
        if (!captured.snap)
            return ok({ found: false, detail: captured.missing, jevTokens: totalTokens - before });
        const view = await snapshotView(captured.snap, { maxChars, mode, intent });
        if ('jevTokens' in view && view.jevTokens !== null)
            track(view.jevTokens);
        const usage = mode === 'raw' ? {} : {
            jevTokens: 'jevTokens' in view && view.jevTokens === null ? null : totalTokens - before,
            ms: { ...('ms' in view ? view.ms : {}), total: performance.now() - started },
        };
        return ok({ ...view, region: captured.region, ...usage });
    }));
    if (READ_ENABLED)
        server.registerTool('read', {
            description: READ_DESCRIPTION + ' `within` also takes css=.',
            inputSchema: { question: z.string().min(1), within: z.string().min(1).optional() },
            annotations: { readOnlyHint: true },
        }, ({ question, within }) => queue(async () => {
            const current = activeSession();
            const started = performance.now();
            const before = totalTokens;
            await settlePage(current.ctx.page).catch(() => null);
            const captured = await capture(within);
            if (!captured.snap)
                return ok({ found: false, detail: captured.missing, jevTokens: totalTokens - before });
            const { tokens, ...answer } = await readAnswer(captured.snap, withPlaceholders(question));
            track(tokens);
            return ok({ ...answer, region: captured.region, url: current.ctx.page.url(), jevTokens: totalTokens - before,
                ms: Math.round(performance.now() - started) });
        }));
    server.registerTool('ask', {
        description: ASK_DESCRIPTION + ' `within` also takes css=.',
        inputSchema: { claims: AskClaims, within: z.string().min(1).optional() },
        annotations: { readOnlyHint: true },
    }, ({ claims, within }) => queue(async () => {
        const current = activeSession();
        const before = totalTokens;
        const judged = await askPage(current.ctx, withPlaceholders(claims), within && withPlaceholders(within));
        const usage = { jevTokens: totalTokens - before, ms: judged.ms };
        if ('detail' in judged)
            return ok({ found: false, detail: judged.detail, ...usage });
        return ok({ ...askResult(claims, judged.probabilities, judged.snap), ...usage });
    }));
    server.registerTool('evaluate', {
        description: EVALUATE_DESCRIPTION,
        inputSchema: { js: z.string() },
    }, ({ js }) => queue(async () => {
        const current = activeSession();
        const value = await current.ctx.page.evaluate(js);
        return ok({ value: value === undefined ? null : value, url: current.ctx.page.url() });
    }));
    server.registerTool('save', {
        description: SAVE_DESCRIPTION,
        inputSchema: { path: z.string(), name: z.string().optional() },
    }, ({ path, name }) => queue(async () => {
        const filePath = resolve(path);
        const hooksPath = hooksFile && relative(dirname(filePath), hooksFile);
        const hooks = hooksPath ? { hooks: hooksPath.startsWith('.') ? hooksPath : './' + hooksPath } : {};
        const goal = spec.goal ? { goal: spec.goal } : {};
        writeFileSync(filePath, stringify({ name: name ?? spec.name, url: spec.url, ...goal, ...hooks, steps: transcript }));
        return ok({ path: filePath, steps: transcript.length });
    }));
    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        let code = 0;
        try {
            await runTeardown();
        }
        catch (error) {
            code = 1;
            console.error(`plainwright: teardown failed: ${error}`);
        }
        try {
            await session?.close();
        }
        catch (error) {
            code = 1;
            console.error(`plainwright: session cleanup failed: ${error}`);
        }
        finally {
            await closeSharedBrowser();
        }
        process.exit(code);
    };
    // connect() owns transport.onclose; the server's onclose is how end of input reaches the cleanup.
    server.server.onclose = () => void shutdown();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
        process.once(signal, () => void shutdown());
    await server.connect(new StdioServerTransport());
}
