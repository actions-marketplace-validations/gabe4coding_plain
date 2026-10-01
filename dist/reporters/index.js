import { textReporter } from './text.js';
import { jsonlReporter } from './jsonl.js';
export function createReporters(opts) {
    return opts.reporters.map(({ name, output }) => {
        if (output !== undefined)
            throw new Error('--reporter output: not implemented yet');
        if (name === 'text')
            return textReporter(opts.timing);
        if (name === 'jsonl')
            return jsonlReporter();
        throw new Error(`--reporter ${name}: not implemented yet`);
    });
}
