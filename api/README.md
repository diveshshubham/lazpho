# Public API contracts

`public-api.json` records package subpaths, runtime exports, error codes and metadata, preset defaults, warning codes, HTTP mappings, metric names, and numeric state mappings.

`public-types.json` records the normalized declaration closure reachable from every public package entry point.

Normal tests never rewrite these files. Run `npm run api:check` to detect drift and `npm run api:update` only after reviewing and classifying an intentional API change.
