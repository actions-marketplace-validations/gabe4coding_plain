/** Events sent to Jev with every judgment; older ones drop off. */
export const MAX_EVENTS = 30;
/** Ad-heavy sites log CSP errors that list every allowed domain: the head says what the error is. */
const MAX_NOTE_CHARS = 300;

/** Resources the browser refused or failed to load (ads, trackers, CSP): nothing about the page under test. */
const BLOCKED_RESOURCE = /Content Security Policy|^Failed to load resource|net::ERR_|Blocked script execution in 'about:blank'|third-party cookie/i;

export function shortNote(message: string): string {
  return message.length <= MAX_NOTE_CHARS ? message : `${message.slice(0, MAX_NOTE_CHARS)}… (${message.length} chars)`;
}

/** True when a console error comes from a blocked or failed resource, or from another site's script. */
export function isConsoleNoise(text: string, sourceUrl: string, pageUrl: string): boolean {
  if (BLOCKED_RESOURCE.test(text)) return true;
  const from = site(sourceUrl);
  const own = site(pageUrl);
  return from !== null && own !== null && from !== own;
}

/** A guess of the registrable domain, enough to tell another site's script: example.co.uk → example.co.uk. */
function site(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const labels = host.split('.');
  const hasCountrySecondLevel = labels.length > 2 && labels.at(-1)!.length === 2 && labels.at(-2)!.length <= 3;
  return labels.slice(hasCountrySecondLevel ? -3 : -2).join('.');
}

export function noiseNote(count: number): string {
  return `console: ${count} error${count === 1 ? '' : 's'} from other sites or blocked resources (ads, trackers, CSP), not listed`;
}

/** Appends `message`, or counts it on the last entry when it repeats it: `message (×3)`. */
export function pushCollapsed(list: string[], message: string): void {
  const last = list.at(-1);
  const repeat = last === undefined ? null : / \(×(\d+)\)$/.exec(last);
  const base = repeat ? last!.slice(0, repeat.index) : last;
  if (base === message) list[list.length - 1] = `${message} (×${repeat ? Number(repeat[1]) + 1 : 2})`;
  else list.push(message);
}
