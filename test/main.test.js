const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
async function boot(t, config = {}, failAttach = false, lock = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todotree-main-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "desktop"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  const handlers = new Map(),
    timers = [],
    windows = [],
    messages = [];
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.bounds = { x: 10, y: 10, ...options };
      windows.push(this);
      this.webContents = { send: (...args) => messages.push(args) };
    }
    loadFile() {}
    setMenu() {}
    show() {}
    focus() {}
    isDestroyed() {
      return false;
    }
    getBounds() {
      return this.bounds;
    }
    setAlwaysOnTop() {}
    setResizable() {}
    setMovable(v) {
      this.movable = v;
    }
    setFocusable(v) {
      this.focusable = v;
    }
    setSkipTaskbar(v) {
      this.skipTaskbar = v;
    }
    static getAllWindows() {
      return windows;
    }
  }
  const app = new EventEmitter();
  Object.assign(app, {
    getPath: (key) => (key === "desktop" ? path.join(dir, "desktop") : dir),
    requestSingleInstanceLock: () => lock,
    whenReady: () => Promise.resolve(),
    quit: () => {
      app.quitCalled = true;
    },
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: () => {},
  });
  const dialog = {
    showOpenDialog: async () => ({ canceled: false, filePaths: [dir] }),
  };
  const electron = {
    app,
    BrowserWindow: Window,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog,
    Menu: { setApplicationMenu: () => {} },
    screen: {
      getPrimaryDisplay: () => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
      getDisplayMatching: () => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "main.js"), "utf8"), {
    require: (name) =>
      name === "electron"
        ? electron
        : name === "./desktop-layer"
          ? {
              attach: () => {
                if (failAttach) throw Error("unsupported");
              },
              detach: () => {},
              ensureAttached: () => {},
            }
          : name === "./lib/file-store"
            ? require("../lib/file-store")
            : require(name),
    __dirname: root,
    process: { platform: "win32", argv: [] },
    console: { error: () => {} },
    setInterval: () => 0,
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
  });
  await Promise.resolve();
  return {
    configPath,
    dir,
    handlers,
    window: windows[0],
    timers,
    messages,
    app,
  };
}
test("saving window bounds preserves previously saved section heights and other preferences", async (t) => {
  const fixture = await boot(t, {
    zoneHeights: { todo: 123 },
    otherPreference: "keep",
  });
  await fixture.handlers.get("save-zone-heights")(null, {
    todo: 210,
    done: 70,
  });
  fixture.window.emit("move");
  fixture.timers.at(-1)();
  const config = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
  assert.deepEqual(config.zoneHeights, { todo: 210, done: 70 });
  assert.equal(config.otherPreference, "keep");
});
test("unsupported desktop anchoring falls back to an accessible floating window", async (t) => {
  const f = await boot(t, {}, true);
  f.window.emit("ready-to-show");
  assert.equal(f.window.focusable, true);
  assert.equal(f.window.movable, true);
  assert.equal(f.window.skipTaskbar, false);
  assert.equal(f.handlers.get("load-todo")().pinned, false);
});
test("a read failure never returns replacement task content; failed file switch preserves current path", async (t) => {
  const f = await boot(t);
  const before = f.handlers.get("get-file-path")();
  const switched = await f.handlers.get("change-file")();
  assert.equal(switched.success, false);
  assert.equal(switched.content, undefined);
  assert.equal(f.handlers.get("get-file-path")(), before);
});
test("native close requests let the renderer flush saves before quitting", async (t) => {
  const f = await boot(t);
  let prevented = false;
  f.window.emit("close", {
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.ok(f.messages.some((message) => message[0] === "close-requested"));
  f.handlers.get("close-app")();
  assert.equal(f.app.quitCalled, true);
});
test("a second process never creates another window", async (t) => {
  const f = await boot(t, {}, false, false);
  assert.equal(f.app.quitCalled, true);
  assert.equal(f.window, undefined);
});
