# HearthKeeper working rules

## Rule 1: Work on main
All work happens on `main`; push to `main` when finished. This overrides any session-assigned branch (e.g. `ccr-*`): don't create or push other branches.

## Rule 2: Test-driven development
Write the test first and run it to see it fail (red). Then write the code that makes it pass (green). No feature code without a prior failing test.

## Rule 3: E2E browser tests at desktop and mobile
Every feature needs e2e browser tests (`npm run test:e2e`, files in `e2e/`) at both a desktop and a mobile resolution. It is not done until both pass.

## Rule 4: Concise rules
Write every rule as concisely as possible without losing any detail.
