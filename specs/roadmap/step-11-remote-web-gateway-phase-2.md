# Step 11 Sub-Spec: Remote Web Gateway (Phase 2)

## Objective
Expose Lucida sessions in web browsers through a remote gateway while keeping desktop engine authority and v1 security posture constraints.

## What Lives in This Sub-Spec
- Gateway transport model (frame/tile streaming + input relay).
- Browser client session controls.
- Token/TLS requirements and bind defaults.
- Latency and degradation behavior over networks.

## Scope
In scope:
1. Single-user trusted-network remote access model.
2. Browser interaction loop backed by daemon session state.
3. Basic deployment guidance for secure exposure.

Out of scope:
1. Multi-tenant shared-host security model.
2. Full browser/desktop feature parity guarantee at launch.

## Interface and Contract Changes
- Define gateway-facing control/event bridge semantics.
- Preserve existing protocol contracts as source of truth.

## Deliverables
1. Gateway service prototype and client adapter.
2. Browser control and render-stream integration.
3. Network behavior and security docs.

## Test and Acceptance Gates
1. Remote browser sessions can control active daemon sessions reliably.
2. Token-protected access and TLS guidance are validated.
3. Degraded network conditions fail safely with clear errors.

## Dependencies
- Steps 01-10 foundational runtime and release maturity.

## Exit Criteria
Step 11 is complete when users can operate Lucida remotely in a browser for supported single-user workflows.
