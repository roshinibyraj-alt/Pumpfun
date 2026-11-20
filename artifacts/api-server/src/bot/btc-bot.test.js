const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("the public root dashboard runs the independent double-rung paper strategy", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../public/double-rung-dashboard.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "../app.ts"), "utf8");
  const route = fs.readFileSync(path.join(__dirname, "../routes/strategy.ts"), "utf8");

  assert.match(app, /public\/double-rung-dashboard\.html/);
  assert.doesNotMatch(app, /public\/cross-pair\.html/);
  assert.match(route, /BtcDoubleRungBot/);
  assert.match(route, /btc-5m-mispricing/);
  assert.match(html, /BTC Double-Rung Paper Bot/);
  assert.match(html, /Buy 5 shares on each side at window start/i);
  assert.match(html, /\$0\.20–\$0\.80/);
  assert.match(html, /once per price/);
  assert.match(html, /10 → 20 → 40 → 80 → 160 → 320 → 640/);
  assert.match(html, /best bid ≥ \$0\.99 pays \$1\/share/i);
  assert.match(html, /No stop-loss/i);
  assert.match(html, /official resolution/i);
  assert.match(html, /@media\(max-width:600px\)/);
  assert.match(html, /setInterval\(refresh, 1_000\)/);
  assert.match(html, /fetch\(["']\/api\/strategy\/state/);

  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    new vm.Script(script[1]);
  }
});
