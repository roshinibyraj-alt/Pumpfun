const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("the public root dashboard runs the 5-minute ask-absorption paper strategy", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../public/btc-5m-ask-absorption-dashboard.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "../app.ts"), "utf8");
  const route = fs.readFileSync(path.join(__dirname, "../routes/strategy.ts"), "utf8");

  assert.match(app, /public\/btc-5m-ask-absorption-dashboard\.html/);
  assert.match(app, /public\/double-rung-dashboard\.html/);
  assert.doesNotMatch(app, /public\/cross-pair\.html/);
  assert.match(route, /Btc5mAskAbsorptionBot/);
  assert.match(route, /btc-5m-mispricing/);
  assert.match(html, /BTC Ask Absorption/);
  assert.match(html, /5-minute paper bot/);
  assert.match(html, /Absorption/);
  assert.match(html, /\$0\.45–\$0\.55/);
  assert.match(html, /10 seconds/);
  assert.match(html, /best bid at \$0\.99 closes that side at \$1 per share/i);
  assert.match(html, /empty bid on a fresh book closes that side at \$0/i);
  assert.match(html, /official resolution/i);
  assert.match(html, /@media \(max-width: 370px\)/);
  assert.match(html, /setInterval\(refresh, 1000\)/);
  assert.match(html, /fetch\(["']\/api\/strategy\/state/);

  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    new vm.Script(script[1]);
  }
});
