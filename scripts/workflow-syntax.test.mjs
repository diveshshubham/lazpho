import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('GitHub Actions workflows are valid YAML with bounded jobs and explicit permissions', async () => {
  const workflowDirectory = resolve(root, '.github/workflows');
  const names = (await readdir(workflowDirectory)).filter((name) => name.endsWith('.yml')).sort();
  assert.deepEqual(names, ['ci.yml', 'long-soak.yml', 'release.yml']);
  for (const name of names) {
    const document = parseDocument(await readFile(resolve(workflowDirectory, name), 'utf8'), { uniqueKeys: true });
    assert.deepEqual(document.errors, [], `${name} contains invalid YAML`);
    const workflow = document.toJS();
    assert.ok(workflow.on, `${name} requires explicit triggers`);
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.ok(Object.keys(workflow.jobs).length > 0);
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if ('uses' in job) continue;
      assert.ok(job['timeout-minutes'] > 0, `${name}:${jobName} requires a timeout`);
      assert.equal(job['runs-on'], 'ubuntu-latest');
    }
  }
});
