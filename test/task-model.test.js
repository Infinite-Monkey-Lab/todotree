const { test } = require("node:test");
const assert = require("node:assert/strict");
const M = require("../renderer/task-model");
const roundTrip = (text) => {
  const first = M.parse(text);
  return M.parse(M.serialize(first.items, first.blocks));
};
test("legacy Markdown imports deadlines, statuses and nested tasks", () => {
  const result = roundTrip(
    "# TodoTree\n## 待完成\n- [!] parent | ddl:2026-12-31\n  - [X] child\n    - [ ] grandchild",
  );
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0].ddl, "2026-12-31");
  assert.equal(result.items[1].parentId, result.items[0].id);
  assert.equal(result.items[2].parentId, result.items[1].id);
  assert.equal(result.items[1].status, "done");
});
test("cross-zone child survives save and reload with its original parent", () => {
  const doc = M.parse("## 待完成\n- [ ] parent\n  - [x] child");
  doc.items[1].zone = "done";
  doc.items[1].collapsed = true;
  const saved = M.parse(M.serialize(doc.items, doc.blocks));
  assert.equal(saved.items.length, 2);
  assert.equal(
    saved.items.find((i) => i.text === "child").parentId,
    doc.items[0].id,
  );
  assert.equal(saved.items.find((i) => i.text === "child").collapsed, true);
});
test("deep trees are not flattened at level five", () => {
  const text =
    "## 目标\n" +
    Array.from(
      { length: 12 },
      (_, i) => "  ".repeat(i) + "- [>] level " + i,
    ).join("\n");
  const result = roundTrip(text);
  for (let n = 1; n < 12; n++)
    assert.equal(result.items[n].parentId, result.items[n - 1].id);
});
test("preserves prose, unknown sections and fenced code without importing code tasks", () => {
  const text =
    "# My plan\nPersonal introduction\n## 待完成\nA note\n- [ ] real task\n\n~~~md\n- [ ] sample\n## 目标\n~~~\n## 自由笔记\n- [ ] keep raw\nhello";
  const parsed = M.parse(text),
    saved = M.serialize(parsed.items, parsed.blocks);
  assert.equal(parsed.items.length, 1);
  for (const part of [
    "Personal introduction",
    "A note",
    "~~~md\n- [ ] sample\n## 目标\n~~~",
    "## 自由笔记\n- [ ] keep raw\nhello",
  ])
    assert.ok(saved.includes(part));
  assert.equal(M.parse(saved).items.length, 1);
});
test("IDs and status timer survive a round trip; external status edits cancel stale timer", () => {
  const doc = M.parse("## 待完成\n- [ ] task");
  doc.items[0].statusChangedAt = 1234;
  const saved = M.serialize(doc.items, doc.blocks),
    loaded = M.parse(saved);
  assert.equal(loaded.items[0].id, doc.items[0].id);
  assert.equal(loaded.items[0].statusChangedAt, 1234);
  assert.equal(
    M.parse(saved.replace("- [ ]", "- [x]")).items[0].statusChangedAt,
    null,
  );
});
test("settling status preserves parent relation across sections and does not move goals", () => {
  const doc = M.parse(
    "## 待完成\n- [ ] parent\n  - [x] child\n## 目标\n- [>] goal",
  );
  doc.items.forEach((i) => {
    i.statusChangedAt = 1;
  });
  assert.equal(M.settle(doc.items, 60000), false);
  assert.equal(M.settle(doc.items, 60001), true);
  assert.equal(doc.items[1].zone, "done");
  assert.equal(doc.items[1].parentId, doc.items[0].id);
  assert.equal(doc.items[2].zone, "goals");
});
test("invalid dates remain literal task text instead of silently disappearing", () => {
  assert.equal(M.validDate("2026-02-30"), false);
  assert.equal(M.validDate("2028-02-29"), true);
  const item = roundTrip("## 待完成\n- [ ] task | ddl:2026-02-30").items[0];
  assert.equal(item.ddl, null);
  assert.ok(item.text.includes("2026-02-30"));
});
test("malformed metadata and HTML-like task names remain data", () => {
  const text = '<img src=x onerror=alert(1)> "hello"';
  assert.equal(roundTrip("## 待完成\n- [ ] " + text).items[0].text, text);
  assert.equal(
    roundTrip("## 待完成\n- [ ] hi <!-- todotree:broken -->").items[0].text,
    "hi <!-- todotree:broken -->",
  );
});
test("cycles and duplicate IDs in edited files cannot lose tasks", () => {
  const meta = (value) =>
    "<!-- todotree:" + encodeURIComponent(JSON.stringify(value)) + " -->";
  const doc = M.parse(
    "## 待完成\n- [ ] a " +
      meta({ id: "a", p: "b" }) +
      "\n- [ ] b " +
      meta({ id: "b", p: "a" }) +
      "\n- [ ] c " +
      meta({ id: "a" }),
  );
  assert.equal(new Set(doc.items.map((i) => i.id)).size, 3);
  assert.equal(M.parse(M.serialize(doc.items, doc.blocks)).items.length, 3);
});
test("external indentation edits update same-section parent relationships", () => {
  const doc = M.parse("## 待完成\n- [ ] parent\n  - [ ] child");
  const saved = M.serialize(doc.items, doc.blocks).replace(
    "  - [ ] child",
    "- [ ] child",
  );
  assert.equal(
    M.parse(saved).items.find((i) => i.text === "child").parentId,
    null,
  );
});
test("non-object metadata stays literal and does not crash the importer", () => {
  for (const value of ["null", "123", "%5B%5D"]) {
    assert.equal(
      M.parse("## 待完成\n- [ ] text <!-- todotree:" + value + " -->").items
        .length,
      1,
    );
  }
});
