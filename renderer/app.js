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
const MIN_ZONE_BODY_HEIGHT = 44;
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
  resizing = false,
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

let closedZones = pref("closedZones", []),
  heights = {};
if (!Array.isArray(closedZones)) closedZones = [];

const clone = (value) => JSON.parse(JSON.stringify(value));
const dirty = () => editVersion !== savedVersion;
// 仅已结算的紧急任务置顶，60 秒缓冲期内保持原位不跳顶，防止连续点击误触别行
const ordered = (a, b) =>
  Number(!!b.pinnedUrgent) - Number(!!a.pinnedUrgent) || a.order - b.order;
const children = (id) => items.filter((i) => i.parentId === id).sort(ordered);
const active = (item) => !["done", "abandoned", "goal"].includes(item.status);

function syncPinnedUrgent(list) {
  for (const item of list) {
    if (!item.statusChangedAt) {
      item.pinnedUrgent = item.status === "urgent" && item.zone !== "goals";
    }
  }
}

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
function mutate(action, customStateText = null) {
  if (!ready || switching) return;
  undoStack.push(clone(items));
  if (undoStack.length > 20) undoStack.shift();
  action();
  editVersion++;
  render();
  void save(customStateText);
}
async function save(customSavedText = null) {
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
      if (!dirty()) {
        state(
          customSavedText ||
            (api.isPreview ? "演示 · 仅当前页面" : "已保存到本地"),
        );
      }
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
  syncPinnedUrgent(items);
  blocks = parsed.blocks;
  filePath = result.filePath;
  revision = result.revision;
  ready = true;
  blocked = false;
  editVersion = savedVersion = 0;
  undoStack = [];
  hideNotice();
  $("file-path-bar").textContent = filePath.split(/[\\/]/).pop();
  $("file-path-bar").title = filePath + "（点击切换任务文件）";
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

async function switchFile() {
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
}

function setStatus(item, status, cascade = true) {
  if (item.status === status) return;
  mutate(() => {
    const targets = cascade ? [item, ...M.descendants(items, item.id)] : [item];
    for (const target of targets) {
      target.status = status;
      target.statusChangedAt = Date.now();
    }
  });
}

function cycleStatus(item) {
  // 目标分区左键点击受保护，防止误点冲掉长期目标（右键菜单仍可显式修改状态）
  if (item.zone === "goals") {
    state("目标项受保护 · 双击可编辑，右键可改状态");
    return;
  }
  const cycle = ["pending", "done", "urgent", "abandoned"];
  const idx = cycle.indexOf(item.status);
  setStatus(item, cycle[(idx + 1) % cycle.length]);
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
      const isUrgent = false;
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
        pinnedUrgent: isUrgent,
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
      pinnedUrgent: false,
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

// 一键删除（带 20 步撤回 + 自动备份保护，不弹多余确认窗）
function deleteSubtree(item) {
  const descendants = M.descendants(items, item.id);
  const count = 1 + descendants.length;
  mutate(() => {
    const ids = new Set([item.id, ...descendants.map((i) => i.id)]);
    items = items.filter((i) => !ids.has(i.id));
  }, `已删除 ${count} 项 · Ctrl+Z 可撤回`);
}

function deleteSingleKeepChildren(item) {
  mutate(() => {
    for (const child of items.filter((i) => i.parentId === item.id)) {
      child.parentId = item.parentId || null;
    }
    items = items.filter((i) => i.id !== item.id);
  }, "已删除此项（保留子任务）· Ctrl+Z 可撤回");
}

function promoteToRoot(item) {
  if (!item.parentId) return;
  mutate(() => {
    item.parentId = null;
    item.order = nextOrder();
  }, "已升级为独立根任务");
}

function clearZone(zoneId) {
  const zone = M.zones.find((z) => z.id === zoneId);
  const toRemove = new Set(
    items.filter((i) => i.zone === zoneId).map((i) => i.id),
  );
  if (!toRemove.size) return;
  mutate(
    () => {
      items = items.filter((i) => !toRemove.has(i.id));
      // 跨分区子任务的父节点若在被清空分区内，自动解除断链保留在其他分区
      for (const item of items) {
        if (item.parentId && toRemove.has(item.parentId)) {
          item.parentId = null;
        }
      }
    },
    `已清空「${zone?.name || zoneId}」(${toRemove.size} 项) · Ctrl+Z 可撤回`,
  );
}

async function menu(item, x, y) {
  await api.beginTransientEdit();
  const root = $("context-menu");
  root.replaceChildren();
  const hasSubtasks = M.descendants(items, item.id).length > 0;
  const actions = [
    ["编辑任务 / 截止日期", () => editItem(item)],
    ["添加子任务", () => addChild(item)],
  ];
  if (item.parentId) {
    actions.push(["升级为独立根任务", () => promoteToRoot(item)]);
  }
  actions.push(["sep"]);
  for (const status of ["pending", "done", "urgent", "goal", "abandoned"])
    actions.push(["设为" + statusNames[status], () => setStatus(item, status)]);
  actions.push(["sep"]);
  if (hasSubtasks) {
    actions.push([
      "仅删此项（保留子任务）",
      () => deleteSingleKeepChildren(item),
      "danger",
    ]);
    actions.push([
      "删除含全部子任务",
      () => deleteSubtree(item),
      "danger",
    ]);
  } else {
    actions.push(["删除任务", () => deleteSubtree(item), "danger"]);
  }
  for (const entry of actions) {
    if (entry[0] === "sep") {
      root.append(element("div", "context-sep"));
      continue;
    }
    const [label, action, style] = entry;
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
  root.querySelector("button")?.focus();
}

function updateParentSelect() {
  const select = $("parent-select"),
    previous = select.value;
  select.replaceChildren(new Option("-- 根 --", ""));
  const currentZone = $("zone-select").value;
  function add(parentId, depth = 0) {
    for (const item of children(parentId).filter(
      (i) => i.zone === currentZone,
    )) {
      const prefix = depth > 0 ? "　".repeat(Math.min(depth - 1, 5)) + "├ " : "";
      select.add(new Option(prefix + item.text, item.id));
      add(item.id, depth + 1);
    }
  }
  // 跨分区父任务下的子任务也列出可选
  for (const item of items.filter(
    (i) =>
      i.zone === currentZone &&
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

// 最后一个展开分区的底线钉在容器下边缘：多余空间由它吸收，溢出时保底最小高度自然滚动
function fitLastZone() {
  const container = $("zones-container");
  if (!container || !container.clientHeight) return;
  const openSections = [...container.querySelectorAll(".zone-section")].filter(
    (sec) => {
      const body = sec.querySelector(".zone-body");
      return body && !body.hidden;
    },
  );
  if (!openSections.length) return;

  // 若上方展开分区尚无自定义高度，按容器高度赋合理初值，以便分隔线可双向丝滑拖动
  const headerBudget = container.querySelectorAll(".zone-section").length * 38;
  const fallbackH = Math.max(
    90,
    Math.min(
      240,
      Math.floor(
        (container.clientHeight - headerBudget) / Math.max(openSections.length, 1),
      ),
    ),
  );
  for (let i = 0; i < openSections.length - 1; i++) {
    const zId = openSections[i].dataset.zoneId;
    const body = openSections[i].querySelector(".zone-body");
    if (!Number.isFinite(heights[zId]) && !body.style.height) {
      body.style.height = fallbackH + "px";
    }
  }

  let total = 0;
  for (const sec of container.querySelectorAll(".zone-section")) {
    const cs = getComputedStyle(sec);
    total +=
      sec.offsetHeight +
      (parseFloat(cs.marginTop) || 0) +
      (parseFloat(cs.marginBottom) || 0);
  }
  for (const sp of container.querySelectorAll(".zone-resize-handle")) {
    total += sp.offsetHeight;
  }
  const padY =
    (parseFloat(getComputedStyle(container).paddingTop) || 0) +
    (parseFloat(getComputedStyle(container).paddingBottom) || 0);

  const lastBody = openSections.at(-1).querySelector(".zone-body");
  const diff = container.clientHeight - padY - total;
  const targetH = Math.max(MIN_ZONE_BODY_HEIGHT, lastBody.offsetHeight + diff);
  lastBody.style.height = targetH + "px";
}

async function persistZoneHeights() {
  const container = $("zones-container");
  if (!container) return;
  const openSections = [...container.querySelectorAll(".zone-section")].filter(
    (sec) => {
      const body = sec.querySelector(".zone-body");
      return body && !body.hidden;
    },
  );
  // 持久化除最后一个自适应贴底分区之外的自定义高度
  openSections.forEach((sec, idx) => {
    if (idx === openSections.length - 1) return;
    const zId = sec.dataset.zoneId;
    const body = sec.querySelector(".zone-body");
    if (zId && body && body.offsetHeight) {
      heights[zId] = Math.max(MIN_ZONE_BODY_HEIGHT, Math.round(body.offsetHeight));
    }
  });
  await api.saveZoneHeights(heights);
}

function setupResizeHandle(handle, upperZoneId) {
  handle.addEventListener("dblclick", () => {
    heights = {};
    void api.saveZoneHeights(heights);
    render();
  });
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const container = $("zones-container");
    const openSections = [
      ...container.querySelectorAll(".zone-section"),
    ].filter((sec) => {
      const b = sec.querySelector(".zone-body");
      return b && !b.hidden;
    });
    const idx = openSections.findIndex(
      (sec) => sec.dataset.zoneId === upperZoneId,
    );
    if (idx < 0 || idx >= openSections.length - 1) return;

    const upperBody = openSections[idx].querySelector(".zone-body");
    const lowerBody = openSections[idx + 1].querySelector(".zone-body");
    const startY = e.clientY;
    const startUpperH = upperBody.offsetHeight;
    const startLowerH = lowerBody.offsetHeight;
    resizing = true;
    handle.classList.add("active");
    handle.setPointerCapture?.(e.pointerId);

    const onMove = (ev) => {
      let delta = ev.clientY - startY;
      if (startUpperH + delta < MIN_ZONE_BODY_HEIGHT) {
        delta = MIN_ZONE_BODY_HEIGHT - startUpperH;
      }
      if (startLowerH - delta < MIN_ZONE_BODY_HEIGHT) {
        delta = startLowerH - MIN_ZONE_BODY_HEIGHT;
      }
      upperBody.style.height = Math.round(startUpperH + delta) + "px";
      lowerBody.style.height = Math.round(startLowerH - delta) + "px";
    };

    const onUp = () => {
      resizing = false;
      handle.classList.remove("active");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      void persistZoneHeights();
      fitLastZone();
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });
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
  if ($("slim-progress-fill")) {
    $("slim-progress-fill").style.width = percentage + "%";
  }
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

  const openZoneIds = zoneOrder.filter(
    (zId) => !(closedZones.includes(zId) && !filtered),
  );

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
      element("span", "zone-title-text", zone.name),
      element("span", "zone-count", members.length + " 项"),
      element("span", "zone-chevron", collapsed ? "▶" : "▼"),
    );

    // 恢复历史版本一键「清除」按钮
    const clearBtn = button(
      "清除",
      `清空「${zone.name}」分区全部任务（支持 Ctrl+Z 撤回）`,
      (e) => {
        e.stopPropagation();
        clearZone(zoneId);
      },
      "zone-clear",
    );
    clearBtn.disabled = members.length === 0;

    const add = button(
      "+",
      "添加到" + zone.name,
      (e) => {
        e.stopPropagation();
        $("zone-select").value = zoneId;
        updateParentSelect();
        $("parent-select").value = "";
        void api.beginTransientEdit().then(() => $("new-todo-input").focus());
      },
      "zone-add",
    );
    header.append(handle, toggle, clearBtn, add);

    // 拖任务到分区标题栏：移入该分区并自动升级为顶级根任务
    header.addEventListener("dragover", (e) => {
      e.preventDefault();
      header.classList.add("header-drop-target");
    });
    header.addEventListener("dragleave", () => {
      header.classList.remove("header-drop-target");
    });
    header.addEventListener("drop", (e) => {
      header.classList.remove("header-drop-target");
      const taskId = e.dataTransfer.getData("text/task");
      const fromZone = e.dataTransfer.getData("text/zone");
      if (fromZone && fromZone !== zoneId) {
        e.preventDefault();
        e.stopPropagation();
        dragging = false;
        zoneOrder.splice(zoneOrder.indexOf(fromZone), 1);
        zoneOrder.splice(zoneOrder.indexOf(zoneId), 0, fromZone);
        keep("zoneOrder", zoneOrder);
        render();
        return;
      }
      if (taskId) {
        const item = items.find((i) => i.id === taskId);
        if (!item) return;
        e.preventDefault();
        e.stopPropagation();
        dragging = false;
        if (item.zone === zoneId && !item.parentId) return;
        mutate(() => {
          item.parentId = null;
          for (const target of [item, ...M.descendants(items, item.id)]) {
            target.zone = zoneId;
            target.status = {
              todo: "pending",
              goals: "goal",
              done: "done",
              abandoned: "abandoned",
            }[zoneId];
            target.statusChangedAt = null;
            target.pinnedUrgent = false;
          }
          item.order = nextOrder();
        });
      }
    });

    section.append(header);
    const body = element("div", "zone-body");
    body.dataset.zone = zoneId;
    body.hidden = collapsed;
    if (
      !collapsed &&
      zoneId !== openZoneIds.at(-1) &&
      Number.isFinite(heights[zoneId])
    ) {
      body.style.height = heights[zoneId] + "px";
    }

    const drawn = new Set();
    const draw = (item, depth, number, isPhantomRoot = false) => {
      if (drawn.has(item.id) || (filtered && !visible.has(item.id))) return;
      drawn.add(item.id);
      body.append(renderRow(item, depth, number, isPhantomRoot));
      if (!item.collapsed || filtered)
        children(item.id)
          .filter((i) => i.zone === zoneId)
          .forEach((child, index) => draw(child, depth + 1, index + 1, false));
    };

    const topRoots = members.filter((i) => !i.parentId);
    const crossZoneRoots = members.filter(
      (i) =>
        i.parentId && items.find((p) => p.id === i.parentId)?.zone !== zoneId,
    );

    topRoots.forEach((item, index) => {
      if (filtered && !visible.has(item.id)) return;
      draw(item, 0, index + 1, false);
    });

    // 按跨区父节点归组展示（同父任务只输出一行 ↳ 上游上下文标题，不重复刷屏）
    const phantomGroups = new Map();
    for (const item of crossZoneRoots) {
      if (filtered && !visible.has(item.id)) continue;
      if (!phantomGroups.has(item.parentId))
        phantomGroups.set(item.parentId, []);
      phantomGroups.get(item.parentId).push(item);
    }
    for (const [pId, groupItems] of phantomGroups) {
      const parent = items.find((p) => p.id === pId);
      if (parent) {
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
      groupItems.forEach((item, index) => {
        draw(item, 1, index + 1, true);
      });
    }

    if (!drawn.size)
      body.append(
        element(
          "p",
          "zone-empty",
          filtered
            ? "没有匹配的任务"
            : {
                goals: "暂无长期目标",
                todo: "暂无待办事项",
                done: "暂无已完成项",
                abandoned: "暂无放弃项",
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
            target.pinnedUrgent = false;
          }
          item.order = nextOrder();
        });
      }
    });

    root.append(section);

    // 在两个相邻展开分区之间插入全宽联动拖拽分隔线
    const openIdx = openZoneIds.indexOf(zoneId);
    if (openIdx >= 0 && openIdx < openZoneIds.length - 1) {
      const resizeBar = element("div", "zone-resize-handle");
      resizeBar.title = "上下拖动调整相邻分区大小 · 双击均分高度";
      setupResizeHandle(resizeBar, zoneId);
      root.append(resizeBar);
    }
  }

  fitLastZone();
  for (const [zId, st] of scrolls) {
    const body = root.querySelector(`.zone-body[data-zone="${zId}"]`);
    if (body) body.scrollTop = st;
  }
  root.scrollTop = scroll;
  updateParentSelect();
}

function renderRow(item, depth, number, isPhantomChild = false) {
  const row = element("div", "node-row " + item.status);
  row.style.setProperty("--depth", depth);
  row.dataset.id = item.id;
  row.dataset.zone = item.zone;
  row.draggable = true;
  const hasChildren = children(item.id).some((i) => i.zone === item.zone);
  const toggle = button(
    hasChildren ? (item.collapsed ? "▶" : "▼") : "",
    "展开或折叠子任务",
    (e) => {
      e.stopPropagation();
      mutate(() => {
        item.collapsed = !item.collapsed;
      });
    },
    "node-toggle",
  );
  toggle.disabled = !hasChildren;

  const statusSymbol = {
    done: "✓",
    urgent: "!",
    goal: "♥",
    abandoned: "✕",
    pending: "",
  }[item.status];
  const statusTip =
    item.zone === "goals"
      ? "长期目标 · 双击编辑 / 右键可改状态"
      : statusNames[item.status] + " · 点击循环切换（60秒后自动归档流转）";
  const status = button(
    statusSymbol,
    statusTip,
    (e) => {
      e.stopPropagation();
      cycleStatus(item);
    },
    "status-dot " + item.status,
  );

  // 恢复父任务中文数字编号（一、二、三…）+ 子任务阿拉伯数字（1. 2. 3.）
  const numLabel =
    depth === 0 && !isPhantomChild ? M.toChineseNum(number) : number + ".";
  const numEl = element("span", "node-number zone-num-" + item.zone, numLabel);

  const text = element("span", "node-text", item.text);
  text.title = "双击编辑任务";
  text.addEventListener("dblclick", () => void editItem(item));

  row.append(status, numEl, toggle, text);

  if (item.ddl) {
    const overdue = active(item) && item.ddl < M.localDate();
    const deadline = element(
      "span",
      "deadline" + (overdue ? " overdue" : ""),
      item.ddl === M.localDate() ? "今天" : item.ddl,
    );
    deadline.title = "截止 " + item.ddl + (overdue ? " · 已逾期" : "");
    row.append(deadline);
  }

  row.append(
    button(
      "⋯",
      "更多操作：" + item.text,
      (e) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        void menu(item, rect.right, rect.bottom);
      },
      "row-menu",
    ),
  );

  // 恢复历史版本行尾醒目红色 × 一键删除按钮
  row.append(
    button(
      "×",
      "删除任务（支持 Ctrl+Z 撤回）",
      (e) => {
        e.stopPropagation();
        deleteSubtree(item);
      },
      "row-delete",
    ),
  );

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void menu(item, e.clientX, e.clientY);
  });
  row.addEventListener("dragstart", (e) => {
    dragging = true;
    row.classList.add("dragging");
    e.dataTransfer.setData("text/task", item.id);
    e.stopPropagation();
  });
  row.addEventListener("dragend", () => {
    dragging = false;
    row.classList.remove("dragging");
  });
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    row.classList.add("row-drag-over");
  });
  row.addEventListener("dragleave", () => {
    row.classList.remove("row-drag-over");
  });
  row.addEventListener("drop", (e) => {
    row.classList.remove("row-drag-over");
    const from = items.find(
      (i) => i.id === e.dataTransfer.getData("text/task"),
    );
    if (!from || from.id === item.id) return;
    // 防循环嵌套：不能拖到自己的后代节点上
    if (M.descendants(items, from.id).some((d) => d.id === item.id)) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = false;

    mutate(() => {
      // 支持跨级/跨区拖到目标行位置对齐同级顺序
      if (from.zone !== item.zone) {
        for (const target of [from, ...M.descendants(items, from.id)]) {
          target.zone = item.zone;
          target.status = {
            todo: "pending",
            goals: "goal",
            done: "done",
            abandoned: "abandoned",
          }[item.zone];
          target.statusChangedAt = null;
          target.pinnedUrgent = false;
        }
      }
      from.parentId = item.parentId;
      const siblings = items
        .filter((i) => i.parentId === item.parentId && i.zone === item.zone)
        .sort((a, b) => a.order - b.order);
      const fromIdx = siblings.indexOf(from);
      if (fromIdx >= 0) siblings.splice(fromIdx, 1);
      const toIdx = siblings.indexOf(item);
      siblings.splice(toIdx >= 0 ? toIdx : siblings.length, 0, from);
      siblings.forEach((sib, index) => {
        sib.order = index;
      });
    });
  });
  return row;
}

function updatePin(value) {
  pinned = value;
  $("pin-btn").textContent = pinned ? "📌" : "📍";
  $("pin-btn").classList.toggle("active", pinned);
  $("pin-btn").setAttribute("aria-pressed", String(pinned));
  $("pin-btn").title = pinned
    ? "已锁定在桌面层 · 点击解锁浮动拖动"
    : "已解锁（可拖动/边缘磁吸）· 点击锁定回桌面层";
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
  void save("已撤回上一步");
}

document.addEventListener("DOMContentLoaded", async () => {
  applyTheme(pref("theme", "gold"));
  const opacity = Math.max(
    55,
    Math.min(100, Number(pref("opacity", 92)) || 92),
  );
  $("opacity").value = opacity;
  document.documentElement.style.setProperty("--opacity", opacity / 100);

  // 恢复 4 档字号循环（含历史版本的「小」0.9 档）
  const fontSteps = [
    { scale: 0.9, label: "小" },
    { scale: 1, label: "标准" },
    { scale: 1.15, label: "大" },
    { scale: 1.3, label: "特大" },
  ];
  let fontIndex = Number(pref("fontStepIndex", 1));
  if (!Number.isInteger(fontIndex) || fontIndex < 0 || fontIndex >= fontSteps.length) {
    fontIndex = 1;
  }
  const applyFont = () => {
    const step = fontSteps[fontIndex];
    document.documentElement.style.setProperty("--font-scale", step.scale);
    $("font-btn").textContent = "字号：" + step.label;
    if ($("quick-font-btn")) {
      $("quick-font-btn").textContent = "A" + step.label[0];
      $("quick-font-btn").title = `当前字号：${step.label} · 点击切换`;
    }
    requestAnimationFrame(fitLastZone);
  };
  const cycleFont = () => {
    fontIndex = (fontIndex + 1) % fontSteps.length;
    keep("fontStepIndex", fontIndex);
    applyFont();
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
      "无法连接桌面服务，请退出后重新启动 Todo。当前页面不会写入任务文件。",
    );
    $("notice").querySelector("div").hidden = true;
    return;
  }

  window.addEventListener("resize", () => requestAnimationFrame(fitLastZone));

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
    if (await allowDiscard("退出 Todo？")) await api.closeApp();
  };

  // 顶栏一键快捷按钮接线
  $("quick-refresh-btn").onclick = () => void reload();
  $("quick-open-btn").onclick = () => void switchFile();
  $("quick-font-btn").onclick = cycleFont;
  $("quick-collapse-btn").onclick = () => {
    mutate(() => {
      items.forEach((i) => {
        i.collapsed = true;
      });
    });
  };
  $("quick-expand-btn").onclick = () => {
    closedZones = [];
    keep("closedZones", closedZones);
    mutate(() => {
      items.forEach((i) => {
        i.collapsed = false;
      });
    });
  };

  $("refresh-btn").onclick = () => {
    $("settings").open = false;
    void reload();
  };
  $("open-file-btn").onclick = () => void switchFile();
  $("file-path-bar").onclick = () => void switchFile();
  $("backup-btn").onclick = () => {
    $("settings").open = false;
    void api.openBackups();
  };
  $("footer-backup-btn").onclick = () => void api.openBackups();

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
  $("font-btn").onclick = cycleFont;

  const applyCompact = () => {
    const compact = !!pref("compact", false);
    document.body.classList.toggle("compact", compact);
    $("compact-btn").textContent = "紧凑概览：" + (compact ? "开" : "关");
    if ($("overview-toggle-btn")) {
      $("overview-toggle-btn").textContent = compact ? "▾" : "▴";
      $("overview-toggle-btn").title = compact
        ? "展开概览卡片"
        : "收起概览为紧凑进度条";
    }
    requestAnimationFrame(fitLastZone);
  };
  const toggleCompact = () => {
    keep("compact", !pref("compact", false));
    applyCompact();
  };
  applyCompact();
  $("compact-btn").onclick = toggleCompact;
  $("overview-toggle-btn").onclick = toggleCompact;

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

  const updateAutoStartUI = (enabled) => {
    $("auto-start-btn").textContent = "开机自启：" + (enabled ? "开" : "关");
    $("footer-autostart-btn").classList.toggle("active", !!enabled);
    $("footer-autostart-btn").textContent = enabled ? "🔌 自启:开" : "🔌 自启";
  };

  try {
    heights = await api.getZoneHeights();
    if (!heights || typeof heights !== "object") heights = {};
    // 兼容旧版保存的 "180px" 字符串格式与新版数字格式
    for (const k of Object.keys(heights)) {
      const parsed = parseFloat(heights[k]);
      if (Number.isFinite(parsed)) heights[k] = parsed;
      else delete heights[k];
    }
    acceptLoaded(await api.load());
    const auto = await api.getAutoStart();
    updateAutoStartUI(auto);
    const onToggleAuto = async () => {
      const enabled = await api.toggleAutoStart();
      updateAutoStartUI(enabled);
    };
    $("auto-start-btn").onclick = onToggleAuto;
    $("footer-autostart-btn").onclick = onToggleAuto;
  } catch (e) {
    state("读取失败", "error");
    notice(e.message);
  }
  if (api.isPreview) {
    $("storage-badge").textContent = "演示 · 不写入文件";
    $("pin-btn").disabled = true;
    $("auto-start-btn").disabled = true;
    $("footer-autostart-btn").disabled = true;
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
  if (e.key === "F5") {
    e.preventDefault();
    void reload();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const key = e.key.toLowerCase();
    if (key === "f") {
      e.preventDefault();
      void api.beginTransientEdit().then(() => $("search").focus());
    }
    if (key === "n" && !$("task-dialog").open) {
      e.preventDefault();
      void api.beginTransientEdit().then(() => $("new-todo-input").focus());
    }
    if (key === "o" && !$("task-dialog").open) {
      e.preventDefault();
      void switchFile();
    }
    if (key === "r" && !$("task-dialog").open) {
      e.preventDefault();
      void reload();
    }
    if (key === "z" && !input && !$("task-dialog").open) {
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
    ]?.focus();
  }
});

api?.onPinStateChanged(updatePin);
api?.onCloseRequested?.(async () => {
  if ($("task-dialog").open) return;
  if (await allowDiscard("退出 Todo？")) await api.closeApp();
});

setInterval(async () => {
  if (
    !ready ||
    saving ||
    blocked ||
    dragging ||
    resizing ||
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
    resizing ||
    switching ||
    $("task-dialog").open
  )
    return;
  const snapshot = clone(items);
  if (M.settle(items)) {
    syncPinnedUrgent(items);
    undoStack.push(snapshot);
    if (undoStack.length > 20) undoStack.shift();
    editVersion++;
    render();
    void save();
  }
}, 1000);
