export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'other';

/**
 * Family of a Claude model id. Matches whole dash/dot/slash separated tokens, so every shape seen in
 * the logs works: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-opus-4-1-20250805`,
 * the bare aliases `opus` / `sonnet` / `haiku`, `claude-3-opus-...`, `anthropic.claude-opus-...`,
 * `...[1m]` suffixes. Anything else (`unknown`, a made-up `opusx`) is `other`.
 */
export function modelFamily(model: string): ModelFamily {
  const tokens = model.toLowerCase().split(/[^a-z0-9]+/);
  if (tokens.includes('opus')) return 'opus';
  if (tokens.includes('sonnet')) return 'sonnet';
  if (tokens.includes('haiku')) return 'haiku';
  return 'other';
}
