const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
function fixture(refuseParent = false) {
  let parent = null,
    alive = true,
    bounds = { x: 110, y: 220, width: 520, height: 740 };
  const functions = {
    FindWindowW: () => 100,
    FindWindowExW: (_p, _a, cls) => (cls === "SHELLDLL_DefView" ? 200 : null),
    SendMessageTimeoutW: () => 1,
    SetParent: (_child, value) => {
      if (!refuseParent) parent = value;
    },
    GetParent: () => parent,
    SetWindowPos: () => 1,
    GetWindowLongW: () => 0,
    SetWindowLongW: () => 0,
    IsWindow: (hwnd) => (hwnd === 100 ? alive : true),
    GetWindowRect: (_h, rect) =>
      Object.assign(rect, { left: 10, top: 20, right: 1930, bottom: 1100 }),
  };
  const context = vm.createContext({
    module: { exports: {} },
    require: () => ({
      struct: () => ({}),
      load: () => ({
        func: (signature) =>
          functions[signature.match(/(?:__stdcall )?(\w+)\(/)[1]],
      }),
    }),
    console: { log: () => {} },
    Date,
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../desktop-layer.js"), "utf8"),
    context,
  );
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(500n);
  const window = {
    isDestroyed: () => false,
    getNativeWindowHandle: () => handle,
    getBounds: () => ({ ...bounds }),
    setBounds: (value) => {
      bounds = value;
    },
  };
  return {
    layer: context.module.exports,
    window,
    parent: () => parent,
    bounds: () => bounds,
    loseContainer: () => {
      alive = false;
      bounds = { ...bounds, x: 100, y: 200 };
    },
  };
}
test("lost desktop container restores the surviving window at its screen position", () => {
  const f = fixture();
  assert.equal(f.layer.attach(f.window), true);
  f.loseContainer();
  assert.equal(f.layer.ensureAttached(f.window), "container-lost");
  assert.equal(f.layer.isAttached(), false);
  assert.equal(f.parent(), null);
  assert.equal(f.bounds().x, 110);
  assert.equal(f.bounds().y, 220);
});
test("failed SetParent does not report a successful desktop attachment", () => {
  const f = fixture(true);
  assert.throws(() => f.layer.attach(f.window), /无法挂入/);
  assert.equal(f.layer.isAttached(), false);
  assert.equal(f.bounds().x, 110);
});
