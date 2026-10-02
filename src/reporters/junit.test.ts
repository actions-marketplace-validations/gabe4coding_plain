import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { escapeXml, junitReporter, junitXml } from './junit.js';
import { attempt, run, spec } from './fixtures.test.js';

function parse(xml: string) {
  assert.equal(XMLValidator.validate(xml), true, 'JUnit must be well-formed XML');
  assert.doesNotMatch(xml, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/);
  return new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, htmlEntities: true,
    isArray: (tag) => ['testcase', 'property', 'flakyFailure', 'flakyError', 'rerunFailure', 'rerunError'].includes(tag) }).parse(xml).testsuites;
}

test('JUnit escapes all XML entities, strips forbidden code points, and preserves valid Unicode', () => {
  const input = `&<>"'\u0000\u0008\u000B\u000C\u001F\uFFFE\uFFFF\uD800\uDC00\uD800ok\uDC00\t\n\r😀é`;
  assert.equal(escapeXml(input), '&amp;&lt;&gt;&quot;&apos;𐀀ok\t\n\r😀é');
  const label = `expect "<&'😀>"\nnext\u0000`;
  const name = `Checkout & <"'>\t😀\u0001`;
  const report = run([spec('fail', { name, file: path.resolve('tests/a&b.yaml'),
    attempts: [attempt('fail', { steps: [{ step: label, status: 'fail', detail: `bad <&"'>\u0000 😀` }] })] })]);
  const parsed = parse(junitXml(report));
  const tc = parsed.testsuite.testcase[0];
  assert.equal(tc['@_name'], name.replace('\u0001', ''));
  assert.equal(tc['@_classname'], path.join('tests', 'a&b.yaml'));
  assert.equal(tc.failure['@_message'], label.replace('\u0000', ''));
  assert.equal(tc.failure['#text'], `bad <&"'> 😀`);
});

test('JUnit maps every final status, load errors, thrown attempts, and both stop rules', () => {
  const report = run([
    spec('pass'), spec('fail'), spec('inconclusive'), spec('error'),
    spec('error', { attempts: [], loadError: 'Error: invalid YAML' }),
    spec('error', { attempts: [attempt('error', { steps: [], error: 'Error: launch failed' })] }),
    spec('skipped', { attempts: [], skipReason: 'bail' }),
    spec('skipped', { attempts: [], skipReason: 'max-tokens' }),
    spec('skipped'),
  ]);
  const parsed = parse(junitXml(report));
  for (const node of [parsed, parsed.testsuite]) {
    assert.equal(node['@_tests'], '9');
    assert.equal(node['@_failures'], '2');
    assert.equal(node['@_errors'], '3');
    assert.equal(node['@_skipped'], '3');
    assert.equal(node['@_time'], '5.25');
  }
  assert.equal(parsed['@_name'], 'plainwright browser');
  assert.equal(parsed.testsuite['@_name'], 'plainwright');
  const cases = parsed.testsuite.testcase;
  assert.equal(cases[0].failure, undefined);
  assert.equal(cases[0].error, undefined);
  assert.equal(cases[1].failure['@_type'], 'fail');
  assert.equal(cases[2].failure['@_type'], 'inconclusive');
  assert.equal(cases[3].error['@_message'], 'expect "Order complete"');
  assert.equal(cases[4].error['#text'], 'Error: invalid YAML');
  assert.equal(cases[4]['@_time'], '0');
  assert.equal(cases[5].error['#text'], 'Error: launch failed');
  assert.equal(cases[6].skipped['@_message'], 'bail');
  assert.equal(cases[7].skipped['@_message'], 'max-tokens');
  assert.equal(cases[8].skipped['@_message'], 'skipped');
});

test('JUnit retains all failed retries, all attempt artifacts, timings, and aggregate properties', () => {
  const artifacts = [
    { kind: 'screenshot' as const, path: path.resolve('plainwright-results/fail&shot.png'), step: 0 },
    { kind: 'trace' as const, path: path.resolve('plainwright-results/trace.zip') },
    { kind: 'dump' as const, path: path.resolve('plainwright-results/pick.json') },
  ];
  const report = run([
    spec('pass', { flaky: true, attempts: [attempt('fail', { artifacts: artifacts.slice(0, 2) }),
      attempt('error', { attempt: 1, steps: [], error: 'Error: timeout', artifacts: artifacts.slice(2) }),
      attempt('pass', { attempt: 2 })] }),
    spec('fail', { attempts: [attempt('inconclusive'), attempt('fail', { attempt: 1 })] }),
  ]);
  const parsed = parse(junitXml(report));
  const [flaky, rerun] = parsed.testsuite.testcase;
  assert.equal(parsed['@_failures'], '1');
  assert.equal(parsed['@_errors'], '0');
  assert.equal(flaky['@_time'], '3.75');
  assert.equal(flaky.failure, undefined);
  // Surefire: a failed earlier attempt is flakyFailure, an errored one flakyError.
  assert.equal(flaky.flakyFailure.length, 1);
  assert.equal(flaky.flakyFailure[0].stackTrace, 'page detail');
  assert.equal(flaky.flakyError.length, 1);
  assert.equal(flaky.flakyError[0].stackTrace, 'Error: timeout');
  assert.equal(rerun.rerunFailure.length, 1);
  assert.equal(rerun.rerunFailure[0]['@_type'], 'inconclusive');
  assert.equal(rerun.failure['@_type'], 'fail');
  assert.equal(rerun.flakyFailure, undefined);
  for (const { path: file } of artifacts) assert.ok(flaky['system-out'].includes(`[[ATTACHMENT|${file}]]`));
  assert.ok(flaky['system-out'].includes('  ✘ expect "Order complete" page detail'));
  assert.ok(flaky['system-out'].includes('attempt 3:'));
  const props = Object.fromEntries(flaky.properties.property.map((p: Record<string, string>) => [p['@_name'], p['@_value']]));
  assert.deepEqual(props, { jevCalls: '6', tokens: '90', provider: 'typesafe', model: 'jev-test', attempts: '3' });
  const suiteProps = Object.fromEntries(parsed.testsuite.properties.property.map((p: Record<string, string>) => [p['@_name'], p['@_value']]));
  assert.deepEqual(suiteProps, { jevCalls: '10', tokens: '150', provider: 'typesafe', model: 'jev-test', attempts: '5' });
});

test('JUnit creates nested directories at runEnd and reports empty native suites', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plainwright-junit-'));
  try {
    const file = path.join(dir, 'nested', 'junit.xml');
    const observer = junitReporter(file);
    assert.equal(observer.specEnd, undefined);
    for (const engine of ['desktop', 'mobile'] as const) {
      await observer.runEnd!({ report: { ...run([]), engine } });
      const xml = await fs.readFile(file, 'utf8');
      const parsed = parse(xml);
      assert.equal(parsed['@_name'], `plainwright ${engine}`);
      assert.equal(parsed['@_tests'], '0');
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
