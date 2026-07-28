/**
 * `chat.postMessage`'s `text` field allows 40k chars, but Slack collapses
 * anything much past ~3k behind a "Show more" fold. Chunk below that so long
 * answers stay readable in the thread.
 */
const MAX_MESSAGE_CHARS = 2900;

/** Split on paragraph, then line, then a hard cut — ignoring code fences. */
function splitRaw(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const out: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    // Prefer to break on a blank line, then a newline, then a hard cut.
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/**
 * Split long text into Slack-safe chunks, preferring paragraph boundaries and
 * repairing any code fence the split landed inside. Without the repair, a
 * chunk that opens a fence it never closes renders the rest of the message —
 * and all of the next one — as a single broken code block.
 */
export function chunk(text: string, limit = MAX_MESSAGE_CHARS): string[] {
  const parts = splitRaw(text, limit);
  if (parts.length <= 1) return parts;

  const out: string[] = [];
  let openFence: string | undefined;

  for (const part of parts) {
    // Reopen a fence the previous chunk had to close, keeping its language.
    const prefix = openFence === undefined ? '' : `\`\`\`${openFence}\n`;

    for (const [, lang] of part.matchAll(/^```(\S*)/gm)) {
      openFence = openFence === undefined ? (lang ?? '') : undefined;
    }

    const suffix = openFence === undefined ? '' : '\n```';
    out.push(`${prefix}${part}${suffix}`);
  }
  return out;
}

/** Truncate a value for display, marking that it was cut. */
export function truncate(s: string, limit: number): string {
  return s.length <= limit ? s : `${s.slice(0, limit)}… (${s.length} chars)`;
}

/**
 * A one-line, human-readable summary of a tool call — this is what shows up in
 * the Slack thread as Claude works, and what you approve or deny against.
 */
export function describeTool(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const str = (k: string): string | undefined =>
    typeof input[k] === 'string' ? (input[k] as string) : undefined;

  switch (toolName) {
    case 'Bash':
      return truncate(str('command') ?? '(no command)', 300);
    case 'Read':
      return str('file_path') ?? '(no path)';
    case 'Write':
      return `${str('file_path') ?? '(no path)'} (${
        (str('content') ?? '').split('\n').length
      } lines)`;
    case 'Edit':
      return str('file_path') ?? '(no path)';
    case 'Glob':
    case 'Grep':
      return `${str('pattern') ?? ''}${
        str('path') ? ` in ${str('path')}` : ''
      }`;
    case 'WebFetch':
      return str('url') ?? '';
    case 'WebSearch':
      return str('query') ?? '';
    case 'Task':
    case 'Agent':
      return truncate(str('description') ?? str('prompt') ?? '', 200);
    default: {
      const json = JSON.stringify(input);
      return truncate(json ?? '', 300);
    }
  }
}

/** Full input rendering for the approval prompt, as a fenced code block. */
export function toolDetail(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return '```' + truncate(input.command, 1500) + '```';
  }
  return '```' + truncate(JSON.stringify(input, null, 2), 1500) + '```';
}

export function formatCost(usd: number | undefined): string {
  if (usd === undefined) return '';
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}
