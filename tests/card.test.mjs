// Смоук-тесты карточки в Node без браузера: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "stats-table-card.js"), "utf8");

// --- минимальные заглушки DOM ---
globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = v; } };
globalThis.location = { pathname: "/test", search: "" };
const mkEl = () => ({
  innerHTML: "", style: {}, dataset: {}, classList: { toggle() {} },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
});
globalThis.HTMLElement = class {
  attachShadow() {
    const els = {};
    const root = { set innerHTML(_) {}, getElementById(id) { return els[id] || (els[id] = mkEl()); } };
    this.shadowRoot = root;
    return root;
  }
};
globalThis.customElements = { _m: {}, get(n) { return this._m[n]; }, define(n, c) { this._m[n] = c; } };
globalThis.window = {};
globalThis.document = {};
globalThis.console.info = () => {};
// eslint-disable-next-line no-eval
(0, eval)(src.replace("class StatsTableCard", "globalThis.STC = class StatsTableCard").replace(
  'customElements.define("stats-table-card", StatsTableCard)', 'customElements.define("stats-table-card", globalThis.STC)'));
const STC = globalThis.STC;

const TZ = "Asia/Yekaterinburg";
const H = 3600000;
const NOW = Date.parse("2026-10-05T12:00:00Z"); // 17:00 по Екатеринбургу
Date.now = () => NOW;
const MID = Date.parse("2026-10-04T19:00:00Z"); // полночь 05.10 по Екатеринбургу

async function render(config, callWS) {
  const el = new STC();
  el.setConfig({ refresh_interval: 0, controls: false, ...config });
  el.hass = { config: { time_zone: TZ }, states: {}, callWS };
  await new Promise((r) => setTimeout(r, 20));
  return el;
}

test("версия задана", () => {
  assert.match(src, /const STC_VERSION = "\d+\.\d+\.\d+"/);
});

test("дневная таблица: значения, итог и прочерк при отсутствии данных", async () => {
  const el = await render(
    { period: "day", default_range: "3d", columns: [{ entity: "sensor.v", stat: "change", decimals: 1 }] },
    async (m) => (m.period === "day" ? { "sensor.v": [{ start: MID - 2 * 86400000, change: 5 }, { start: MID - 86400000, change: 7.5 }] } : {})
  );
  assert.deepEqual(el._rows.map((r) => r.v.c0), [5, 7.5, null]);
  assert.equal(el._footerValue(el._columns[0]), 12.5); // stat: change => итог sum
  assert.equal(el._fmt(null, 1), "—");
  assert.equal(el._fmt(12.5, 1), "12,5");
});

test("source_period: hour -> day, avg_nonzero и формула", async () => {
  const pts = Array.from({ length: 17 }, (_, i) => ({ start: MID + i * H, mean: i < 8 ? 0 : 100 }));
  const el = await render(
    {
      period: "day", default_range: "today",
      columns: [
        { entity: "sensor.p", source_period: "hour", stat: "mean", agg: "sum" },
        { entity: "sensor.p", source_period: "hour", stat: "mean", agg: "avg_nonzero" },
        { formula: "c0 / 1000" },
      ],
    },
    async (m) => (m.period === "hour" ? { "sensor.p": pts } : {})
  );
  const v = el._rows[0].v;
  assert.equal(v.c0, 900);
  assert.equal(v.c1, 100);
  assert.equal(v.c2, 0.9);
});

test("avg_nonzero: все нули => 0, нет данных => прочерк", async () => {
  const el = await render(
    { period: "day", default_range: "3d", columns: [{ entity: "sensor.p", source_period: "hour", stat: "mean", agg: "avg_nonzero" }] },
    async (m) => (m.period === "hour" ? { "sensor.p": [{ start: MID - 86400000, mean: 0 }, { start: MID - 86400000 + H, mean: 0 }] } : {})
  );
  assert.deepEqual(el._rows.map((r) => r.v.c0), [null, 0, null]);
});

test("часовая таблица: сетка до текущего часа, agg last из 5minute", async () => {
  const pts = [];
  for (let t = MID; t < NOW; t += 300000) pts.push({ start: t, mean: (t - MID) / 300000 });
  const el = await render(
    { period: "hour", default_range: "today", columns: [{ entity: "sensor.p", source_period: "5minute", stat: "mean", agg: "last" }] },
    async (m) => (m.period === "5minute" ? { "sensor.p": pts } : {})
  );
  assert.equal(el._rows.length, 17);
  assert.equal(el._rows[0].v.c0, 11); // последний 5-минутный интервал первого часа
});

test("prefer заменяет только завершённые интервалы", async () => {
  Date.now = () => NOW + 30 * 60000; // 17:30 — текущий час 17:00 не завершён
  const el = await render(
    {
      period: "hour", default_range: "today",
      columns: [{ entity: "sensor.p", stat: "mean", prefer: { entity: "sensor.acc", stat: "change" } }],
    },
    async () => ({
      "sensor.p": Array.from({ length: 18 }, (_, i) => ({ start: MID + i * H, mean: 1 })),
      "sensor.acc": Array.from({ length: 18 }, (_, i) => ({ start: MID + i * H, change: 2 })),
    })
  );
  Date.now = () => NOW;
  const vals = el._rows.map((r) => r.v.c0);
  assert.equal(vals.length, 18);
  assert.equal(vals[0], 2);
  assert.equal(vals[17], 1); // текущий час (17:00–18:00) не завершён — основной расчёт
});

test("подсветка: выбирается самое тяжёлое правило", async () => {
  const el = await render(
    {
      period: "day", default_range: "today",
      columns: [{ entity: "sensor.t", highlight: [{ below: 160, level: "warn", row: true }, { below: 150, level: "bad", row: true }] }],
    },
    async () => ({ "sensor.t": [{ start: MID, mean: 148 }] })
  );
  const html = el.shadowRoot.getElementById("root").innerHTML;
  assert.match(html, /<tr class="row-bad">/);
  assert.match(html, /class="hl-bad"/);
  assert.match(html, /class="legend"/);
});

test("пресеты периода", () => {
  const el = new STC();
  el.setConfig({ columns: [{ entity: "sensor.x" }], refresh_interval: 0 });
  el._hass = { config: { time_zone: TZ } };
  el._initSelection();
  assert.deepEqual(el._sel, ["2026-10-01", "2026-10-05"]); // default: month
});

test("period: month выравнивается на 1-е число", async () => {
  let req;
  await render(
    { period: "month", default_range: "year", live_today: false, columns: [{ entity: "sensor.v", stat: "change" }] },
    async (m) => { req = m; return {}; }
  );
  assert.equal(req.start_time, new Date(Date.parse("2025-12-31T19:00:00Z")).toISOString());
});

test("getStubConfig выбирает накопительный сенсор", () => {
  const cfg = STC.getStubConfig({
    states: {
      "sensor.t": { attributes: { state_class: "measurement" } },
      "sensor.e": { attributes: { state_class: "total_increasing", unit_of_measurement: "kWh", friendly_name: "Энергия" } },
    },
  });
  assert.equal(cfg.columns[0].entity, "sensor.e");
  assert.equal(cfg.columns[0].stat, "change");
});

test("period: week — строки с понедельника, подпись диапазоном", async () => {
  let req;
  const MON = Date.parse("2026-09-27T19:00:00Z"); // пн 28.09 00:00 по Екатеринбургу
  const el = await render(
    { period: "week", default_range: "7d", live_today: false, columns: [{ entity: "sensor.v", stat: "change" }] },
    async (m) => { req = m; return { "sensor.v": [{ start: MON, change: 10 }, { start: MON + 7 * 86400000, change: 3 }] }; }
  );
  assert.equal(req.start_time, new Date(MON).toISOString()); // 7d = 29.09–05.10 -> с пн 28.09
  assert.deepEqual(el._rows.map((r) => r.v.c0), [10, 3]);
  assert.equal(el._rowLabel(el._rows[0].start), "28.09–04.10");
});
