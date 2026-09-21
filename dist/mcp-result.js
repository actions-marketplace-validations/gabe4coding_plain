// MCP 2025-11-25 requires an object for structuredContent. Keep the text copy for
// older clients; apps supplies its historical bare-array text representation.
export function jsonResult(data, legacyText) {
    const text = JSON.stringify(data);
    return {
        content: [{ type: 'text', text: legacyText ?? text }],
        // Apply the same JSON normalization on in-memory and stdio transports (e.g. undefined).
        structuredContent: JSON.parse(text),
    };
}
