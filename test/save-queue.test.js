// Exercise the renderer persistence boundary with controlled IPC latency.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
function fixture(save) {
  const elements = new Map();
  const document = {
    getElementById: (id) => {
      if (!elements.has(id))
        elements.set(id, { dataset: {}, hidden: false, textContent: "" });
      return elements.get(id);
    },
    addEventListener: () => {},
  };
  const context = vm.createContext({
    window: {
      TaskModel: require("../renderer/task-model"),
      todoAPI: { save, onPinStateChanged: () => {} },
    },
    document,
    localStorage: { getItem: () => null },
    setInterval: () => {},
    console,
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8"),
    context,
  );
  vm.runInContext(
    "ready=true; revision='r0'; filePath='tasks.md'; items=[{id:'one',text:'first',zone:'todo',status:'pending',order:0,parentId:null}]; editVersion=1;",
    context,
  );
  return { run: (code) => vm.runInContext(code, context), elements };
}
test("rapid edits save in sequence and the last snapshot is never lost", async () => {
  const requests = [],
    resolvers = [];
  const f = fixture((request) => {
    requests.push(request);
    return new Promise((resolve) => resolvers.push(resolve));
  });
  const saving = f.run("save()");
  f.run("items[0].text='second'; editVersion++; save();");
  f.run("items[0].text='latest'; editVersion++; save();");
  assert.equal(requests.length, 1);
  resolvers[0]({ success: true, revision: "r1" });
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].revision, "r1");
  assert.ok(requests[1].content.includes("latest"));
  resolvers[1]({ success: true, revision: "r2" });
  await saving;
  assert.equal(f.run("dirty()"), false);
  assert.equal(f.run("revision"), "r2");
});
test("save conflicts block subsequent writes and expose unsaved state", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return { success: false, conflict: true, error: "external edit" };
  });
  await f.run("save()");
  f.run("items[0].text='more edits'; editVersion++;");
  await f.run("save()");
  assert.equal(calls, 1);
  assert.equal(f.run("dirty()"), true);
  assert.equal(f.run("revision"), "r0");
  assert.equal(f.elements.get("save-state").dataset.state, "error");
  assert.equal(f.elements.get("notice").hidden, false);
  assert.equal(f.elements.get("notice-text").textContent, "external edit");
});
test("IPC rejection retains unsaved edits and allows an explicit retry", async () => {
  let calls = 0;
  const f = fixture(async () => {
    if (++calls === 1) throw Error("disk unavailable");
    return { success: true, revision: "r1" };
  });
  await f.run("save()");
  assert.equal(f.run("dirty()"), true);
  f.run("blocked=false;");
  await f.run("save()");
  assert.equal(f.run("dirty()"), false);
  assert.equal(calls, 2);
});
