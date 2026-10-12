# HearthKeeper working rules

## Branching
- All work is done on `main` in this repo and pushed when finished.

## Test-driven development
- Write the test first and run it to confirm it fails (red).
- Only then write the code that makes it pass (green).
- Do not write feature code before a failing test exists for it.

## End-to-end browser tests
- Every feature needs e2e browser tests (`npm run test:e2e`, files in `e2e/`).
- Test at both a desktop and a mobile resolution. A feature is not done until both pass.
