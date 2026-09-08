import assert from 'node:assert/strict';
import test from 'node:test';
import { assertVersionUnpublished, isPrerelease, releaseDistTag, validateReleaseTag } from './release-policy.mjs';

test('release tags must be canonical SemVer and exactly match package.json', () => {
  assert.equal(validateReleaseTag('v1.2.3', '1.2.3'), '1.2.3');
  assert.equal(validateReleaseTag('v1.2.3-beta.1', '1.2.3-beta.1'), '1.2.3-beta.1');
  assert.throws(() => validateReleaseTag('v1.2.4', '1.2.3'), /must exactly match/);
  assert.throws(() => validateReleaseTag('1.2.3', '1.2.3'), /must exactly match/);
  assert.throws(() => validateReleaseTag('v01.2.3', '01.2.3'), /canonical SemVer/);
});

test('stable, beta, and other prereleases receive safe npm dist-tags', () => {
  assert.equal(releaseDistTag('1.2.3'), 'latest');
  assert.equal(releaseDistTag('1.2.3-beta.2'), 'beta');
  assert.equal(releaseDistTag('1.2.3-rc.1'), 'next');
  assert.equal(isPrerelease('1.2.3'), false);
  assert.equal(isPrerelease('1.2.3-rc.1'), true);
});

test('duplicate publication check distinguishes absent, existing, and failed registry responses', async () => {
  await assert.doesNotReject(assertVersionUnpublished('lazpho', '1.2.3', async () => new Response(null, { status: 404 })));
  await assert.rejects(assertVersionUnpublished('lazpho', '1.2.3', async () => new Response('{}')), /already exists/);
  await assert.rejects(assertVersionUnpublished('lazpho', '1.2.3', async () => new Response(null, { status: 503 })), /HTTP 503/);
});
