# Changelog

## [0.8.0](https://github.com/aelefebv/lucida/compare/v0.7.0...v0.8.0) (2026-06-20)


### Features

* @-mention autocomplete in the comment edit composer ([#800](https://github.com/aelefebv/lucida/issues/800)) ([a24febc](https://github.com/aelefebv/lucida/commit/a24febcf55e8f349842e0fcde3b5fced883b8d6f))
* @-mention collaborators in annotation comments ([#798](https://github.com/aelefebv/lucida/issues/798)) ([ffb4107](https://github.com/aelefebv/lucida/commit/ffb410720f077d38c98948be31592993c54b7edd))
* add dataset reliability diagnostics ([#763](https://github.com/aelefebv/lucida/issues/763)) ([943e264](https://github.com/aelefebv/lucida/commit/943e264a3acb72c7e15d027b4517877c152a9af0))
* collaborative annotations — pins, threads, shapes, 3D, and data-context anchoring ([#797](https://github.com/aelefebv/lucida/issues/797)) ([b365c8f](https://github.com/aelefebv/lucida/commit/b365c8f77ed2c4671f16fb5c4141df21f8cdee74))
* mentions-of-me — find and jump to comments that @-mention you ([#807](https://github.com/aelefebv/lucida/issues/807)) ([8fa54f1](https://github.com/aelefebv/lucida/commit/8fa54f1fce4e3d1fddbda25077f1886b59e2308f))
* **tryout:** agent tryout harness — web/CLI/Python + saved screenshots & logs ([d187c41](https://github.com/aelefebv/lucida/commit/d187c41f5fc0bdc4ae754f4a9345cbaedf4c5150))
* **tryout:** drive + capture the CLI and Python surfaces (slice 2) ([730d294](https://github.com/aelefebv/lucida/commit/730d294a5328ec72e28a3afdeb37d52d92d6cbb4))
* **tryout:** one-command lucida env bring-up for agents (slice 1) ([35d7653](https://github.com/aelefebv/lucida/commit/35d765333a3358954796df108bf2980808c0fe3e))
* **tryout:** scenario layer — drive --scenario + mentions scenario + --email (slice 6) ([#809](https://github.com/aelefebv/lucida/issues/809)) ([1269c44](https://github.com/aelefebv/lucida/commit/1269c44ff59b2badba1860abf8d48f5294000f6c))
* **tryout:** unified cross-surface verification report + discoverability (slice 4) ([59717bc](https://github.com/aelefebv/lucida/commit/59717bc921ce46db762473aa4d7b77aec03edbe6))
* **tryout:** web client surface — headless + real-SPA screenshots (slice 3) ([d33b713](https://github.com/aelefebv/lucida/commit/d33b713c9f95abb8c8335c7ad497c66e5d207565))
* viewed vs. unviewed @-mentions ([#803](https://github.com/aelefebv/lucida/issues/803)) ([#806](https://github.com/aelefebv/lucida/issues/806)) ([98cb8a0](https://github.com/aelefebv/lucida/commit/98cb8a06215e6efc2d85b074ab02e39ee8b14983))
* **workspace:** personal saved views server foundation ([#699](https://github.com/aelefebv/lucida/issues/699)) ([1a2126b](https://github.com/aelefebv/lucida/commit/1a2126b5b94baed351d917a6cbdc0d5575fae92c))
* **workspace:** personal saved views web UI ([#699](https://github.com/aelefebv/lucida/issues/699)) ([5167eda](https://github.com/aelefebv/lucida/commit/5167eda2c2a8a83dc563efc86f2ddfd8b9d5cebd))
* **workspace:** promote a personal saved view to shared ([#699](https://github.com/aelefebv/lucida/issues/699)) ([1b9dd1f](https://github.com/aelefebv/lucida/commit/1b9dd1fee8c5a6a5db4fb74ef010f21b4dffe19e))
* **workspace:** remember my last view per workspace ([#700](https://github.com/aelefebv/lucida/issues/700)) ([f324dc6](https://github.com/aelefebv/lucida/commit/f324dc6b8ae4632e28e44a51b4cad2cad23cc20a))
* **workspace:** viewer-proposed saved views ([#702](https://github.com/aelefebv/lucida/issues/702)) ([039712c](https://github.com/aelefebv/lucida/commit/039712ca1ef56a46df63dd60b184ca4dadfb99d1))


### Bug Fixes

* first @-mention shows in the Mentions indicator live, no refresh ([#805](https://github.com/aelefebv/lucida/issues/805)) ([4db6958](https://github.com/aelefebv/lucida/commit/4db6958299736c0e38bbeeda6a08ee0f8aaf97c7))
* show a readable collaborator handle in the annotation thread, not the raw author id ([#804](https://github.com/aelefebv/lucida/issues/804)) ([e2f28bd](https://github.com/aelefebv/lucida/commit/e2f28bdf73fb33970ffc80682883d9758f321bdf))


### Refactors

* **tryout:** unify the surface contract behind one registry + subprocess spine ([d7bce0e](https://github.com/aelefebv/lucida/commit/d7bce0ed6c337edd8ad730a5a18ec80b70055d24))

## [0.7.0](https://github.com/aelefebv/lucida/compare/v0.6.0...v0.7.0) (2026-06-09)


### Features

* add idle live workspace eviction ([931c61d](https://github.com/aelefebv/lucida/commit/931c61d0a1cefed5c22e4dd3146e80be27a38005))
* add workspace admin support endpoints ([dd94557](https://github.com/aelefebv/lucida/commit/dd94557c07ecba3959a20935f380629db5c38ed5))
* add workspace archive restore ([c7ec844](https://github.com/aelefebv/lucida/commit/c7ec8449902939b7af6dc65734c2ebfdc71bd900))
* add workspace recents and pins ([50a827d](https://github.com/aelefebv/lucida/commit/50a827d9a86d6aef06fa9b78012b46060bbdfa3f))
* add workspace saved view routes ([a4d533e](https://github.com/aelefebv/lucida/commit/a4d533e1e00d81a1286f3324aa07f4a641663fd5))
* add workspace saved views ([38e6478](https://github.com/aelefebv/lucida/commit/38e6478d223417498fb550c1304a8197ed270b6d))
* implement workspace-first CLI and Python client ([b4a38a5](https://github.com/aelefebv/lucida/commit/b4a38a593b02ba61888948f2c487c5d5d71223f8))


### Bug Fixes

* keep workspace inline views local ([01baef1](https://github.com/aelefebv/lucida/commit/01baef143b9a1a7dbd82feb91a15e21036929e5a)), closes [#722](https://github.com/aelefebv/lucida/issues/722)

## [0.6.0](https://github.com/aelefebv/lucida/compare/v0.5.1...v0.6.0) (2026-05-29)


### Features

* add dev auth user switcher ([8528bc7](https://github.com/aelefebv/lucida/commit/8528bc70adbbba9b13450bbe74e6d5ac1006d967))
* add workspace isolation tracer bullet ([bbe2d54](https://github.com/aelefebv/lucida/commit/bbe2d5468c6f2dd8059f3f1c9ae12268106fa1f5))
* add workspace sharing controls ([d882e63](https://github.com/aelefebv/lucida/commit/d882e63e4e3be367936f8095d5f2917e3858006f))
* cross-platform local dataset paths (Windows + UNC) ([#710](https://github.com/aelefebv/lucida/issues/710)) ([88a75c3](https://github.com/aelefebv/lucida/commit/88a75c3b72001a11265d36f9b53bf0937be868bc))
* use workspace-local dataset ids ([5a3b384](https://github.com/aelefebv/lucida/commit/5a3b38422116bfdfaaef1b86d82de467508423c9))

## [0.5.1](https://github.com/aelefebv/lucida/compare/v0.5.0...v0.5.1) (2026-05-21)


### Bug Fixes

* refresh runtime packages before release scan ([7deb4ce](https://github.com/aelefebv/lucida/commit/7deb4ce8d938e76334f4f62df2c0bbecdb4665ed))

## [0.5.0](https://github.com/aelefebv/lucida/compare/v0.4.0...v0.5.0) (2026-05-21)


### Features

* add chunk-only coarse/detail residency ([#691](https://github.com/aelefebv/lucida/issues/691)) ([45f7038](https://github.com/aelefebv/lucida/commit/45f703867c1f020a22cb3d0bf4e9742a61219bc5))
* budget proxy GPU residency ([#671](https://github.com/aelefebv/lucida/issues/671)) ([43cd2fa](https://github.com/aelefebv/lucida/commit/43cd2fac4959cf2cb4934c73ef5695fc9a401224)), closes [#670](https://github.com/aelefebv/lucida/issues/670)
* preview render radius while dragging sliders ([#693](https://github.com/aelefebv/lucida/issues/693)) ([555f0fe](https://github.com/aelefebv/lucida/commit/555f0fef922bcb73d84b6f2ed5dc0b5c54060567))


### Bug Fixes

* keep same-level coarse radius chunks resident ([#694](https://github.com/aelefebv/lucida/issues/694)) ([c694d31](https://github.com/aelefebv/lucida/commit/c694d314a97dfb99810c7b4adb7967ded69bd22c))
* **renderer:** harden worker residency feedback ([#662](https://github.com/aelefebv/lucida/issues/662)) ([7635fab](https://github.com/aelefebv/lucida/commit/7635faba869123539812662098e5fe82b35661f0))
* **renderer:** multi channel scrubbing was sometimes stuck without all 3 channels loaded, but panning / zooming fixed it. ([#663](https://github.com/aelefebv/lucida/issues/663)) ([09295e9](https://github.com/aelefebv/lucida/commit/09295e9d463cc1e2dd567906f2599b97c268f0b6))
* **renderer:** requeue stale chunks during scrubbing ([#653](https://github.com/aelefebv/lucida/issues/653)) ([5828bd3](https://github.com/aelefebv/lucida/commit/5828bd31b2a3c739d64463ebb4ebd7125f13b74a))

## [0.4.0](https://github.com/aelefebv/lucida/compare/v0.3.2...v0.4.0) (2026-05-17)


### Features

* **planning:** slice 5 — minimap promotion + lane renumbering ([#559](https://github.com/aelefebv/lucida/issues/559)) ([ba5e794](https://github.com/aelefebv/lucida/commit/ba5e794e3b3c1433cd9a8f8eda431605afcb4181))
* **planning:** slice 6 — ConfigStore + ConfigTab UI ([#551](https://github.com/aelefebv/lucida/issues/551)) ([#560](https://github.com/aelefebv/lucida/issues/560)) ([ba58823](https://github.com/aelefebv/lucida/commit/ba5882374e7915993bcca16e9bd9d6d5427b0296))


### Bug Fixes

* **planning:** drop validatePlanningInputs check 6 (asset-catalog refs) ([#587](https://github.com/aelefebv/lucida/issues/587)) ([2c6138a](https://github.com/aelefebv/lucida/commit/2c6138ad3ff39ef4d0bb09623f0f57fa7a650759))
* **planning:** drop validatePlanningInputs check 7 (minimapPending keys); audit pass ([#589](https://github.com/aelefebv/lucida/issues/589)) ([fdf7866](https://github.com/aelefebv/lucida/commit/fdf7866bded066b36b241d942ea8d7bca5893bb4))
* **planning:** validatePlanningInputs check 9 allows Image to back FieldEntry ([#588](https://github.com/aelefebv/lucida/issues/588)) ([57b6cf2](https://github.com/aelefebv/lucida/commit/57b6cf247d5234567f8040bc89d019d998f7b529))


### Refactors

* **planning:** coordinate-frame naming — Vox/World/Px suffixes + Axis namespace ([#580](https://github.com/aelefebv/lucida/issues/580)) ([#584](https://github.com/aelefebv/lucida/issues/584)) ([0150827](https://github.com/aelefebv/lucida/commit/01508275044bcb3dec7314de95cd1c63484c3b58))
* **planning:** discriminated ActiveSetEntry — three variants ([#568](https://github.com/aelefebv/lucida/issues/568)) ([#573](https://github.com/aelefebv/lucida/issues/573)) ([57e3738](https://github.com/aelefebv/lucida/commit/57e373871664ec58cef92fa2de7c10d7412f8a7f)), closes [#563](https://github.com/aelefebv/lucida/issues/563)
* **planning:** discriminated EntitySnapshot — three variants ([#569](https://github.com/aelefebv/lucida/issues/569)) ([#574](https://github.com/aelefebv/lucida/issues/574)) ([d2429b5](https://github.com/aelefebv/lucida/commit/d2429b5d9e2d01a96e502d4b0a381019a7af0fdd)), closes [#563](https://github.com/aelefebv/lucida/issues/563)
* **planning:** foundational cleanup + characterization tests ([#546](https://github.com/aelefebv/lucida/issues/546)) ([#553](https://github.com/aelefebv/lucida/issues/553)) ([3cad3f4](https://github.com/aelefebv/lucida/commit/3cad3f465bd07e0376fe1f3bd23d30fb06c671ba))
* **planning:** introduce PlanningState as the carry-forward seam ([#567](https://github.com/aelefebv/lucida/issues/567)) ([#572](https://github.com/aelefebv/lucida/issues/572)) ([480e6c2](https://github.com/aelefebv/lucida/commit/480e6c278035f9d8879e74ec56c98eef072b5d4b)), closes [#563](https://github.com/aelefebv/lucida/issues/563)
* **planning:** mechanical contract cleanups (numLevels, parentId, datasetId) ([#565](https://github.com/aelefebv/lucida/issues/565)) ([#570](https://github.com/aelefebv/lucida/issues/570)) ([95e1963](https://github.com/aelefebv/lucida/commit/95e1963ff029a7558ac741140ec90546f11c183c)), closes [#563](https://github.com/aelefebv/lucida/issues/563)
* **planning:** relocate scene types — SceneEpochs + VisibleRegion ([#566](https://github.com/aelefebv/lucida/issues/566)) ([#571](https://github.com/aelefebv/lucida/issues/571)) ([9c86630](https://github.com/aelefebv/lucida/commit/9c866308f240b59945e44e31910f1d52f4154975)), closes [#563](https://github.com/aelefebv/lucida/issues/563)
* **planning:** slice 2 — extracts + drop +2 LOD buffer + planning/ directory ([#547](https://github.com/aelefebv/lucida/issues/547)) ([#555](https://github.com/aelefebv/lucida/issues/555)) ([f6ab886](https://github.com/aelefebv/lucida/commit/f6ab886cad7e954dfac819f5f8e55b971205a27d))
* **planning:** slice 3 — PlanningConfig parameter threaded through plan() ([#548](https://github.com/aelefebv/lucida/issues/548)) ([#557](https://github.com/aelefebv/lucida/issues/557)) ([d592c42](https://github.com/aelefebv/lucida/commit/d592c42bcbfd75ecedbe5148e13d2de8c7cb4532))
* **planning:** slice 4 — snapshot builder + debug builder extraction ([#549](https://github.com/aelefebv/lucida/issues/549)) ([#558](https://github.com/aelefebv/lucida/issues/558)) ([645d325](https://github.com/aelefebv/lucida/commit/645d325771ff4011975b1c50e1b69ee57a7fc357))
* **planning:** split index.ts into types/modes/chunks/emit/plan ([#579](https://github.com/aelefebv/lucida/issues/579)) ([#583](https://github.com/aelefebv/lucida/issues/583)) ([166f1f6](https://github.com/aelefebv/lucida/commit/166f1f67af626791d2c1e018471e78d3aa97a82a))
* **planning:** validatePlanningInputs as dev-mode boundary check ([#581](https://github.com/aelefebv/lucida/issues/581)) ([#585](https://github.com/aelefebv/lucida/issues/585)) ([c878fcd](https://github.com/aelefebv/lucida/commit/c878fcdfda324bc9dd2545089986cf4e4df16ccf))

## [0.3.2](https://github.com/aelefebv/lucida/compare/v0.3.1...v0.3.2) (2026-05-15)


### Bug Fixes

* **store:** honor GOOGLE_APPLICATION_CREDENTIALS for gs:// ([#543](https://github.com/aelefebv/lucida/issues/543)) ([01d0289](https://github.com/aelefebv/lucida/commit/01d02899652225786505b8126e2b469669bac447))

## [0.3.1](https://github.com/aelefebv/lucida/compare/v0.3.0...v0.3.1) (2026-05-14)


### Bug Fixes

* **auth:** restore StubPrincipalExtractor for disabled mode ([#533](https://github.com/aelefebv/lucida/issues/533)) ([c41e7ca](https://github.com/aelefebv/lucida/commit/c41e7cade2777a6fc6fe3071e200307e4d80f9a5))

## [0.3.0](https://github.com/aelefebv/lucida/compare/v0.2.0...v0.3.0) (2026-05-14)


### Features

* **release:** add linked-versions plugin so all packages bump together ([#521](https://github.com/aelefebv/lucida/issues/521)) ([bc9c438](https://github.com/aelefebv/lucida/commit/bc9c438b5cbc6b127e1645acb68507f1ed47fa62))
* **server:** add GET /version endpoint ([#522](https://github.com/aelefebv/lucida/issues/522)) ([0edd588](https://github.com/aelefebv/lucida/commit/0edd588b29b49b689acea943f53f5eb2eacc54c4))


### Bug Fixes

* **docs:** rewrite README to remove stale references + add quick-start paths ([#518](https://github.com/aelefebv/lucida/issues/518)) ([8a94c15](https://github.com/aelefebv/lucida/commit/8a94c152ec7553359456beb66a241f1e8da64656))

## [0.2.0](https://github.com/aelefebv/lucida/compare/v0.1.0...v0.2.0) (2026-05-14)


### Features

* **server:** support --version on the CLI ([#511](https://github.com/aelefebv/lucida/issues/511)) ([94b522a](https://github.com/aelefebv/lucida/commit/94b522a4d57f8836bf2d5cf521a14975ed2aee35))
- feat(tryout): one-command lucida env bring-up for agents (slice 1) (slipway, reversible: git-revert)
- feat(tryout): drive + capture the CLI and Python surfaces (slice 2) (slipway, reversible: git-revert)
- feat(tryout): web client surface — headless + real-SPA screenshots (slice 3) (slipway, reversible: git-revert)
- feat(tryout): unified cross-surface verification report + discoverability (slice 4) (slipway, reversible: git-revert)
- refactor(tryout): unify the surface contract behind one registry + subprocess spine (slipway, reversible: git-revert)
- feat(workspace): personal saved views server foundation (#699) (slipway, reversible: git-revert)
- feat(workspace): personal saved views web UI (#699) (slipway, reversible: git-revert)
- feat(workspace): remember my last view per workspace (#700) (slipway, reversible: git-revert)
- feat(workspace): promote a personal saved view to shared (#699) (slipway, reversible: git-revert)
- feat(workspace): viewer-proposed saved views (#702) (slipway, reversible: git-revert)
- feat(cli,python): saved-view sharing parity — visibility, promote, approve, reject (#699/#702) (slipway, reversible: git-revert)
- docs: note that large datasets are fine for testing (chunked loading) (#815) (slipway, reversible: git-revert)
- fix(web): capture + restore the saved-view Z/T/C plane, clamp to the addressed dataset (#814) (slipway, reversible: git-revert)
- feat(web): saved-view sidebar UX — Shared chip, default-Personal, position-aware names, viewer manages own views, active-row feedback (slipway, reversible: git-revert)
- feat(web): confirm before proposing, withdraw a proposal, and undoable reject (#702 follow-up) (slipway, reversible: git-revert)
- fix(deps): bump vulnerable lockfile deps; drop stray npm lockfile (slipway, reversible: git-revert)
- fix(deps): jsonwebtoken 9 -> 10.3 (auth; fixes exp/nbf type-confusion bypass) (slipway, reversible: git-revert)
- ci(deps): add lucida-py CI job; drop Python 3.9 (clears pytest alert) (slipway, reversible: git-revert)
- fix(deps): lru 0.12 -> 0.16 (lucida-store; clears soundness alert) (slipway, reversible: git-revert)
- fix(deps): force js-yaml 4.2.0 + @babel/core 7.29.6 via pnpm overrides (lucida-web) (slipway, reversible: git-revert)
- build(deps): vite 7 -> 8 (rolldown); drops esbuild — clears last alert (slipway, reversible: git-revert)
- chore: add .gitattributes with CHANGELOG.md merge=union (slipway, reversible: git-revert)
