# Changelog

## [0.12.0](https://github.com/chrischall/homes-mcp/compare/v0.11.0...v0.12.0) (2026-05-29)


### Features

* adopt @fetchproxy/server 0.11.0 parsing helpers (drop local extractImgTags + lastPathSegment) + realty-core 0.4.1 ([#75](https://github.com/chrischall/homes-mcp/issues/75)) ([1385cec](https://github.com/chrischall/homes-mcp/commit/1385cec9d1ea29268d8c706f01d92b869ceeec3e))
* price_min/price_max on homes_get_by_address search-fallback ([#46](https://github.com/chrischall/homes-mcp/issues/46)) ([#72](https://github.com/chrischall/homes-mcp/issues/72)) ([06bfc7a](https://github.com/chrischall/homes-mcp/commit/06bfc7ac9fc2f7eba2e53afa2e4392344a99b48f))


### Bug Fixes

* cap homes_healthcheck probe at 18s with an open-&-interact hint ([#70](https://github.com/chrischall/homes-mcp/issues/70)) ([0c58993](https://github.com/chrischall/homes-mcp/commit/0c58993c1ed43c5c4c0c14c236b72419bb83032f)), closes [#66](https://github.com/chrischall/homes-mcp/issues/66)
* **ci:** arm auto-merge from verdict comment when structured_output is empty ([#73](https://github.com/chrischall/homes-mcp/issues/73)) ([45b648d](https://github.com/chrischall/homes-mcp/commit/45b648d93f513b0cfe760be8a5a513adb314bbb1))
* **ci:** treat instant-merge race as success in auto-merge arm ([#71](https://github.com/chrischall/homes-mcp/issues/71)) ([9086236](https://github.com/chrischall/homes-mcp/commit/90862368c9b6ef9d9c5f14781bf30366e44af3c6))
* resolver timeout taxonomy (single path) + first-class search-fallback rung ([#68](https://github.com/chrischall/homes-mcp/issues/68)) ([612ddf5](https://github.com/chrischall/homes-mcp/commit/612ddf5072da2139e186dd890e8f132060ca5599))

## [0.11.0](https://github.com/chrischall/homes-mcp/compare/v0.10.0...v0.11.0) (2026-05-29)


### Features

* adopt @chrischall/realty-core 0.4.0 (marina place-name guard + completed→Sold) ([#63](https://github.com/chrischall/homes-mcp/issues/63)) ([15937ac](https://github.com/chrischall/homes-mcp/commit/15937acef7c11c86b8d4728449fe50a10245ae2b))
* adopt realty-core extractFeatures (canonical basement detector) + drop inline copy ([#62](https://github.com/chrischall/homes-mcp/issues/62)) ([3dd95bd](https://github.com/chrischall/homes-mcp/commit/3dd95bd07d221e63fb9bd46ee1276f33256d4950))
* consume @chrischall/realty-core 0.3.1 — drop inline hoisted helpers ([#61](https://github.com/chrischall/homes-mcp/issues/61)) ([9e5b75d](https://github.com/chrischall/homes-mcp/commit/9e5b75dc78aafad958244cdb5b8e1cbeac7f090d))
* **properties:** add derived lot_size_acres ([#82](https://github.com/chrischall/homes-mcp/issues/82)) ([#59](https://github.com/chrischall/homes-mcp/issues/59)) ([6b225ec](https://github.com/chrischall/homes-mcp/commit/6b225ecc4a7c2405eb9756d6d581834fb0217faf))


### Bug Fixes

* **by-address:** resolve via structured smartsearch typeahead to fix coverage false-negatives ([#58](https://github.com/chrischall/homes-mcp/issues/58)) ([14f0a84](https://github.com/chrischall/homes-mcp/commit/14f0a841ba40801b13f9cb0bd3de533ae77eca70))
* **resolve-addresses:** add overall deadline + paced fan-out + single-call timeout ([#54](https://github.com/chrischall/homes-mcp/issues/54)) ([#56](https://github.com/chrischall/homes-mcp/issues/56)) ([c90508d](https://github.com/chrischall/homes-mcp/commit/c90508de972dffbdfd1a7b45af1981dcdaaa3b13))
* **resolve-addresses:** unref pacing timer + true staggered refill dispatch ([#57](https://github.com/chrischall/homes-mcp/issues/57)) ([b43e013](https://github.com/chrischall/homes-mcp/commit/b43e01392eb7ada96b7020b4454692ea721dd883))


### Refactor

* **transport:** read fetchTimeoutMs from bridgeHealth() instead of local DEFAULT — closes drift gap per fetchproxy[#82](https://github.com/chrischall/homes-mcp/issues/82) ([#52](https://github.com/chrischall/homes-mcp/issues/52)) ([53abda5](https://github.com/chrischall/homes-mcp/commit/53abda5f5b7fd0b8c09a7e5e797f1089adac123b))

## [0.10.0](https://github.com/chrischall/homes-mcp/compare/v0.9.0...v0.10.0) (2026-05-28)


### Features

* **resolve:** add search-fallback rung (closes [#47](https://github.com/chrischall/homes-mcp/issues/47)) ([#50](https://github.com/chrischall/homes-mcp/issues/50)) ([40d2178](https://github.com/chrischall/homes-mcp/commit/40d2178ce161dea4c8bd22cbe8aadebc8d5e8509))


### Bug Fixes

* **resolve:** bulk should run same rungs as single (closes [#44](https://github.com/chrischall/homes-mcp/issues/44)) ([#45](https://github.com/chrischall/homes-mcp/issues/45)) ([7b63359](https://github.com/chrischall/homes-mcp/commit/7b63359c431bff9824c09f2a5ebdf99bdf83a8a2))

## [0.9.0](https://github.com/chrischall/homes-mcp/compare/v0.8.0...v0.9.0) (2026-05-27)


### Features

* **bulk:** add homes_bulk_get + homes_resolve_addresses ([#35](https://github.com/chrischall/homes-mcp/issues/35)) ([5b79dc3](https://github.com/chrischall/homes-mcp/commit/5b79dc3f1395bddead9888b0a0474ede24e1c195))
* **format:** add derived fields + tax sentinel cleanup + portal hyperlink + alternates ([#34](https://github.com/chrischall/homes-mcp/issues/34)) ([1d838d3](https://github.com/chrischall/homes-mcp/commit/1d838d3722ea5b468dd498397d1edbf72c85511c))
* **history:** bundle into homes_get_property + add homes_get_history; deprecate split ([#38](https://github.com/chrischall/homes-mcp/issues/38)) ([3775938](https://github.com/chrischall/homes-mcp/commit/37759389715f7b9fc557e5fdacc948ffc50ec154))
* **p0:** default include_description=false + server-side extracted_features ([#32](https://github.com/chrischall/homes-mcp/issues/32)) ([91760e6](https://github.com/chrischall/homes-mcp/commit/91760e6beca9021e49a75cdefaa7d4cbadb3eebf))
* **search,history:** truncated marker + events_normalized ([#37](https://github.com/chrischall/homes-mcp/issues/37)) ([f31f8db](https://github.com/chrischall/homes-mcp/commit/f31f8db15c8a94667e06ea54c4b1ee447d9409bb))
* **sessions:** label-only multi-session registry + diagnostic tools ([#36](https://github.com/chrischall/homes-mcp/issues/36)) ([e01b9e3](https://github.com/chrischall/homes-mcp/commit/e01b9e3290564ae95a1e52d754472aaf6d7e242f))
* **transport-fetchproxy,healthcheck:** adopt @fetchproxy/server 0.8.0 + surface bridge hints ([#43](https://github.com/chrischall/homes-mcp/issues/43)) ([4c6d01e](https://github.com/chrischall/homes-mcp/commit/4c6d01e94284693e9c9d4adf550cc7fa62c48b6a))
* **transport,docs:** SW lazy-revive retry + tool-description honesty sweep ([#40](https://github.com/chrischall/homes-mcp/issues/40)) ([69f5d7b](https://github.com/chrischall/homes-mcp/commit/69f5d7bc2bacaa2c2b0bad0abb8494548a2c893c))


### Bug Fixes

* **p0:** drop bare "with exceptions" false-positive + negative-cache loadCommunities ([#41](https://github.com/chrischall/homes-mcp/issues/41)) ([5cf7046](https://github.com/chrischall/homes-mcp/commit/5cf70468afe3953483f2084c234faf6285bc9a71))


### Documentation

* **rental:** document the homes.com rental-data gap ([#39](https://github.com/chrischall/homes-mcp/issues/39)) ([99eed0d](https://github.com/chrischall/homes-mcp/commit/99eed0d48c010f655761b3af9bb3afc87f8b0908))

## [0.8.0](https://github.com/chrischall/homes-mcp/compare/v0.7.0...v0.8.0) (2026-05-26)


### Features

* add homes_get_by_address for unified canonical-URL resolution ([#11](https://github.com/chrischall/homes-mcp/issues/11)) ([219b582](https://github.com/chrischall/homes-mcp/commit/219b5828cfcd90f3755d8a9d9feb4d4ac3cba6c9)), closes [#10](https://github.com/chrischall/homes-mcp/issues/10)

## [0.7.0](https://github.com/chrischall/homes-mcp/compare/v0.6.0...v0.7.0) (2026-05-26)


### Features

* commits, and propose v0.7.0. ([f42374a](https://github.com/chrischall/homes-mcp/commit/f42374aa08546e4aa600df3241c8167ba34bcb08))
* initial homes-mcp scaffold ([b50a426](https://github.com/chrischall/homes-mcp/commit/b50a426fdfbfe3e42fe7307659376732f51fb9c2))
* v0.7 — Zillow/Redfin/Compass parity (7 new tools + 2 extensions) ([#3](https://github.com/chrischall/homes-mcp/issues/3)) ([cecda68](https://github.com/chrischall/homes-mcp/commit/cecda684b1da49bb173cc89caeb055d57825f93e))


### Bug Fixes

* **ci:** prevent labeled event from cancelling auto-review ([#2](https://github.com/chrischall/homes-mcp/issues/2)) ([a37f51d](https://github.com/chrischall/homes-mcp/commit/a37f51d2f500c2e114929c2eb168680e210d0a10))
* real-world homes.com parsing — th cells, entity-encoded JSON-LD, id fragments, headless nearby ([#5](https://github.com/chrischall/homes-mcp/issues/5)) ([414e6fb](https://github.com/chrischall/homes-mcp/commit/414e6fb5797a5306ae65c2d1a5f4157fb40bddfa))


### Documentation

* **claude:** treat first-party dep bumps as fix/feat, not chore ([#7](https://github.com/chrischall/homes-mcp/issues/7)) ([ad00466](https://github.com/chrischall/homes-mcp/commit/ad00466fe05fe71713e73d55791ba2b74ee4a7f5))
* **claude:** warn against opening PRs before the feature is done ([#6](https://github.com/chrischall/homes-mcp/issues/6)) ([886a6d8](https://github.com/chrischall/homes-mcp/commit/886a6d81dfeaea4d1ea5f368643bc15b65ea4ac1))
