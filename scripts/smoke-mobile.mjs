// Opt-in native connection/tree/screenshot smoke against an installed test app. No Jev key.
import assert from 'node:assert/strict';
import { AppiumAdapter } from '../dist/mobile/adapter.js';
import { MobileTargetSchema } from '../dist/mobile/spec.js';

const target = MobileTargetSchema.parse({
  platform: process.env.PLAIN_MOBILE_PLATFORM,
  device: process.env.PLAIN_MOBILE_DEVICE,
  app: process.env.PLAIN_MOBILE_APP,
  capabilities: process.env.PLAIN_MOBILE_CAPABILITIES ? JSON.parse(process.env.PLAIN_MOBILE_CAPABILITIES) : undefined,
});
const adapter = new AppiumAdapter(process.env.PLAIN_APPIUM_URL);
try {
  await adapter.open(target);
  const frame = await adapter.capture('region');
  assert.ok(frame.snapshot.aria.length > 0, 'App exposes a nonempty native UI tree');
  const png = await adapter.screenshot();
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'Device returns a PNG screenshot');
  console.log(`${target.platform}: session, native tree (${frame.candidates.length} regions) and PNG capture passed`);
} finally { await adapter.close(); }
