import semver from 'semver';

export function validateReleaseTag(tag, packageVersion) {
  if (semver.valid(packageVersion) !== packageVersion) {
    throw new Error(`package.json version is not valid canonical SemVer: ${packageVersion}`);
  }
  if (tag !== `v${packageVersion}`) {
    throw new Error(`Release tag ${JSON.stringify(tag)} must exactly match package.json version v${packageVersion}.`);
  }
  return packageVersion;
}

export function releaseDistTag(version) {
  const prerelease = semver.prerelease(version);
  if (!prerelease) return 'latest';
  return String(prerelease[0]).toLowerCase() === 'beta' ? 'beta' : 'next';
}

export function isPrerelease(version) {
  return semver.prerelease(version) !== null;
}

export async function assertVersionUnpublished(name, version, fetchImplementation = globalThis.fetch) {
  const response = await fetchImplementation(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
  if (response.status === 404) return;
  if (response.ok) throw new Error(`${name}@${version} already exists on npm and cannot be overwritten.`);
  throw new Error(`Unable to verify npm publication status: registry returned HTTP ${response.status}.`);
}
