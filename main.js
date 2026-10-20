const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  screen,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const demoMode = process.argv.includes("--demo");
// Keep the original profile when changing the visible product name to Todo.
const legacyProfile = path.join(app.getPath("appData"), "todotree");
fs.mkdirSync(legacyProfile, { recursive: true });
app.setPath("userData", legacyProfile);
if (demoMode) {
  const demoData = path.join(app.getPath("temp"), "TodoTree-demo");
  fs.mkdirSync(demoData, { recursive: true });
  app.setPath("userData", demoData);
}

// 单实例锁：重复启动时直接退出，避免两个窗口叠在桌面层
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      isPinned = false;
      transientEdit = false;
      applyPinState();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  const desktopLayer = require("./desktop-layer");
  const fileStore = require("./lib/file-store");
  const seed = demoMode
    ? fs.readFileSync(path.join(__dirname, "examples", "demo.md"), "utf8")
    : "# Todo\n\n## 目标\n\n## 待完成\n\n## 已完成\n\n## 放弃\n";

  let currentFilePath = path.join(app.getPath("desktop"), "TODOTREE.md");
  if (demoMode)
    currentFilePath = path.join(app.getPath("userData"), "演示任务.md");
  let configPath = path.join(app.getPath("userData"), "config.json");
  let mainWindow;
  let isPinned = !demoMode;
  let expectQuit = false;
  let transientEdit = false;
  let recreateCount = 0;
  let windowBounds = { x: undefined, y: undefined, width: 520, height: 740 };

  function loadConfig() {
    try {
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (
          typeof config.filePath === "string" &&
          path.isAbsolute(config.filePath)
        )
          currentFilePath = config.filePath;
        for (const key of ["x", "y", "width", "height"])
          if (Number.isFinite(config.bounds?.[key]))
            windowBounds[key] = config.bounds[key];
        isPinned = demoMode ? false : config.pinned !== false;
      }
    } catch (_) {}
  }
  function saveConfig(patch = {}) {
    try {
      let existing = {};
      try {
        existing = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } catch (_) {}
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const temp = configPath + ".tmp";
      fs.writeFileSync(
        temp,
        JSON.stringify(
          {
            ...existing,
            filePath: currentFilePath,
            bounds: windowBounds,
            pinned: isPinned,
            ...patch,
          },
          null,
          2,
        ),
        "utf8",
      );
      fs.renameSync(temp, configPath);
    } catch (_) {}
  }
  loadConfig();

  function applyPinState(sendEvent = true) {
    if (!mainWindow) return;
    if (isPinned) {
      mainWindow.setAlwaysOnTop(false);
      mainWindow.setSkipTaskbar(true);
      // 锁定模式下仍允许拉伸窗口边缘（横向拉宽等），只禁拖动
      mainWindow.setResizable(true);
      mainWindow.setMovable(false);
      try {
        desktopLayer.attach(mainWindow);
        mainWindow.setFocusable(false);
      } catch (e) {
        // 环境不支持桌面层时回退为普通窗口
        console.error("[desktop-layer] attach failed:", e.message);
        isPinned = false;
        mainWindow.setFocusable(true);
        mainWindow.setSkipTaskbar(false);
        mainWindow.setMovable(true);
      }
    } else {
      mainWindow.setAlwaysOnTop(false);
      try {
        desktopLayer.detach(mainWindow);
      } catch (e) {
        console.error("[desktop-layer] detach failed:", e.message);
      }
      mainWindow.setFocusable(true);
      mainWindow.setSkipTaskbar(false);
      mainWindow.setResizable(true);
      mainWindow.setMovable(true);
    }
    if (sendEvent) mainWindow.webContents.send("pin-state-changed", isPinned);
  }

  function createWindow() {
    {
      const hasPosition =
        Number.isFinite(windowBounds.x) && Number.isFinite(windowBounds.y);
      const area = hasPosition
        ? screen.getDisplayMatching(windowBounds).workArea
        : screen.getPrimaryDisplay().workArea;
      windowBounds.width = Math.min(
        Math.max(380, windowBounds.width),
        area.width,
      );
      windowBounds.height = Math.min(
        Math.max(500, windowBounds.height),
        area.height,
      );
      if (hasPosition)
        windowBounds.x = Math.max(
          area.x,
          Math.min(windowBounds.x, area.x + area.width - windowBounds.width),
        );
      if (hasPosition)
        windowBounds.y = Math.max(
          area.y,
          Math.min(windowBounds.y, area.y + area.height - windowBounds.height),
        );
    }
    mainWindow = new BrowserWindow({
      x: windowBounds.x,
      y: windowBounds.y,
      width: windowBounds.width,
      height: windowBounds.height,
      minWidth: 380,
      minHeight: 500,
      resizable: true,
      frame: false,
      transparent: true,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    Menu.setApplicationMenu(null);
    mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
    mainWindow.setMenu(null);
    mainWindow.on("blur", () => {
      // 临时输入结束（点击了其他窗口）：自动回到桌面层
      if (isPinned && transientEdit) {
        transientEdit = false;
        applyPinState();
      }
    });
    mainWindow.on("ready-to-show", () => {
      mainWindow.show();
      applyPinState();
    });
    mainWindow.on("close", (event) => {
      if (!expectQuit) {
        event.preventDefault();
        mainWindow.webContents.send("close-requested");
      }
    });

    let saveBoundsTimer = null;
    const onBoundsChange = () => {
      if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
      saveBoundsTimer = setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const b = mainWindow.getBounds();
        windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
        saveConfig();
      }, 500);
    };
    mainWindow.on("resize", onBoundsChange);
    mainWindow.on("move", onBoundsChange);
  }

  ipcMain.handle("load-todo", () => {
    return { ...fileStore.read(currentFilePath, seed), pinned: isPinned };
  });

  ipcMain.handle("save-todo", (_event, request) =>
    fileStore.save(
      currentFilePath,
      request,
      path.join(app.getPath("userData"), "backups"),
    ),
  );
  ipcMain.handle("save-copy", async (_event, content) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "保留当前任务副本",
      defaultPath: currentFilePath.replace(/\.(md|txt)$/i, "") + "-副本.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (result.canceled || !result.filePath) return null;
    if (
      path.resolve(result.filePath).toLowerCase() ===
      path.resolve(currentFilePath).toLowerCase()
    )
      return { success: false, error: "请选择其他文件名，以保留外部修改" };
    const disk = fileStore.read(result.filePath);
    if (!disk.success) return disk;
    return {
      ...fileStore.save(result.filePath, {
        content,
        filePath: result.filePath,
        revision: disk.revision,
      }),
      filePath: result.filePath,
    };
  });
  ipcMain.handle("open-backups", () => {
    const dir = fileStore.backupFolder(
      currentFilePath,
      path.join(app.getPath("userData"), "backups"),
    );
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });

  ipcMain.handle("change-file", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 TODOTREE 文件",
      filters: [
        { name: "Markdown", extensions: ["md", "txt"] },
        { name: "All Files", extensions: ["*"] },
      ],
      properties: ["openFile"],
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const loaded = fileStore.read(result.filePaths[0]);
      if (!loaded.success) return loaded;
      currentFilePath = result.filePaths[0];
      saveConfig();
      return loaded;
    }
    return null;
  });

  ipcMain.handle("get-file-path", () => currentFilePath);
  ipcMain.handle("toggle-pin", () => {
    isPinned = !isPinned;
    transientEdit = false;
    applyPinState();
    saveConfig();
    return isPinned;
  });
  // 锁定模式下点击输入框：临时摘回普通窗口拿键盘焦点，失焦后自动回到桌面层
  ipcMain.handle("begin-transient-edit", () => {
    if (!isPinned || !mainWindow) return false;
    try {
      desktopLayer.detach(mainWindow);
      mainWindow.setFocusable(true);
      transientEdit = true;
      mainWindow.focus();
      return true;
    } catch (e) {
      console.error("[desktop-layer] transient edit failed:", e.message);
      return false;
    }
  });
  ipcMain.handle("close-app", () => {
    expectQuit = true;
    app.quit();
  });

  ipcMain.handle("get-zone-heights", () => {
    try {
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        return config.zoneHeights || {};
      }
    } catch (_) {}
    return {};
  });

  ipcMain.handle("save-zone-heights", async (_event, heights) => {
    saveConfig({ zoneHeights: heights });
  });

  ipcMain.handle("get-auto-start", () => {
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle("toggle-auto-start", () => {
    const current = app.getLoginItemSettings().openAtLogin;
    const settings = { openAtLogin: !current, name: "TodoTree" };
    // 开发模式跑的是 electron.exe，必须带上项目路径参数，否则开机弹出 Electron 默认页
    if (!app.isPackaged) settings.args = [__dirname];
    app.setLoginItemSettings(settings);
    return !current;
  });

  app.whenReady().then(() => {
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on("window-all-closed", () => {
    // 挂在桌面树里的窗口会被 explorer 重启连带销毁：非用户主动关闭时自动重建
    if (process.platform !== "darwin" && !expectQuit && recreateCount < 3) {
      recreateCount += 1;
      setTimeout(() => {
        try {
          createWindow();
        } catch (e) {
          console.error("recreate failed:", e.message);
        }
      }, 1000);
      return;
    }
    app.quit();
  });

  // 桌面层看门狗：explorer 重启等意外后自动恢复
  setInterval(() => {
    if (!mainWindow || !isPinned || transientEdit) return;
    try {
      const result = desktopLayer.ensureAttached(mainWindow);
      if (result === "container-lost") {
        isPinned = false;
        applyPinState();
      }
    } catch (_) {}
  }, 5000);
}
