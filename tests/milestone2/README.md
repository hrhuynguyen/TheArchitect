# Milestone 2 browser smoke

Run the committed two-context consensus and restart proof with:

```bash
npm run test:milestone2
```

Prerequisites are Docker and the Playwright Chromium browser
(`npx playwright install chromium`). The smoke owns an exact-name ephemeral
PostgreSQL container plus dynamically ported server and web child processes. It
migrates only that database and removes only those owned resources in teardown;
it does not use the repository's shared Compose volume.

The scenario creates a shared room in two isolated browser contexts, verifies
presence, bidirectional synchronized drawing, synchronized requirements,
restart recovery, readiness progress and the 80% gate, then queries its isolated
PostgreSQL database for the durable phase and exactly one `ready` transition job.
