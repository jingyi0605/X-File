#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, "-");
const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), `x-file-ui-${stamp}-`));
const libraryRoot = path.join(sessionRoot, "library-fixture");
const screenshotsDir = path.join(sessionRoot, "screenshots");

fs.mkdirSync(libraryRoot, { recursive: true });
fs.mkdirSync(screenshotsDir, { recursive: true });

const dirs = [
  "产品资料",
  "产品资料/需求",
  "产品资料/设计",
  "团队资料",
  "团队资料/会议纪要",
  "归档",
  "空目录-用于右键空白处",
];
for (const dir of dirs) {
  fs.mkdirSync(path.join(libraryRoot, dir), { recursive: true });
}

const files = [
  ["产品资料/需求/20260609-X-File主界面走查.md", "# X-File 主界面走查\n\n用于检查网格视图、详情区和标签展示。\n\n标签：文档库、主界面、截图\n"],
  ["产品资料/需求/文档库列表模式说明.txt", "列表模式截图用文件。请在 Finder/List 视图下选中这一行，检查行高、图标和右侧详情。\n"],
  ["产品资料/设计/右键菜单覆盖项.md", "# 右键菜单覆盖项\n\n用于右键菜单截图，重点看复制、新建、标签、删除等菜单项。\n"],
  ["团队资料/会议纪要/标签弹窗检查.md", "# 标签弹窗检查\n\n打开标签弹窗，确认推荐标签、输入框、按钮和错误区域的间距。\n"],
  ["团队资料/会议纪要/新建弹窗检查.md", "# 新建弹窗检查\n\n打开新建目录或新建文件弹窗，确认标题、字段说明、取消和创建按钮。\n"],
  ["归档/旧资料.md", "# 旧资料\n\n用于让目录树和列表有更多层级。\n"],
  ["README.md", "# X-File UI 截图临时资料库\n\n这是脚本生成的临时 fixture，只用于本地人工截图对照。不要提交本目录或截图。\n"],
];
for (const [relativePath, content] of files) {
  const absolutePath = path.join(libraryRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf8");
}

const summary = {
  createdAt: now.toISOString(),
  sessionRoot,
  libraryRoot,
  screenshotsDir,
  expectedScreenshots: [
    path.join(screenshotsDir, "01-grid-main.png"),
    path.join(screenshotsDir, "02-list-finder.png"),
    path.join(screenshotsDir, "03-context-menu.png"),
    path.join(screenshotsDir, "04-create-modal.png"),
    path.join(screenshotsDir, "05-tag-modal.png"),
  ],
  bindApiExample: `curl -sS -X PUT http://127.0.0.1:17321/api/library/binding -H 'content-type: application/json' --data '{"rootDir":"${libraryRoot.replaceAll("\\", "\\\\")}"}'`,
  refreshApiExample: "curl -sS -X POST http://127.0.0.1:17321/api/library/refresh -H 'content-type: application/json' --data '{\"reason\":\"manual_ui_screenshot\"}'",
  reminder: "截图完成后停止 server/web dev server；临时目录和截图不要提交。",
};

console.log(JSON.stringify(summary, null, 2));
