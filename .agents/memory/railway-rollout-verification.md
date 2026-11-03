---
name: Railway rollout verification
description: How to confirm Invented's Railway auto-deployment after a GitHub main push.
---

Use the public Railway app as the source of truth for whether a pushed change is deployed. GitHub's deployments endpoint may not show Railway's build, and the live app may serve the previous version briefly after main advances.

**Why:** The repository main branch advanced before the public Railway dashboard and API changed; later, the live app updated without a matching GitHub deployment record.

**How to apply:** After a push, allow time for the automatic rollout, then verify a user-visible dashboard change and the corresponding `/api/healthz` and `/api/state` values before reporting success.

Railway can remain on “creating container”/`in_progress` for several minutes while the previous app version continues serving traffic; a delayed status alone does not prove the rollout failed.

**Why:** The Pumpfun deployment stayed on the old API and dashboard for about six minutes after the push, then switched to the threshold-only version and reset its in-memory ledger.

**How to apply:** Verify the public API and page directly after a push, and check the paper ledger after the rollout. Do not infer success or failure from the deployment label alone.

The workspace's local `main` may be a separate backup history rather than the GitHub deployment source. In that case, push the updated files as a new commit based on the latest GitHub `main` via the connected GitHub integration; do not force-update the branch from the local mirror.

**Why:** the local checkout had no GitHub remote and its `main` did not match the current GitHub branch, which had newer settlement changes.

**How to apply:** check the GitHub `main` tip before pushing, preserve it as the new commit's parent, then verify the external Railway app rather than assuming a GitHub commit alone means deployment succeeded.

The paper ledger is process memory and resets on redeploy. Before production rollout, compare the live balance, trade count, and open positions, and tell the user if the update will reset them; preserve the ledger first when history must survive.

**Why:** A Railway rollout reset the live bot from a populated paper ledger to its default bankroll and empty history.

**How to apply:** A healthy HTTP check does not prove account state survived. Confirm the intended reset/persistence behavior before publishing, then compare the live ledger after rollout.

The local Git remote may reject pushes even when the GitHub App connection is available. Publish with the connected GitHub integration, based on the current remote `main` tip, then verify the Railway app directly.

**Why:** The worktree's HTTPS push had no accepted credentials, while the connected GitHub App could create a commit and advance `main`.

**How to apply:** Check the latest GitHub `main` SHA first; use Git Data API to create a tree/commit and update the branch without force-pushing. For text files, send inline `content` entries in one tree request rather than parallel per-file blob requests. Verify the public Railway health, state, and page after rollout.

**Why inline tree content:** Concurrent blob writes through the GitHub connector can hit HTTP 429 limits. One tree request avoids that burst; honor retry delays on rate-limit responses.

If the public app still serves the old version after the expected rollout window, inspect Railway's deployment state and build logs rather than polling the app indefinitely. When the pushed commit is attached to the correct service and the build failed for a transient Railway infrastructure error, retry that same deployment, then verify the public app.

**Why:** A Railway build daemon connection failure left the previous version live; retrying the failed deployment of the same commit succeeded without code changes.

**How to apply:** Confirm the service's GitHub repository and commit SHA, inspect its latest deployment status and build logs, and only retry when the failure is transient and the intended commit is attached.

When porting a strategy change from a stale local checkout onto GitHub `main`, preserve unrelated market-data polling methods and test the full runtime path. Broadly deleting a block of legacy strategy methods can remove a quote-refresh helper the new loop still calls.

**Why:** The production scanner started reporting `this.refreshLiveQuotes is not a function` after a strategy port removed that helper; a follow-up commit restored it.

**How to apply:** Before pushing, check that every method called by the scan loop still exists, then exercise quote refresh and an exit in a smoke test.

The local trading-bot files may live under `pumpfun-src/`, while Railway builds them from repository-root paths such as `artifacts/api-server/`. Map the local prefix to the deployed root; do not push the workspace path verbatim.

**Why:** A successful Railway build still served the old strategy because the commit changed a duplicate nested directory instead of the configured service source.

**How to apply:** Check the service's source root and confirm the changed path in GitHub's tree before pushing. Verify the public API and dashboard report the new strategy after the rollout.
