# lucida-protocol Glossary

**ClientFetchDescriptor** -- How a client turns logical chunk addresses into bytes. Enum: Proxied, Direct, Local.

**ProxiedFetchDescriptor** -- Server-proxied mode. Client sends chunk keys, server returns bytes. No storage addressing exposed.

**DirectFetchDescriptor** -- Client resolves storage paths itself. Needs level paths and store prefix. Future.

**LocalFetchDescriptor** -- Local filesystem access. Same addressing as Direct. Used by Python headless.

**WireFormat** -- Byte encoding of chunk responses: Raw (decompressed), Lz4, Zstd. Each carries a DataType.

**RegisterDataset** -- Application-level registration message. Carries ContentGraph + ClientFetchDescriptor. No server-private state.

**LevelAddress** -- Maps a level index to its on-disk path string.
