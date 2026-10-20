"use strict";
const M = window.TaskModel;
const $ = (id) => document.getElementById(id);
const api = window.todoAPI;
const statusNames = {
  pending: "待完成",
  done: "已完成",
  urgent: "紧急",
  goal: "目标",
  abandoned: "放弃",
};
let items = [],
  blocks,
  filePath = "",
  revision = null,
  ready = false,
  pinned = true;
let editVersion = 0,
  savedVersion = 0,
  saving = null,
  blocked = false,
  filter = "all",
  query = "";
let undoStack = [],
  dragging = false,
  switching = false;
const pref = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem("todotree." + key)) ?? fallback;
  } catch (_) {
    return fallback;
  }
};
const keep = (key, value) => {
  try {
    localStorage.setItem("todotree." + key, JSON.stringify(value));
  } catch (_) {}
};
let zoneOrder = pref(
  "zoneOrder",
  M.zones.map((z) => z.id),
);
if (
  !Array.isArray(zoneOrder) ||
  zoneOrder.length !== 4 ||
  new Set(zoneOrder).size !== 4 ||
  zoneOrder.some((id) => !M.zones.some((z) => z.id === id))
)
  zoneOrder = M.zones.map((z) => z.id);
let closedZones = pref("closedZones", ["abandoned"]),
  heights = {};
if (!Array.isArray(closedZones)) closedZones = [];
const clone = (value) => JSON.parse(JSON.stringify(value));
const dirty = () => editVersion !== savedVersion;
const ordered = (a, b) =>
  Number(b.status === "urgent") - Number(a.status === "urgent") ||
  a.order - b.order;
const children = (id) => items.filter((i) => i.parentId === id).sort(ordered);
const active = (item) => !["done", "abandoned", "goal"].includes(item.status);
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(text, label, action, className = "") {
  const el = element("button", className, text);
  el.type = "button";
  el.title = label;
  el.setAttribute("aria-label", label);
  el.addEventListener("click", action);
  return el;
}
function state(text, type = "saved") {
  $("save-state").textContent = text;
  $("save-state").dataset.state = type;
}
function notice(text, conflict = false) {
  $("notice").hidden = false;
  $("notice-text").textContent = text;
  $("retry-btn").hidden = conflict;
  $("copy-btn").hidden = !ready;
  $("load-btn").textContent = conflict ? "载入外部版本" : "重新读取";
}
function hideNotice() {
  $("notice").hidden = true;
}
function serialize() {
  return M.serialize(items, blocks);
}
function mutate(action) {
  if (!ready || switching) return;
  undoStack.push(clone(items));
  if (undoStack.length > 20) undoStack.shift();
  action();
  editVersion++;
  render();
  void save();
}
async function save() {
  if (saving) return saving;
  if (!ready || blocked || !dirty()) return;
  saving = (async () => {
    try {
      while (dirty() && !blocked) {
        const version = editVersion,
          content = serialize();
        state("正在保存…", "saving");
        const result = await api.save({ content, revision, filePath });
        if (!result.success) {
          blocked = true;
          state("更改未保存", "error");
          notice(result.error || "保存失败，请重试", !!result.conflict);
          break;
        }
        revision = result.revision;
        savedVersion = version;
      }
      if (!dirty()) state(api.isPreview ? "演示 · 仅当前页面" : "已保存到本地");
    } catch (error) {
      blocked = true;
      state("更改未保存", "error");
      notice(error.message || "保存失败，请重试");
    } finally {
      saving = null;
    }
  })();
  return saving;
}
async function modal({
  title,
  description = "",
  text = "",
  date = "",
  confirm = false,
  submit = "保存",
}) {
  const dialog = $("task-dialog");
  if (dialog.open) return null;
  $("dialog-title").textContent = title;
  $("dialog-description").textContent = description;
  $("dialog-description").hidden = !description;
  $("dialog-text-label").hidden = confirm;
  $("dialog-date-label").hidden = confirm;
  $("dialog-text").value = text;
  $("dialog-date").value = date;
  $("dialog-text").required = !confirm;
  $("dialog-submit").textContent = submit;
  await api.beginTransientEdit();
  dialog.showModal();
  (confirm ? $("dialog-cancel") : $("dialog-text")).focus();
  if (!confirm) $("dialog-text").select();
  return new Promise((resolve) => {
    let result = null;
    const finish = () => {
      $("dialog-form").removeEventListener("submit", onSubmit);
      $("dialog-cancel").removeEventListener("click", onCancel);
      dialog.removeEventListener("close", finish);
      resolve(result);
    };
    const onSubmit = (event) => {
      event.preventDefault();
      const value = $("dialog-text").value.trim(),
        ddl = $("dialog-date").value;
      if (!confirm && (!value || (ddl && !M.validDate(ddl)))) return;
      result = confirm ? true : { text: value, ddl: ddl || null };
      dialog.close();
    };
    const onCancel = () => dialog.close();
    $("dialog-form").addEventListener("submit", onSubmit);
    $("dialog-cancel").addEventListener("click", onCancel);
    dialog.addEventListener("close", finish);
  });
}
async function allowDiscard(title) {
  await save();
  if (!dirty() && !$("new-todo-input").value.trim()) return true;
  return !!(await modal({
    title,
    description:
      "还有未保存的更改或正在输入的任务。继续后将丢弃这些内容；也可以取消并先保存副本。",
    confirm: true,
    submit: "继续",
  }));
}
function acceptLoaded(result) {
  if (!result?.success) {
    state("读取失败", "error");
    notice(result?.error || "无法读取文件");
    return false;
  }
  const parsed = M.parse(result.content);
  items = parsed.items;
  blocks = parsed.blocks;
  filePath = result.filePath;
  revision = result.revision;
  ready = true;
  blocked = false;
  editVersion = savedVersion = 0;
  undoStack = [];
  hideNotice();
  $("file-path-bar").textContent = filePath.split(/[\\/]/).pop();
  $("file-path-bar").title = filePath;
  $("add-btn").disabled = false;
  if (typeof result.pinned === "boolean") updatePin(result.pinned);
  render();
  state(
    api.isPreview
      ? "演示 · 仅当前页面"
      : revision === null
        ? "添加任务后创建文件"
        : "已同步本地文件",
  );
  return true;
}
async function reload() {
  if (!(await allowDiscard("载入文件版本？"))) return;
  switching = true;
  try {
    acceptLoaded(await api.load());
  } catch (e) {
    notice(e.message);
  } finally {
    switching = false;
  }
}
function setStatus(item, status) {
  if (item.status === status) return;
  mutate(() => {
    for (const target of [item, ...M.descendants(items, item.id)]) {
      target.status = status;
      target.statusChangedAt = Date.now();
    }
  });
}
function cycleStatus(item) {
  const cycle = ["pending", "done", "urgent", "abandoned"];
  setStatus(item, cycle[(cycle.indexOf(item.status) + 1) % cycle.length]);
}
async function editItem(item) {
  const result = await modal({
    title: "编辑任务",
    text: item.text,
    date: item.ddl || "",
  });
  if (result) mutate(() => Object.assign(item, result));
}
async function addChild(item) {
  const result = await modal({
    title: "添加子任务",
    description: "属于：" + item.text,
  });
  if (result)
    mutate(() => {
      item.collapsed = false;
      items.push({
        id: M.id(),
        ...result,
        parentId: item.id,
        zone: item.zone,
        status: {
          goals: "goal",
          todo: "pending",
          done: "done",
          abandoned: "abandoned",
        }[item.zone],
        collapsed: false,
        order: nextOrder(),
        statusChangedAt: null,
      });
    });
}
function nextOrder() {
  return items.reduce((max, item) => Math.max(max, item.order), -1) + 1;
}
function addItem() {
  const text = $("new-todo-input").value.trim(),
    ddl = $("ddl-input").value,
    zone = $("zone-select").value,
    parentId = $("parent-select").value || null;
  if (!text || !ready) {
    $("new-todo-input").focus();
    return;
  }
  if (ddl && !M.validDate(ddl)) return;
  mutate(() => {
    items.push({
      id: M.id(),
      text,
      ddl: ddl || null,
      zone,
      parentId,
      status: {
        goals: "goal",
        done: "done",
        abandoned: "abandoned",
        todo: "pending",
      }[zone],
      order: nextOrder(),
      collapsed: false,
      statusChangedAt: null,
    });
    const parent = items.find((i) => i.id === parentId);
    if (parent) parent.collapsed = false;
    closedZones = closedZones.filter((id) => id !== zone);
    keep("closedZones", closedZones);
  });
  $("new-todo-input").value = "";
  $("ddl-input").value = "";
  $("new-todo-input").focus();
}
async function deleteItem(item) {
  const descendants = M.descendants(items, item.id);
  if (
    descendants.length &&
    !(await modal({
      title: "删除这棵任务树？",
      description:
        "将删除“" +
        item.text +
        "”及其 " +
        descendants.length +
        " 项子任务，删除后可以撤回。",
      confirm: true,
      submit: "删除",
    }))
  )
    return;
  mutate(() => {
    const ids = new Set([item.id, ...descendants.map((i) => i.id)]);
    items = items.filter((i) => !ids.has(i.id));
  });
}
async function menu(item, x, y) {
  await api.beginTransientEdit();
  const root = $("context-menu");
  root.replaceChildren();
  const actions = [
    ["编辑任务", () => editItem(item)],
    ["添加子任务", () => addChild(item)],
  ];
  for (const status of ["pending", "done", "urgent", "goal", "abandoned"])
    actions.push(["设为" + statusNames[status], () => setStatus(item, status)]);
  actions.push(["删除任务", () => deleteItem(item), "danger"]);
  for (const [label, action, style] of actions) {
    const el = button(
      label,
      label,
      () => {
        root.hidden = true;
        void action();
      },
      style,
    );
    el.setAttribute("role", "menuitem");
    root.append(el);
  }
  root.hidden = false;
  root.style.left =
    Math.max(8, Math.min(x, innerWidth - root.offsetWidth - 8)) + "px";
  root.style.top =
    Math.max(8, Math.min(y, innerHeight - root.offsetHeight - 8)) + "px";
  root.querySelector("button").focus();
}
function updateParentSelect() {
  const select = $("parent-select"),
    previous = select.value;
  select.replaceChildren(new Option("独立任务", ""));
  function add(parentId, depth = 0) {
    for (const item of children(parentId).filter(
      (i) => i.zone === $("zone-select").value,
    )) {
      select.add(
        new Option("　".repeat(Math.min(depth, 6)) + item.text, item.id),
      );
      add(item.id, depth + 1);
    }
  }
  // Include cross-zone roots whose parent is displayed in another section.
  for (const item of items.filter(
    (i) =>
      i.zone === $("zone-select").value &&
      i.parentId &&
      items.find((p) => p.id === i.parentId)?.zone !== i.zone,
  )) {
    select.add(new Option("↳ " + item.text, item.id));
    add(item.id, 1);
  }
  add(null);
  select.value = [...select.options].some((o) => o.value === previous)
    ? previous
    : "";
}
function matches(item) {
  const search = !query || item.text.toLocaleLowerCase().includes(query);
  return (
    search &&
    (filter === "all" ||
      (filter === "urgent"
        ? item.status === "urgent"
        : active(item) && item.ddl && item.ddl <= M.localDate()))
  );
}
function render() {
  const root = $("zones-container"),
    scroll = root.scrollTop;
  const scrolls = new Map(
    [...root.querySelectorAll(".zone-body")].map((el) => [
      el.dataset.zone,
      el.scrollTop,
    ]),
  );
  root.replaceChildren();
  $("undo-btn").disabled = !undoStack.length;
  const work = items.filter(
    (i) => i.status !== "goal" && i.status !== "abandoned",
  );
  const done = work.filter((i) => i.status === "done").length;
  const percentage = work.length ? Math.round((done / work.length) * 100) : 0;
  $("pending-count").textContent = items.filter(active).length;
  $("urgent-count").textContent = items.filter(
    (i) => i.status === "urgent",
  ).length;
  $("done-count").textContent = done;
  $("progress-value").replaceChildren(
    document.createTextNode(String(percentage)),
    element("span", "", "%"),
  );
  $("progress-ring").style.setProperty("--progress", percentage + "%");
  $("progress-ring").setAttribute(
    "aria-label",
    "执行任务完成度 " + percentage + "%",
  );
  $("overview-caption").textContent = work.length
    ? "执行任务已完成 " + done + " / " + work.length + " · 不含目标与放弃项"
    : "写下第一件小事，就从这里开始";
  const matched = items.filter(matches),
    visible = new Set(matched.map((i) => i.id)),
    filtered = !!query || filter !== "all";
  if (filtered)
    for (const item of matched) {
      let parent = items.find((i) => i.id === item.parentId);
      const seen = new Set();
      while (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        visible.add(parent.id);
        parent = items.find((i) => i.id === parent.parentId);
      }
    }
  $("stats").textContent = filtered
    ? matched.length + " 项匹配 / 共 " + items.length + " 项"
    : "共 " + items.length + " 项";
  for (const zoneId of zoneOrder) {
    const zone = M.zones.find((z) => z.id === zoneId),
      members = items.filter((i) => i.zone === zoneId).sort(ordered);
    const section = element("section", "zone-section");
    section.dataset.zoneId = zoneId;
    const header = element("div", "zone-header");
    const handle = element("span", "zone-drag", "⠿");
    handle.draggable = true;
    handle.title = "拖动调整分区顺序";
    handle.addEventListener("dragstart", (e) => {
      dragging = true;
      e.dataTransfer.setData("text/zone", zoneId);
    });
    handle.addEventListener("dragend", () => {
      dragging = false;
    });
    const collapsed = closedZones.includes(zoneId) && !filtered;
    const toggle = button(
      "",
      (collapsed ? "展开" : "折叠") + zone.name,
      () => {
        closedZones = closedZones.includes(zoneId)
          ? closedZones.filter((id) => id !== zoneId)
          : [...closedZones, zoneId];
        keep("closedZones", closedZones);
        render();
      },
      "zone-toggle",
    );
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.append(
      element("span", "zone-symbol"),
      element("span", "", zone.name),
      element("span", "zone-count", String(members.length)),
      element("span", "zone-chevron", collapsed ? "›" : "⌄"),
    );
    const add = button(
      "+",
      "添加到" + zone.name,
      () => {
        $("zone-select").value = zoneId;
        updateParentSelect();
        $("parent-select").value = "";
        void api.beginTransientEdit().then(() => $("new-todo-input").focus());
      },
      "zone-add",
    );
    header.append(handle, toggle, add);
    section.append(header);
    const body = element("div", "zone-body");
    body.dataset.zone = zoneId;
    body.hidden = collapsed;
    if (Number.isFinite(heights[zoneId]))
      body.style.height = heights[zoneId] + "px";
    body.addEventListener("pointerup", () => {
      if (body.style.height) {
        heights[zoneId] = Math.max(
          38,
          Math.min(480, parseFloat(body.style.height)),
        );
        void api.saveZoneHeights(heights);
      }
    });
    const drawn = new Set();
    const draw = (item, depth, number) => {
      if (drawn.has(item.id) || (filtered && !visible.has(item.id))) return;
      drawn.add(item.id);
      body.append(renderRow(item, depth, number));
      if (!item.collapsed || filtered)
        children(item.id)
          .filter((i) => i.zone === zoneId)
          .forEach((child, index) => draw(child, depth + 1, index + 1));
    };
    members
      .filter(
        (i) =>
          !i.parentId ||
          items.find((p) => p.id === i.parentId)?.zone !== zoneId,
      )
      .forEach((item, index) => {
        if (filtered && !visible.has(item.id)) return;
        if (item.parentId) {
          const parent = items.find((p) => p.id === item.parentId);
          if (parent)
            body.append(
              element(
                "p",
                "parent-context",
                "↳ " +
                  parent.text +
                  " · " +
                  (M.zones.find((z) => z.id === parent.zone)?.name || ""),
              ),
            );
        }
        draw(item, 0, index + 1);
      });
    if (!drawn.size)
      body.append(
        element(
          "p",
          "zone-empty",
          filtered
            ? "没有匹配的任务"
            : {
                goals: "给想去的方向，留个位置",
                todo: "暂时没有待办，享受这会儿轻松",
                done: "每一个完成，都算数",
                abandoned: "留白也没关系",
              }[zoneId],
        ),
      );
    section.append(body);
    section.addEventListener("dragover", (e) => {
      e.preventDefault();
      section.classList.add("drag-over");
    });
    section.addEventListener("dragleave", (e) => {
      if (!section.contains(e.relatedTarget))
        section.classList.remove("drag-over");
    });
    section.addEventListener("drop", (e) => {
      e.preventDefault();
      section.classList.remove("drag-over");
      dragging = false;
      const from = e.dataTransfer.getData("text/zone"),
        taskId = e.dataTransfer.getData("text/task");
      if (from && from !== zoneId) {
        zoneOrder.splice(zoneOrder.indexOf(from), 1);
        zoneOrder.splice(zoneOrder.indexOf(zoneId), 0, from);
        keep("zoneOrder", zoneOrder);
        render();
      } else if (taskId) {
        const item = items.find((i) => i.id === taskId);
        if (!item || item.zone === zoneId) return;
        mutate(() => {
          for (const target of [item, ...M.descendants(items, item.id)]) {
            target.zone = zoneId;
            target.status = {
              todo: "pending",
              goals: "goal",
              done: "done",
              abandoned: "abandoned",
            }[zoneId];
            target.statusChangedAt = null;
          }
          item.order = nextOrder();
        });
      }
    });
    root.append(section);
    body.scrollTop = scrolls.get(zoneId) || 0;
  }
  root.scrollTop = scroll;
  updateParentSelect();
}
function renderRow(item, depth, number) {
  const row = element("div", "node-row " + item.status);
  row.style.setProperty("--depth", depth);
  row.dataset.id = item.id;
  row.draggable = true;
  const hasChildren = children(item.id).some((i) => i.zone === item.zone);
  const toggle = button(
    hasChildren ? (item.collapsed ? "›" : "⌄") : "",
    "展开或折叠子任务",
    () =>
      mutate(() => {
        item.collapsed = !item.collapsed;
      }),
    "node-toggle",
  );
  toggle.disabled = !hasChildren;
  const status = button(
    { done: "✓", urgent: "!", goal: "·", abandoned: "−", pending: "" }[
      item.status
    ],
    statusNames[item.status] + "，点击切换状态",
    () => cycleStatus(item),
    "status-dot " + item.status,
  );
  const text = element("span", "node-text", item.text);
  text.addEventListener("dblclick", () => void editItem(item));
  row.append(
    toggle,
    status,
    element("span", "node-number", number + "."),
    text,
  );
  if (item.ddl) {
    const overdue = active(item) && item.ddl < M.localDate();
    const deadline = element(
      "span",
      "deadline" + (overdue ? " overdue" : ""),
      item.ddl === M.localDate() ? "今天" : item.ddl.slice(5).replace("-", "/"),
    );
    deadline.title = "截止 " + item.ddl + (overdue ? " · 已逾期" : "");
    row.append(deadline);
  }
  row.append(
    button(
      "⋯",
      "更多操作：" + item.text,
      (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        menu(item, rect.right, rect.bottom);
      },
      "row-menu",
    ),
  );
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    menu(item, e.clientX, e.clientY);
  });
  row.addEventListener("dragstart", (e) => {
    dragging = true;
    e.dataTransfer.setData("text/task", item.id);
    e.stopPropagation();
  });
  row.addEventListener("dragend", () => {
    dragging = false;
  });
  row.addEventListener("dragover", (e) => e.preventDefault());
  row.addEventListener("drop", (e) => {
    const from = items.find(
      (i) => i.id === e.dataTransfer.getData("text/task"),
    );
    if (
      !from ||
      from.id === item.id ||
      from.parentId !== item.parentId ||
      from.zone !== item.zone
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    dragging = false;
    mutate(() => {
      const siblings = items
        .filter((i) => i.parentId === item.parentId && i.zone === item.zone)
        .sort((a, b) => a.order - b.order);
      siblings.splice(siblings.indexOf(from), 1);
      siblings.splice(siblings.indexOf(item), 0, from);
      const orders = siblings.map((i) => i.order).sort((a, b) => a - b);
      siblings.forEach((i, index) => {
        i.order = orders[index];
      });
    });
  });
  return row;
}
function updatePin(value) {
  pinned = value;
  $("pin-btn").classList.toggle("active", pinned);
  $("pin-btn").setAttribute("aria-pressed", String(pinned));
  $("pin-btn").title = pinned
    ? "已固定到桌面 · 点击解锁"
    : "浮动窗口 · 点击固定到桌面";
}
function applyTheme(theme) {
  if (!["gold", "paper", "forest"].includes(theme)) theme = "gold";
  document.documentElement.dataset.theme = theme;
  keep("theme", theme);
  document
    .querySelectorAll("[data-theme-choice]")
    .forEach((el) =>
      el.setAttribute("aria-pressed", String(el.dataset.themeChoice === theme)),
    );
}
function undo() {
  if (!undoStack.length || !ready) return;
  items = undoStack.pop();
  editVersion++;
  render();
  void save();
}
document.addEventListener("DOMContentLoaded", async () => {
  applyTheme(pref("theme", "gold"));
  const opacity = Math.max(
    65,
    Math.min(100, Number(pref("opacity", 95)) || 95),
  );
  $("opacity").value = opacity;
  document.documentElement.style.setProperty("--opacity", opacity / 100);
  const fontSteps = [1, 1.12, 1.24];
  let fontIndex = Math.max(0, Math.min(2, Number(pref("fontIndex", 0)) || 0));
  const applyFont = () => {
    document.documentElement.style.setProperty(
      "--font-scale",
      fontSteps[fontIndex],
    );
    $("font-btn").textContent = "字号：" + ["标准", "大", "更大"][fontIndex];
  };
  applyFont();
  $("today").textContent = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());
  $("add-btn").disabled = true;
  if (!api) {
    state("桌面连接失败", "error");
    notice(
      "无法连接桌面服务，请退出后重新启动 TodoTree。当前页面不会写入任务文件。",
    );
    $("notice").querySelector("div").hidden = true;
    return;
  }
  $("add-btn").onclick = addItem;
  $("new-todo-input").onkeydown = (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      addItem();
    }
  };
  $("zone-select").onchange = updateParentSelect;
  $("undo-btn").onclick = undo;
  $("pin-btn").onclick = async () => updatePin(await api.togglePin());
  $("close-btn").onclick = async () => {
    if (await allowDiscard("退出 TodoTree？")) await api.closeApp();
  };
  $("refresh-btn").onclick = () => {
    $("settings").open = false;
    void reload();
  };
  $("open-file-btn").onclick = async () => {
    $("settings").open = false;
    if (!(await allowDiscard("切换任务文件？"))) return;
    switching = true;
    try {
      const result = await api.changeFile();
      if (result) acceptLoaded(result);
    } catch (e) {
      notice(e.message);
    } finally {
      switching = false;
    }
  };
  $("file-path-bar").onclick = () => {
    $("settings").open = true;
  };
  $("backup-btn").onclick = () => void api.openBackups();
  $("retry-btn").onclick = async () => {
    if (!ready) {
      acceptLoaded(await api.load());
      return;
    }
    blocked = false;
    hideNotice();
    await save();
  };
  $("load-btn").onclick = () => void reload();
  $("copy-btn").onclick = async () => {
    const result = await api.saveCopy(serialize());
    if (result?.success) {
      state("副本已保存；原文件尚未同步", "error");
      $("notice-text").textContent =
        "当前更改已保存在 " + result.filePath + "，现在可以载入外部版本。";
    } else if (result) notice(result.error || "保存副本失败", true);
  };
  $("font-btn").onclick = () => {
    fontIndex = (fontIndex + 1) % fontSteps.length;
    keep("fontIndex", fontIndex);
    applyFont();
  };
  const applyCompact = () => {
    const compact = !!pref("compact", false);
    document.body.classList.toggle("compact", compact);
    $("compact-btn").textContent = "紧凑视图：" + (compact ? "开" : "关");
  };
  applyCompact();
  $("compact-btn").onclick = () => {
    keep("compact", !pref("compact", false));
    applyCompact();
  };
  $("opacity").oninput = () => {
    document.documentElement.style.setProperty(
      "--opacity",
      Number($("opacity").value) / 100,
    );
    keep("opacity", Number($("opacity").value));
  };
  document
    .querySelectorAll("[data-theme-choice]")
    .forEach((el) => (el.onclick = () => applyTheme(el.dataset.themeChoice)));
  document.querySelectorAll("[data-filter]").forEach(
    (el) =>
      (el.onclick = () => {
        filter = el.dataset.filter;
        document
          .querySelectorAll("[data-filter]")
          .forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
        render();
      }),
  );
  $("search").oninput = () => {
    query = $("search").value.trim().toLocaleLowerCase();
    render();
  };
  for (const [id, collapsed] of [
    ["collapse-all", true],
    ["expand-all", false],
  ])
    $(id).onclick = () => {
      closedZones = collapsed ? [...zoneOrder] : [];
      keep("closedZones", closedZones);
      mutate(() =>
        items.forEach((i) => {
          i.collapsed = collapsed;
        }),
      );
      $("settings").open = false;
    };
  try {
    heights = await api.getZoneHeights();
    if (!heights || typeof heights !== "object") heights = {};
    acceptLoaded(await api.load());
    const auto = await api.getAutoStart();
    $("auto-start-btn").textContent = "开机自启：" + (auto ? "开" : "关");
    $("auto-start-btn").onclick = async () => {
      const enabled = await api.toggleAutoStart();
      $("auto-start-btn").textContent = "开机自启：" + (enabled ? "开" : "关");
    };
  } catch (e) {
    state("读取失败", "error");
    notice(e.message);
  }
  if (api.isPreview) {
    $("storage-badge").textContent = "演示 · 不写入文件";
    $("pin-btn").disabled = true;
    $("auto-start-btn").disabled = true;
  }
});
document.addEventListener("pointerdown", (e) => {
  if (!$("context-menu").contains(e.target)) $("context-menu").hidden = true;
  if (!$("settings").contains(e.target)) $("settings").open = false;
  if (pinned && e.target.closest("input,select"))
    void api.beginTransientEdit().then(() => {
      if (e.target.isConnected) e.target.focus();
    });
});
document.addEventListener("keydown", (e) => {
  const input = e.target.closest("input,textarea,[contenteditable=true]");
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (e.key.toLowerCase() === "f") {
      e.preventDefault();
      $("search").focus();
    }
    if (e.key.toLowerCase() === "n" && !$("task-dialog").open) {
      e.preventDefault();
      $("new-todo-input").focus();
    }
    if (e.key.toLowerCase() === "z" && !input && !$("task-dialog").open) {
      e.preventDefault();
      undo();
    }
  }
  if (e.key === "Escape") {
    $("context-menu").hidden = true;
    $("settings").open = false;
  }
  if (!$("context-menu").hidden && ["ArrowDown", "ArrowUp"].includes(e.key)) {
    e.preventDefault();
    const buttons = [...$("context-menu").querySelectorAll("button")],
      current = buttons.indexOf(document.activeElement);
    buttons[
      (current + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
        buttons.length
    ].focus();
  }
});
api?.onPinStateChanged(updatePin);
api?.onCloseRequested?.(async () => {
  if ($("task-dialog").open) return;
  if (await allowDiscard("退出 TodoTree？")) await api.closeApp();
});
setInterval(async () => {
  if (
    !ready ||
    saving ||
    blocked ||
    dragging ||
    switching ||
    $("task-dialog").open
  )
    return;
  try {
    const result = await api.load();
    if (!result.success) {
      state("读取失败", "error");
      notice(result.error);
      return;
    }
    if (result.revision !== revision) {
      if (dirty() || $("new-todo-input").value.trim()) {
        blocked = true;
        notice("文件已在外部修改。请先保存副本，再载入外部版本。", true);
        state("等待处理文件变化", "error");
      } else acceptLoaded(result);
    }
  } catch (e) {
    notice(e.message);
  }
}, 15000);
setInterval(() => {
  if (
    !ready ||
    blocked ||
    saving ||
    dragging ||
    switching ||
    $("task-dialog").open
  )
    return;
  const snapshot = clone(items);
  if (M.settle(items)) {
    undoStack.push(snapshot);
    if (undoStack.length > 20) undoStack.shift();
    editVersion++;
    render();
    void save();
  }
}, 1000);
