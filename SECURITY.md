# Security policy

Security reports should concern vulnerabilities in Lazpho, unsafe behavior caused by its package, or Lazpho-originated dependency/supply-chain issues—not unrelated vulnerabilities in a consuming application.

Do not include credentials, production data, or exploit details in a public issue. Use [GitHub private vulnerability reporting](https://github.com/diveshshubham/lazpho/security/advisories/new) for sensitive reports. If private reporting is temporarily unavailable, contact the repository owner privately before sharing exploit details; do not fall back to a public issue.

When reporting, include the affected Lazpho version/commit, Node version, minimal reproduction, impact, and any known mitigation. Maintainers should acknowledge scope privately, coordinate a fix and disclosure, and avoid publishing sensitive details before users can update. No response-time SLA is promised.

Supported runtime and dependency ranges are maintained in `docs/compatibility.md`. Node 18/20 compatibility does not restore upstream security support for those EOL runtimes; production users should prefer Node 22/24.
