"use strict";
// Run with: npm test   (Node 18+, no dependencies)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* ---- load the real app.js in a sandbox with a minimal fake browser ---- */
function makeApp(opts = {}) {
  const store = new Map(Object.entries(opts.storage || {}));
  const el = { innerHTML: "", textContent: "", hidden: false, scrollTop: 0, scrollHeight: 0, scrollIntoView() {}, focus() {} };
  const ctx = vm.createContext({
    console, URL, Blob, setTimeout, clearTimeout, AbortController,
    window: { scrollY: 0, scrollTo() {}, claude: opts.claude },
    location: { hash: "", protocol: "https:" },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      title: "", body: { appendChild() {} },
      querySelector: () => el, querySelectorAll: () => [], getElementById: () => null,
      addEventListener() {}, createElement: () => ({ click() {}, remove() {} }),
    },
    addEventListener() {},
    fetch: opts.fetch || (async () => ({ ok: false, status: 404, json: async () => ({}) })),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "app.js"), "utf8"), ctx, { filename: "app.js" });
  const run = (code) => vm.runInContext(code, ctx);
  const json = (code) => JSON.parse(run("JSON.stringify(" + code + ")"));
  return { run, json, store };
}

const mkEvent = (type, over = {}) =>
  JSON.stringify(Object.assign({
    name: "Test event", type, date: "", budget: 100000, guests: 100, loc: "", theme: "",
    ps: "Balanced", notes: "", pri: ["Affordability"], currency: "INR",
  }, over));
function planFor(app, type, over = {}) {
  app.run(`S=build(Object.assign(${mkEvent(type, over)},{date:ds(today()+30),theme:T["${type}"].themes[0]}))`);
}

/* ---- tests ---- */

test("validDate accepts real dates and rejects impossible ones", () => {
  const app = makeApp();
  assert.equal(app.run('validDate("2026-11-15")'), true);
  assert.equal(app.run('validDate("2026-02-30")'), false);
  assert.equal(app.run('validDate("15-11-2026")'), false);
  assert.equal(app.run('validDate("")'), false);
});

test("esc neutralises HTML", () => {
  const app = makeApp();
  assert.equal(app.run('esc(`<img src=x onerror="a()">&\'`)'), "&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;");
});

test("build(): budget allocations are whole rupees and add up exactly, for every event type", () => {
  const app = makeApp();
  for (const type of ["birthday", "wedding", "community"]) {
    for (const budget of [1, 999, 5000, 123457, 2500000]) {
      for (const pri of [[], ["Food"], ["Decorations", "Photography", "Accessibility"]]) {
        planFor(app, type, { budget, pri });
        const a = app.json("S.alloc");
        assert.equal(a.reduce((s, x) => s + x.v, 0), budget, `${type} ${budget} ${pri}`);
        assert.ok(a.every((x) => Number.isInteger(x.v) && x.v >= 0));
      }
    }
  }
});

test("build(): a priority moves money toward that category", () => {
  const app = makeApp();
  planFor(app, "wedding", { pri: [] });
  const base = app.json("S.alloc.find(a=>/cater/i.test(a.n)).v");
  planFor(app, "wedding", { pri: ["Food"] });
  const boosted = app.json("S.alloc.find(a=>/cater/i.test(a.n)).v");
  assert.ok(boosted > base);
});

test("build(): task dates never fall after the event and urgent events get high priority", () => {
  const app = makeApp();
  planFor(app, "wedding");
  const date = app.run("S.ev.date");
  assert.ok(app.json("S.tasks").every((t) => t.due <= date));
  app.run(`S=build(Object.assign(${mkEvent("birthday")},{date:ds(today()+1),theme:"Pastel"}))`);
  const tasks = app.json("S.tasks");
  assert.ok(tasks.length > 0 && tasks.every((t) => t.pri === "high" || t.due === app.run("S.ev.date")));
});

test("sim(): what-if totals match the new budget and never go negative", () => {
  const app = makeApp();
  planFor(app, "birthday", { budget: 20000, guests: 25, pri: ["Food"] });
  for (const [b, g] of [[20000, 25], [15000, 40], [60000, 100], [5000, 10], [20000, 200]]) {
    const r = app.json(`sim(${b},${g})`);
    assert.ok(r.p.every((x) => x.v >= 0), `${b}/${g} negative`);
    assert.ok(r.p.reduce((s, x) => s + x.v, 0) <= b, `${b}/${g} over budget`);
  }
});

test("saved-data validation accepts a real plan and rejects tampered data", () => {
  const app = makeApp();
  planFor(app, "wedding");
  const good = app.json("S");
  assert.equal(app.run(`valid(${JSON.stringify(good)})`), true);
  const bad = (mutate) => { const c = JSON.parse(JSON.stringify(good)); mutate(c); return app.run(`valid(${JSON.stringify(c)})`); };
  assert.equal(bad((c) => { c.ev.budget = "<img src=x onerror=alert(1)>"; }), false);
  assert.equal(bad((c) => { c.ev.guests = -5; }), false);
  assert.equal(bad((c) => { c.tasks[0].pri = "<script>"; }), false);
  assert.equal(bad((c) => { c.tasks[0].due = "not-a-date"; }), false);
  assert.equal(bad((c) => { c.items[0].st = "hacked"; }), false);
  assert.equal(bad((c) => { c.ev.theme = "<b>x</b>"; }), false);
  assert.equal(bad((c) => { c.alloc.pop(); }), false);
});

test("a saved plan survives a page reload (save, then load in a fresh app)", () => {
  const first = makeApp();
  planFor(first, "wedding", { guests: 150 });
  first.run("save()");
  const second = makeApp({ storage: Object.fromEntries(first.store) });
  assert.notEqual(second.run("S"), null, "saved plan was rejected on load");
  assert.equal(second.json("S.ev.guests"), 150);
});

test("a corrupted localStorage entry is ignored instead of crashing the app", () => {
  const app = makeApp({ storage: { "utsav.v1": '{"v":1,"ev":{"type":"wedding","budget":"x"}}' } });
  assert.equal(app.run("S"), null);
  const app2 = makeApp({ storage: { "utsav.v1": "not json at all" } });
  assert.equal(app2.run("S"), null);
});

test("every page renders without 'undefined' or 'NaN' for all event types", () => {
  const app = makeApp();
  for (const type of ["birthday", "wedding", "community"]) {
    planFor(app, type, { guests: 57 });
    const pages = { home: app.run("home()"), form: app.run("form()") };
    for (const t of ["overview", "visuals", "budget", "timeline", "checklist", "whatif", "assistant"]) {
      app.run(`tab="${t}"`);
      pages[t] = app.run("dash()");
    }
    for (const [name, html] of Object.entries(pages)) {
      assert.ok(html.length > 200, `${type}/${name} empty`);
      assert.ok(!/undefined|NaN/.test(html), `${type}/${name} contains undefined/NaN`);
    }
  }
});

test("all illustrations are well-formed SVG (balanced tags, no bad numbers)", () => {
  const app = makeApp();
  const voidTags = new Set(["path", "rect", "circle", "ellipse", "line", "stop", "feDropShadow", "polygon"]);
  let count = 0;
  for (const type of ["birthday", "wedding", "community"]) {
    const themes = app.json(`T["${type}"].themes`);
    for (const theme of themes) {
      planFor(app, type, { guests: 150 });
      app.run(`S.ev.theme=${JSON.stringify(theme)}`);
      for (const svg of app.json('figList("t").map(x=>x[0])')) {
        count++;
        assert.ok(!/NaN|undefined|Infinity/.test(svg), `${type}/${theme} has bad number`);
        const stack = [];
        for (const m of svg.matchAll(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g)) {
          const [, close, tag, , self] = m;
          if (self || (!close && voidTags.has(tag))) continue;
          if (close) assert.equal(stack.pop(), tag, `${type}/${theme}: mismatched </${tag}>`);
          else stack.push(tag);
        }
        assert.equal(stack.length, 0, `${type}/${theme}: unclosed ${stack}`);
      }
    }
  }
  assert.equal(count, 3 * 5 * 6);
});

test("built-in planner answers every suggested question using the user's own numbers", () => {
  const app = makeApp();
  planFor(app, "birthday", { budget: 20000, guests: 25 });
  const starters = app.json("STARTERS").concat(["hello", "what is my schedule?"]);
  for (const q of starters) {
    const a = app.run(`localAnswer(${JSON.stringify(q)})`);
    assert.ok(a.length > 40, q);
    assert.ok(!/undefined|NaN/.test(a), q);
  }
  assert.match(app.run('localAnswer("What happens if 20 more guests attend?")'), /45 in total/);
  assert.match(app.run('localAnswer("Create a backup plan for rain.")'), /Rain plan/);
  assert.doesNotMatch(app.run('localAnswer("how do I train staff")'), /Rain plan/);
});

test("assistant falls back to the built-in planner when no live AI is reachable", async () => {
  const app = makeApp(); // fetch returns 404, no window.claude
  planFor(app, "wedding");
  await app.run('ask("How can I save money?")');
  const chat = app.json("chat");
  assert.equal(chat.length, 2);
  assert.equal(chat[1].role, "assistant");
  assert.equal(chat[1].src, "planner");
  assert.equal(app.run("noProxy"), true);
});

test("assistant uses the server proxy when it answers, and shows the reply as AI", async () => {
  let sent;
  const app = makeApp({
    fetch: async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ text: "**Book the venue** first." }) }; },
  });
  planFor(app, "wedding");
  await app.run('ask("What first?")');
  const chat = app.json("chat");
  assert.equal(sent.url, "/api/ask");
  assert.equal(sent.body.event.type, "wedding");
  assert.ok(!("name" in sent.body.event) && !("loc" in sent.body.event) && !("notes" in sent.body.event), "private fields must not be sent");
  assert.equal(chat[1].src, "claude");
  assert.equal(chat[1].content, "Book the venue first.");
});

test("assistant uses Claude's runtime (artifact viewer) when it is available", async () => {
  const claude = { use: async (n) => (n === "sample" ? async () => ({ text: "Hello from Claude", truncated: false }) : null) };
  const app = makeApp({ claude });
  planFor(app, "birthday");
  await app.run('ask("Hi")');
  assert.equal(app.json("chat")[1].src, "claude");
});

test("clearing history during a pending reply does not resurrect messages", async () => {
  let release;
  const app = makeApp({ fetch: () => new Promise((r) => { release = () => r({ ok: true, status: 200, json: async () => ({ text: "late" }) }); }) });
  planFor(app, "birthday");
  const p = app.run('ask("Hi")');
  await new Promise((r) => setTimeout(r, 5));
  app.run('document.querySelector("x");ctl.abort();ctl=null;chat=[];busy=false');
  release();
  await p;
  assert.equal(app.json("chat").length, 0);
});

/* ---- serverless function ---- */
const fn = require("./functions/ask.js");
const goodBody = () => JSON.stringify({
  event: { type: "wedding", date: "2026-12-01", daysLeft: 30, guests: 100, budgetINR: 500000, theme: "Floral", planningStyle: "Balanced", priorities: ["Food"], allocationsINR: [{ category: "Venue", planned: 150000, actualSpent: 0 }], openTasks: [] },
  messages: [{ role: "user", content: "Save money?" }],
});
const req = (over) => Object.assign({ httpMethod: "POST", headers: { host: "site.test", origin: "https://site.test" }, body: goodBody() }, over);

test("function: rejects GET, missing key, cross-origin, bad and oversized input", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal((await fn.handler(req({ httpMethod: "GET" }))).statusCode, 405);
  assert.equal((await fn.handler(req())).statusCode, 503);
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  assert.equal((await fn.handler(req({ headers: { host: "site.test", origin: "https://evil.test" } }))).statusCode, 403);
  assert.equal((await fn.handler(req({ body: "{not json" }))).statusCode, 400);
  assert.equal((await fn.handler(req({ body: JSON.stringify({ event: { type: "x" }, messages: [] }) }))).statusCode, 400);
  assert.equal((await fn.handler(req({ body: "x".repeat(20000) }))).statusCode, 413);
  delete process.env.ANTHROPIC_API_KEY;
});

test("function: calls the Anthropic API with the key in a header and never leaks it", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  const realFetch = global.fetch;
  let call;
  global.fetch = async (url, init) => { call = { url, init, payload: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "Trim décor first." }] }) }; };
  try {
    const res = await fn.handler(req());
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).text, "Trim décor first.");
    assert.equal(call.url, "https://api.anthropic.com/v1/messages");
    assert.equal(call.init.headers["x-api-key"], "test-key-not-real");
    assert.ok(!res.body.includes("test-key-not-real"));
    assert.ok(call.payload.system.includes("EVENT DATA"));
    assert.equal(call.payload.messages.at(-1).role, "user");
    assert.ok(call.payload.max_tokens <= 500);
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    assert.equal((await fn.handler(req())).statusCode, 502);
  } finally {
    global.fetch = realFetch;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("function: strips unknown fields and normalises message order", () => {
  const p = fn.buildPayload({
    event: { type: "birthday", guests: 20, budgetINR: 5000, secretName: "Asha's party", loc: "Pune" },
    messages: [{ role: "assistant", content: "stray" }, { role: "user", content: "a" }, { role: "user", content: "b" }],
  }, "m");
  assert.ok(!p.system.includes("Asha") && !p.system.includes("Pune"));
  assert.deepEqual(p.messages, [{ role: "user", content: "a\nb" }]);
});

test("repository hygiene: no API keys or secrets are committed in source files", () => {
  const files = ["app.js", "index.html", "styles.css", "functions/ask.js", "netlify.toml", "package.json", ".env.example", "README.md"];
  for (const f of files) {
    const p = path.join(__dirname, f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, "utf8");
    assert.ok(!/sk-ant-[A-Za-z0-9_-]{10,}/.test(t), f + " looks like it contains an API key");
  }
  assert.ok(/^\.env$/m.test(fs.readFileSync(path.join(__dirname, ".gitignore"), "utf8")));
});
