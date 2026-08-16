# Accelerated Dual-Tier Model Execution Plan

## Decision

ReconcileAI will maintain **two supported self-hosted serving tiers**. The choice is
made from the institution's infrastructure, capacity evidence, and control
requirements—not from a different application codebase.

| Tier | Intended institution | Intelligence layer | Serving runtime | Deployment posture |
|---|---|---|---|---|
| **CPU tier** | Institutions without GPU infrastructure | Approved, quantized Qwen derivative | Ollama | Private, offline-capable CPU deployment |
| **GPU tier** | Institutions with an approved NVIDIA GPU environment | Approved Qwen artifact, initially evaluated against Qwen3 8B/14B and 30B-A3B candidates | vLLM | Private authenticated service behind the institution's gateway |

The deterministic reconciliation engine remains the source of truth for transaction
matching, balances, postings, settlement finality, and any consequential action.
The model is restricted to structured explanation, classification, evidence
summarisation, and analyst recommendations. It must never be empowered to execute a
payment, alter a ledger, or approve a write-off.

## What is already implemented

The CPU profile now supports a first-class offline import path for a verified GGUF
artifact and keeps Ollama off host ports. The GPU profile provides an internal-only
vLLM service with application-to-model authentication, an immutable model-revision
contract, request-content logging disabled, and host-loopback application binding.
Both profiles activate ReconcileAI's fail-closed `on_premise` egress guard.

> These implementation controls provide a safe technical baseline. They do not
> replace an institution's security architecture, model-risk governance, legal
> review, operational resilience testing, or change approval.

## Six-week accelerated programme

The original 90-day approach can be compressed to six weeks only by running the
CPU and GPU workstreams in parallel and by preparing the institution-facing control
evidence from the first day. The non-negotiable gate is that no real bank or customer
data leaves the institution-controlled environment.

| Week | Parallel work | CPU/Ollama exit evidence | GPU/Qwen/vLLM exit evidence | Control gate |
|---|---|---|---|---|
| **1** | Freeze permitted use cases, prohibited actions, output schema, model inventory, and rollback owner. | GGUF packaging plan and SHA-256 manifest agreed. | Candidate model, immutable revision, GPU capacity target, and vLLM image review record agreed. | Deterministic engine formally confirmed as decision authority. |
| **2** | Prepare a bank-internal, human-labelled evaluation set; do not upload it to external services. | Imported model completes offline startup and produces schema-valid outputs. | Private vLLM starts from pre-staged artifact and passes authenticated API smoke test. | Provenance, licence, SBOM, and vulnerability-review evidence recorded. |
| **3** | Run functional and security validation in parallel. | Residency guard, private-network, model-import, and rollback tests pass. | Gateway design, service identity, private-network, rate-limit, and rollback tests pass. | Threat model and prompt/tool-abuse tests accepted by security owner. |
| **4** | Measure quality and capacity on the institution's internal evaluation set. | JSON validity, category precision/recall, latency, and failure handling measured. | Same quality measures plus concurrency, GPU memory, and queue behaviour measured. | Acceptance thresholds met or documented remediation approved. |
| **5** | Limited, read-only operational pilot with human approval in the loop. | Analyst recommendations are sampled and reconciled against deterministic evidence. | Same analyst validation with API and audit evidence retained. | No automatic posting, closure, payment, or customer communication. |
| **6** | Joint go/no-go review and production package sign-off. | Offline package, checksums, installation record, and rollback rehearsal complete. | Pinned image/model release, secrets, gateway configuration, and rollback rehearsal complete. | Model-risk, security, operations, and business owners sign the decision. |

## Evidence and acceptance thresholds

The pilot should adopt a single scorecard across both tiers so a bank can choose the
lowest-cost serving tier that meets the intended use case. The thresholds below are
initial product gates; an institution can impose stricter thresholds.

| Measure | Gate | Evidence |
|---|---:|---|
| Structured-response validity | ≥99% | Versioned evaluation harness output |
| Exception category quality | ≥95% on human-labelled internal cases | Confusion matrix and sample audit |
| Unsafe consequential action | 0 | Adversarial prompt and permission test record |
| Deterministic-output disagreement | Investigated before release | Linked exception, evidence, and reviewer outcome |
| CPU latency | Bank-agreed, measured at planned concurrency | Capacity test report |
| GPU throughput and tail latency | Bank-agreed, measured at planned concurrency | Capacity test report |
| Recovery | Documented and rehearsed | Rollback and restore evidence |

## Execution responsibilities

| Owner | Immediate responsibility |
|---|---|
| **Richard / Infinity AI** | Select the first pilot institution, appoint business and technical sponsors, approve use-case boundaries, and obtain access to an internal evaluation environment. |
| **ReconcileAI engineering** | Package the CPU GGUF artifact, complete evaluation harnesses, maintain both Compose profiles, and collect technical evidence. |
| **Claude Code** | Review and harden every implementation pull request, particularly secrets, image pinning, input validation, error handling, and deployment safety. |
| **Institution** | Retain control of real data, approve model and image artifacts, provide the gateway and identity controls, perform model-risk/security review, and authorise any pilot. |

## Decision rule

Select the **CPU/Ollama tier** when it meets the bank's validated use case and
throughput requirements, because it avoids a GPU dependency while retaining private,
offline-capable operation. Select the **GPU/Qwen/vLLM tier** when the institution
needs the additional model capability or concurrent throughput and can operate the
required GPU, gateway, identity, monitoring, and model-governance controls.

Neither tier is activated for a bank merely because it starts. Production use begins
only after the six-week evidence gates are complete and the institution has approved
the release.

## References

[1] [Qwen vLLM Deployment Guide](https://qwen.readthedocs.io/en/latest/deployment/vllm.html)

[2] [Qwen3-30B-A3B-Instruct-2507 Model Card](https://huggingface.co/Qwen/Qwen3-30B-A3B-Instruct-2507)
