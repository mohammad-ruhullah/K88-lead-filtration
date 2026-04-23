# AGENTS.md

## Project Objective
Build a Vite + React + TypeScript + Tailwind web app that:
1) runs DuckDB-Wasm in the browser,
2) loads user-selected very large CSV files (4+ files supported),
3) filters data based on user criteria,
4) produces one final merged dataset using UNION semantics,
5) exports result without server-side processing.

## Non-Negotiable Constraints
- All data ingestion, filtering, union, and export must run in the user's browser.
- Prioritize efficiency and memory safety for million-row CSV inputs.
- Do not send dataset rows to any backend service.

## Huge File Safety Disclaimer (MANDATORY)
- DO NOT EVER TRY TO READ THESE FILES FULL.
- For inspection/debugging, only read tiny slices (e.g. first 5-50 lines).
- Use small previews only (`Read` with low limit or `head -n` style command).
- Never run commands that print full file contents.
- In app code, avoid loading full CSV content into JS strings/arrays when file handles can be registered directly with DuckDB-Wasm.

## Source Datasets (Current)
- User will pick files from local machine at runtime (do not assume fixed filesystem paths).
- Current sample files used during development:
- `From_500_To_Beyond_1_of_4.csv`
- `From_500_To_Beyond_2_of_4.csv`
- `From_500_To_Beyond_3_of_4.csv`
- `From_500_To_Beyond_4_of_4.csv`

## Confirmed Data Strategy
- Combine datasets with UNION (not JOIN).
- Default union operator: `UNION ALL BY NAME` to preserve all rows and tolerate schema drift.
- Support dynamic number of input files (not fixed to exactly 4).
- If deduplication is later required, add an optional dedupe stage as a separate feature.

## Architecture Direction
- DuckDB-Wasm service layer for:
  - instantiate DB/worker once,
  - manage a single long-lived connection,
  - register user-selected local CSV file handles,
  - execute SQL queries for filtering/union,
  - export result files via `COPY ... TO` + `copyFileToBuffer`.
- React UI layer for:
  - file status,
  - filter builder,
  - query preview,
  - export action.
- SQL-first data pipeline (push filtering and union into DuckDB, not JS loops).

## Iterative Feature Roadmap
1. Foundation: DuckDB service + lifecycle states.
2. File registration: load N CSV file handles from file picker and validate schema/header.
3. Filter model: typed criteria and SQL generation.
4. Union pipeline: create merged filtered result table/view.
5. Preview: sampled result rows and row counts.
6. Export: download final merged dataset as CSV.
7. Performance hardening: memory/thread tuning, cleanup, and UX improvements.

## Done Criteria Per Feature
- Feature code is implemented and wired to UI.
- Large-file safety rules remain respected.
- No server dependency is introduced.
- Basic manual validation steps are documented in this file.
- AGENTS.md is updated with decisions, risks, and next step.

## Decision Log
- 2026-04-21: Created AGENTS.md as project control file.
- 2026-04-21: Confirmed union-based merge strategy.
- 2026-04-21: Added mandatory huge-file disclaimer and dataset inventory.
- 2026-04-21: Implemented Feature 1 with singleton DuckDB runtime service and app-level lifecycle UI states (`idle`, `initializing`, `ready`, `error`).
- 2026-04-21: Foundation keeps one long-lived DuckDB connection per app session.
- 2026-04-21: Updated requirement to support user-selected local files (dynamic count: 4/5/6+).
- 2026-04-21: Implemented Feature 2 with multi-file picker, small-slice header validation, and DuckDB file-handle registration.
- 2026-04-21: Implemented filter criteria model with fixed rule `CURRENT_CASH_BALANCE >= 5000`.
- 2026-04-21: Materialized merged filtered result as temp view `merged_filtered_dataset` using UNION-compatible multi-file read (`union_by_name = true`).
- 2026-04-21: Implemented CSV-only export from temp view via `COPY ... TO` + `copyFileToBuffer` and browser download.
- 2026-04-21: Switched filter pipeline from prepared parameters to direct SQL execution due DuckDB-Wasm binder limitation (`Unexpected prepared parameter` for this query shape).

## Basic Manual Validation (Feature 1)
1. Run `pnpm dev`.
2. Open the app in browser.
3. Confirm status moves from `Initializing` to `Ready`.
4. Confirm a DuckDB version string appears in the runtime card.
5. Confirm no network/backend API is required for initialization.

## Basic Manual Validation (Feature 2)
1. Run `pnpm dev`.
2. In the app, click `Select CSV Files` and choose 4+ matching CSV files from any folder.
3. Confirm status becomes `Registered` and file count matches selection.
4. Confirm virtual file paths appear in the file registration list.
5. Try selecting one file with a different header and confirm schema mismatch is reported.

## Basic Manual Validation (Feature 3/4/5)
1. After registering files, click `Run Filter`.
2. Confirm filter rule shown is `CURRENT_CASH_BALANCE >= 5000`.
3. Confirm status moves to `Ready` and a filtered row count is displayed.
4. Confirm preview rows are shown (limited sample, not full dataset materialization in JS).
5. Confirm message states temp view `merged_filtered_dataset` is ready.

## Basic Manual Validation (Feature 6)
1. After filter status is `Ready`, click `Download CSV`.
2. Confirm a `.csv` file downloads in browser.
3. Open the downloaded file and confirm rows satisfy `CURRENT_CASH_BALANCE >= 5000`.

## Next Feature To Build
- Feature 7: performance hardening and memory-focused UX safeguards.
