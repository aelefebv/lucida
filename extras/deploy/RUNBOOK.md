# Lucida Deployment Runbook

Step-by-step walkthrough for deploying lucida-server to a Kubernetes cluster
behind a TLS-terminating ingress. The compose file in this directory is the
single-host alternative; `k8s/` is the production target.

This runbook is **opinionated about the procedure** and **unopinionated about
which cloud, which cluster, which storage class, or which ingress controller**.
Every adopter-specific value appears as `<UPPERCASE-WITH-DASHES>`. Find them
all and replace them with values from your environment.

Per [ADR-0021](../../wiki/decisions/0021-deployment-artifacts-as-reference-templates.md),
the manifests in `k8s/` are reference templates, not packaged infrastructure.
Copy them into your own infra repo, replace placeholders, and own the result
from there. Do not `kubectl apply` directly from a checkout of the lucida
upstream repo — your cluster details belong in your own version control, not
upstream.

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Provision an OAuth client](#2-provision-an-oauth-client)
3. [Create the Kubernetes Secret for the OAuth client secret](#3-create-the-kubernetes-secret-for-the-oauth-client-secret)
4. [Edit the manifests: replace every placeholder](#4-edit-the-manifests-replace-every-placeholder)
5. [Cloud-specific identity wiring](#5-cloud-specific-identity-wiring)
6. [Apply the manifests](#6-apply-the-manifests)
7. [Verify the deployment end-to-end](#7-verify-the-deployment-end-to-end)
8. [First-time admin bootstrap](#8-first-time-admin-bootstrap)
9. [Backup considerations](#9-backup-considerations)
10. [Updating to a new release](#10-updating-to-a-new-release)
11. [Branch protection and Actions setup (forks)](#11-branch-protection-and-actions-setup-forks)

---

## 1. Prerequisites

You will need:

- **A Kubernetes cluster** with an installed ingress controller and a
  StorageClass that supports `ReadWriteOnce` PersistentVolumeClaims. Any
  cluster qualifies: GKE, EKS, AKS, on-prem (k3s, Talos, OpenShift, kubeadm,
  Rancher), or a single-node `minikube` / `kind` for kicking the tires.
- **`kubectl`** configured against the target cluster
  (`kubectl cluster-info` should succeed).
- **A Google Cloud project** if you intend to use `LUCIDA_AUTH=google` (the
  v1 supported provider). You do not need any GCP-managed services for this
  flow other than the OAuth client; the OAuth client itself is free.
- **A DNS-resolvable hostname** that you control, pointing (eventually) at
  your ingress controller's external IP. Examples: `lucida.example.com`,
  `viewer.internal.example.com`. This runbook calls it
  `<YOUR-EXTERNAL-HOSTNAME>`.
- **A TLS certificate plan**. Two common patterns:
    - cert-manager + Let's Encrypt (or your private CA): cert-manager issues
      a `Certificate` resource and writes the chain into a Secret; the
      Ingress references that Secret. Works with most ingress controllers.
    - Controller-managed cert: AWS ACM ARN attached to an ALB Ingress, GKE
      `ManagedCertificate`, AKS Application Gateway listener certs.
- **A container image** for lucida. Either:
    - Pull a published release image (recommended once releases are tagged):
      `<YOUR-REGISTRY>/lucida:<YOUR-TAG>@sha256:<YOUR-DIGEST>`. Adopters
      generally re-tag into their own registry for promotion control, then pin
      the resulting digest so a later tag move cannot change a rollout.
    - Build your own from a checkout: `docker build -t my-registry/lucida:v0 .`
      then push. The Dockerfile is at the repo root.

You do NOT need:

- A relational database service (lucida keeps sessions, workspaces, and saved
  views in one SQLite database on a PVC; see
  [Workspaces](../../wiki/systems/subsystems/workspaces.md)).
- A Redis or other cache (generated coarse data uses the same PVC).
- A separate static-asset host (lucida-server serves the SPA itself; see
  [ADR-0020](../../wiki/decisions/0020-single-image-with-servedir.md)).

## 2. Provision an OAuth client

Lucida's authenticated flow uses Google OAuth (`LUCIDA_AUTH=google`). The
OAuth client identifies your deployment to Google; the secret authenticates
the deployment to Google's token exchange.

1. Go to the Google Cloud Console -> APIs & Services -> Credentials.
2. Click **Create Credentials** -> **OAuth client ID**.
3. Application type: **Web application**.
4. Name: anything that helps you find it later (e.g., `lucida-prod`).
5. **Authorized JavaScript origins**: `https://<YOUR-EXTERNAL-HOSTNAME>`
6. **Authorized redirect URIs**: `https://<YOUR-EXTERNAL-HOSTNAME>/auth/callback`
   (must match `LUCIDA_OAUTH_REDIRECT_URI` exactly — Google compares the
   string verbatim, including trailing slashes and case).
7. Save. Copy the **Client ID** (this is the value for
   `LUCIDA_GOOGLE_CLIENT_ID`; not a secret) and the **Client Secret**
   (this is `LUCIDA_GOOGLE_CLIENT_SECRET`; treat as a real secret).

If you want to restrict sign-in to one or more Google Workspace domains,
note the workspace domain(s) now (e.g., `example.com`). You will use them as
`LUCIDA_ALLOWED_HOSTED_DOMAINS` (comma-separated). Empty / unset = anyone
with a verified Google account can sign in (the OSS-permissive default; see
[wiki/gotchas/oss-config-defaults.md](../../wiki/gotchas/oss-config-defaults.md)).

## 3. Create the Kubernetes Secret for the OAuth client secret

The OAuth client **secret** must NOT live in the manifest YAML. Create a
Secret in your target namespace:

    kubectl create namespace <YOUR-NAMESPACE>

    kubectl -n <YOUR-NAMESPACE> create secret generic lucida-google-oauth \
        --from-literal=client_secret='<PASTE-CLIENT-SECRET-HERE>'

The Deployment manifest references this Secret as `name: lucida-google-oauth,
key: client_secret`. If you rename the Secret, update the Deployment's
`secretKeyRef` to match.

For production, prefer a real secret manager over a hand-created Secret:

- **GCP**: Secret Manager + Secrets Store CSI driver (mount the secret as a
  file, or sync it into a Kubernetes Secret with `External Secrets Operator`).
- **AWS**: Secrets Manager / Parameter Store + External Secrets Operator.
- **Azure**: Key Vault + Secrets Store CSI driver.
- **On-prem**: HashiCorp Vault + External Secrets Operator, or
  Bitnami Sealed Secrets, or SOPS-decrypted by your GitOps controller.

Whichever path: the resulting Kubernetes Secret should still be named
`lucida-google-oauth` with key `client_secret`, OR you should update the
Deployment's `secretKeyRef` block to point at whatever name you chose.

If you set `LUCIDA_ADMIN_TOKEN` for service-to-service admin access, create
a similar Secret (the manifest has a commented-out block showing the shape).

## 4. Edit the manifests: replace every placeholder

Copy `extras/deploy/k8s/` into your own infra repo. Then find and replace
every `<UPPERCASE-WITH-DASHES>` placeholder. Checklist:

- [ ] `<YOUR-NAMESPACE>` — the namespace from step 3. Appears in every
      manifest's `metadata.namespace`.
- [ ] `<YOUR-REGISTRY>/lucida:<YOUR-TAG>@sha256:<YOUR-DIGEST>` — the image to
      deploy. Use a specific version tag (`v0.1.0`) plus the digest published
      for that release, never `latest`. In `deployment.yaml`.
- [ ] `<YOUR-OAUTH-CLIENT-ID>` — the Client ID from step 2. In
      `deployment.yaml`.
- [ ] `<YOUR-EXTERNAL-HOSTNAME>` — your DNS hostname. Appears in
      `deployment.yaml` (as part of `LUCIDA_OAUTH_REDIRECT_URI`) and in
      `ingress.yaml` (`spec.rules[].host` and `spec.tls[].hosts[]`).
- [ ] `<YOUR-STORAGE-CLASS>` — the StorageClass for the PVC. In `pvc.yaml`.
      Examples: `standard-rwo` (GKE), `gp3` (EKS), `managed-csi` (AKS),
      `longhorn` / `openebs-hostpath` / `local-path` (on-prem).
- [ ] `<YOUR-INGRESS-CLASS>` — your ingress controller's class. In
      `ingress.yaml`. Examples: `nginx`, `traefik`, `alb`, `gce`.
- [ ] `<YOUR-TLS-SECRET>` — the Secret name holding your TLS cert + key.
      In `ingress.yaml`. cert-manager-managed Secret name, or remove the
      `tls:` block entirely if your ingress controller terminates TLS at
      the controller level (ACM, ManagedCertificate, ...).
- [ ] (Optional) `<YOUR-WORKSPACE-DOMAIN>`,
      `<ADMIN-EMAIL-ONE>,<ADMIN-EMAIL-TWO>`, etc. — uncomment the matching
      env blocks in `deployment.yaml` and fill in your values.

Sanity check before applying — searching for any leftover placeholders
should return matches only inside the manifests you have not customized
yet:

    grep -RE '<[A-Z][A-Z0-9-]*>' k8s/

If grep returns nothing, you have replaced everything. (The runbook itself
contains placeholders; do not grep it.)

## 5. Cloud-specific identity wiring

`serviceaccount.yaml` upstream is bare. Lucida itself does not call the
Kubernetes API and does not need RBAC. The reason a dedicated
ServiceAccount exists is so adopters can bind a **cloud workload identity**
to it (for accessing GCS / S3 / Azure Blob datasets, secret managers, KMS,
etc.). Pick the snippet matching your cluster and apply it in your fork
(NOT upstream — see ADR-0021):

### GKE Workload Identity

1. Create or pick a Google Service Account (GSA). Grant it the IAM roles
   your deployment needs (e.g., `roles/storage.objectViewer` for GCS dataset
   reads).
   Also set `LUCIDA_SOURCE_GCS_BUCKETS` to the exact permitted buckets and
   `LUCIDA_SOURCE_ALLOW_AMBIENT_CLOUD_CREDENTIALS=true` in your Deployment;
   IAM alone does not opt a source into Lucida's deny-by-default trust policy.
2. Allow the KSA to impersonate the GSA:

       gcloud iam service-accounts add-iam-policy-binding <GSA-EMAIL> \
           --role roles/iam.workloadIdentityUser \
           --member "serviceAccount:<PROJECT-ID>.svc.id.goog[<YOUR-NAMESPACE>/lucida]"

3. Annotate the KSA in your fork's `serviceaccount.yaml`:

       metadata:
         annotations:
           iam.gke.io/gcp-service-account: <GSA-EMAIL>

#### Non-GKE: service-account JSON key

For deploys outside GKE (single-host docker, on-prem k8s without WI, EKS/AKS
clusters reading from GCS), Workload Identity isn't an option. Mount a
Google service-account JSON key as a secret/volume inside the pod (or bind
it in via `docker run -v`) and set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json`
in the deployment env. Lucida forwards that env var to the GCS client
explicitly; see [wiki/gotchas/gcs-credentials.md](../../wiki/gotchas/gcs-credentials.md)
for credential discovery order. WI on GKE remains the recommended path
when available.

### EKS IRSA (IAM Roles for Service Accounts)

1. Create an IAM role with a trust policy that allows the EKS OIDC provider
   to assume it for `system:serviceaccount:<YOUR-NAMESPACE>:lucida`.
2. Attach the IAM policies your deployment needs.
3. Annotate the KSA:

       metadata:
         annotations:
           eks.amazonaws.com/role-arn: arn:aws:iam::<AWS-ACCOUNT-ID>:role/<ROLE-NAME>

### AKS Workload Identity (Azure AD)

1. Create an Azure AD app + federated credential whose subject is
   `system:serviceaccount:<YOUR-NAMESPACE>:lucida`.
2. Grant the app the Azure RBAC roles you need.
3. Annotate AND label the KSA:

       metadata:
         annotations:
           azure.workload.identity/client-id: <AZURE-AD-CLIENT-ID>
         labels:
           azure.workload.identity/use: "true"

   And add the same `azure.workload.identity/use: "true"` label on the pod
   template in `deployment.yaml`.

### On-prem / non-cloud

No identity binding required. Fetch any cloud credentials from your
in-cluster secret manager (Vault, Sealed Secrets, SOPS-decrypted by your
GitOps controller) and reference them from the Deployment env block. The
upstream `serviceaccount.yaml` is sufficient as-is.

## 6. Apply the manifests

From your fork's directory containing the customized manifests:

    kubectl apply -f k8s/

Order does not matter — `kubectl apply` reconciles whatever is referenced.
The PVC may take a moment to bind depending on your CSI driver; the pod
will stay `Pending` until the volume is bound.

Watch progress:

    kubectl -n <YOUR-NAMESPACE> get pods,pvc,svc,ingress -w

You are looking for:

- `pvc/lucida-data` -> `Bound`
- `pod/lucida-...` -> `Running` then `Ready 1/1`
- `service/lucida` -> a ClusterIP assigned
- `ingress/lucida` -> an external address (depends on your controller)

## 7. Verify the deployment end-to-end

**Pod ready.** From inside the cluster:

    kubectl -n <YOUR-NAMESPACE> port-forward svc/lucida 9876:9876
    # then in another terminal:
    curl -fsS http://127.0.0.1:9876/readyz   # expect 200 / "ok"
    curl -fsS http://127.0.0.1:9876/healthz  # expect 200 / "ok"

If `/readyz` returns 503 or the pod CrashLoops, check
`kubectl logs deploy/lucida` — the most common failures are surfaced as
fail-fast startup errors:

- `AuthConfigError::InsecureRequiresOptIn` — `LUCIDA_AUTH=disabled` on a
  non-loopback bind without `LUCIDA_INSECURE=1`. Either set the explicit
  acknowledgment or switch to `LUCIDA_AUTH=google` with credentials.
- `LUCIDA_GOOGLE_CLIENT_ID is required` — Secret not found / wrong key /
  wrong Secret name. Verify with
  `kubectl -n <YOUR-NAMESPACE> get secret lucida-google-oauth -o yaml`.
- File-permission errors on `/var/lib/lucida/lucida.db` — the image and reference
  manifest run as UID/GID `10001` with `runAsNonRoot`, a read-only root
  filesystem, and PVC ownership supplied through `fsGroup: 10001`. Confirm your
  storage driver honors `fsGroup`, or pre-provision the volume with matching
  ownership. Do not solve this by restoring root or privilege escalation.

**Sign-in flow.** Visit `https://<YOUR-EXTERNAL-HOSTNAME>` in a browser.
Click sign-in. You should be redirected to Google, complete the consent
screen, redirected back to `/auth/callback`, and land on the app with a
session cookie set. If the cookie is missing, the most likely cause is the
TLS-termination cookie gotcha — verify `LUCIDA_COOKIE_SECURE=always` is set
in the manifest (it is, in the upstream template) and that the redirect
URI registered with Google exactly matches what lucida posts.

**Open a dataset.** If `LUCIDA_DATA_DIR` is set, browse a known-good dataset
under that directory with the UI's file picker. For an HTTP(S) smoke source,
first put its exact hostname in `LUCIDA_SOURCE_HTTP_HOSTS`; private/LAN
destinations additionally need an admitted `LUCIDA_SOURCE_HTTP_CIDRS` range.
Standard IPv6 translation/transition addresses are always rejected. If your
network uses an RFC 6052 network-specific translation prefix, add it to the
denylist `LUCIDA_SOURCE_HTTP_IPV6_TRANSLATION_CIDRS`; arbitrary prefixes cannot
be inferred from an IPv6 address itself.
For `gs://` or `s3://`, configure the exact bucket allowlist plus
`LUCIDA_SOURCE_ALLOW_AMBIENT_CLOUD_CREDENTIALS=true`. A public URL or a valid
cloud identity is not sufficient on its own: source trust remains
deny-by-default.

## 8. First-time admin bootstrap

Lucida's admin allowlist starts empty. To make yourself an admin:

1. Edit the Deployment env to set `LUCIDA_ADMIN_EMAILS` to your email
   (lowercase comparison, whitespace tolerated):

       - name: LUCIDA_ADMIN_EMAILS
         value: "<YOUR-EMAIL>"

   For multiple admins: comma-separated, e.g., `"a@x.com,b@x.com"`.

2. `kubectl apply -f k8s/deployment.yaml` (the change forces a Recreate
   rollout; the pod restarts).

3. Sign out and sign back in (or refresh — admin status is computed
   per-request from the session principal, not stored on the session row).

There is no in-app admin promotion today;
[wiki/gotchas/oss-config-defaults.md](../../wiki/gotchas/oss-config-defaults.md)
documents the "I want to add an admin without restarting" gotcha. Plan
admin changes around restarts.

## 9. Backup considerations

Two pieces of state live on the PVC:

- **SQLite database** at `/var/lib/lucida/lucida.db` (plus `lucida.db-wal`
  and `lucida.db-shm` from WAL journal mode). Sessions, workspaces, saved views,
  and any future server-stored state. Small (typically MB, not GB).
- **Generated-coarse cache** at `/var/lib/lucida/generated-coarse/`. Recomputable
  from upstream sources; backing it up is convenience, not necessity. The
  reference deployment caps it at 8 GiB, preserving nominal headroom on the
  shared 50 GiB PVC for authoritative SQLite/WAL state.
- **Retired proxy cache** at `/var/lib/lucida/proxy-cache/`. New releases do not
  write here. It remains named by deprecated `LUCIDA_PROXY_CACHE_DIR` only so
  upgrade cleanup can remove artifacts left by older releases.

**SQLite-WAL gotcha.** The WAL file (`lucida.db-wal`) is part of the
authoritative state — copying only `lucida.db` while writes are in flight
gives you a torn snapshot. Two safe approaches:

- Use `sqlite3 lucida.db ".backup '/path/to/backup.db'"` from inside the
  pod (or via `kubectl exec`). This produces a consistent single-file
  backup regardless of WAL state.
- Quiesce writes (scale to 0 replicas briefly) and snapshot the volume.
  Safe but introduces downtime.

Pick the tool that fits your environment; this runbook is **explicitly
not prescriptive**:

- [Velero](https://velero.io/) — k8s-native, snapshots PVCs through your
  CSI driver, schedules backups via CRDs.
- [k8up](https://k8up.io/) — restic-based, writes to S3-compatible storage.
- Cloud provider snapshots — GKE / EKS / AKS volume snapshot APIs work
  directly; consistency is your job.

`/var/lib/lucida/data/` (if you set `LUCIDA_DATA_DIR`) is your dataset
directory; back it up however your dataset workflow normally handles bulk
data. Lucida treats it as read-only.

## 10. Updating to a new release

Pin a readable release tag and its immutable digest, not `latest`. Promotion is
a manifest edit, but an upgrade is also a data operation.

**Mandatory migration checkpoint.** The upgrade from the released v0.10
short source IDs performs a one-way short-ID -> full-digest rewrite the first
time the new server opens SQLite. The v0.10 binary cannot safely use that
rewritten database: its short-ID lookup can collide with the new
`canonical_url` uniqueness contract. Before *any* new-image pod or container
starts, quiesce the old server, take a WAL-safe backup/snapshot described in
§9, and verify that backup can be read (preferably by restoring it to a
disposable volume and running `PRAGMA integrity_check`). Record the previous
image digest and backup/snapshot identifier together. This checkpoint is
required even when the release notes describe the application rollout as
otherwise routine.

### Kubernetes upgrade order

1. Identify the new release tag and digest. Record the currently running image
   from `kubectl -n <YOUR-NAMESPACE> get deploy lucida -o
   jsonpath='{.spec.template.spec.containers[0].image}'`.
2. Quiesce the old writer and wait until its pod is gone:

       kubectl -n <YOUR-NAMESPACE> scale deploy/lucida --replicas=0
       kubectl -n <YOUR-NAMESPACE> wait --for=delete pod \
         -l app.kubernetes.io/name=lucida --timeout=120s

3. Create a full PVC snapshot (or an equivalent offline copy containing
   `lucida.db`, `lucida.db-wal`, and `lucida.db-shm`) and wait for the storage
   backend to report it ready. Verify a restored disposable copy before
   proceeding. **Do not start the new image without this checkpoint.**
4. Re-tag into your registry if desired, update `deployment.yaml` to the new
   `tag@sha256:digest`, restore `replicas: 1`, and apply it. `Recreate` keeps the
   RWO writer slot single-owned:

       kubectl apply -f k8s/deployment.yaml
       kubectl -n <YOUR-NAMESPACE> rollout status deploy/lucida --timeout=180s

5. Clear recomputable active and legacy cache roots with the new binary. This
   leaves `lucida.db{,-wal,-shm}` untouched:

       kubectl -n <YOUR-NAMESPACE> exec deploy/lucida -- \
         lucida-server clear-proxy-cache

6. Verify `/readyz`, sign-in, dataset reopen, and the running image digest.

### Compose upgrade and UID 10001 volume migration

The current runtime remains non-root (`10001:10001`). Volumes written by an
older root-running image need a one-time ownership migration; the profile-gated
`lucida-volume-migrate` service has only `CHOWN` and `DAC_OVERRIDE`, no network,
a read-only root filesystem, and the data volume as its sole writable mount.
It deliberately excludes the operator-managed `/var/lib/lucida/data` tree,
refuses symlinked application roots, and verifies that every existing
application path has the same device ID as `/var/lib/lucida` before changing
any ownership. A separately mounted database or cache path is rejected rather
than treated as a new `find -xdev` traversal root. Once validation succeeds,
the helper stays on the volume filesystem and changes descendant symlink
ownership without following symlink targets.

1. Record the previous image digest, stop the old writer, and confirm it is not
   running:

       docker compose stop lucida
       docker compose ps lucida

2. Snapshot/archive the named volume (or bind mount) while it is quiescent,
   including all three `lucida.db{,-wal,-shm}` files, and verify a disposable
   restore with SQLite `PRAGMA integrity_check`. Do not continue on a missing
   or unverified backup.
3. Update the Compose image to the new tag+digest. Run only the one-shot
   ownership helper, explicitly acknowledging that steps 1-2 completed:

       LUCIDA_VOLUME_MIGRATION_ACK=backup-complete-and-lucida-stopped \
         docker compose --profile volume-migration run --rm --no-deps \
         lucida-volume-migrate

   Bind-mount adopters must give the helper's `10001:10001` ownership to the
   same application paths or perform the equivalent host-side migration. The
   helper intentionally refuses a separate-device application child; migrate
   such a child independently while Lucida is stopped, then
   verify every application root is writable by `10001:10001` before restart.
4. Start the non-root runtime (its first SQLite open may perform the source-ID
   rewrite), wait for health, then clear recomputable cache roots:

       docker compose up -d lucida
       docker compose exec lucida lucida-server clear-proxy-cache
       docker compose ps lucida

### Rollback past the source-ID migration

Never use binary-only `kubectl rollout undo` or merely put the previous image
back after the new server has opened the database. To roll back across this
migration: quiesce the new server, restore the verified **pre-upgrade**
PVC/volume (or its WAL-safe SQLite backup), select the recorded previous image
digest, and only then restart. A rollback that keeps the migrated database is
unsupported: it requires the previous image **and** restoring the pre-upgrade database/volume.
Forward-only releases after this boundary follow the same rule
whenever their release notes identify a data migration.

## 11. Branch protection and Actions setup (forks)

If you forked the repo (or vendored the manifests into your own monorepo)
and intend to track upstream:

1. **Branch protection on `main`**. Require:
    - Status checks `Rust workspace (test + clippy)`, `Web (wasm-pack +
      pnpm)`, `Docker smoke build (no push)`, and `Manifest dry-run` to
      pass.
    - At least one PR review (or your org's standard).
    - Linear history (squash-merge), unless you have a specific reason for
      merge commits.
2. **Actions enabled**. The CI workflow at `.github/workflows/ci.yml`
   exercises the same builds upstream uses. The manifest dry-run job
   substitutes placeholders to dummy values and runs `kubectl apply
   --dry-run=client -f` against your fork's manifests; if you customize
   the manifest set or add adopter-specific resources, that job will
   continue to validate them.
3. **Release workflow**. The upstream release process (release-please +
   image publish) is documented in
   [wiki/gotchas/branching-and-releases.md](../../wiki/gotchas/branching-and-releases.md).
   If you want to publish your own image tags from your fork, replicate
   the relevant pieces of `.github/workflows/release.yml` against your
   registry credentials.

For internal-only forks that don't track upstream, you can drop the
manifest dry-run job — but if you do, your manifest-edit workflow loses
its safety net. Keeping the job enabled costs you a few seconds per PR
and catches schema regressions early.
