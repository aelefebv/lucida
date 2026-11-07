# Deployment Artifacts Are Reference Templates, Not Opinionated Infra

Status: Accepted.

## Context

lucida keeps every adopter-specific value out of the code ([0017](0017-configurable-from-day-one-for-oss-release.md)), and deployment needs the same posture. A typical deployment is one Deployment, Service, PVC, and Ingress. Adopters use a mix of tools: Helm, Kustomize, plain `kubectl apply`, Pulumi, CDK8s.

## Decision

`extras/deploy/` ships raw YAML with `<PLACEHOLDER>` values (`k8s/` for Kubernetes, `docker-compose.yml` for small deployments) and a `RUNBOOK.md` that walks through first-time setup. Adopters copy the files, fill them in, and own them from there. The repo has no Helm chart, no Kustomize overlays, and no provider-specific resources such as `BackendConfig`, `ManagedCertificate`, or a fixed storage class. Provider notes, such as GKE Workload Identity or EKS IRSA, live as prose in the runbook.

The manifests are documentation and are not meant to be applied unedited. CI checks their schema with `kubectl apply --dry-run=client` after substituting dummy values, and runs no cluster.

## Rejected alternatives

- A Helm chart. It brings its own release cadence, distribution, and bugs, which the project cannot maintain alongside the app, and it favors Helm users over everyone else. Worth revisiting if a contributor wants to own it long-term.
- Kustomize `base/` plus example overlays. Layered abstraction without matching benefit, and provider overlays would lead adopters on other platforms to think those resources are required.
- No manifests, only prose. Every adopter would write the YAML from the env-var contract.

## Consequences

The runbook and the manifests must both track the env-var contract. Neither is complete alone.
