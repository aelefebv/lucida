---
type: Decision
title: "Deployment Artifacts Are Reference Templates, Not Opinionated Infra"
description: "The deployment artifacts shipped in extras/deploy/ are raw YAML reference templates with <PLACEHOLDER> values, not packaged infrastructure."
tags: [lucida, decision]
source_path: wiki/decisions/0021-deployment-artifacts-as-reference-templates.md
created: 2026-05-13
modified: 2026-06-25
---

# Deployment Artifacts Are Reference Templates, Not Opinionated Infra

> Status: Accepted (implemented; PRD #486). The `extras/deploy/` manifests, `docker-compose.yml`, and `RUNBOOK.md` all exist.

## Decision

The deployment artifacts shipped in `extras/deploy/` are **raw YAML reference templates with `<PLACEHOLDER>` values**, not packaged infrastructure. No Helm chart, no Kustomize overlay, no provider-specific resources (no `BackendConfig`, no `ManagedCertificate`, no hardcoded storage class) live in the upstream lucida repo. Adopters copy the manifests, replace placeholders, and own them from there. A generic `RUNBOOK.md` next to the manifests walks through first-time setup with placeholder syntax that any organization can fork.

## Why

Lucida is open-source and intentionally OSS-permissive ([Configurable From Day One for OSS Release](0017-configurable-from-day-one-for-oss-release.md)). The deployment surface should be analogous to the configuration surface — every adopter-specific value is supplied by the adopter, not baked in.

Three real alternatives existed:

1. **Helm chart.** Standard practice for OSS Kubernetes apps. Powerful templating, values-file ergonomics, OCI chart registry distribution.
2. **Kustomize overlay structure** — `base/` with the common resources, `examples/<flavor>/` with overlays demonstrating different cloud topologies.
3. **Raw YAML with `<PLACEHOLDER>` values** — one file per resource, adopter copies and edits.

(3) wins for lucida's scale and posture for three reasons:

**Documentation-by-example.** Raw YAML reads like documentation. An adopter scanning `deployment.yaml` sees what fields exist and what defaults are supplied; an adopter scanning a Helm `values.yaml.example` sees Helm syntax that the adopter must mentally expand. For a project whose primary deployment is a single Deployment + Service + PVC + Ingress, the Helm overhead delivers nothing but layered abstraction.

**Maintenance burden is real.** Helm charts have their own release cadence (chart versioning separate from app versioning), their own distribution surface (OCI chart registries, `helm repo` indexes), and their own bug surface (templating bugs that don't appear without a real adopter trying to install). Taking on that maintenance is a multi-month commitment that lucida is not currently positioned to make. Adopters who want chart packaging build their own (and the same Dockerfile + manifests support being wrapped by either Helm or Kustomize trivially).

**Adopter-tool diversity.** Some adopters use Helm. Some use Kustomize. Some use raw YAML in a `kubectl apply` pipeline. Some use Pulumi or CDK8s. Picking one tool privileges that adopter and forces every other adopter to wrap or unwrap. Picking *no* tool is the only neutral position.

The same logic applies to provider-specific resources. A `gke-internal-lb/` Kustomize overlay would help GKE adopters but actively confuse on-prem k3s or Talos adopters who would assume `BackendConfig` is required when it is irrelevant for them. The reference Ingress is generic with a comment block pointing at the deployment article's per-provider notes — every adopter customizes for their own infrastructure.

## Alternatives considered

- **(1) Helm chart.** Rejected — documented above. Lucida-the-project does not have the maintenance capacity for a chart release process alongside the app release process. Re-evaluate if/when a contributor wants to own chart maintenance long-term.
- **(2) Kustomize `base/` + `examples/`.** Rejected — also documented above. Layered abstraction without proportional benefit at lucida's scale; risks privileging certain cloud topologies via the example overlays.
- **Ship no manifests at all, document only in prose.** Rejected — leaves every adopter to write Deployment / Service / PVC YAML from scratch from the env-var contract, which is meaningful friction. Reference templates with placeholders are the lowest-friction artifact that does not lock anyone in.

## Consequences

- **`extras/deploy/k8s/` contents are documentation, not source.** Adopters fork. The upstream files exist to communicate "here is the shape of the deployment" — they are not designed to be `kubectl apply`'d directly without edits. The placeholders are obvious enough that this should not surprise anyone, but `RUNBOOK.md` says it explicitly.
- **Adopter customization is unbounded.** Some will wrap in Helm, some in Kustomize, some in plain shell with `envsubst`. The upstream cannot know what shape an adopter chose, which is the point.
- **Provider-specific guidance lives in `wiki/systems/subsystems/deployment.md`, not in the manifests.** The deployment article documents Workload Identity for GKE, IRSA for EKS, etc., as text. The manifests stay generic. Cross-cloud parity by reference, not by overlay.
- **CI validates manifest syntax, not behavior.** A `kubectl apply --dry-run=client -f extras/deploy/k8s/` step (with placeholders substituted to dummy strings) catches schema regressions; we do not run a real cluster in CI for this artifact.
- **`extras/deploy/RUNBOOK.md` carries weight.** The manifest-by-itself is incomplete; the RUNBOOK is the procedural counterpart. Both must stay accurate to the env-var contract.

## How this decision shows up in code

- `extras/deploy/k8s/{deployment,service,pvc,serviceaccount,ingress}.yaml` — five files, raw YAML, `<PLACEHOLDER>` syntax.
- `extras/deploy/docker-compose.yml` — small-deploy alternative; same posture (placeholder values).
- `extras/deploy/RUNBOOK.md` — step-by-step walkthrough using placeholder values.
- `wiki/systems/subsystems/deployment.md` — the conceptual reference these artifacts implement.
- *Conspicuous absence:* no `Chart.yaml`, no `kustomization.yaml`, no `values.yaml`, no provider-specific CRD examples in the upstream repo.

## Related

- PRD #486 — implementation specification
- [Configurable From Day One for OSS Release](0017-configurable-from-day-one-for-oss-release.md) — the OSS posture this extends from configuration to deployment
- [Single-Image Container with `ServeDir` is the Canonical Deploy Unit](0020-single-image-with-servedir.md) — the deploy unit these manifests reference
- [OSS Config Defaults and the LUCIDA_* Env Var Contract](../gotchas/oss-config-defaults.md) — env-var contract the manifests plug values into
