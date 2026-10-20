(function (root, factory) {
  const model = factory();
  if (typeof module === "object" && module.exports) module.exports = model;
  else root.TaskModel = model;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const zones = [
    { id: "goals", name: "目标" },
    { id: "todo", name: "待完成" },
    { id: "done", name: "已完成" },
    { id: "abandoned", name: "放弃" },
  ];
  const marks = {
    pending: " ",
    done: "x",
    urgent: "!",
    goal: ">",
    abandoned: "~",
  };
  const statuses = {
    "": "pending",
    x: "done",
    X: "done",
    "!": "urgent",
    ">": "goal",
    "~": "abandoned",
  };
  const id = () => globalThis.crypto.randomUUID();
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
    const d = new Date(`${value}T12:00:00`);
    return !Number.isNaN(+d) && localDate(d) === value;
  }
  function localDate(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  function descendants(items, parentId) {
    const seen = new Set([parentId]);
    const result = [];
    for (const key of seen) {
      for (const item of items)
        if (item.parentId === key && !seen.has(item.id)) {
          seen.add(item.id);
          result.push(item);
        }
    }
    return result;
  }
  function parse(text) {
    const items = [],
      blocks = [{ zone: null, heading: null, raw: [] }];
    let block = blocks[0],
      stack = [],
      fence = null;
    for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fenceMatch) {
        if (!fence) fence = fenceMatch[1];
        else if (
          fenceMatch[1][0] === fence[0] &&
          fenceMatch[1].length >= fence.length
        )
          fence = null;
        block.raw.push(line);
        continue;
      }
      if (fence) {
        block.raw.push(line);
        continue;
      }
      const heading = line.match(/^##\s+(.+?)\s*#*\s*$/);
      if (heading) {
        block = {
          zone: zones.find((z) => z.name === heading[1])?.id || null,
          heading: line,
          raw: [],
        };
        blocks.push(block);
        stack = [];
        continue;
      }
      const task =
        block.zone && line.match(/^(\s*)-\s*\[([ xX!>~]?)\]\s+(.+)$/);
      if (!task) {
        block.raw.push(line);
        continue;
      }
      let taskText = task[3],
        meta = {};
      const metadata = taskText.match(/\s+<!-- todotree:([^ ]+) -->$/);
      if (metadata) {
        try {
          const parsed = JSON.parse(decodeURIComponent(metadata[1]));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("Invalid metadata");
          meta = parsed;
          taskText = taskText.slice(0, metadata.index);
        } catch (_) {
          /* Unrecognized comments remain visible, never discarded. */
        }
      }
      const ddl = taskText.match(/\s*\|\s*ddl:\s*(\d{4}-\d{2}-\d{2})$/);
      if (ddl && validDate(ddl[1])) taskText = taskText.slice(0, ddl.index);
      const indent = task[1].replace(/\t/g, "  ").length;
      while (stack.length && stack.at(-1).indent >= indent) stack.pop();
      const status = statuses[task[2].trim()] || "pending";
      const item = {
        id:
          typeof meta.id === "string" && !items.some((i) => i.id === meta.id)
            ? meta.id
            : id(),
        text: taskText,
        zone: block.zone,
        status,
        ddl: ddl && validDate(ddl[1]) ? ddl[1] : null,
        parentId: Object.hasOwn(meta, "p") ? meta.p : stack.at(-1)?.id || null,
        collapsed: meta.c === true,
        order: items.length,
        statusChangedAt:
          meta.s === status && Number.isFinite(meta.t) ? meta.t : null,
      };
      items.push(item);
      stack.push({ id: item.id, indent });
    }
    // An edited or malformed metadata comment must not introduce a cyclic tree.
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const item of items) {
      const seen = new Set([item.id]);
      let parent = item.parentId;
      while (parent) {
        if (seen.has(parent) || !byId.has(parent)) {
          item.parentId = null;
          break;
        }
        seen.add(parent);
        parent = byId.get(parent).parentId;
      }
    }
    return { items, blocks };
  }
  function serialize(
    items,
    blocks = [{ zone: null, heading: null, raw: ["# TodoTree", ""] }],
  ) {
    const lines = [],
      written = new Set();
    function writeZone(zone) {
      const members = items
        .filter((i) => i.zone === zone && !i.isCopy)
        .sort((a, b) => a.order - b.order);
      const ids = new Set(members.map((i) => i.id));
      const emitted = new Set();
      function visit(item, depth) {
        if (emitted.has(item.id)) return;
        emitted.add(item.id);
        const meta = { id: item.id };
        const parent = items.find((i) => i.id === item.parentId);
        // In one section, ordinary Markdown indentation remains authoritative.
        // Only a relationship spanning sections needs a hidden parent reference.
        if (parent && parent.zone !== item.zone) meta.p = parent.id;
        if (item.collapsed) meta.c = true;
        if (item.statusChangedAt) {
          meta.t = item.statusChangedAt;
          meta.s = item.status;
        }
        const content = item.text.replace(/[\r\n]+/g, " ");
        lines.push(
          `${"  ".repeat(depth)}- [${marks[item.status] ?? " "}] ${content}${item.ddl ? ` | ddl:${item.ddl}` : ""} <!-- todotree:${encodeURIComponent(JSON.stringify(meta))} -->`,
        );
        for (const child of members.filter((i) => i.parentId === item.id))
          visit(child, depth + 1);
      }
      for (const item of members.filter((i) => !ids.has(i.parentId)))
        visit(item, 0);
      for (const item of members) visit(item, 0);
    }
    for (const block of blocks) {
      if (block.heading) lines.push(block.heading);
      if (block.zone && !written.has(block.zone)) {
        lines.push("");
        writeZone(block.zone);
        written.add(block.zone);
      }
      lines.push(...block.raw);
    }
    for (const zone of zones)
      if (!written.has(zone.id)) {
        lines.push("", `## ${zone.name}`, "");
        writeZone(zone.id);
        lines.push("");
      }
    return lines.join("\n");
  }
  function settle(items, now = Date.now()) {
    let changed = false;
    for (const item of items) {
      if (
        !item.statusChangedAt ||
        now - item.statusChangedAt < 60000 ||
        item.zone === "goals"
      )
        continue;
      const target = {
        done: "done",
        abandoned: "abandoned",
        pending: "todo",
        urgent: "todo",
      }[item.status];
      if (target && target !== item.zone) {
        item.zone = target;
        changed = true;
      }
      item.statusChangedAt = null;
      changed = true;
    }
    return changed;
  }
  return {
    zones,
    id,
    parse,
    serialize,
    descendants,
    localDate,
    validDate,
    settle,
  };
});
