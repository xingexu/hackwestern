import test from "node:test";
import assert from "node:assert/strict";
import {
  fresh,
  emergencies,
  routes,
  CaseState,
  Finding,
} from "../src/contract";
import { append, applyTool, applyBatch, review } from "../src/state/engine";
import { scenarios, playStep } from "../src/state/scenarios";
import { cards, route } from "../src/rules";
import { lines } from "../src/note/lines";
import { saveNote, getNote, TTL } from "../src/note/store";
import { readback } from "../src/note/lines";
test("an allergy sharing a symptom turn has its own cited note line", () => {
  const s = applyBatch(sample(), [
    f("rash"),
    { name: "add_allergy", args: { name: "DemoMint", sourceTurn: 0 } },
  ]);
  assert.deepEqual(
    lines(s).map((l) => [l.title, l.sourceTurn]),
    [
      ["Reported", 0],
      ["Reported allergy", 0],
    ],
  );
  assert.equal(lines(s)[1].text, "DemoMint");
});
import { applyExtraction } from "../src/state/engine";
test("first-turn fallback handles urgent disclosures with no watchdog or Live tool", () => {
  const s = sample();
  for (const state of [
    s,
    { ...s, review: true },
    { ...s, route: "health811" as const },
  ]) {
    assert.equal(
      applyExtraction(state, [f("chest_pain")], 0, false).route,
      "911",
    );
    assert.equal(
      applyExtraction(state, [f("self_harm_thoughts")], 0, false).route,
      "crisis",
    );
  }
  assert.equal(
    applyExtraction(s, [f("chest_pain", { present: false })], 0, false),
    s,
  );
  assert.equal(
    applyExtraction(s, [f("chest_pain", { sourceTurn: 9 })], 0, false),
    s,
  );
});
test("a triggering batch keeps accompanying evidence without reopening the interview", () => {
  const s = applyBatch(sample(), [
    f("self_harm_thoughts"),
    f("chest_pain"),
    f("nausea"),
    { name: "finish_intake", args: {} },
  ]);
  assert.equal(s.route, "911");
  assert.equal(s.review, false);
  assert.equal(s.findings.length, 3);
  assert.equal(applyBatch(s, [f("rash")]), s);
});
test("earlier urgent findings set a floor through correction", () => {
  let s = applyTool(sample(), f("rash", { severity: 5 }));
  s = applyTool(s, f("rash", { severity: 1 }));
  assert.equal(s.findings[0].severity, 1);
  assert.equal(route({ ...s, confirmed: true }), "er");
});
test("read-back identifies what the reducer understood in Mandarin", () => {
  let s = fresh("zh-CN");
  for (const step of scenarios[0].steps) s = playStep(s, step);
  assert.match(readback(s), /眼睛发红/);
  assert.match(readback(s), /否认：胸痛/);
  assert.match(readback(s), /2天前/);
  assert.match(readback(s), /发痒/);
});
for (const sc of scenarios)
  for (let i = 0; i < 10; i++)
    test(sc.id + " rehearsal " + (i + 1), () => {
      let s = fresh(sc.lang);
      s = append(s, { speaker: "ai", original: "Opening", english: "Opening" });
      for (const st of sc.steps) {
        s = playStep(s, st);
        if (s.route) break;
      }
      if (s.review) s = review(s, true);
      assert.equal(s.route, sc.expected);
      if (sc.id === "eye") {
        assert.ok(s.findings.some((f) => f.bodyRegion === "eyes"));
        assert.ok(lines(s).some((l) => l.quote.includes("眼睛")));
      }
      if (sc.id === "ankle")
        assert.ok(lines(s).some((l) => l.text === "DemoMint"));
      if (sc.id === "child") assert.equal(s.subject, "other");
      if (sc.id === "unsure") assert.equal(s.findings.length, 0);
      if (sc.id === "chest")
        assert.equal(
          s.transcript.filter((t) => t.speaker === "patient").length,
          1,
        );
      if (sc.id === "redirect")
        assert.ok(
          s.transcript.some((t) => t.original.includes("can't tell you")),
        );
      if (sc.id === "support" || sc.id === "chest")
        assert.equal(
          append(s, {
            speaker: "ai",
            original: "Continue?",
            english: "Continue?",
          }),
          s,
        );
      for (const l of lines(s)) {
        assert.equal(l.quote, s.transcript[l.sourceTurn].original);
        assert.equal(s.transcript[l.sourceTurn].speaker, "patient");
      }
    });
const sample = () =>
  append(fresh(), {
    speaker: "patient",
    original: "Practice reply",
    english: "Practice reply",
  });
const f = (code: Finding["code"], extra: Partial<Finding> = {}) => ({
  name: "record_finding",
  args: { code, present: true, sourceTurn: 0, ...extra },
});
for (const code of emergencies)
  test("current, unknown, denied and past: " + code, () => {
    assert.equal(applyTool(sample(), f(code)).route, "911");
    assert.equal(
      applyTool(sample(), f(code, { happeningNow: true })).route,
      "911",
    );
    for (const args of [{ happeningNow: false }, { present: false }])
      assert.equal(applyTool(sample(), f(code, args)).route, null);
  });
test("emergency is immutable, denial can escalate", () => {
  let s = applyTool(sample(), f("chest_pain", { present: false }));
  s = applyTool(s, f("chest_pain"));
  assert.equal(s.route, "911");
  assert.equal(applyTool(s, f("chest_pain", { present: false })), s);
  assert.equal(review(s, false), s);
});
test("immediate danger precedes crisis in a single turn", () =>
  assert.equal(
    applyBatch(sample(), [f("self_harm_thoughts"), f("chest_pain")]).route,
    "911",
  ));
test("unknown tools, unknown codes, invalid data and invented turn are rejected", () => {
  const s = sample();
  for (const c of [
    { name: "other", args: {} },
    { name: "__proto__", args: {} },
    {
      name: "record_finding",
      args: { code: "x", present: true, sourceTurn: 0 },
    },
    f("rash", { severity: 9 as 5 }),
    f("rash", { sourceTurn: 8 }),
  ])
    assert.equal(applyTool(s, c), s);
  const t = append(s, {
    speaker: "ai",
    original: "Question",
    english: "Question",
  });
  assert.equal(applyTool(t, f("rash", { sourceTurn: 1 })), t);
});
test("duplicate tool calls upsert; correction preserves source turns", () => {
  let s = applyTool(sample(), f("rash"));
  s = applyTool(s, f("rash"));
  assert.equal(s.findings.length, 1);
  s = append(s, {
    speaker: "patient",
    original: "Not a rash",
    english: "Not a rash",
  });
  s = applyTool(s, f("rash", { present: false, sourceTurn: 1 }));
  assert.equal(s.findings[0].present, false);
  assert.equal(s.transcript.length, 2);
});
test("incomplete or unsupported cases never return pharmacy", () => {
  for (const cond of [
    { code: "other" },
    { severity: undefined },
    { code: "painful_urination" },
  ]) {
    const s = applyTool(
      sample(),
      f("sprain", { severity: 2, ...cond } as Partial<Finding>),
    );
    assert.equal(
      route({ ...s, confirmed: true, ageBand: "adult", pregnant: false }),
      "health811",
    );
  }
  assert.equal(route(fresh()), "health811");
  assert.equal(
    route({
      ...applyTool(sample(), f("sprain", { severity: 2 })),
      ageBand: "adult",
      confirmed: true,
    }),
    "health811",
  );
});
test("urgent populations, unconfirmed severity and a chronic concern", () => {
  const s = applyTool(
    sample(),
    f("fever", { severity: 2, onset: "16 days ago" }),
  );
  for (const ageBand of ["infant", "child", "adult"] as const)
    assert.equal(
      route({ ...s, ageBand, confirmed: true }),
      { infant: "er", child: "walk_in", adult: "family_doctor" }[ageBand],
    );
  assert.equal(route({ ...s, pregnant: true }), "walk_in");
  assert.equal(route(applyTool(sample(), f("rash", { severity: 5 }))), "er");
  assert.equal(
    route(applyTool(sample(), f("fatigue", { severity: 4 }))),
    "walk_in",
  );
});
test("two rejected summaries default to unconfirmed nurse route", () => {
  let s = sample();
  for (let i = 0; i < 2; i++)
    s = review(applyTool(s, { name: "finish_intake", args: {} }), false);
  assert.equal(s.route, "health811");
  assert.equal(s.confirmed, false);
});
test("all routes have non-diagnostic text and no stay-home outcome", () => {
  assert.equal(Object.keys(cards).length, 7);
  for (const r of routes)
    assert.doesNotMatch(cards[r].title, /stay home|you have/i);
});
test("notes expire at the boundary and do not expose other notes", () => {
  const n = saveNote(
    { lines: [], confirmed: true, language: "en", route: "health811" },
    500,
  );
  assert.ok(getNote(n.id, 500 + TTL - 1));
  assert.equal(getNote(n.id, 500 + TTL), null);
  assert.equal(getNote("missing"), null);
});
