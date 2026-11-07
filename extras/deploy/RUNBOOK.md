# Lucida deployment runbook

How to deploy lucida-server to Kubernetes behind a TLS-terminating ingress.
[`docker-compose.yml`](docker-compose.yml) is the single-host alternative and
takes the same [environment variables](#environment-variables).

The manifests in [`k8s/`](k8s/) are reference templates. Copy them into your
own infra repo, replace every `<UPPERCASE-WITH-DASHES>` placeholder, and own
the result there.

## 1. Prerequisites

- A cluster with an ingress controller, and `kubectl` pointed at it. The
  shipped manifests need a StorageClass that offers `ReadWriteOnce`; the
  network-database shape in step 4 does not.
- A hostname, `<YOUR-EXTERNAL-HOSTNAME>`, with TLS terminated at the ingress.
- For `LUCIDA_AUTH=google`, a Google Cloud project for the OAuth client. For
  `LUCIDA_AUTH=iap`, an Identity-Aware Proxy already in front.
- An image. Releases publish `ghcr.io/aelefebv/lucida:vX.Y.Z`, or run
  `docker build` at the repo root.

No cache server or static-asset host is needed. The proxy cache is a
directory, and lucida-server serves the web UI itself.

### Choose a storage backend

The scheme of `LUCIDA_DB_URL` picks the backend. Both hold the same seven
stores: login sessions, pending authentications, bearer tokens, CLI token
authorizations, bookmarks, workspaces, and inbox.

SQLite is the default and suits one person or a small group. PostgreSQL is
for a second replica, since one SQLite file has one writer, or for a managed
database's backups and failover. It needs an empty database, a role that can
create tables, and up to 10 connections per replica.

| `LUCIDA_DB_URL` | What lucida opens |
| --- | --- |
| unset | `sqlite://lucida.db`, relative to the working directory |
| `sqlite:///var/lib/lucida/lucida.db` | SQLite at an absolute path (three slashes) |
| `postgres://<DB-USER>:<DB-PASSWORD>@<DB-HOST>:5432/<DB-NAME>` | PostgreSQL. `postgresql://` also works. |

A bare path has no scheme and fails startup. Lucida migrates the database at
startup and exits if it can't. Logs show the connection string with
credentials replaced by `<redacted>`. Switching backends copies no data.

## 2. Provision an OAuth client

For `LUCIDA_AUTH=google`:

1. In the Google Cloud Console, under APIs & Services, Credentials, create
   an OAuth client ID of type Web application.
2. Add the redirect URI `https://<YOUR-EXTERNAL-HOSTNAME>/auth/callback`. It
   must equal `LUCIDA_OAUTH_REDIRECT_URI` exactly.
3. The client ID goes in `LUCIDA_GOOGLE_CLIENT_ID`. The client secret goes
   in `LUCIDA_GOOGLE_CLIENT_SECRET` and is the only secret.

`LUCIDA_AUTH=iap` skips this step and needs only `LUCIDA_IAP_AUDIENCE`, the
`aud` claim your IAP mints (`/projects/PROJECT_NUMBER/global/backendServices/SERVICE_ID`),
copied from the load balancer's backend service. A wrong value answers every
request with 401 and logs the first as `auth.iap.assertion.rejected.first`.
IAP's IAM policy decides who gets in, so `LUCIDA_ALLOWED_HOSTED_DOMAINS` does
nothing there.

## 3. Create the Kubernetes Secrets

    kubectl create namespace <YOUR-NAMESPACE>
    kubectl -n <YOUR-NAMESPACE> create secret generic lucida-google-oauth \
        --from-literal=client_secret='<PASTE-CLIENT-SECRET-HERE>'

`deployment.yaml` reads `lucida-google-oauth`, key `client_secret`. If a
secret manager syncs it instead, keep that name and key or edit the
`secretKeyRef`. For PostgreSQL, the connection string carries the password,
so it gets its own Secret. SQLite's URL is set inline.

    kubectl -n <YOUR-NAMESPACE> create secret generic lucida-database \
        --from-literal=url='postgres://<DB-USER>:<DB-PASSWORD>@<DB-HOST>:5432/<DB-NAME>'

## 4. Edit the manifests

| Placeholder | File |
| --- | --- |
| `<YOUR-NAMESPACE>` | every manifest |
| `<YOUR-REGISTRY>/lucida:<YOUR-TAG>` | `deployment.yaml`. Pin a version, not `latest`. |
| `<YOUR-OAUTH-CLIENT-ID>` | `deployment.yaml` |
| `<YOUR-EXTERNAL-HOSTNAME>` | `deployment.yaml`, `ingress.yaml` |
| `<YOUR-STORAGE-CLASS>` | `pvc.yaml` |
| `<YOUR-INGRESS-CLASS>`, `<YOUR-TLS-SECRET>` | `ingress.yaml` |

Optional variables sit in commented blocks in `deployment.yaml`. This finds
placeholders left on active lines, as CI does:

    grep -RnE '<[A-Z][A-Z0-9-]+>' k8s/ | grep -vE ':[[:space:]]*#'

### Optional: the network-database shape

The shipped shape runs one replica on one ReadWriteOnce PVC with a
`Recreate` rollout, so two pods never open the same SQLite file. PostgreSQL
removes that constraint. The variant is described here, not shipped as a
second manifest, because `kubectl apply -f k8s/` would apply both.

1. Delete `pvc.yaml`.
2. In `deployment.yaml`, make these changes:

        spec:
          strategy:
            type: RollingUpdate       # was: Recreate
            rollingUpdate: {maxSurge: 1, maxUnavailable: 0}
          template:
            spec:
              containers:
                - name: lucida
                  env:
                    - name: LUCIDA_DB_URL   # replaces the inline sqlite: value
                      valueFrom:
                        secretKeyRef: {name: lucida-database, key: url}
              volumes:
                - name: data
                  emptyDir: {sizeLimit: 20Gi}   # was: persistentVolumeClaim

3. Raise `replicas`. Concurrent startup migrations serialize on a PostgreSQL
   advisory lock.

Each pod now has its own cold cache. Size `sizeLimit` for one pod; without
it the cache grows until the kubelet evicts the pod. Drop `LUCIDA_DATA_DIR`
unless you mount datasets separately.

## 5. Cloud identity wiring

Lucida never calls the Kubernetes API. The `lucida` ServiceAccount exists so
you can bind a cloud identity to it for reading datasets from object storage.

For `gs://` on GKE, grant a Google service account the roles it needs (such
as `roles/storage.objectViewer`), let the KSA impersonate it, and annotate
the KSA in `serviceaccount.yaml` with `iam.gke.io/gcp-service-account: <GSA-EMAIL>`:

    gcloud iam service-accounts add-iam-policy-binding <GSA-EMAIL> \
        --role roles/iam.workloadIdentityUser \
        --member "serviceAccount:<PROJECT-ID>.svc.id.goog[<YOUR-NAMESPACE>/lucida]"

Elsewhere, mount a service-account key and set
`GOOGLE_APPLICATION_CREDENTIALS`. The README's "Reading from `gs://`"
section gives the discovery order. On EKS, annotate the KSA with
`eks.amazonaws.com/role-arn`. On AKS, annotate it with
`azure.workload.identity/client-id` and label the KSA and pod template
`azure.workload.identity/use: "true"`.

## 6. Apply and verify

    kubectl apply -f k8s/
    kubectl -n <YOUR-NAMESPACE> get pods,pvc,svc,ingress -w
    kubectl -n <YOUR-NAMESPACE> port-forward svc/lucida 9876:9876
    curl -fsS http://127.0.0.1:9876/version

`/healthz` and `/readyz` answer 200 whenever the process serves, and don't
check the database. A bad configuration shows up as a pod that exits at
startup. `kubectl -n <YOUR-NAMESPACE> logs deploy/lucida` names the cause:

- `LUCIDA_AUTH=disabled with non-loopback LUCIDA_BIND=... requires LUCIDA_INSECURE=1`.
- `LUCIDA_AUTH=google requires LUCIDA_GOOGLE_CLIENT_ID`, or `_CLIENT_SECRET`,
  or `LUCIDA_OAUTH_REDIRECT_URI`. A missing Secret fails earlier, as
  `CreateContainerConfigError`.
- `LUCIDA_AUTH=iap requires LUCIDA_IAP_AUDIENCE`.
- `IAP key set fetch failed`. The pod can't reach
  `https://www.gstatic.com/iap/verify/public_key-jwk`.
- `cannot open the database at postgres://<redacted>@...`. Lucida gives up
  after 3 seconds. Check host, port, password, and NetworkPolicy.
- `cannot migrate the database at ...`. Usually a role that can't create
  tables.
- Permission errors on `/var/lib/lucida/lucida.db`. The image runs as root,
  so a `restricted` PodSecurity profile needs a non-root `securityContext`
  and matching volume permissions.

If sign-in loses its session cookie, check `LUCIDA_COOKIE_SECURE=always`
(the template sets it) and the redirect URI.

## 7. First admin

Admins come only from `LUCIDA_ADMIN_EMAILS`, which starts empty. It is read
at startup, so each change needs a restart. Admin status is computed per
request, so signed-in users don't need to sign in again.

## 8. Persistence and backups

On SQLite, the state is the `LUCIDA_DB_URL` file plus its `-wal` and `-shm`
files, a few megabytes. Copying `lucida.db` alone during writes gives a torn
copy. Scale to 0 and copy all three, or run
`sqlite3 lucida.db ".backup '/path/backup.db'"` from a sidecar on the same
volume, since the image has no `sqlite3`. On PostgreSQL, nothing on the
pod's disk is authoritative.

The proxy cache can be rebuilt from its sources. Lucida only reads
`LUCIDA_DATA_DIR`.

## 9. Updating to a new release

Change the image tag and apply. The `Recreate` rollout stops the old pod
first, so expect tens of seconds of downtime; the network-database shape has
none. `kubectl -n <YOUR-NAMESPACE> rollout undo deployment/lucida` rolls
back, but migrations are forward-only on both backends. Back up before a
release whose notes mention a migration.

## Environment variables

`lucida-server --help` lists the tuning flags not shown here, with their
variables.

| Variable | Default | What it sets |
| --- | --- | --- |
| `LUCIDA_BIND` | `127.0.0.1:9876`; the image sets `0.0.0.0:9876` | Listen address |
| `LUCIDA_DB_URL` | `sqlite://lucida.db` | Storage backend. See step 1. |
| `LUCIDA_DATA_DIR` | unset: lists from `/` | Root the file picker is confined to |
| `LUCIDA_PROXY_CACHE_DIR` | `<user cache dir>/lucida/proxies` | Proxy cache directory |
| `LUCIDA_PROXY_CONCURRENCY` | half the CPUs | Per-generator concurrency cap |
| `LUCIDA_LOG_FORMAT` | `text` | `json` for structured logs |
| `LUCIDA_WEB_DIST` | `./lucida-web/dist`; set in the image | Web UI bundle |
| `LUCIDA_THEME_FILE` | unset or blank: built-in theme | Default appearance and token overrides. See the README's [Theme a deployment](../../README.md#theme-a-deployment). |
| `LUCIDA_AUTH` | `disabled` on a loopback bind, else `google` | `google`, `iap`, or `disabled` |
| `LUCIDA_INSECURE` | unset | `1` allows `disabled` on a non-loopback bind |
| `LUCIDA_GOOGLE_CLIENT_ID`, `LUCIDA_GOOGLE_CLIENT_SECRET`, `LUCIDA_OAUTH_REDIRECT_URI` | none | Required for `google` |
| `LUCIDA_ALLOWED_HOSTED_DOMAINS` | unset: any Google account | Comma-separated Workspace domains, `google` only |
| `LUCIDA_IAP_AUDIENCE` | none | Required for `iap` |
| `LUCIDA_ADMIN_EMAILS` | unset: no admins | Comma-separated, case-insensitive, every mode |
| `LUCIDA_COOKIE_SECURE` | `auto`, from the request scheme | `always` behind a TLS-terminating ingress, or `never` |
| `LUCIDA_COOKIE_NAME` | `lucida_session` | Session cookie name |
| `LUCIDA_SESSION_IDLE_TIMEOUT_HOURS` | `168` | Idle session lifetime |
| `LUCIDA_SESSION_HARD_CAP_HOURS` | `720` | Maximum session lifetime |

### Profile directory

Behind a perimeter the server learns only an email. A JSON array of people,
one object each, fills in names and pictures in every auth mode. It never
changes the email, admin rights, or who can sign in.

| Variable | Default | What it sets |
| --- | --- | --- |
| `LUCIDA_DIRECTORY_URL` | unset or blank: off | The listing, over `http` or `https` |
| `LUCIDA_DIRECTORY_EMAIL_FIELD` | `email` | Key holding the address. Rows without one are skipped. |
| `LUCIDA_DIRECTORY_NAME_FIELDS` | `name` | Space-separated keys, joined by a space for the display name |
| `LUCIDA_DIRECTORY_PICTURE_FIELD` | `picture` | Key holding the picture URL |
| `LUCIDA_DIRECTORY_HEADERS` | none | `Name: value` pairs separated by semicolons |
| `LUCIDA_DIRECTORY_REFRESH_SECONDS` | `21600` (6 hours) | Refresh interval |

A malformed value, or a field variable set but blank, stops the boot. The
listing lives in memory and refreshes in the background with a 10-second
timeout, so requests never wait on it. Down at startup, the server serves
derived names and retries from 30 seconds, doubling to 10 minutes. A failed
or empty refresh keeps the last good copy. Events log as `auth.directory.*`
and never name a person.

### Status route

For a monitor that polls dependency state. A `GET` on `LUCIDA_STATUS_PATH`
runs one query with a 2-second timeout and answers 200 either way, with
`connected: false` and `message: "Failure"` when the query fails:

    {"details": {"dependencies": {"database": [
      {"resource_name": "lucida", "connected": true, "message": "Success"}
    ]}}}

| Variable | Default | What it sets |
| --- | --- | --- |
| `LUCIDA_STATUS_PATH` | unset: off | Mount path. Starts with `/`, no whitespace or `?#{}`, not a probe path. |
| `LUCIDA_STATUS_LABEL` | `database` | The key under `dependencies` |
| `LUCIDA_STATUS_RESOURCE_NAME` | database name from `LUCIDA_DB_URL` | `resource_name`. Required if the URL names no database. |

The route needs no session, and the body carries no host or credential. An
invalid path, or a label or resource name set but blank, stops the boot.
