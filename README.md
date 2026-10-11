# Track

A private betting journal at `/track/`: a static six-ledger interface and a separately authenticated Firebase API. The owner views records; maintenance and ticket confirmations happen through the associated chat.

## Development and verification

Use Node 22 and pnpm 11.25. Run `pnpm install`, then `pnpm upcheck` for type checks, accounting/authentication tests, build and static artifact checks. Verify from source and deployment tooling only; the owner checks production. Do not open browser previews or the deployed site for verification.

The Pages workflow deploys the shell after a push to main. Deploy only this backend using `firebase deploy --only functions:track --project pickledgerpro`. This repository deliberately contains no Firestore rules or CNAME.

## Private data and access

Runtime balances, goals, staking policies and wagers enter through the service-only bootstrap and event APIs. They never belong in Git. The server uses the isolated `track_private/journal` namespace; existing Firestore client rules deny direct access. Server-check the access code with a scrypt hash stored in `TRACK_PIN_HASH`; `TRACK_SERVICE_TOKEN` authorizes the updater. The API uses `X-Track-Authorization: Bearer <token>` so platform authentication does not intercept application tokens. Browser sessions are read-only, live only in memory and expire after twelve hours. Login attempts have per-address and global limits.

The updater reads an owner-only credential file outside the repository. `scripts/track-client.mjs` accepts `state`, `bootstrap`, `event` and `cards`; mutation payloads must also live outside the repository. Credentials are never included in routine prompts. `shared/types.ts` defines the API input and display types. Secrets are set separately and only their names are in source.

## Accounting and research

Cards remain proposals until placement is explicitly confirmed. Calculated outcomes remain pending until actual app settlement is confirmed. Entries use integer cents, idempotency keys and transactions. Returns include the stake; realized profit deducts stake and fees. Append corrections with a reference and explanation instead of rewriting history. Recent tickets are returned in the dashboard; complete tickets and events remain in private server storage.

Each daily run checks current source availability, offered prices, settlement terms, lineup dependencies, correlations and the private loss-review log before proposing any stake. Missing required evidence produces a no-bet record. Odds-implied probability is never described as a validated likelihood. Review losses against the information available before placement; distinguish process mistakes, missing evidence and ordinary outcome uncertainty. Do not change selection rules based on a single result or increase stakes to recover losses.
