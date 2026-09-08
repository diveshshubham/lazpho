import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const documents = ['README.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/api.md', 'docs/operations.md', 'docs/compatibility.md', 'docs/versioning.md', 'docs/migration.md', 'docs/phase8-validation.md', 'docs/phase8b-bottleneck-lab.md', 'docs/phase8-application-integration.md', 'docs/vision-and-usage.md', 'docs/load-lab.md', 'docs/1.0-readiness.md'];

test('documentation links resolve to repository files', async () => {
  for (const document of documents) {
    const body = await readFile(resolve(root, document), 'utf8');
    for (const match of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split('#', 1)[0];
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
      await assert.doesNotReject(access(resolve(dirname(resolve(root, document)), decodeURIComponent(target))), `${document}: broken link ${target}`);
    }
  }
});

test('consumer documentation uses the selected package identity', async () => {
  for (const document of ['README.md', 'docs/api.md', 'docs/operations.md', 'docs/compatibility.md']) {
    const body = await readFile(resolve(root, document), 'utf8');
    assert.doesNotMatch(body, /(?:from\s+['"]|npm install\s+)factory-node(?:[/\s'"]|$)/, document);
  }
  assert.equal(extname('docs/compatibility.md'), '.md');
});
