import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeployment } from '../deploy/check-config.mjs';
import { healthyResponse } from '../deploy/check-health.mjs';

const valid = () => ({ DEVICE_TOKEN: 'd'.repeat(32), DASHBOARD_TOKEN: 'b'.repeat(32), PUBLIC_ORIGIN: 'https://translate.playground.computer' });
test('deployment accepts existing default state paths and optional OpenAI key', () => {
  assert.doesNotThrow(() => validateDeployment(valid()));
  assert.doesNotThrow(() => validateDeployment({ ...valid(), RECORDINGS_DIR: '/opt/rokid-test/recordings', LOG_DIR: './logs' }));
});
test('deployment rejects incompatible service/proxy settings without disclosing values', () => {
  for (const override of [{ PORT: '9999' }, { HOST: '0.0.0.0' }, { PUBLIC_ORIGIN: 'https://wrong.example' }, { RECORDINGS_DIR: '/private/path' }, { LOG_DIR: '../logs' }]) {
    assert.throws(() => validateDeployment({ ...valid(), ...override }));
  }
  assert.throws(() => validateDeployment({ ...valid(), DEVICE_TOKEN: 'private-token' }), error => !error.message.includes('private-token'));
  assert.throws(() => validateDeployment({ ...valid(), DASHBOARD_TOKEN: 'd'.repeat(32) }));
});
test('health check rejects unrelated pages, malformed JSON and unhealthy responses', () => {
  assert.equal(healthyResponse('{"ok":true,"mode":"translation-relay"}'), true);
  for (const body of ['<html>Apache</html>', '{}', 'null', '{"ok":false,"mode":"translation-relay"}', '{"ok":true,"mode":"other"}']) {
    assert.equal(healthyResponse(body), false);
  }
});
