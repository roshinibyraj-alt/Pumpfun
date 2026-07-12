# pump.fun Demo Trending Bot (Paper Trading — No Real Money)

This bot watches live pump.fun trade activity and, when a coin crosses your
"trending" thresholds, it **logs a simulated buy**. It never touches a real
wallet, private key, or real funds. It's for testing whether your strategy
even makes sense before you risk anything.

---

## Step 0 — Required: get a PumpPortal API key (do this first)

Token-creation events are free with no key. But the actual **trade data**
(needed to detect anything "trending" and trigger a simulated buy) requires
a PumpPortal API key tied to a wallet funded with a small amount of real SOL:

1. Go to https://pumpportal.fun and create a free account.
2. Generate an API key from your dashboard.
3. Send **0.02 SOL** (a few dollars) to the wallet linked to that key. This
   money is NOT used to buy any coins — it only covers PumpPortal's tiny
   metering fee for streaming trade data (0.01 SOL per 10,000 messages,
   which is pennies per day). The bot still never touches this wallet to
   place trades.
4. In Railway, go to your service → **Variables** tab → add a new variable:
   - Name: `PUMPPORTAL_API_KEY`
   - Value: (paste your key)
5. Railway will automatically redeploy with the key available.

Without this, the dashboard and logs will show tokens being discovered, but
"Trades Processed" will stay at 0 forever and no buy will ever trigger — this
is a PumpPortal requirement, not a bug in the bot.

---

## Step 1 — Put this code on GitHub

1. Go to https://github.com and log in.
2. Click the **+** icon (top right) → **New repository**.
3. Name it something like `pumpfun-demo-bot`. Keep it **Private** if you don't
   want it public. Click **Create repository**.
4. On the next page, click **uploading an existing file**.
5. Drag in all the files from this project: `bot.js`, `config.js`,
   `package.json`, `railway.json`, `.gitignore`, `README.md`.
6. Scroll down, click **Commit changes**.

You now have the code safely on GitHub.

---

## Step 2 — Deploy it on Railway

1. Go to https://railway.app and log in with your account.
2. Click **New Project** → **Deploy from GitHub repo**.
3. Authorize Railway to access your GitHub if asked, then select the
   `pumpfun-demo-bot` repo you just created.
4. Railway will detect it's a Node.js project and start building automatically
   (it reads `railway.json`, which tells it to run `node bot.js`).
5. Click into the new service → **Deployments** tab → wait for the build to
   finish (usually under a minute).
6. Click **View Logs**. You should start seeing lines like:
   ```
   === pump.fun DEMO trending bot starting ===
   DEMO_MODE = true (true = safe, no real money is ever used)
   Connecting to wss://pumpportal.fun/api/data ...
   Connected. Subscribing to new token + trade streams...
   Bot is live in DEMO (paper trading) mode. Watching for trending coins...
   🆕 New token: SOMECOIN (mint address...)
   ```
7. When a coin crosses your thresholds, you'll see a block like:
   ```
   🟢 SIMULATED BUY (no real funds used)
      Token: DOGEWIF
      Mint address: ABC123...
      Fake spend: 0.1 SOL
      Trigger stats: 18 trades / 9 unique buyers / 6.40 SOL volume in last 60s
      pump.fun link: https://pump.fun/ABC123...
   ---
   ```
   That's the bot telling you "if this were live, I would have bought here."

**That's it — it's now running 24/7 in the cloud, in safe demo mode.**

---

## Step 3 — Tune the strategy (optional)

Open `config.js` in GitHub (click the file → pencil icon to edit) and change
the numbers, for example:

- `MIN_TRADES_IN_WINDOW`: raise this to require more activity before it
  "trending"
- `WINDOW_SECONDS`: shorten to catch faster moves, lengthen to filter noise
- `FAKE_BUY_SIZE_SOL`: just cosmetic, doesn't spend anything

Every time you edit and commit a file on GitHub, Railway automatically
redeploys with the new settings within a minute or two.

---

## Step 4 — Watch it for a while before doing anything else

Let it run for at least a few days. Keep notes on:
- How many "simulated buys" per day it triggers
- Whether those coins actually kept climbing afterward, or dumped right after
  your trigger fired (very common on pump.fun)

This is the only way to know if the "trending = buy" idea is actually
survivable *before* any real money is involved.

---

## What this bot does NOT do (on purpose)

- It does **not** hold a wallet or private key.
- It does **not** place real trades.
- It does **not** guarantee catching every notification pump.fun's app shows
  you — it approximates the same signals (trade frequency, buyer count,
  volume) from the public data feed.

If you later want to move to real execution, that's a separate, much higher
stakes step (real wallet key, real funds, real slippage/latency risk) — happy
to help with that specifically when/if you get there, but I'd want you to
have watched demo logs for a while first so you know what you're actually
turning on.
