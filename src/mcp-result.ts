import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// MCP 2025-11-25 requires an object for structuredContent. Keep the text copy for
// older clients; apps supplies its historical bare-array text representation.
export function jsonResult(data: object, legacyText?: string): CallToolResult {
  const text = JSON.stringify(data);
  return {
    content: [{ type: 'text', text: legacyText ?? text }],
    // Apply the same JSON normalization on in-memory and stdio transports (e.g. undefined).
    structuredContent: JSON.parse(text) as Record<string, unknown>,
  };
}
