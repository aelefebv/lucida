---
created: 2026-05-14
modified: 2026-05-14
---

# Use `GoogleCloudStorageBuilder::from_env()`, not `new()`, for GCS credentials

A user trying to open a `gs://` dataset from `docker run` (or any non-laptop, non-GKE environment) will set `GOOGLE_APPLICATION_CREDENTIALS=/gcp/adc.json` — Google's standard ADC env var, used by every Google SDK and tutorial — and reasonably expect that to "just work." It almost did, and didn't, for a long time. This page captures why, and what lucida does about it.

## The footgun

`GoogleCloudStorageBuilder::new()` does no env-var reading at construction time. At `build()` time the only env-driven path is `ApplicationDefaultCredentials::read(None)`, which checks the well-known file at `$HOME/.config/gcloud/application_default_credentials.json` and **does not honor `GOOGLE_APPLICATION_CREDENTIALS`** before falling through to the GCE metadata server at `169.254.169.254`. So if you construct via `new()`, every `GOOGLE_*` env var the user set sits unread.

`GoogleCloudStorageBuilder::from_env()` is the discovery seam. It iterates `std::env::vars_os()`, lowercases each `GOOGLE_*` key, parses it as `GoogleConfigKey`, and routes via `with_config(...)`. That covers `GOOGLE_SERVICE_ACCOUNT`, `GOOGLE_SERVICE_ACCOUNT_PATH`, `GOOGLE_SERVICE_ACCOUNT_KEY`, `GOOGLE_BUCKET*`, **and** `GOOGLE_APPLICATION_CREDENTIALS` (which routes to `application_credentials_path` — the same field `with_application_credentials(...)` would set). The name `from_env` is literal; pick it.

What lucida used to do (broken):

`GoogleCloudStorageBuilder::new().with_bucket_name(bucket).build()` — no env discovery; only the well-known ADC file or the metadata server were ever consulted. The user's `GOOGLE_APPLICATION_CREDENTIALS=/gcp/adc.json` was silently ignored.

What lucida does now:

`GoogleCloudStorageBuilder::from_env().with_bucket_name(bucket).build()` — mirrors the S3 line. Every `GOOGLE_*` env var, including `GOOGLE_APPLICATION_CREDENTIALS`, is plumbed into the builder before `build()` runs.

## The ~13s metadata-server hang

When neither a `GOOGLE_*` env var nor the well-known ADC file resolves credentials, object_store falls through to the GCE metadata server. The metadata-server fallback is intentional — it's how Workload Identity on GKE provisions credentials. But off-cluster (most laptops, any non-GKE deploy), the metadata server is unreachable, and object_store retries it ~10 times over ~13 seconds before surfacing a confusing error:

> `storage error: Generic GCS error: Error performing token request to 169.254.169.254 ... in 13.3s, after 10 retries, max_retries: 10, retry_timeout: 180s`

Pre-fix, the user's bind-mounted ADC JSON sat unused because `new()` never asked the env. They'd give up, mount the file at the obscure container `$HOME` path (`/root/.config/gcloud/application_default_credentials.json`), and it would work — but only after burning 13 seconds per attempt learning it.

## Effective discovery order

Post-fix, the `gs://` arm of `lucida-store::backend::open` (see [[lucida-store]]) constructs `GoogleCloudStorageBuilder::from_env().with_bucket_name(bucket)`. The discovery order:

1. **`GOOGLE_SERVICE_ACCOUNT*`** — object_store-native (read by `from_env`). Use this if you already export these for other tools in your stack.
2. **`GOOGLE_APPLICATION_CREDENTIALS`** — Google's standard ADC env. Read by `from_env` (lowercased to `google_application_credentials`, parsed via `GoogleConfigKey::FromStr`, routed to `application_credentials_path`). Accepts both service-account JSON keys and user-credentials JSON (the file `gcloud auth application-default login` writes).
3. **Well-known ADC file** at `$HOME/.config/gcloud/application_default_credentials.json` — read by `ApplicationDefaultCredentials::read(None)` when no explicit credentials are provided.
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

A probe at `open()` time (e.g. `HEAD` against `metadata.google.internal` with a short timeout) would let lucida fail-fast off-cluster instead of hanging 13s. Considered and rejected in PRD #541: false positives during transient GCE conditions (in-cluster but metadata briefly unreachable) would be worse than the hang, and switching to `from_env()` plus the README "Reading from `gs://`" block address the same UX pain at the source.

## Why no `LUCIDA_GCS_*` env vars?

Cloud-vendor SDK passthrough preserves the cloud vendor's standard env vars. The S3 arm inherits `AWS_*` directly via `AmazonS3Builder::from_env()`; the GCS arm inherits `GOOGLE_*` the same way. Wrapping these in a `LUCIDA_GCS_*` namespace would invent a dialect that adds nothing and breaks anyone running `gcloud` and lucida together. See [[oss-config-defaults]] for the broader env-var-contract posture.

## Public-bucket reads

Anonymous `gs://` access (`with_skip_signature(true)` on the object_store side) is **not currently surfaced** by lucida. If a concrete public-bucket use case lands, a future PRD can add an env knob, a `gs+anon://...` URL scheme hint, or a 401-then-retry autodetect. Until then, anonymous reads return the same "credentials required" error any signed call would.

## Related

- [[lucida-store]] — backend.rs URL routing and the credential-discovery wrapper.
- [[oss-config-defaults]] — `LUCIDA_*` env-var contract and why cloud-vendor passthrough wins for cloud SDK config.
