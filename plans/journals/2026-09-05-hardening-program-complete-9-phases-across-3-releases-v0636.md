---
title: "Hardening program complete: 9 phases across 3 releases (v0.6.36-v0.6.38)"
date: 2026-09-05
summary: "Shipped the full 57-finding audit program: 45 fixes + alerts, circuit breaker, v2go scheduler, per-key budgets, cache analytics"
---

# Hardening program complete: 9 phases across 3 releases (v0.6.36-v0.6.38)

## What happened
Executed plans/260904-0344-hardening-alerts-breaker-budgets end to end in --auto mode across three releases:
- Release A **v0.6.36** (phases 01-04): 45 audit findings (P/X/C/S/N) + CI windows process-lifecycle job + stream fuzz harness.
- Release B **v0.6.37** (phases 05-06): alert system (TG/Discord/webhook, dedup, rate-limited queues, 6 wired events; 19+2 tests) and the per-account circuit breaker (closed/open/half-open, 60s×2 backoff cap 10 min, single real-request probe, R9 strike-block layering, dashboard panel; 18 tests).
- Release C **v0.6.38** (phases 07-09): xrayHealthCheckIntervalMin wired to a boot-armed scheduler with xray-rotation-failed alert (19 tests); per-API-key budgets (USD/tokens × daily/monthly, edge-triggered threshold alert, optional hard block 429+Retry-After+X-9Router-Budget, fresh indexed spend reads; 24 tests); cache analytics panel riding the existing usage stats payload (6 tests).

Process discipline held throughout: GitNexus impact() before every edited symbol (HIGH/CRITICAL reported with pre-decided mitigations, e.g. mergeWithDefaults CRITICAL = additive-defaults-only change), detect_changes() before every commit, and full-suite failing-set diffs vs the prior phase baseline as the regression gate in the broken test env.

## Key lessons this session
- The full-suite gate saved one real regression: 3 "new" failures after phase 07 turned out to be 5000ms timeout flakes under parallel load (all passed isolated; none touched edited modules) — evidence-based triage, not blind re-runs.
- Sharing one file across two phases (usageRepo had both getSpendForKey and getCacheAnalytics) was split into clean per-phase commits by temporarily stripping phase-09 hunks, committing 08, restoring, committing 09 — each commit stays green at checkout.
- Subagent delegation worked well for self-contained halves: the alerts module (phase 05) and the budget editor UI (phase 08) while the precise server wiring stayed local.
- JS gotcha hit twice: mixing ?? with || unparenthesized is a hard parse error (rolldown caught it); and heredoc-driven python edits must detect CRLF vs LF before multi-line replacements.

## Decision
- Budget enforcement placed in the chat handler's requireApiKey branch (single getApiKeyRow SELECT; unbudgeted keys short-circuit before any spend query). Documented scope caveat: budgets are inert unless Require API key is on.
- Cache hit-rate defined as cached/prompt per the plan (provider semantics vary; labeled "estimated"); pricing gaps render n/a, never $0.
- Deferred (documented): X-9Router-Budget: nearing-limit informational header on success responses (would mutate every response); alert-channel manual smoke test flagged for the release runbook (headless session cannot test TG/Discord/webhook delivery).

## Next steps
- Release runbook: manual alert-channel smoke (TG/Discord/webhook.site) against a live v0.6.38 install.
- Watch for breaker/modelLock interaction reports in the field (kill switch: breakerEnabled=false).
- Optional follow-ups from plan: per-API-key cache breakdown, cost-trend alerts, budget UI graphs.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
