import type { Frame } from 'playwright';

/** Iframe name, or its URL's pathname. Labels iframe candidates and iframe snapshot sections. */
export function frameLabel(frame: Frame): string {
  const name = frame.name();
  if (name) return name;
  try { return new URL(frame.url()).pathname || frame.url(); } catch { return frame.url(); }
}
