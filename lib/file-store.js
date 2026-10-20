"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const revision = (content) =>
  crypto.createHash("sha256").update(content).digest("hex");
const backupFolder = (filePath, root) =>
  path.join(
    root,
    `${path.basename(filePath, path.extname(filePath))}-${revision(path.resolve(filePath)).slice(0, 8)}`,
  );
function read(filePath, seed = "") {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return { success: true, content, filePath, revision: revision(content) };
  } catch (error) {
    if (error.code === "ENOENT")
      return { success: true, content: seed, filePath, revision: null };
    return { success: false, error: error.message, filePath };
  }
}
function save(filePath, request, backupDir) {
  let temp;
  try {
    if (
      !request ||
      typeof request.content !== "string" ||
      request.content.length > 10 * 1024 * 1024
    )
      throw new Error("无效的文件内容");
    if (request.filePath !== filePath)
      throw new Error("当前文件已切换，请重新载入");
    const disk = read(filePath);
    if (!disk.success) return disk;
    if (disk.revision !== request.revision)
      return {
        success: false,
        conflict: true,
        error: "文件已被其他程序修改，请先处理冲突",
      };
    if (disk.revision === revision(request.content))
      return { success: true, revision: disk.revision };
    if (disk.revision !== null && backupDir) {
      const dir = backupFolder(filePath, backupDir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(
          dir,
          `${Date.now()}-${process.hrtime.bigint().toString().padStart(20, "0")}-${crypto.randomUUID()}.md`,
        ),
        disk.content,
        { flag: "wx" },
      );
      const old = fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".md"))
        .sort()
        .reverse()
        .slice(20);
      for (const name of old) fs.unlinkSync(path.join(dir, name));
    }
    temp = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`,
    );
    fs.writeFileSync(temp, request.content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    // Recheck after preparing the temp file to detect edits during backup/write.
    const latest = read(filePath);
    if (!latest.success || latest.revision !== disk.revision)
      return {
        success: false,
        conflict: true,
        error: "文件在保存期间发生变化",
      };
    fs.renameSync(temp, filePath);
    return { success: true, revision: revision(request.content) };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    try {
      if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch (_) {
      /* Preserve the original save error if cleanup is denied. */
    }
  }
}
module.exports = { read, save, revision, backupFolder };
