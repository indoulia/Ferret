---
name: ferret-production-validation
description: Validate Ferret behavior against live or deployment-like environments without confusing observation, inference, and historical evidence.
---

# Ferret Production Validation

Use this skill for live validation, gate evidence, deployment verification, and production investigations.

## Safety

- Read-only by default.
- Never trigger jobs, mutate data, change secrets, alter Kubernetes resources, or deploy without explicit authorization.
- Prefer the current production context and verify the context before every consequential cluster operation.
- Never print credential values.

## Evidence order

1. Verify the running image identity and content.
2. Verify live configuration without exposing secrets.
3. Observe the real execution or user-visible behavior.
4. Capture independent evidence where the criterion requires corroboration.
5. Map the observation to the exact acceptance criterion.

## Evidence vocabulary

Use precisely:
- `OBSERVED` — directly seen in the target environment.
- `MEASURED` — numeric or state result directly measured.
- `INFERRED` — conclusion supported by evidence but not directly observed.
- `HISTORICAL` — evidence from an earlier environment/run.
- `NOT OBSERVED` — the required observation did not occur; never reconstruct it.

## Production truth

- Current production evidence outranks stale cluster evidence and green tests.
- A passing application self-report is not independent corroboration of that same property.
- If a scheduled execution is required, observe the natural scheduled execution rather than manually triggering it unless explicitly authorized.
- If evidence is perishable, capture it before logs/events are garbage-collected.

## Gate handling

For each criterion record:
- status
- exact environment
- timestamp
- execution/job identity
- evidence source
- whether evidence is perishable
- remaining gaps

Do not close a gate merely because its implementation exists.

## Deployment verification

After an authorized deployment, verify:
- expected image is actually running, not merely present on the node
- expected configuration is active
- health endpoint works externally and internally where useful
- scheduled resources remain unchanged unless intentionally changed
- relevant behavior occurs naturally

If a deployment script reports failure but the rollout may have succeeded, independently verify the live state before drawing a conclusion.
