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
3. [Create the Kubernetes Secrets](#3-create-the-kubernetes-secrets)
4. [Edit the manifests: replace every placeholder](#4-edit-the-manifests-replace-every-placeholder)
5. [Cloud-specific identity wiring](#5-cloud-specific-identity-wiring)
6. [Apply the manifests](#6-apply-the-manifests)
7. [Verify the deployment end-to-end](#7-verify-the-deployment-end-to-end)
8. [First-time admin bootstrap](#8-first-time-admin-bootstrap)
9. [Persistence and backups](#9-persistence-and-backups)
10. [Updating to a new release](#10-updating-to-a-new-release)
11. [Branch protection and Actions setup (forks)](#11-branch-protection-and-actions-setup-forks)

---

## 1. Prerequisites

You will need:

- **A Kubernetes cluster** with an installed ingress controller. The
  manifests as shipped also need a StorageClass that supports
  `ReadWriteOnce` PersistentVolumeClaims; the network-database shape in
  step 4 drops that requirement. Any cluster qualifies: GKE, EKS, AKS,
  on-prem (k3s, Talos, OpenShift, kubeadm, Rancher), or a single-node
  `minikube` / `kind` for kicking the tires.
- **`kubectl`** configured against the target cluster
  (`kubectl cluster-info` should succeed).
- **A storage backend.** SQLite needs nothing beyond the volume the shipped
  manifests already claim. PostgreSQL needs a server the cluster can reach,
  an empty database, a role that can create tables in it, and room for up
  to 10 connections per replica. Have its connection string ready before
  step 3: the string carries the password, so it belongs in a Secret rather
  than in a manifest. For which backend to run, see
  [Choose a storage backend](#choose-a-storage-backend) later on this page.
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
      `<YOUR-REGISTRY>/lucida:<YOUR-TAG>`. Adopters generally re-tag into
      their own registry for promotion control.
    - Build your own from a checkout: `docker build -t my-registry/lucida:v0 .`
      then push. The Dockerfile is at the repo root.

You do NOT need:

- A Redis or other cache. The proxy cache is a directory lucida manages
  itself, at the path in `LUCIDA_PROXY_CACHE_DIR`.
- A separate static-asset host (lucida-server serves the SPA itself; see
  [ADR-0020](../../wiki/decisions/0020-single-image-with-servedir.md)).

### Choose a storage backend

Lucida ships two storage backends, and the scheme of `LUCIDA_DB_URL` picks
one at startup. Both hold the same state — login sessions, pending
authentications, bearer tokens, CLI token authorizations, bookmarks, and
workspaces — and the server behaves the same on either.

**Run SQLite if one person or a small group uses the deployment.** It is the
default. There is no server to run, no password to rotate, and no second
thing that can be down. A single-writer database fits a workload with a
single writer, and nothing about SQLite here is a starter tier you are
expected to grow out of.

**Run PostgreSQL for one of two reasons.** The first is a second replica:
one SQLite file has one writer, so two pods cannot share it, and the
ReadWriteOnce volume the shipped manifests claim cannot be mounted by both
anyway. The second is that you want someone else operating the database — a
managed PostgreSQL brings backups, point-in-time recovery, and failover that
you would otherwise assemble around a file. If neither reason applies,
PostgreSQL adds a server to run and buys nothing.

Switching later is a change of connection string and nothing more. Lucida
copies no data from one backend to the other, so a deployment that switches
starts on an empty database and whatever the old one held stays where it is.

`LUCIDA_DB_URL` takes these forms:

| Value | What lucida opens |
| --- | --- |
| unset | `sqlite://lucida.db`, relative to the working directory |
| `sqlite:///var/lib/lucida/lucida.db` | SQLite at an absolute path. Three slashes: two from the scheme, one from the root. |
| `postgres://<DB-USER>:<DB-PASSWORD>@<DB-HOST>:5432/<DB-NAME>` | PostgreSQL. `postgresql://` is accepted as a second spelling of the same scheme. |

Lucida migrates whichever database it opens, at startup. A server that
cannot migrate exits, so no request ever reaches a half-built schema. It
prints the connection string with the credentials replaced by
`<redacted>` — in the startup log and in every storage error — so a
PostgreSQL password does not reach your log aggregator.

`LUCIDA_DB_PATH` no longer exists. It was removed with no alias when
`LUCIDA_DB_URL` replaced it, and a value left in the old variable is ignored
rather than half-honored. Rewrite `LUCIDA_DB_PATH=/x/y.db` as
`LUCIDA_DB_URL=sqlite:///x/y.db`. A bare path in the new variable fails
startup instead of opening the wrong database, because a bare path has no
scheme. For more information, see
[ADR-0055](../../wiki/decisions/0055-storage-backend-selected-by-connection-string.md).

### The storage backend as an extension point

Which database lucida keeps its own records in is configuration, not a
build-time choice. One object owns the connection, the migrations, and all
six stores behind a single trait, so a third backend — MySQL, or a managed
dialect of someone's own — is one implementation and one scheme rather than
an edit to every site that reads or writes a row.

That is the seam the authentication provider already uses: a new identity
provider is an implementation of `PrincipalExtractor`, not a refactor of the
code that consumes identity. For more information, see
[ADR-0017](../../wiki/decisions/0017-configurable-from-day-one-for-oss-release.md).

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
with a verified Google account can sign in (the OSS-permissive default).

## 3. Create the Kubernetes Secrets

The OAuth client **secret** must NOT live in the manifest YAML. Create a
Secret in your target namespace:

    kubectl create namespace <YOUR-NAMESPACE>

    kubectl -n <YOUR-NAMESPACE> create secret generic lucida-google-oauth \
        --from-literal=client_secret='<PASTE-CLIENT-SECRET-HERE>'

The Deployment manifest references this Secret as `name: lucida-google-oauth,
key: client_secret`. If you rename the Secret, update the Deployment's
`secretKeyRef` to match.

If you chose PostgreSQL, its connection string carries the password, so it
gets a Secret of its own:

    kubectl -n <YOUR-NAMESPACE> create secret generic lucida-database \
        --from-literal=url='postgres://<DB-USER>:<DB-PASSWORD>@<DB-HOST>:5432/<DB-NAME>'

Step 4 shows the Deployment change that reads it. Deployments on SQLite skip
this Secret; the shipped manifests set `LUCIDA_DB_URL` inline, because a
`sqlite:` string holds no credential.

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
- [ ] `<YOUR-REGISTRY>/lucida:<YOUR-TAG>` — the image to deploy. Pin a
      specific version tag (`v0.1.0`), not `latest`. In `deployment.yaml`.
- [ ] `<YOUR-OAUTH-CLIENT-ID>` — the Client ID from step 2. In
      `deployment.yaml`.
- [ ] `<YOUR-EXTERNAL-HOSTNAME>` — your DNS hostname. Appears in
      `deployment.yaml` (as part of `LUCIDA_OAUTH_REDIRECT_URI`) and in
      `ingress.yaml` (`spec.rules[].host` and `spec.tls[].hosts[]`).
- [ ] `<YOUR-STORAGE-CLASS>` — the StorageClass for the PVC. In `pvc.yaml`.
      Examples: `standard-rwo` (GKE), `gp3` (EKS), `managed-csi` (AKS),
      `longhorn` / `openebs-hostpath` / `local-path` (on-prem). Skip it if
      you take the network-database shape, which deletes `pvc.yaml`.
- [ ] `<YOUR-INGRESS-CLASS>` — your ingress controller's class. In
      `ingress.yaml`. Examples: `nginx`, `traefik`, `alb`, `gce`.
- [ ] `<YOUR-TLS-SECRET>` — the Secret name holding your TLS cert + key.
      In `ingress.yaml`. cert-manager-managed Secret name, or remove the
      `tls:` block entirely if your ingress controller terminates TLS at
      the controller level (ACM, ManagedCertificate, ...).
- [ ] (Optional) `<YOUR-WORKSPACE-DOMAIN>`,
      `<ADMIN-EMAIL-ONE>,<ADMIN-EMAIL-TWO>`, etc. — uncomment the matching
      env blocks in `deployment.yaml` and fill in your values.

Quick check before applying — searching for any leftover placeholders
should return matches only inside the manifests you have not customized
yet:

    grep -RE '<[A-Z][A-Z0-9-]*>' k8s/

If grep returns nothing, you have replaced everything. (The runbook itself
contains placeholders; do not grep it.)

### Optional: the network-database shape

The manifests in `k8s/` ship the volume shape: one replica, one
ReadWriteOnce PVC holding the database beside the proxy cache, and a
`Recreate` rollout so two pods never hold the same SQLite file open. Point
lucida at PostgreSQL and none of that is load-bearing any more, because the
state a pod had to keep to itself now lives on the database server.

The shape lives here as prose, not as a second set of files.
`kubectl apply -f k8s/` applies the whole directory, so a second Deployment
sitting in it would be applied by accident, and a copy of a 200-line
manifest drifts from the one it varies. Documenting a deployment variant as
text is what [ADR-0021](../../wiki/decisions/0021-deployment-artifacts-as-reference-templates.md)
already asks for, and it is how this runbook handles per-cloud identity too.

Three changes, starting from the customized manifests:

1. Delete `pvc.yaml`. Nothing claims a volume any more.
2. In `deployment.yaml`, read `LUCIDA_DB_URL` from the Secret you created in
   step 3, put the proxy cache on ephemeral storage, and roll pods rather
   than replace them. A shared database means a new pod can start before the
   old one retires, so the strategy that protected the writer slot now only
   costs you downtime. The keys that change:

        spec:
          strategy:
            type: RollingUpdate       # was: Recreate
            rollingUpdate:
              maxSurge: 1
              maxUnavailable: 0
          template:
            spec:
              containers:
                - name: lucida
                  env:
                    # replaces the inline sqlite: value
                    - name: LUCIDA_DB_URL
                      valueFrom:
                        secretKeyRef:
                          name: lucida-database
                          key: url
              volumes:
                - name: data
                  emptyDir:           # was: persistentVolumeClaim
                    sizeLimit: 20Gi

3. Raise `replicas` when you want more than one pod. Nothing else has to
   change: every pod migrates the database at startup, and concurrent runs
   serialize on a PostgreSQL advisory lock, so the second pod finds the
   schema already built. See
   [ADR-0059](../../wiki/decisions/0059-postgresql-is-selectable-and-the-alias-stops-at-the-parser.md).

Two consequences worth planning for. The proxy cache is per-pod under
`emptyDir`, so each replica warms its own and every restart starts cold.
Size the `sizeLimit` above for one pod's cache, not the whole deployment's;
the 20Gi is a starting point, and without any limit the cache draws on the
node's ephemeral storage until the kubelet evicts the pod. And
`LUCIDA_DATA_DIR` points into that same empty directory, so drop the
variable unless you mount datasets separately — a ReadOnlyMany volume, or a
bucket URL that needs no volume at all.

As step 1 notes, switching backends carries no data across. A deployment
moving off SQLite starts on an empty PostgreSQL database.

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
explicitly; see the README's "Google Cloud credentials" notes for the
discovery order. WI on GKE remains the recommended path
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
will stay `Pending` until the volume is bound. The network-database shape
has no PVC, so its pod starts as soon as the image is pulled.

Watch progress:

    kubectl -n <YOUR-NAMESPACE> get pods,pvc,svc,ingress -w

You are looking for:

- `pvc/lucida-data` -> `Bound` (volume shape only)
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
- File-permission errors on `/var/lib/lucida/lucida.db` (SQLite) — your
  PodSecurity profile + the runtime image's user are mismatched. The
  `debian:bookworm-slim` runtime runs as root by default; if your cluster
  enforces `restricted`, add `securityContext` with a non-root user to the
  pod template (and ensure the volume's filesystem permissions match).
- `cannot open the database at postgres://<redacted>@…` — the server is
  unreachable or refused the credentials. Lucida waits three seconds for its
  first connection and then exits, leaving the retry to whatever restarts
  the pod. Check the host, the port, the role's password, and any
  NetworkPolicy between the pod and the database.
- `cannot migrate the database at …` — lucida connected and could not build
  the schema. The usual cause is a role that cannot create tables in the
  target database. The pod stays down until the role has the grant it
  needs.

**Sign-in flow.** Visit `https://<YOUR-EXTERNAL-HOSTNAME>` in a browser.
Click sign-in. You should be redirected to Google, complete the consent
screen, redirected back to `/auth/callback`, and land on the app with a
session cookie set. If the cookie is missing, the most likely cause is the
TLS-termination cookie gotcha — verify `LUCIDA_COOKIE_SECURE=always` is set
in the manifest (it is, in the upstream template) and that the redirect
URI registered with Google exactly matches what lucida posts.

**Open a dataset.** The simplest smoke test is to open a known-good public
URL (your team's standard dataset; or any OME-Zarr you have read access to).
If `LUCIDA_DATA_DIR` is set, you can also browse that directory via the UI's
file picker.

## 8. First-time admin bootstrap

Lucida's admin allowlist starts empty. To make yourself an admin:

1. Edit the Deployment env to set `LUCIDA_ADMIN_EMAILS` to your email
   (lowercase comparison, whitespace tolerated):

       - name: LUCIDA_ADMIN_EMAILS
         value: "<YOUR-EMAIL>"

   For multiple admins: comma-separated, e.g., `"a@x.com,b@x.com"`.

2. `kubectl apply -f k8s/deployment.yaml` (the change triggers a rollout;
   the pod restarts).

3. Sign out and sign back in (or refresh — admin status is computed
   per-request from the session principal, not stored on the session row).

There is no in-app admin promotion today: the admin list is read from the
environment at startup, so adding an admin requires a restart. Plan
admin changes around restarts.

## 9. Persistence and backups

What lucida keeps, and where, follows from the backend you chose in step 1.

**On SQLite**, the authoritative state is one file at the path in
`LUCIDA_DB_URL` — `/var/lib/lucida/lucida.db` in the shipped manifests —
plus `lucida.db-wal` and `lucida.db-shm` from WAL journal mode. It holds
sessions, bookmarks, workspaces, and tokens, and it stays small: megabytes,
not gigabytes. Back up the volume and you have the deployment's state.

**On PostgreSQL**, that same state is on the database server and nothing on
the pod's disk is authoritative. Back the database up the way you back up
any other database on that server. Lucida adds no requirement of its own.

Under both, the **proxy on-disk cache** at `LUCIDA_PROXY_CACHE_DIR` is
recomputable from the sources it mirrors, so backing it up only saves you
the re-fetch. And `/var/lib/lucida/data/`, if you set
`LUCIDA_DATA_DIR`, is your dataset directory: lucida only reads from it, so
back it up however your dataset workflow handles bulk data.

### Back up SQLite

The WAL file is part of the authoritative state, so copying `lucida.db` on
its own while writes are in flight gives you a torn snapshot. Two approaches
avoid that:

- **Quiesce writes.** Scale to 0 replicas, then snapshot the volume or copy
  `lucida.db`, `lucida.db-wal`, and `lucida.db-shm` together. Consistent,
  and it costs downtime.
- **Take an online backup with the SQLite client.**
  `sqlite3 lucida.db ".backup '/path/to/backup.db'"` writes a consistent
  single file whatever the WAL holds. The runtime image ships no `sqlite3`
  binary, so run it from a sidecar container that mounts the same volume:
  same pod, same node, so the ReadWriteOnce claim still binds.

This caveat belongs to SQLite. It does not carry over to PostgreSQL, whose
own backup tools take a consistent copy of a running database.

For the volume itself, pick the tool that fits your environment; this
runbook is **explicitly not prescriptive**:

- [Velero](https://velero.io/) — k8s-native, snapshots PVCs through your
  CSI driver, schedules backups via CRDs.
- [k8up](https://k8up.io/) — restic-based, writes to S3-compatible storage.
- Cloud provider snapshots — GKE / EKS / AKS volume snapshot APIs work
  directly; consistency is your job.

### Back up PostgreSQL

On a managed service, its own backups are the answer. Turn on automated
backups, set a retention window, and check that point-in-time recovery
covers the window you would need to rewind. That path also gives you
failover, which no volume snapshot does.

On a server you run yourself, `pg_dump` takes a consistent logical backup
without quiescing writes, and `pg_basebackup` with continuous archiving adds
point-in-time recovery on top. Either way, restore into a scratch database
and start lucida against it at least once, so you find out whether the
backup works before you need it.

## 10. Updating to a new release

Pin the image tag, not `latest`. Promotion is a manifest edit:

1. Identify the new release tag (e.g., `v0.2.0`) from the upstream
   release-please flow.
2. Re-tag into your registry (recommended) and update
   `deployment.yaml` accordingly.
3. `kubectl apply -f k8s/deployment.yaml`. In the volume shape the
   Deployment uses the `Recreate` strategy (single replica + RWO PVC), so
   the old pod is terminated before the new one starts. Brief downtime is
   expected during image pull + readiness convergence (typically tens of
   seconds). In the network-database shape the rollout is `RollingUpdate`
   and the new pod becomes ready before the old one goes away, so a release
   costs no downtime.
4. Verify post-rollout: `/readyz` returns 200, sign-in still works.

If a release ships breaking config changes, the release notes call them
out. Read before applying.

If you need to roll back: `kubectl rollout undo deployment/lucida -n
<YOUR-NAMESPACE>` reverts to the previous ReplicaSet. Migrations are
forward-only on both backends — a rollback past a migration is not
supported and may corrupt state. Take a backup before a release whose notes
mention one.

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
   image publish) lives in `.github/workflows/`; see also
   `wiki/decisions/0022-manual-merge-release-please-on-main.md`.
   If you want to publish your own image tags from your fork, replicate
   the relevant pieces of `.github/workflows/release.yml` against your
   registry credentials.

For internal-only forks that don't track upstream, you can drop the
manifest dry-run job — but if you do, your manifest-edit workflow loses
its safety net. Keeping the job enabled costs you a few seconds per PR
and catches schema regressions early.
