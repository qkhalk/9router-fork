---
title: Fix 5 bugs Model Proxy Filter multi-subscription
date: 2026-09-28
summary: "Slice ranking uu tien config thieu ket qua tuoi, dirty-flag re-run auto-filter, api-mode ghi nguoc latency, skip reason len UI, bulkUpsert giu identity sub dau"
---

# Fix 5 bugs Model Proxy Filter multi-subscription

## What happened
Research chuoi /dashboard/xray multi-subscription (reports/Research-260928-...) chi ra 5 bugs o Model Proxy Filter khi dung nhieu subscription:

1. **Top-N starvation (nang nhat):** `filterConfigsByModel` slice top-N theo sort latency (`configs.slice(0, limit)`, manager.js) — server cua sub moi (chua co latency) sort xuong cuoi, khong bao gio duoc test, va vi rotation candidates lay tu model-filter results + health-rotate can latency nen server chua test vo hinh voi ca 2 duong rotation.
2. **Skip-on-conflict:** auto-filter trigger khi filter dang chay bi nuot im lang (`runModelFilterJob` tra `{skipped: already_running}`).
3. **api-mode khong ghi nguoc latency** vao `xrayConfigs` (chi spawn-mode goi `updateXrayTestResult`).
4. **Skip reason chi log console**, UI khong biet.
5. **Cosmetic:** server trung o 2 sub bi sub sync sau ghi de name/link/country (state test thi GIU NGUYEN nhu da research).

## Decision
Chon fix 1' "uu tien thieu + tai thi dung han" sau khi user hoi ve cache staleness: sort key = chua co ket qua tuoi (untested HOAC cache het TTL 24h) len dau slice; server tot van duoc tai thi dung chu ky TTL. Cac fix khac theo huong nho nhat: coalesced re-run (dirty-flag, khong queue), write-back trong `makeApiProbeFn` (khong sua apiFilter de tranh import moi), skip fields vao `modelFilterState` (tu dong flow qua `/api/xray/status`), bulkUpsert `CASE WHEN COALESCE(name,'')=''` giu identity cua sub dau.

## Changes
- `src/lib/xray/manager.js`: `orderConfigsForFilterSelection` (export, pure), `isDueForProbe` predicate dung chung cho ranking + toTest, maps build tren toan catalog truoc slice, `makeApiProbeFn` write-back (+ export `_makeApiProbeFn`), `runModelFilterJob` them `queueRerunIfBusy` + latch `autoFilterRerunQueued` + autoFilterSkip{Reason,At} vao state, `runModelFilterFromSettings` truyen `queueRerunIfBusy: true`.
- `src/lib/db/repos/xrayRepo.js`: `bulkUpsertXrayConfigs` ON CONFLICT giu link/name/country khi existing co ten.
- `src/app/(dashboard)/dashboard/xray/page.js`: hien dong "Auto-filter skipped (...) — re-runs automatically" vang canh.
- Tests moi: `tests/unit/xray-filter-multi-sub-fixes.test.js` (7 tests: ranking, write-back, latch e2e, manual-khong-latch), `tests/unit/xray-config-identity-upsert.test.js` (3 tests, real better-sqlite3 adapter).

## Verification
- 2 test file moi: 10/10 pass.
- Toan bo 21 file test xray hien co: 144 passed / 5 skipped (skip co san), khong regression.
- impact analysis truoc edit: 2 symbols HIGH (runModelFilterJob, runModelFilterFromSettings) do fan-out module — thay doi deu additive. detect_changes sau edit: MEDIUM, dung pham vi 3 files.
- Lint: 1 error pre-existing tai page.js:313 (set-state-in-effect, ngoai scope).

## Next steps
- Monitored rollout: sau sync sub moi, kiem tra server sub moi xuat hien trong ket qua filter (khong con nam cuoi danh sach).
- Neu muon phu 100% ngay: van con nut "Test all active" (xrayModelFilterAll) nhu workaround.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
