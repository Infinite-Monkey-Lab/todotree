const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const store = require("../lib/file-store");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todotree-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    filePath: path.join(dir, "tasks.md"),
    backup: path.join(dir, "backups"),
  };
}
test("loading an absent file never creates it; first save creates exact content", (t) => {
  const { filePath, backup } = fixture(t),
    loaded = store.read(filePath, "seed");
  assert.equal(loaded.revision, null);
  assert.equal(fs.existsSync(filePath), false);
  const result = store.save(filePath, { ...loaded, content: "new" }, backup);
  assert.equal(result.success, true);
  assert.equal(fs.readFileSync(filePath, "utf8"), "new");
});
test("external edit or deletion prevents overwriting and leaves no temp files", (t) => {
  const { filePath, dir, backup } = fixture(t);
  fs.writeFileSync(filePath, "original");
  const before = store.read(filePath);
  fs.writeFileSync(filePath, "external");
  assert.equal(
    store.save(filePath, { ...before, content: "mine" }, backup).conflict,
    true,
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), "external");
  fs.unlinkSync(filePath);
  assert.equal(
    store.save(filePath, { ...before, content: "mine" }, backup).conflict,
    true,
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});
test("content revision catches edits even if mtime is unchanged", (t) => {
  const { filePath, backup } = fixture(t);
  fs.writeFileSync(filePath, "first");
  const stat = fs.statSync(filePath),
    before = store.read(filePath);
  fs.writeFileSync(filePath, "other");
  fs.utimesSync(filePath, stat.atime, stat.mtime);
  assert.equal(
    store.save(filePath, { ...before, content: "mine" }, backup).conflict,
    true,
  );
});
test("backup keeps previous bytes and only the most recent twenty versions", (t) => {
  const { filePath, backup } = fixture(t);
  fs.writeFileSync(filePath, "0");
  for (let n = 1; n <= 25; n++)
    assert.equal(
      store.save(
        filePath,
        { ...store.read(filePath), content: String(n) },
        backup,
      ).success,
      true,
    );
  const dir = path.join(backup, fs.readdirSync(backup)[0]);
  assert.equal(fs.readdirSync(dir).length, 20);
  assert.equal(fs.readFileSync(filePath, "utf8"), "25");
});
test("failed write or switched file returns a visible error without changing original", (t) => {
  const { filePath, backup } = fixture(t);
  fs.writeFileSync(filePath, "safe");
  assert.equal(
    store.save(
      filePath,
      { ...store.read(filePath), filePath: "other.md", content: "oops" },
      backup,
    ).success,
    false,
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), "safe");
  const absent = path.join(path.dirname(filePath), "missing", "tasks.md");
  assert.equal(
    store.save(
      absent,
      { filePath: absent, revision: null, content: "oops" },
      backup,
    ).success,
    false,
  );
});
