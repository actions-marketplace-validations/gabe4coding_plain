import assert from 'node:assert/strict';
import { fixtureApp, installMobileFixture } from '../../scripts/mobile-fixture.mjs';

let uninstall;

export function setup({ spec }) {
  assert.equal(spec.app, fixtureApp, 'This hook only manages the disposable Plainwright fixture');
  uninstall = installMobileFixture(spec.platform, spec.env.device);
}

export function teardown() {
  uninstall?.();
}
