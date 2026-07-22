# Task Plan: Automated test coverage

## Goal
Add a Vitest suite with v8-enforced ≥90% coverage for the add-on JavaScript.

## Current Phase
Phase 1 — discovery

## Phases
### Phase 1: Requirements & Discovery
- [x] Confirm test-stack decision
- [x] Map public seams and Zotero/Gecko dependencies
- **Status:** complete

### Phase 2: Test Design
- [x] Define coverage scope and thresholds
- [ ] Define reusable mocks and test fixtures
- **Status:** in_progress

### Phase 3: Implementation
- [ ] Add Yarn/Vitest tooling
- [ ] Add tests and minimal testability seams
- **Status:** pending

### Phase 4: Verification
- [ ] Run coverage and meet thresholds
- [ ] Run syntax checks
- **Status:** pending

### Phase 5: Delivery
- [ ] Review changed files and report results
- **Status:** pending

## Decisions Made
| Decision | Rationale |
|---|---|
| Vitest with v8 coverage | User-approved; supports mock-heavy isolated execution and CI thresholds. |

## Errors Encountered
| Error | Attempt | Resolution |
|---|---:|---|
| None | — | — |
