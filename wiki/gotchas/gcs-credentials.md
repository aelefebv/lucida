---
created: 2026-05-14
modified: 2026-05-14
---

# `object_store::gcp` credential discovery is incomplete vs. Google's full ADC contract

A user trying to open a `gs://` dataset from `docker run` (or any non-laptop, non-GKE environment) will set `GOOGLE_APPLICATION_CREDENTIALS=/gcp/adc.json` — Google's standard ADC env var, used by every Google SDK and tutorial — and reasonably expect that to "just work." It almost did, and didn't, for a long time. This page captures why, and what lucida does about it.

## The footgun

`object_store::gcp::GoogleCloudStorageBuilder::from_env()` is the natural-looking constructor for "read GCS credentials from the environment." It mirrors the S3 line's `AmazonS3Builder::from_env()`. But its env-var coverage is **deliberately narrow**: it reads object_store's own `GOOGLE_SERVICE_ACCOUNT` / `GOOGLE_SERVICE_ACCOUNT_PATH` / `GOOGLE_SERVICE_ACCOUNT_KEY` (and `GOOGLE_BUCKET*`), but its handling of `GOOGLE_APPLICATION_CREDENTIALS` has historically been unreliable enough that lucida cannot rely on it.

When neither object_store-native env var is set, the builder falls through to:

1. The well-known ADC file at `$HOME/.config/gcloud/application_default_credentials.json`.
2. The GCE metadata server at `169.254.169.254`.

The metadata-server fallback is intentional — it's how Workload Identity on GKE provisions credentials. But off-cluster (most laptops, any non-GKE deploy), the metadata server is unreachable, and object_store retries it ~10 times over ~13 seconds before surfacing a confusing error:

> `storage error: Generic GCS error: Error performing token request to 169.254.169.254 ... in 13.3s, after 10 retries, max_retries: 10, retry_timeout: 180s`

The user's bind-mounted ADC JSON sits unused. They give up, mount the file at the obscure container `$HOME` path (`/root/.config/gcloud/application_default_credentials.json`), and it works — but only after burning 13 seconds per attempt learning it.

## What lucida does

The `gs://` arm of `lucida-store::backend::open` (see [[lucida-store]]) constructs the GCS client as: `GoogleCloudStorageBuilder::from_env().with_bucket_name(bucket)`, then explicitly forwards a non-empty `GOOGLE_APPLICATION_CREDENTIALS` via `.with_application_credentials(...)`. The explicit forward is a belt-and-suspenders guarantee that Google's standard ADC env always reaches the builder — independent of object_store version drift.

Effective credential discovery order after the lucida wrapper:

1. **`GOOGLE_SERVICE_ACCOUNT*`** — object_store-native (read by `from_env`). Use this if you already export these for other tools in your stack.
2. **`GOOGLE_APPLICATION_CREDENTIALS`** — Google's standard ADC env. Lucida forwards it explicitly. Accepts both service-account JSON keys and user-credentials JSON (the file `gcloud auth application-default login` writes).
3. **Well-known ADC file** at `$HOME/.config/gcloud/application_default_credentials.json` — read by object_store when no explicit credentials are provided.
4. **GCE metadata server** — for Workload Identity on GKE and GCE instance default service accounts. Hangs ~13s before erroring off-cluster (unchanged — this is the intentional WI path).

## Remediation one-liners

**Bare binary on a dev laptop** with `gcloud auth application-default login` already done — zero config, the well-known ADC file is read automatically because `$HOME` resolves to your actual home:

`cargo run -p lucida-server`

**`docker run`** with the host's ADC file bind-mounted:

```
-e GOOGLE_APPLICATION_CREDENTIALS=/gcp/adc.json \
-v "$HOME/.config/gcloud/application_default_credentials.json:/gcp/adc.json:ro"
```

**Self-hosted (non-GKE)** with a service-account JSON file. Drop the file somewhere the deployment owns and set the env var to its absolute path:

`LUCIDA_*=... GOOGLE_APPLICATION_CREDENTIALS=/srv/lucida-sa.json lucida-server`

**GKE Workload Identity** — annotate the KSA with the GSA email; metadata server provides credentials. No env config required. See [`extras/deploy/RUNBOOK.md`](../../extras/deploy/RUNBOOK.md) §5.

## Why not surface the failure faster?

A probe at `open()` time (e.g. `HEAD` against `metadata.google.internal` with a short timeout) would let lucida fail-fast off-cluster instead of hanging 13s. Considered and rejected in PRD #541: false positives during transient GCE conditions (in-cluster but metadata briefly unreachable) would be worse than the hang, and the natural-env-var support plus the README "Reading from `gs://`" block address the same UX pain at the source.

## Why no `LUCIDA_GCS_*` env vars?

Cloud-vendor SDK passthrough preserves the cloud vendor's standard env vars. The S3 arm inherits `AWS_*` directly via `AmazonS3Builder::from_env()`; the GCS arm inherits `GOOGLE_*` the same way. Wrapping these in a `LUCIDA_GCS_*` namespace would invent a dialect that adds nothing and breaks anyone running `gcloud` and lucida together. See [[oss-config-defaults]] for the broader env-var-contract posture.

## Public-bucket reads

Anonymous `gs://` access (`with_skip_signature(true)` on the object_store side) is **not currently surfaced** by lucida. If a concrete public-bucket use case lands, a future PRD can add an env knob, a `gs+anon://...` URL scheme hint, or a 401-then-retry autodetect. Until then, anonymous reads return the same "credentials required" error any signed call would.

## Related

- [[lucida-store]] — backend.rs URL routing and the credential-discovery wrapper.
- [[oss-config-defaults]] — `LUCIDA_*` env-var contract and why cloud-vendor passthrough wins for cloud SDK config.
