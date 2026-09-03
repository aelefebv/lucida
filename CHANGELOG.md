# Changelog

## [0.12.0](https://github.com/aelefebv/lucida/compare/v0.11.0...v0.12.0) (2026-09-03)


### ⚠ BREAKING CHANGES

* **server:** the schema is one baseline and no earlier database upgrades into it. sqlx compares the migrations it finds against the ones the database recorded and reports a mismatch, so an existing database has to be replaced with a fresh one rather than migrated.
* **server:** LUCIDA_DB_PATH is removed with no alias. Set LUCIDA_DB_URL instead, so LUCIDA_DB_PATH=/x/y.db becomes LUCIDA_DB_URL=sqlite:///x/y.db. Leaving it unset still opens sqlite://lucida.db, so a default install needs no change. A bare path in the new variable fails startup rather than silently opening the wrong database.

### Features

* **server:** collapse the schema to one baseline ([#973](https://github.com/aelefebv/lucida/issues/973)) ([dd4dcd4](https://github.com/aelefebv/lucida/commit/dd4dcd4c7e4c5f0943c76554b8e1ce67ec36ce57))
* **server:** make PostgreSQL selectable at runtime ([#978](https://github.com/aelefebv/lucida/issues/978)) ([0441e98](https://github.com/aelefebv/lucida/commit/0441e98bb068735457b7f7466c0d93ce5de81301))
* **server:** run the bookmark store on PostgreSQL ([#976](https://github.com/aelefebv/lucida/issues/976)) ([02bc56a](https://github.com/aelefebv/lucida/commit/02bc56aa14081520db38057ec7b1fe78f4b4f5aa))
* **server:** run the pending-authentication store on PostgreSQL ([#974](https://github.com/aelefebv/lucida/issues/974)) ([88fa60b](https://github.com/aelefebv/lucida/commit/88fa60b3e14c2fc23282829096381368b2c5d160))
* **server:** run the remaining authentication stores on PostgreSQL ([#975](https://github.com/aelefebv/lucida/issues/975)) ([1a2e5bd](https://github.com/aelefebv/lucida/commit/1a2e5bdb69741e7874c4ad28efca89aa0c84fbf3))
* **server:** run the workspace store on PostgreSQL ([#977](https://github.com/aelefebv/lucida/issues/977)) ([5af57a8](https://github.com/aelefebv/lucida/commit/5af57a8670caa4c8114c08a390f8ffcf2e5c25a5))
* **server:** select the storage backend from a connection string ([#970](https://github.com/aelefebv/lucida/issues/970)) ([861ca44](https://github.com/aelefebv/lucida/commit/861ca44c9bcbf5e1d73ec068b4b51d9b9e116cf3))

## [0.11.0](https://github.com/aelefebv/lucida/compare/v0.10.0...v0.11.0) (2026-08-28)


### Features

* **cli:** lucida trace drives a headless open and prints the page's diagnostic ([e7b2ba5](https://github.com/aelefebv/lucida/commit/e7b2ba5a884517825fffbd8d4304e720d1701c9d)), closes [#935](https://github.com/aelefebv/lucida/issues/935)
* **monitor:** the monitor page ([00af17a](https://github.com/aelefebv/lucida/commit/00af17af2d9936d65d51313fec790c2468640e41)), closes [#936](https://github.com/aelefebv/lucida/issues/936)
* **monitor:** watch a run while it is still open ([a5009fc](https://github.com/aelefebv/lucida/commit/a5009fc50b4891e982987394afede85694519ab2)), closes [#937](https://github.com/aelefebv/lucida/issues/937)
* **store:** fair-share source-read admission sized by measurement ([7259705](https://github.com/aelefebv/lucida/commit/725970542db42979d21da93395f252dc96dd6417)), closes [#901](https://github.com/aelefebv/lucida/issues/901)
* **store:** name pyramid levels that were never written ([65a36ca](https://github.com/aelefebv/lucida/commit/65a36ca4c652a7007ea570560390290164e7fa29)), closes [#904](https://github.com/aelefebv/lucida/issues/904)
* **trace:** correlation label, server lifecycle table, and the timing batch ([0c191dd](https://github.com/aelefebv/lucida/commit/0c191dda88a328d29f6a9064a8011fff48801019))
* **trace:** declare the reconnect gap and both drop sources ([7422f83](https://github.com/aelefebv/lucida/commit/7422f83ae583a7fdf300f3e52edfbdbbbaac7844)), closes [#932](https://github.com/aelefebv/lucida/issues/932)
* **trace:** derive a diagnostic from a trace, read by both surfaces ([1d8f508](https://github.com/aelefebv/lucida/commit/1d8f508e2863ab458294a269e7647ff26dc646cc))
* **trace:** file dataset-open metadata reads as their own server timing family ([1eb8c27](https://github.com/aelefebv/lucida/commit/1eb8c279233f4786b445e8646941abcc231d3508))
* **trace:** full server phase enum and the leader/follower split ([7981c5a](https://github.com/aelefebv/lucida/commit/7981c5aeb4562df727b35d1a50a8facc7c7b418b))
* **trace:** nest an open's metadata reads inside the browser's open bracket ([4174075](https://github.com/aelefebv/lucida/commit/41740756bcc598b2a9e9efbc016f090222eaf3a6))
* **trace:** per-tick aggregates and point events ([109d288](https://github.com/aelefebv/lucida/commit/109d288e5333b0790b43d0de8b917a81f62f3b53)), closes [#926](https://github.com/aelefebv/lucida/issues/926)
* **trace:** project the trace into Chrome Trace Event JSON for Perfetto ([61b8232](https://github.com/aelefebv/lucida/commit/61b8232b04b71a648267d7fdc288df5709db0b9f))
* **trace:** record the whole browser phase enum, not just the wire ([e193ae3](https://github.com/aelefebv/lucida/commit/e193ae30717ea8689e5199cb0678eaae6e67ff81)), closes [#925](https://github.com/aelefebv/lucida/issues/925)
* **trace:** retention, the truncation record, and the coverage block ([1cd4e32](https://github.com/aelefebv/lucida/commit/1cd4e325d6bd88b95be6d27b31dcb251463d47cc))
* **trace:** trace core, run lifecycle, published quiescent, and the export seam ([387eed8](https://github.com/aelefebv/lucida/commit/387eed8f5cffa9bc590f43edf480c46ca98bd3db)), closes [#924](https://github.com/aelefebv/lucida/issues/924)
* **web:** decouple debug overlays and lift config into Dev controls ([3845282](https://github.com/aelefebv/lucida/commit/3845282b1b097d745df1a3efb18aa0325deba58b)), closes [#917](https://github.com/aelefebv/lucida/issues/917)


### Bug Fixes

* **cli:** make a first-time dataset measurable, and export a page that never renders ([be156d9](https://github.com/aelefebv/lucida/commit/be156d902d56b0002e0b222e15c2bc32a7a5efa7))
* **fetch:** report backlog entries as ageless, not age-zero, in the pending dump ([52ce430](https://github.com/aelefebv/lucida/commit/52ce430f91c7c3a9bff08622a049a65150335bb3)), closes [#900](https://github.com/aelefebv/lucida/issues/900)
* **server:** satisfy the clippy lints new in Rust 1.98 ([2fde43e](https://github.com/aelefebv/lucida/commit/2fde43e4048df006cadbf96c23f4a5373991a4ec))
* **store:** an absent optional metadata object is not a backend error ([42ab50c](https://github.com/aelefebv/lucida/commit/42ab50cd41f338c05844cc37e9e21a64c2398d6c))
* **store:** compare origin-chunk footprints before accusing a level ([dc3876f](https://github.com/aelefebv/lucida/commit/dc3876fe6811354d0dad9fba38eb7a5edcdab535)), closes [#904](https://github.com/aelefebv/lucida/issues/904)
* **store:** read OME attributes from the 0.4-style top-level placement ([054eddd](https://github.com/aelefebv/lucida/commit/054eddd91eca64a45b9df57dde4a62ce503e28b9)), closes [#903](https://github.com/aelefebv/lucida/issues/903)
* **trace:** answer the review of the matched-shape floor comparison ([a94a7c9](https://github.com/aelefebv/lucida/commit/a94a7c963af0a4dfb9c11ace266e986280369aea))
* **trace:** correct the demand basis, the stamp clamp, and the publish path ([ba88f42](https://github.com/aelefebv/lucida/commit/ba88f422472ac06f5b26a2ce9855a02199bd7ab8)), closes [#924](https://github.com/aelefebv/lucida/issues/924)
* **trace:** give the container build the release manifest it stamps ([70173dd](https://github.com/aelefebv/lucida/commit/70173ddcdd07766c3d9a193d716e21c137731c57)), closes [#924](https://github.com/aelefebv/lucida/issues/924)
* **trace:** hold a run open while a dataset open is unsettled ([5c03578](https://github.com/aelefebv/lucida/commit/5c03578950bc8a75ce152e56a7c0409092599820))
* **trace:** let the run settle before export, and label the constructed positions ([fad9d39](https://github.com/aelefebv/lucida/commit/fad9d3956e1798657712f5a8cc35a1a2979192be))
* **trace:** read the residency tier off the chunk, not the store ([c708f18](https://github.com/aelefebv/lucida/commit/c708f185c3bae9fa69603d47fff5e38ce48105bb)), closes [#926](https://github.com/aelefebv/lucida/issues/926)
* **trace:** settle the ledger's per-tick half against a matched tick shape ([a1e088a](https://github.com/aelefebv/lucida/commit/a1e088ad23d94fc73205362b8b9c011d9d14cbba))
* **trace:** teach the diagnose fixtures the reconnect fields ([41e09d0](https://github.com/aelefebv/lucida/commit/41e09d04b565f43bc7bb615b455a885bd459ac7b))
* **web:** replace UploadTelemetry shift() prunes with a ring buffer ([e7e7aae](https://github.com/aelefebv/lucida/commit/e7e7aaec92bc7a91c8dca2cc5c086b560e245310)), closes [#898](https://github.com/aelefebv/lucida/issues/898)
* **web:** stop the capture surface writing user state ([9851cd1](https://github.com/aelefebv/lucida/commit/9851cd17a0a03036cc57c9ffd1c35635a3811269)), closes [#923](https://github.com/aelefebv/lucida/issues/923)


### Performance

* **fetch:** bound the scheduler admission window and derive submit keys once ([4933218](https://github.com/aelefebv/lucida/commit/4933218f7357b5ee8881afe210ac3874a105303f)), closes [#900](https://github.com/aelefebv/lucida/issues/900)
* **store:** read dataset-open metadata through the source cache ([597d48f](https://github.com/aelefebv/lucida/commit/597d48f68b04aa152659228a23ef3cf141f4cba3)), closes [#902](https://github.com/aelefebv/lucida/issues/902)
* **trace:** collapse the recorder's three dispatch writes into one ([71e9bf9](https://github.com/aelefebv/lucida/commit/71e9bf93b20bd75691ca7bf8e0b3ba58d798d279)), closes [#949](https://github.com/aelefebv/lucida/issues/949)


### Refactors

* **cli:** extract the headless browser driver into one module ([620020c](https://github.com/aelefebv/lucida/commit/620020ca91d4bb7394be596caee9f4176e24d3bf)), closes [#922](https://github.com/aelefebv/lucida/issues/922)
* **cli:** fold the CDP call into Page and add with_browser ([a276c5f](https://github.com/aelefebv/lucida/commit/a276c5f7da9047606aab7ccac36152e8355d1ef3)), closes [#922](https://github.com/aelefebv/lucida/issues/922)
* **debug:** delete dead debugStats fields and their write sites ([4d2059a](https://github.com/aelefebv/lucida/commit/4d2059abf34741b2ede94ff4ad53c35cef22d9f2)), closes [#916](https://github.com/aelefebv/lucida/issues/916)
* **debug:** delete DebugPanel.tsx ([c278b3e](https://github.com/aelefebv/lucida/commit/c278b3efc40a79dbb710a9cd4f61ec0634fa0e50)), closes [#919](https://github.com/aelefebv/lucida/issues/919)
* **debug:** delete debugStats.enabled with the recorder's landing ([5df3f1f](https://github.com/aelefebv/lucida/commit/5df3f1f3a78e94e6b1e36ef460e9748c22cb1666)), closes [#918](https://github.com/aelefebv/lucida/issues/918)
* **debug:** drop the cold-state snapshot the gate's removal orphaned ([7acf50b](https://github.com/aelefebv/lucida/commit/7acf50b8a4b22af470f75ca64398b929c5f69d42)), closes [#918](https://github.com/aelefebv/lucida/issues/918)
* **debug:** retire the dead half of debug_lod_info ([8f537c1](https://github.com/aelefebv/lucida/commit/8f537c1522f8b3566f411c5a7eb8623469aa61c0))
* **monitor:** answer the review of the live view ([a225bbd](https://github.com/aelefebv/lucida/commit/a225bbde0051d56cee245708e623b36669bc89f4))
* **store:** resolve the OME attribute scope once per group ([79c4adc](https://github.com/aelefebv/lucida/commit/79c4adcb61d271e12b4687e55e0c8eb18bddb4bf))
* **store:** tighten limiter invariants and correct the sizing docs ([5bb825e](https://github.com/aelefebv/lucida/commit/5bb825e3dbce4aa5736aa1d817d118b66b216b5c)), closes [#901](https://github.com/aelefebv/lucida/issues/901)
* **trace:** address review of the correlation label and timing batch ([f321adb](https://github.com/aelefebv/lucida/commit/f321adb688579ca1aa87b33ebe0a11e972f93eed))
* **trace:** answer the review of the dispatch collapse ([084c269](https://github.com/aelefebv/lucida/commit/084c269a037f65df54eb8d3b9c6ad7e8ac0e23e0))
* **trace:** carry the leader's label and close the row's remainder ([a9acf19](https://github.com/aelefebv/lucida/commit/a9acf198cc7974c84ae522fc2d3562b0629ac61d))
* **trace:** review follow-ups on the metadata-read family ([0e65964](https://github.com/aelefebv/lucida/commit/0e65964c4fdd4e0914157ff7f0085bf7406852f5))
* **trace:** rotate steady state at the cap, and sharpen the coverage words ([5660671](https://github.com/aelefebv/lucida/commit/566067161f5d497e330e3e254b01d60a1cca9097))
* **trace:** speak the glossary's vocabulary in the derivation ([3519caa](https://github.com/aelefebv/lucida/commit/3519caa9af8c98f22653051834f018ceb9f25bf8))
* **trace:** the phase depth renders on the page, and the wait is for a concluded run ([42e5ef0](https://github.com/aelefebv/lucida/commit/42e5ef0306d5b749920b76f5e34cb35f2064a299))
* **trace:** tighten the lane type and the plan-pass boundary ([40ded83](https://github.com/aelefebv/lucida/commit/40ded83169c80c5c0b5fb185bdd2780fa2944098))
* **trace:** tighten the refusal rule and the outage window ([fe0c99f](https://github.com/aelefebv/lucida/commit/fe0c99f83dcc9f7e9fe55e9249d5217950f812a3))
* **web:** address review of the Dev controls lift ([73d7068](https://github.com/aelefebv/lucida/commit/73d7068128a2f0aa470d7de92928a9967e2043a5))
## [0.10.0](https://github.com/aelefebv/lucida/compare/v0.9.0...v0.10.0) (2026-07-13)


### Features

* **camera:** auto-fit the camera to a dataset's extent on open ([f2ac799](https://github.com/aelefebv/lucida/commit/f2ac7999cd4e14058dbacfbc2ebf4f3adf02a14d))
* **camera:** auto-fit the camera to a dataset's full extent on open ([#846](https://github.com/aelefebv/lucida/issues/846)) ([ceb6440](https://github.com/aelefebv/lucida/commit/ceb644092a95d16bc66e3d5f06430eb0a91a1c73))
* **camera:** shared fit-to-bounds framing math for the main camera ([77b4f7e](https://github.com/aelefebv/lucida/commit/77b4f7ee3dd3076b7b2f45d33ee5af0d6fb49822))
* **channels:** collapsible per-channel panels with collapse-all/expand-all (collapsed by default) ([#847](https://github.com/aelefebv/lucida/issues/847)) ([31a8238](https://github.com/aelefebv/lucida/commit/31a82386aeac04ec0dc20adf21bc80fb6c2a3df3))
* **cli:** dataset montage — agent dataset overview ([#838](https://github.com/aelefebv/lucida/issues/838)) ([b0027b9](https://github.com/aelefebv/lucida/commit/b0027b96f857269f3d015255636ff377d0e6de20))
* **collab:** auto-fit a dataset on open only for the client that opened it ([373563a](https://github.com/aelefebv/lucida/commit/373563a4b3adafa22a57d69e06c58b1a209ebbb7))
* **collab:** show peer name + avatar on cursors in peer mode ([#540](https://github.com/aelefebv/lucida/issues/540)) ([92e6829](https://github.com/aelefebv/lucida/commit/92e6829b25c19c6011ee1ec1ea1fc5684e8da437))
* **core:** add incremental delta view_query (entered/left/quantized-change since last query) ([6bc322f](https://github.com/aelefebv/lucida/commit/6bc322f29e6c0b9ac945c18da870528b6c817d8a))
* **explore:** add `dataset explore` CLI command (JSON plan + contact-sheet) ([cbbafc5](https://github.com/aelefebv/lucida/commit/cbbafc560d58f37133c179921ce1865521e9fc1f))
* **explore:** add pure mode-aware view-transform generator (lucida-core) ([afd5833](https://github.com/aelefebv/lucida/commit/afd583393afac607e90ba46634e87cd889229cf9))
* **explore:** enriched mode-aware move-set (elevation/time/channel/projection) ([3559c2d](https://github.com/aelefebv/lucida/commit/3559c2d9ec2dae9b5b3f17312c51aad37e142859))
* **explore:** guided / branching dataset exploration (CLI · Python · web) ([304208a](https://github.com/aelefebv/lucida/commit/304208abf36b3523f771a0083ef0d747567080c3))
* **explore:** Python pyo3 explore surface + shared default-view in lucida-core ([2bf873d](https://github.com/aelefebv/lucida/commit/2bf873d6f0b6c46b385ff3d0b158635ce060142d))
* **explore:** rendered preview thumbnails (contact sheet) in the Explore panel ([a685f27](https://github.com/aelefebv/lucida/commit/a685f277d0118c59186b8d9c3d79f8ce6c785098))
* **explore:** rendered preview thumbnails in the Explore panel ([33eb2d2](https://github.com/aelefebv/lucida/commit/33eb2d2eaa8942bd9975054c1d796665446a2d30))
* **explore:** sidecar parity + web nudge dedup + discoverability + finer back ([ad29c9b](https://github.com/aelefebv/lucida/commit/ad29c9b67e7d0545b4d5fd528087fc3c22b199a4))
* **explore:** web Explore panel + wasm-export the generator ([d694b43](https://github.com/aelefebv/lucida/commit/d694b43ef8707f272a612fab37d0b71467d0c2c5))
* interactive per-label visibility and opacity controls for OME-Zarr labels ([7870f0c](https://github.com/aelefebv/lucida/commit/7870f0c36753aa11a3c89d3e24576685f76a7318))
* OME-Zarr label (segmentation) overlays — colored 2D + 3D with per-label opacity ([e698535](https://github.com/aelefebv/lucida/commit/e698535e33ba837e57c5f3214e01e6418cd4e4b0))
* parse OME-Zarr labels and attach them to their source image ([ab3c68f](https://github.com/aelefebv/lucida/commit/ab3c68f4c985658f8ac5c5599a8078ba73a1e49c))
* **protocol:** scale dataset-open payloads with structure, not tile count ([f4f3382](https://github.com/aelefebv/lucida/commit/f4f3382b5fe747b3016dda0436c1a55cacd9fc65))
* **protocol:** version-mark compact dataset-open payloads and bound decode expansion ([f22aaa3](https://github.com/aelefebv/lucida/commit/f22aaa3b78004ebb0fad1b0686525d2149112240))
* render OME-Zarr label overlays in 2D (colored, adjustable opacity, aligned) ([8d05451](https://github.com/aelefebv/lucida/commit/8d05451b437548fcede25e9d70380dcc7cb5e8da))
* render OME-Zarr label overlays in 3D (volume view) ([b15907f](https://github.com/aelefebv/lucida/commit/b15907fb25c446df7fa9e4f5fc6e5806dc12bab0))
* seq-gap detection and snapshot resync for the collaborative document protocol (lucida-dah) ([43016fb](https://github.com/aelefebv/lucida/commit/43016fbfaa641dc7289d9954b0d5ebe7b3ef386c))
* show OME channel names in the LayerPanel + let users rename channels ([#845](https://github.com/aelefebv/lucida/issues/845)) ([edc595f](https://github.com/aelefebv/lucida/commit/edc595f9cbe8fb4a203b8eea0330f815b077c774))
* **viewer:** configurable 3D chunk-spawn focal depth ([#532](https://github.com/aelefebv/lucida/issues/532)) ([54ebdc4](https://github.com/aelefebv/lucida/commit/54ebdc43e40bcc116d44ab3bac83ecac2aed239b))
* **web:** default label masks to hidden; opt-in per mask ([c3703e9](https://github.com/aelefebv/lucida/commit/c3703e9bf0b27d13b2ace2272c1f5f33e45b2347))
* **web:** default the Explore panel to closed ([da34a48](https://github.com/aelefebv/lucida/commit/da34a488710988547c8ae6a1137a85aeaa3c726a))
* **web:** durable collection-import warning banner + tolerate an unreadable representative tile ([d7625d6](https://github.com/aelefebv/lucida/commit/d7625d60eccb8af537d40b5dddd2dade1e1413f2))
* **web:** fold the Rust view_query delta into the planning snapshot (O(delta) camera-move rebuild, coarseDetail-gated) ([f177e9c](https://github.com/aelefebv/lucida/commit/f177e9c5e05ba7ba6a5755d27b232fdead746cec))
* **web:** render 3D label overlays from a bricked r32uint atlas (nearest across bricks) ([0221285](https://github.com/aelefebv/lucida/commit/0221285b7c53d501a93feb7732018b299243abf2))
* **web:** render large 3D labels via a bricked r32uint atlas (nearest across bricks) ([717d900](https://github.com/aelefebv/lucida/commit/717d900d0024b4862c91e00acbe8220d9e642176))
* **web:** render large per-axis 3D labels via bricking; budget labels by their actual bricked allocation ([5890309](https://github.com/aelefebv/lucida/commit/5890309461d266408e8ddd988380c8986fa26642))
* **web:** show every drawable label by default with per-label on/off overrides (explicit off honored); cap visible 3D masks to a memory budget ([621264c](https://github.com/aelefebv/lucida/commit/621264c5d654a151e4df9915e1d0eb6175c79b3c))
* **web:** surface collection-import warnings in a durable, dismissible banner ([c56230a](https://github.com/aelefebv/lucida/commit/c56230add5ce73c4d092ea466aad961beac58d7a))
* **workspace:** create a workspace directly from a dataset ([#697](https://github.com/aelefebv/lucida/issues/697)) ([35587ba](https://github.com/aelefebv/lucida/commit/35587babab8339acaa1ef3d05ecaa2e8af3e00c7))
* **workspace:** duplicate a workspace without transferring permissions ([#698](https://github.com/aelefebv/lucida/issues/698)) ([d0e73c6](https://github.com/aelefebv/lucida/commit/d0e73c6645e57f4ce9c210bb19695e22ef9c147a))
* **workspace:** editable dataset display names via a collaborative rename command ([#701](https://github.com/aelefebv/lucida/issues/701)) ([bc07308](https://github.com/aelefebv/lucida/commit/bc07308210913a560892a7b07a348c87852c5020))


### Bug Fixes

* **ci:** pin wasm-pack and de-flake shuffled web tests ([bd8444e](https://github.com/aelefebv/lucida/commit/bd8444ebcd15bf1ff6bf53151e82208fdce14018))
* **cli:** keep collected warnings when a dataset open fails ([82557f4](https://github.com/aelefebv/lucida/commit/82557f43bc78990f86c992134fe76f14b9eeca59))
* **cli:** print import warnings after a dataset open ([a3675db](https://github.com/aelefebv/lucida/commit/a3675db2bd7ec9e0b02af4015fbdf85f9f956452))
* **content:** lowercase URI schemes in the canonical dataset URL form ([dd469eb](https://github.com/aelefebv/lucida/commit/dd469eb52814750a3f0ce37ba611ac5b6d0f239c))
* **core:** clear all dataset-id-keyed fields on remove_dataset; unify the traversal ([4815d34](https://github.com/aelefebv/lucida/commit/4815d34a38c2b2b0c170347c1f2436bdcefd9f57))
* place plate label overlays on their own well in 2D ([1f144f9](https://github.com/aelefebv/lucida/commit/1f144f9132ed480bcd83b1a5c5d353b07a77fdcf))
* report source-chunk store failures to the requesting client ([7843dbf](https://github.com/aelefebv/lucida/commit/7843dbf69f16b5df43f1efac33592f747392cbe5))
* **server:** blosc decoder — non-filter-aligned and raw-stored blocks ([#839](https://github.com/aelefebv/lucida/issues/839)) ([8ceab1b](https://github.com/aelefebv/lucida/commit/8ceab1b19b8b6c83816cd1d699c503eee01d143e))
* **server:** bounded single-flight source reads with fail-fast retries; client self-heals throttled tiles (569) ([789a72a](https://github.com/aelefebv/lucida/commit/789a72a97220b0386ffb30a5e4ca7027805c33bb))
* **server:** enforce saved-view visibility transition allow-list ([#817](https://github.com/aelefebv/lucida/issues/817)) ([b6321d9](https://github.com/aelefebv/lucida/commit/b6321d9e69eb92d0b49c82b3e108cc2cb3ec1d20))
* **store:** allow plain-http object stores ([81bdc49](https://github.com/aelefebv/lucida/commit/81bdc49bae97bb1158fdd611dfab5f5cb73d410d))
* **store:** bound anomaly-driven label expansion and surface unusable indexes ([89adc50](https://github.com/aelefebv/lucida/commit/89adc50d0899e2e7fe7a13dfbe75633c0b073536))
* **store:** charge the unusable-expansion cap only when expansion adds reads ([fe9dbf9](https://github.com/aelefebv/lucida/commit/fe9dbf946069f22f7aa924bd779b89f99da85df4))
* **store:** harden sampled label discovery ([998fa68](https://github.com/aelefebv/lucida/commit/998fa68ce30e33019f8e7acad262ccaa6f45ea9a))
* **store:** tolerate an unreadable representative tile when opening a collection ([8f42944](https://github.com/aelefebv/lucida/commit/8f42944c639f3c24d83d97e84f2ea3f0812610e1))
* tear down the web session stack on workspace unmount (lucida-pke) ([e207263](https://github.com/aelefebv/lucida/commit/e20726366d507db7dcbd79a1f5efa076366de73e))
* uniform label overlay opacity (normalize declared image-label.colors alpha) ([cc4fa0a](https://github.com/aelefebv/lucida/commit/cc4fa0a9e5fffceb569073d3ddad5bdb3140a800))
* **viewer:** 2D minimap colormap + live annotation draw + 3D annotation context ([#837](https://github.com/aelefebv/lucida/issues/837)) ([3982f9b](https://github.com/aelefebv/lucida/commit/3982f9ba741278771773da56631a14dfe676988b))
* **viewer:** frame the minimap to visible datasets only ([#836](https://github.com/aelefebv/lucida/issues/836)) ([e3cb977](https://github.com/aelefebv/lucida/commit/e3cb977ff28292f6698906bca525e5de79219a8e))
* **viewer:** render minimap overview with the active channel's contrast ([#835](https://github.com/aelefebv/lucida/issues/835)) ([f8e776e](https://github.com/aelefebv/lucida/commit/f8e776ed1806a17637ecc7294b0c77e4884b10f1))
* **web:** back-fill missing per-label settings as hidden so an unrelated gesture never reveals an untouched label (gmt) ([994e15e](https://github.com/aelefebv/lucida/commit/994e15eebf06ae3de5ca4ea5f3fbcfb2f6b737c2))
* **web:** boot wasm once per page and surface fatal viewer/data failures ([1b42712](https://github.com/aelefebv/lucida/commit/1b42712867f34e2bf17f15171c7db68b9a58e410))
* **web:** cancel a departed entity's in-flight per-tile proxy fetch to free its shared scheduler slot ([4927325](https://github.com/aelefebv/lucida/commit/49273252b7d1ebf1c3c70862a57de7f94dc5fa42))
* **web:** clamp the total label-volume budget to at least the per-texture cap so a drawable mask is never dropped (never-blank invariant) ([0b508ae](https://github.com/aelefebv/lucida/commit/0b508ae9a6c84cb682ddfb47ebfc5b6dc9f9c404))
* **web:** class and recover the viewer's visible error surface ([041b320](https://github.com/aelefebv/lucida/commit/041b320ac50e45e9c7fca3794301d8bceec0eed4))
* **web:** free fetch slots when entities scroll out of view so the current view isn't starved (6k0) ([4a9eab2](https://github.com/aelefebv/lucida/commit/4a9eab2769eb030b29baafcbeb753b78e1d84a83))
* **web:** give the 2D label-slice pool datasetId-scoped cleanup and an alloc-failure guard, mirroring the 3D volume pool (0h9, l6j) ([9d9bf6c](https://github.com/aelefebv/lucida/commit/9d9bf6c636993242aecaca22041329fbe521e88e))
* **web:** hold the member-pass cap exactly and cull zero-extent members ([2a3bc76](https://github.com/aelefebv/lucida/commit/2a3bc76696972ce4348548d402368f839137626a))
* **web:** keep view lanes ahead of bulk minimap seeding, deliver dual-lane arrivals ([dcdd82f](https://github.com/aelefebv/lucida/commit/dcdd82fc3bfdc9a491606a1e0a9f33468fd2864a))
* **web:** make the labels panel view-mode-aware and never open blank when a label is drawable (skr, 5rc) ([25b5444](https://github.com/aelefebv/lucida/commit/25b5444b5d0877335c9fb6272fe24b4133747023))
* **web:** minimap volume fly-camera look-around refreshes the frustum overlay instead of freezing it ([0acfbc2](https://github.com/aelefebv/lucida/commit/0acfbc2834b5fb210ccf0882d7b561a42effad93))
* **web:** rank bulk minimap seeding behind the plan's actual priorities ([a6bc7dd](https://github.com/aelefebv/lucida/commit/a6bc7dd2d4c45e78bad03bb6d14b2e9378cb731b))
* **web:** re-fetch transiently-failed chunks on pan/scrub instead of leaving them dark (gzn) ([d7a9571](https://github.com/aelefebv/lucida/commit/d7a9571e0023bf1210412aad09274d70f218b8ba))
* **web:** reachable Undo for every pending saved-view reject; fix stale active-row highlight ([#818](https://github.com/aelefebv/lucida/issues/818)) ([58d4afb](https://github.com/aelefebv/lucida/commit/58d4afb4b8328220c085e1b4dc562ba0db40e183))
* **web:** render slice aggregates from live residency, one draw per pool set ([f0d5aed](https://github.com/aelefebv/lucida/commit/f0d5aed19ca4382bff063ca52d642b77c9a75de6))
* **web:** report real upload budget, slice upload time, and live member sent counts ([25194a9](https://github.com/aelefebv/lucida/commit/25194a93af8feec6a8581712c0bfc8392901b69e))
* **web:** restore per-label view settings by name, occurrence-aware, after the label list changes (8q6, dk4) ([72544ca](https://github.com/aelefebv/lucida/commit/72544ca1f6bd1f913666e9797a3934526f681f46))
* **web:** route every fetch-settle completion through one settleFetch + per-key FailureRecord ([2cdb585](https://github.com/aelefebv/lucida/commit/2cdb585cdabcb5cd8a46f49b54eadc59163a3698))
* **web:** share one wasm instantiation across concurrent mounts ([8b8ff00](https://github.com/aelefebv/lucida/commit/8b8ff0056147b808add8a441fb847741af9a3814))
* **web:** surface fatal scene-apply and chunk-fetch failure streaks ([acb1d28](https://github.com/aelefebv/lucida/commit/acb1d28bfb12f67bc5fff5c43bbba2d9b4c9e81b))
* **web:** surface persistently-failing remote sources via the failure streak while throttled tiles self-heal (7k4) ([7c27c3d](https://github.com/aelefebv/lucida/commit/7c27c3d4b8725b2604c87ff70a2efde034343634))
* **web:** unify fetch-settle completion + cancel departed-entity in-flight proxy fetches ([8fe522c](https://github.com/aelefebv/lucida/commit/8fe522cda0ff512ba0cdf63647d9579f11761668))


### Performance

* **core,web:** O(delta) camera-move rebuild via a Rust delta view_query (closes the 2D stutter) ([b94c47e](https://github.com/aelefebv/lucida/commit/b94c47e0d848687a99455cae621cd534b9a61f21))
* make wide-collection member lookups and layout resolution hash-indexed ([2b5b008](https://github.com/aelefebv/lucida/commit/2b5b008e524abbd7d752e58ae75a98ba742f07e9))
* open and view wide remote collections fast and reliably ([633e1c8](https://github.com/aelefebv/lucida/commit/633e1c869624d7d95d0dc3372f179961095f6d02))
* parallelize OME-Zarr plate import metadata fetches and tolerate unreadable wells (lucida-te7) ([8230851](https://github.com/aelefebv/lucida/commit/82308519f18076d6e39aaadbc92dc907bd3c89a1))
* **store:** scale collection label discovery with groups, not tiles ([9c974c2](https://github.com/aelefebv/lucida/commit/9c974c264c454c19e1dac3b6ea5b7238a5ed8686))
* **web:** bound slice render passes by a screen budget, not member count ([4f74be8](https://github.com/aelefebv/lucida/commit/4f74be8d1542be469ebf8b36c3d0fdf7b91bfa56))
* **web:** cache the minimap overview across camera-only moves on large collections ([0028937](https://github.com/aelefebv/lucida/commit/0028937157a080a9f3bdfd3aa863a21b47b8eeb4))
* **web:** cap per-member debug rows and report uncapped totals ([22a8ce0](https://github.com/aelefebv/lucida/commit/22a8ce0cfc4654b5ec62a8877cb23985dd5ddbe6))
* **web:** coalesce the per-frame cold-state rebuild so interaction stays smooth on large collections ([9f9c2d0](https://github.com/aelefebv/lucida/commit/9f9c2d09072813091fdb652df8b07a61a4e0d429))
* **web:** cut minimap per-move cost on 2D pan/zoom and 3D orbit; fix fly-camera frustum freeze ([8cf5085](https://github.com/aelefebv/lucida/commit/8cf5085c9c05ede7a8badc50fbeb2f84377741ff))
* **web:** eliminate periodic interaction stutter during T/Z scrub and 2D pan/zoom ([93bed25](https://github.com/aelefebv/lucida/commit/93bed253eaa81a2b2506c8a8b373878ea4928bc2))
* **web:** make pan/zoom/orbit view moves cheaper via an incremental cold-state delta + matrix reuse ([8c92f12](https://github.com/aelefebv/lucida/commit/8c92f1247d055953bf752831f19529e8ed62ffa5))
* **web:** make pure T/Z scrub cheap — skip the O(N) cold-state rebuild + resend ([6fa74ff](https://github.com/aelefebv/lucida/commit/6fa74ffab88abf8f5279b7dc480a051e4b3b768c))
* **web:** minimap 2D pan/zoom reuses a cached Z-plane overlay layer instead of re-stroking every member slice plane ([b78203e](https://github.com/aelefebv/lucida/commit/b78203e30431e7380b25be8c882d0fe83557ddb8))
* **web:** render display-only edits (contrast/gamma/colormap) without a full O(N) rebuild ([0d7ffff](https://github.com/aelefebv/lucida/commit/0d7ffffa855eb9a1d8a4ed5322f1ca77d82f6b8c))
* **web:** reuse cached minimap geometry on a 3D orbit instead of re-reading every member per frame ([79c602f](https://github.com/aelefebv/lucida/commit/79c602f82e647e750bbcd8d724e5fcb49018a7ae))
* **web:** reuse camera-independent planning-snapshot inputs across view replans ([6acec62](https://github.com/aelefebv/lucida/commit/6acec623c5f4a33a6e10075fa05cf4292f899977))
* **web:** reuse camera-independent planning-snapshot inputs across view replans ([635423c](https://github.com/aelefebv/lucida/commit/635423c83765cd29c506e489b66dca0620784976))
* **web:** snapshot the cpu cache at most once per plan rebuild ([574421f](https://github.com/aelefebv/lucida/commit/574421f4eb98393d703c7e6a89c4874874e39b00))
* **web:** throttle the minimap overview seed-scan to bound per-move CPU on large collections ([103b928](https://github.com/aelefebv/lucida/commit/103b92827ef194091240e1b40534b8e9e0c96867))
* **web:** throttle the minimap overview seed-scan to bound per-move CPU on large collections ([bab9697](https://github.com/aelefebv/lucida/commit/bab969785e4fcfe083e42e301bb18d9847eca26f))
* **web:** update the minimap overview's display in place on contrast/gamma/colormap edits instead of re-reading every member ([df45c30](https://github.com/aelefebv/lucida/commit/df45c307396a0326c2f2df482e9557eaa66173c7))
* **web:** wide collections render fast at any devicePixelRatio (overview aggregation) ([c020a17](https://github.com/aelefebv/lucida/commit/c020a1749cf96c8533d4ed76252b2f6397c0219a))


### Refactors

* collapse wasm.rs setters onto Scene::apply with a scoped diff-based epoch policy (lucida-i31) ([f8da770](https://github.com/aelefebv/lucida/commit/f8da7708fda72acc86006c0ccd89f5cdbecfcf55))
* **core:** single-source member world-placement via rendering_transform ([119cd20](https://github.com/aelefebv/lucida/commit/119cd20937706ad0d9d330a8226dc47312bc7600))
* debug tooling separated from production - lazy chunks, cached log gate, dev-gated control surface (lucida-s6m) ([5846137](https://github.com/aelefebv/lucida/commit/5846137c40f0460dab7c94a69dc06c2ddf0f6c41))
* final domain-neutral sweep (extras, scripts, layout name, wiki filenames) ([9ebbaaa](https://github.com/aelefebv/lucida/commit/9ebbaaaecca55708be784370dcb4458d6698e1c5))
* headless dataset-open service and single-layer command authorization (lucida-ce7) ([7bbcb19](https://github.com/aelefebv/lucida/commit/7bbcb19b631c503608ee5bd1ffa91176122924c9))
* intent-named invalidation notifiers replace hand-tapped change signals; first App wiring tests (lucida-0hm) ([46992b5](https://github.com/aelefebv/lucida/commit/46992b549c47302f205f80bae3cb22e3bc0ba2ce))
* non-React session controller owns the web session; useBridge becomes a thin adapter (lucida-wxu) ([e30a2c2](https://github.com/aelefebv/lucida/commit/e30a2c2e573b66dca69025faa435e3cfbf8bb2cd))
* one shared home for annotation overlay logic across 2D and 3D; comment badge ported to 3D (lucida-4ne) ([6e9691c](https://github.com/aelefebv/lucida/commit/6e9691ced52a21ea83cd25acd1fcc94e3635affe))
* one shared session and http layer for the CLI noun modules (lucida-nd0) ([edb171b](https://github.com/aelefebv/lucida/commit/edb171b8c6d2e59e5c714502aaba1fae9a5a2854))
* rename Plate dataset kind to Collection (neutral container vocabulary) ([7cd929e](https://github.com/aelefebv/lucida/commit/7cd929ee29a7d5064215aa6d024ff3ed8b03d037))
* rename positioning mode to Explicit/Derived (neutral, drop stage vocabulary) ([1be0bca](https://github.com/aelefebv/lucida/commit/1be0bca57429ce96b41cd12ac0b79b24291b0a00))
* rename well/field entities to group/tile (neutral member vocabulary) ([2a4d883](https://github.com/aelefebv/lucida/commit/2a4d883c0f40ecd9c9c7d0db0ed8406dea70c905))
* replace biology proper-nouns in fixtures with neutral labels ([9b794a0](https://github.com/aelefebv/lucida/commit/9b794a01ccb6a7026413016b85f590e6b217a68d))
* single always-compiled source for placement correction; wasm placement queries become delegates (lucida-q0x) ([40db1f6](https://github.com/aelefebv/lucida/commit/40db1f65701429bfe8a1bb473483dd861bdd1ccc))
* split lucida-server workspace.rs into a layered workspace/ module (lucida-mi7) ([9d9d96b](https://github.com/aelefebv/lucida/commit/9d9d96bfc6c0d199392f2b97585ee3e8285041f0))
* typed TS command vocabulary with a real-wasm apply_command lock (lucida-8ci) ([4450448](https://github.com/aelefebv/lucida/commit/445044886e1deda317184a69d515ce3349c6841e))
* **web:** remove dead BookmarkSidebar component ([#819](https://github.com/aelefebv/lucida/issues/819)) ([c2f1463](https://github.com/aelefebv/lucida/commit/c2f1463478ca41906980104a3dde54490616c411))

## [0.9.0](https://github.com/aelefebv/lucida/compare/v0.8.0...v0.9.0) (2026-06-23)


### Features

* **annotations:** capture the author's view when an annotation is created ([8729aea](https://github.com/aelefebv/lucida/commit/8729aea515a59fe8a898222c9bffb3f73a77250c))
* **annotations:** capture, restore, and share a view per annotation ([7551901](https://github.com/aelefebv/lucida/commit/7551901a0110e81f3c1a3091ae09758021d8a892))
* **annotations:** restore the author's view when navigating to an annotation ([188d364](https://github.com/aelefebv/lucida/commit/188d36406827eabb8fbec119aa8fe869d2cb16e4))
* **annotations:** share an annotation by link (deep-link, never-leak) ([4806ff0](https://github.com/aelefebv/lucida/commit/4806ff020808b481eefec70b8f16dc3b9f1a289b))
* **cli,python:** saved-view sharing parity — visibility, promote, approve, reject ([#699](https://github.com/aelefebv/lucida/issues/699)/[#702](https://github.com/aelefebv/lucida/issues/702)) ([b606363](https://github.com/aelefebv/lucida/commit/b606363c939d23cdc8c83342ad581ca7d16fcea7))
* **web:** confirm before proposing, withdraw a proposal, and undoable reject ([#702](https://github.com/aelefebv/lucida/issues/702) follow-up) ([7c820a2](https://github.com/aelefebv/lucida/commit/7c820a204e84149ed1581f87abb82b18ff94a89e))
* **web:** saved-view sidebar UX — Shared chip, default-Personal, position-aware names, viewer manages own views, active-row feedback ([d80e1a7](https://github.com/aelefebv/lucida/commit/d80e1a7e05593e1117352a434451b4b3d9f7a4ee))


### Bug Fixes

* **deps:** bump vulnerable lockfile deps; drop stray npm lockfile ([e7dbdcf](https://github.com/aelefebv/lucida/commit/e7dbdcf60fdd8ef5c080e045bf508725d34b8317))
* **deps:** bump vulnerable lockfile deps; drop stray npm lockfile ([be17f9d](https://github.com/aelefebv/lucida/commit/be17f9d6f7649c0a635a70770e42c17a2413ae61))
* **deps:** force js-yaml 4.2.0 + @babel/core 7.29.6 via pnpm overrides (lucida-web) ([65b92dd](https://github.com/aelefebv/lucida/commit/65b92dd29f876b5eea53b20c20727f5d17c79dd0))
* **deps:** js-yaml 4.2.0 + @babel/core 7.29.6 via pnpm overrides (lucida-web) ([37df216](https://github.com/aelefebv/lucida/commit/37df216c0e061a8aa1e65b54401b46f62e1cb28c))
* **deps:** jsonwebtoken 9 -&gt; 10.3 (auth; aws_lc_rs backend) ([eb5d988](https://github.com/aelefebv/lucida/commit/eb5d988363a628d97d5e45c3f7d213400cc1625e))
* **deps:** jsonwebtoken 9 -&gt; 10.3 (auth; fixes exp/nbf type-confusion bypass) ([6c60172](https://github.com/aelefebv/lucida/commit/6c601729ef6488563317f59d7aff191785f3efea))
* **deps:** lru 0.12 -&gt; 0.16 (lucida-store; clears soundness alert) ([1d01db4](https://github.com/aelefebv/lucida/commit/1d01db490543b91645b42f8efd7ec1179a787566))
* **deps:** lru 0.12 -&gt; 0.16 (lucida-store) ([81537d9](https://github.com/aelefebv/lucida/commit/81537d9634493eebb2ded7794d1ce10520090ba6))
* **deps:** pyo3 0.24 -&gt; 0.29 (fixes PyList/PyTuple iterator OOB read) ([8b2ec93](https://github.com/aelefebv/lucida/commit/8b2ec935c6667b9309b5f2767e26050bfaeb55eb))
* **deps:** pyo3 0.24 -&gt; 0.29 (python binding) ([e79574b](https://github.com/aelefebv/lucida/commit/e79574b822d4867b296e2f79b2969eacd8b5e072))
* **docker:** pin rust-builder to bookworm (glibc match) ([953d63b](https://github.com/aelefebv/lucida/commit/953d63b4297d39f0f9de226788b96f5656469c99))
* **docker:** pin rust-builder to bookworm so the binary's glibc matches the runtime ([b84f8bd](https://github.com/aelefebv/lucida/commit/b84f8bd1a8ec6e08db75d5c897ae6591c74e34c9))
* **web:** capture + restore the saved-view Z/T/C plane, clamp to the addressed dataset ([#814](https://github.com/aelefebv/lucida/issues/814)) ([ec5d76d](https://github.com/aelefebv/lucida/commit/ec5d76d19cf2e362403f70e6dbebc3a0447c45a6))
* **web:** clamp saved-view Z/T/C to the deepest visible dataset, not the shallowest ([#814](https://github.com/aelefebv/lucida/issues/814)) ([7d5cdac](https://github.com/aelefebv/lucida/commit/7d5cdac364d1d60dacd72b1079940feef2079964))

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
- feat(annotations): capture the author's view when an annotation is created (slipway, reversible: git-revert)
- feat(annotations): restore the author's view when navigating to an annotation (slipway, reversible: git-revert)
- feat(annotations): share an annotation by link (deep-link, never-leak) (slipway, reversible: git-revert)
- fix(docker): pin rust-builder to bookworm so the binary's glibc matches the runtime (slipway, reversible: git-revert)
- refactor(web): remove dead BookmarkSidebar component (#819) (slipway, reversible: git-revert)
- fix(server): enforce saved-view visibility transition allow-list (#817) (slipway, reversible: git-revert)
- fix(web): reachable Undo for every pending saved-view reject; fix stale active-row highlight (#818) (slipway, reversible: git-revert)
- feat(workspace): editable dataset display names via a collaborative rename command (#701) (slipway, reversible: git-revert)
- feat(workspace): create a workspace directly from a dataset (#697) (slipway, reversible: git-revert)
- feat(workspace): duplicate a workspace without transferring permissions (#698) (slipway, reversible: git-revert)
- feat(collab): show peer name + avatar on cursors in peer mode (#540) (slipway, reversible: git-revert)
- feat(viewer): configurable 3D chunk-spawn focal depth (#532) (slipway, reversible: git-revert)
- fix(core): clear all dataset-id-keyed fields on remove_dataset; unify the traversal (slipway, reversible: git-revert)
- fix(server): decode blosc non-filter-aligned trailing blocks (slipway, reversible: git-revert)
- fix(server): decode blosc per-block raw-stored (uncompressed) blocks (slipway, reversible: git-revert)
- refactor(core): single-source member world-placement via rendering_transform (slipway, reversible: git-revert)
- feat(collab): auto-fit a dataset on open only for the client that opened it (slipway, reversible: git-revert)
- feat(explore): add pure mode-aware view-transform generator (lucida-core) (slipway, reversible: git-revert)
- feat(explore): add `dataset explore` CLI command (JSON plan + contact-sheet) (slipway, reversible: git-revert)
- feat(explore): Python pyo3 explore surface + shared default-view in lucida-core (slipway, reversible: git-revert)
- feat(explore): web Explore panel + wasm-export the generator (slipway, reversible: git-revert)
- feat(explore): enriched mode-aware move-set (elevation/time/channel/projection) (slipway, reversible: git-revert)
- feat(explore): rendered preview thumbnails in the Explore panel (slipway, reversible: git-revert)
