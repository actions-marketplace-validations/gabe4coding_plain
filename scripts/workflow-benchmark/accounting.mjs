// Catalog rates are dollars per token. Output tokens already include reasoning.
export function costs(usage, pricing, reported) {
  if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) throw new Error('Missing model token usage');
  const rate = name => {
    const tiers = pricing[`${name}_tiers`];
    const tier = tiers?.find(t => usage.inputTokens >= (t.min ?? 0) && usage.inputTokens < (t.max ?? Infinity));
    const value = Number(tier?.cost ?? pricing[name]);
    if (!Number.isFinite(value)) throw new Error(`Missing price: ${name}`);
    return value;
  };
  const read = usage.inputTokenDetails.cacheReadTokens ?? 0;
  const write = usage.inputTokenDetails.cacheWriteTokens ?? 0;
  const regular = usage.inputTokens - read - write;
  if (regular < 0) throw new Error('Cache counts exceed total input');
  const listCost = regular * rate('input') + read * rate('input_cache_read') + write * rate('input_cache_write') + usage.outputTokens * rate('output');
  const noCacheCost = usage.inputTokens * rate('input') + usage.outputTokens * rate('output');
  const reportedCost = reported == null ? null : Number(reported);
  if (reportedCost !== null && (!Number.isFinite(reportedCost) || reportedCost < 0)) throw new Error('Invalid reported cost');
  return { reportedCost, listCost, noCacheCost };
}
