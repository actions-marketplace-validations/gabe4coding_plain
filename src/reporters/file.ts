import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** File reporters write once the suite is complete, creating nested output directories. */
export async function writeReport(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, 'utf8');
}
