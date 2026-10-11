# Track maintenance

Track is a private betting journal with a public static shell at `/track/`. Its authenticated API owns every ledger record. Keep all personal balances, tickets, goals, PIN material and credentials outside source and built assets.

Follow the parent workspace deployment and privacy instructions. Preserve the standalone repository, deploy only the `track` Firebase Functions codebase, and do not change shared Firestore rules or other apps. Do not add a CNAME.

Verify with source review, typecheck, tests, builds, Firebase tooling and GitHub Actions. Never open the deployed site or a browser preview for verification. Run the upcheck before reporting health.

Recommendations are not placed wagers. Only explicit placement confirmations and confirmed settlements may change available funds. Keep writes idempotent, transactional and auditable. Never execute wagers or orders.
