import { createHmac, timingSafeEqual } from "node:crypto";
import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";

const router: IRouter = Router();
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
let tradingClient: any;

function sessionToken(expires: number): string {
  return createHmac("sha256", process.env.TRADING_DASHBOARD_PASSWORD || "")
    .update(`polymarket-dashboard:${expires}`)
    .digest("hex");
}

function requireSession(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const password = process.env.TRADING_DASHBOARD_PASSWORD;
  const sessionCookie = String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("pm_session="));
  const [expiresText, signature] = sessionCookie
    ?.slice("pm_session=".length)
    .split(".") || [];
  const expires = Number(expiresText);

  if (
    !password ||
    !signature ||
    !Number.isSafeInteger(expires) ||
    expires < Date.now()
  ) {
    res.status(401).json({ error: "Sign in to trade." });
    return;
  }

  const expected = sessionToken(expires);
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    res.status(401).json({ error: "Session expired. Sign in again." });
    return;
  }

  next();
}

async function getClient(): Promise<any> {
  if (tradingClient) return tradingClient;
  if (!process.env.PRIVATE_KEY) {
    throw new Error("Polymarket signer is not configured.");
  }

  const sdkName = "@polymarket/client";
  const signerName = "@polymarket/client/viem";
  const sdk: any = await import(sdkName);
  const signer: any = await import(signerName);
  tradingClient = await sdk.createSecureClient({
    signer: signer.privateKey(process.env.PRIVATE_KEY),
  });
  return tradingClient;
}

function formatBaseUnits(value: bigint | string | number): string {
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function collectPages<T>(
  paginator: AsyncIterable<{ items: T[] }>,
): Promise<T[]> {
  const items: T[] = [];
  for await (const page of paginator) {
    items.push(...page.items);
  }
  return items;
}

function requireSameOrigin(req: Request, res: Response): boolean {
  const origin = req.get("origin");
  if (!origin || new URL(origin).host !== req.get("host")) {
    res.status(403).json({ error: "Cross-origin order requests are not allowed." });
    return false;
  }
  return true;
}

router.get("/markets", async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 24));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const params = new URLSearchParams({
      active: "true",
      closed: "false",
      limit: String(limit),
      offset: String(offset),
      order: "volume24hr",
      ascending: "false",
    });
    const url = search
      ? `${GAMMA}/public-search?q=${encodeURIComponent(search)}&events_status=active&limit=${limit}`
      : `${GAMMA}/markets?${params}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Market feed returned ${response.status}`);
    const data: any = await response.json();
    const markets = Array.isArray(data)
      ? data
      : data.markets ||
        data.events?.flatMap((event: any) => event.markets || []) ||
        [];
    res.set("Cache-Control", "public, max-age=5").json(markets);
  } catch (error: any) {
    res.status(502).json({ error: error.message || "Market feed unavailable" });
  }
});

router.get("/markets/book/:tokenId", async (req, res) => {
  if (!/^\d+$/.test(req.params.tokenId)) {
    res.status(400).json({ error: "Invalid outcome token." });
    return;
  }
  try {
    const response = await fetch(
      `${CLOB}/book?token_id=${encodeURIComponent(req.params.tokenId)}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!response.ok) throw new Error(`Order book returned ${response.status}`);
    res.set("Cache-Control", "no-store").json(await response.json());
  } catch (error: any) {
    res.status(502).json({ error: error.message || "Order book unavailable" });
  }
});

router.post("/trading/login", (req, res) => {
  const password = process.env.TRADING_DASHBOARD_PASSWORD;
  const provided =
    typeof req.body?.password === "string"
      ? Buffer.from(req.body.password)
      : Buffer.alloc(0);
  const expected = Buffer.from(password || "");

  if (
    !password ||
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    res.status(401).json({ error: "Password not accepted." });
    return;
  }

  const expires = Date.now() + 8 * 60 * 60 * 1000;
  res.setHeader(
    "Set-Cookie",
    `pm_session=${expires}.${sessionToken(expires)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`,
  );
  res.json({ authenticated: true });
});

router.post("/trading/logout", (_req, res) => {
  res.setHeader(
    "Set-Cookie",
    "pm_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
  );
  res.json({ authenticated: false });
});

router.get("/trading/status", requireSession, (_req, res) => {
  res.json({ configured: Boolean(process.env.PRIVATE_KEY), dashboard: "manual-only" });
});

router.get("/trading/account", requireSession, async (_req, res) => {
  try {
    const client = await getClient();
    const sdkName = "@polymarket/client";
    const sdk: any = await import(sdkName);
    const [orders, positions, collateral] = await Promise.all([
      collectPages(client.listOpenOrders({ pageSize: 100 })),
      collectPages(client.listPositions({ pageSize: 100 })),
      client.fetchBalanceAllowance({ assetType: sdk.AssetType.COLLATERAL }),
    ]);
    res.set("Cache-Control", "no-store").json({
      orders,
      positions,
      collateral: {
        balance: formatBaseUnits(collateral.balance),
        allowances: Object.fromEntries(
          Object.entries(collateral.allowances || {}).map(([address, amount]) => [
            address,
            String(amount),
          ]),
        ),
      },
    });
  } catch (error: any) {
    res.status(502).json({ error: error.message || "Account data unavailable." });
  }
});

router.post("/trading/orders", requireSession, async (req, res) => {
  try {
    if (!requireSameOrigin(req, res)) return;
    if (req.body?.geoBlocked !== false || req.body?.geoCountry === "AU") {
      res.status(403).json({ error: "Trading is disabled by Polymarket location rules." });
      return;
    }

    const { assetId, side, price, size } = req.body || {};
    const parsedPrice = Number(price);
    const parsedSize = Number(size);
    if (
      !/^\d+$/.test(String(assetId)) ||
      !["BUY", "SELL"].includes(side) ||
      !Number.isFinite(parsedPrice) ||
      parsedPrice <= 0 ||
      parsedPrice >= 1 ||
      !Number.isFinite(parsedSize) ||
      parsedSize < 5 ||
      parsedSize > 10_000
    ) {
      res.status(400).json({
        error: "Check outcome, side, price, and share size (5–10,000).",
      });
      return;
    }

    const client = await getClient();
    const sdkName = "@polymarket/client";
    const sdk: any = await import(sdkName);
    const result = await client.placeLimitOrder({
      assetId: String(assetId),
      side: side === "BUY" ? sdk.OrderSide.BUY : sdk.OrderSide.SELL,
      price: parsedPrice.toFixed(4),
      size: parsedSize.toFixed(2),
    });
    if (!result?.ok) {
      res.status(422).json({
        error: result?.message || "Polymarket rejected the order.",
      });
      return;
    }
    res.json({ orderId: result.orderId, status: result.status });
  } catch (error: any) {
    res.status(502).json({ error: error.message || "Order submission failed" });
  }
});

router.post(
  "/trading/orders/:orderId/cancel",
  requireSession,
  async (req, res) => {
    try {
      if (!requireSameOrigin(req, res)) return;
      const orderId = Array.isArray(req.params.orderId)
        ? req.params.orderId[0]
        : req.params.orderId;
      if (!orderId || orderId.length > 200) {
        res.status(400).json({ error: "Invalid order ID." });
        return;
      }

      const client = await getClient();
      const result = await client.cancelOrder({ orderId });
      const canceled = Array.isArray(result?.canceled) ? result.canceled : [];
      if (!canceled.includes(orderId)) {
        res.status(409).json({
          error: result?.notCanceled?.[orderId] || "Order was not canceled.",
        });
        return;
      }
      res.set("Cache-Control", "no-store").json({ orderId, canceled: true });
    } catch (error: any) {
      res.status(502).json({ error: error.message || "Order cancellation failed." });
    }
  },
);

export default router;
