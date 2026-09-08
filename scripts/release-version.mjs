import { appendFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertVersionUnpublished, isPrerelease, releaseDistTag, validateReleaseTag } from './release-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const [command = 'validate', argument] = process.argv.slice(2);

if (command === 'validate' || command === 'validate-local') {
  const tag = command === 'validate-local' ? `v${packageJson.version}` : argument ?? process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
  if (!tag) throw new Error('Provide the release tag as v<package-version>.');
  const version = validateReleaseTag(tag, packageJson.version);
  const values = {
    package_name: packageJson.name,
    package_version: version,
    release_tag: tag,
    npm_dist_tag: releaseDistTag(version),
    prerelease: String(isPrerelease(version))
  };
  for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
  }
} else if (command === 'check-unpublished') {
  await assertVersionUnpublished(packageJson.name, packageJson.version);
  console.log(`${packageJson.name}@${packageJson.version} is not present on npm.`);
} else {
  throw new Error('Usage: node scripts/release-version.mjs <validate [vX.Y.Z]|check-unpublished>');
}
