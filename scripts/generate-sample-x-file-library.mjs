#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const defaultSampleDir = path.join(rootDir, ".x-file-sample");
const defaultCount = 1200;
const setFilePath = resolveSetFilePath();

const formatDefinitions = [
  { extension: "md", label: "Markdown", slug: "markdown" },
  { extension: "txt", label: "纯文本", slug: "text" },
  { extension: "json", label: "JSON", slug: "json" },
  { extension: "yaml", label: "YAML", slug: "yaml" },
  { extension: "html", label: "HTML", slug: "html" },
  { extension: "xml", label: "XML", slug: "xml" },
  { extension: "css", label: "CSS", slug: "css" },
  { extension: "scss", label: "SCSS", slug: "scss" },
  { extension: "js", label: "JavaScript", slug: "javascript" },
  { extension: "ts", label: "TypeScript", slug: "typescript" },
  { extension: "tsx", label: "TSX", slug: "tsx" },
  { extension: "py", label: "Python", slug: "python" },
  { extension: "sql", label: "SQL", slug: "sql" },
  { extension: "csv", label: "CSV", slug: "csv" },
  { extension: "sh", label: "Shell", slug: "shell" },
  { extension: "rtf", label: "RTF", slug: "rtf" },
  { extension: "log", label: "日志", slug: "log" },
  { extension: "toml", label: "TOML", slug: "toml" },
  { extension: "ini", label: "INI", slug: "ini" },
  { extension: "svg", label: "SVG", slug: "svg" },
  { extension: "less", label: "Less", slug: "less" },
  { extension: "c", label: "C", slug: "c" },
  { extension: "cpp", label: "C++", slug: "cpp" },
  { extension: "go", label: "Go", slug: "go" },
  { extension: "rs", label: "Rust", slug: "rust" },
  { extension: "java", label: "Java", slug: "java" },
];

const industryDefinitions = {
  "software-development": {
    label: "软件开发",
    rootDir: "software-development",
    industryTag: "行业/软件开发",
    projects: ["Atlas", "Nimbus", "Orion", "Pioneer", "Vector"],
    angles: [
      { folder: "01-product", stage: "需求分析", aspect: "用户研究" },
      { folder: "02-architecture", stage: "架构设计", aspect: "系统架构" },
      { folder: "03-frontend", stage: "实现开发", aspect: "前端工程" },
      { folder: "04-backend", stage: "实现开发", aspect: "后端与API" },
      { folder: "05-data", stage: "实现开发", aspect: "数据工程" },
      { folder: "06-quality", stage: "测试验证", aspect: "质量工程" },
      { folder: "07-security", stage: "安全合规", aspect: "应用安全" },
      { folder: "08-delivery", stage: "交付运维", aspect: "DevOps发布" },
      { folder: "09-operations", stage: "运行复盘", aspect: "可观测性" },
    ],
  },
  "film-television-design": {
    label: "影视设计",
    rootDir: "film-television-design",
    industryTag: "行业/影视设计",
    projects: ["North Star", "Blue Hour", "Paper Moon", "Signal Fire", "Glass River"],
    angles: [
      { folder: "01-development", stage: "项目开发", aspect: "剧本开发" },
      { folder: "02-preproduction", stage: "前期策划", aspect: "分镜预演" },
      { folder: "03-art-direction", stage: "视觉开发", aspect: "美术概念" },
      { folder: "04-character-design", stage: "视觉开发", aspect: "角色造型" },
      { folder: "05-cinematography", stage: "现场制作", aspect: "摄影灯光" },
      { folder: "06-production", stage: "现场制作", aspect: "制片管理" },
      { folder: "07-editing", stage: "后期制作", aspect: "剪辑声音" },
      { folder: "08-vfx", stage: "后期制作", aspect: "特效合成" },
      { folder: "09-delivery", stage: "发行交付", aspect: "宣发交付" },
    ],
  },
};

const statusTags = [
  "状态/草稿",
  "状态/评审中",
  "状态/已批准",
  "状态/已归档",
];

const rootTagDescriptions = {
  行业: "样例资料库的行业维度。",
  阶段: "行业工作流阶段维度。",
  视角: "内容和专业角色维度。",
  格式: "文件格式维度。",
  状态: "文档生命周期状态维度。",
  项目: "项目或片名维度。",
};

const args = parseArgs(process.argv.slice(2));
const sampleDir = path.resolve(args.sampleDir ?? defaultSampleDir);
const libraryRoot = path.resolve(args.libraryRoot ?? path.join(sampleDir, "library"));
const dataDir = path.resolve(args.dataDir ?? path.join(sampleDir, "state"));
const count = parseCount(args.count ?? String(defaultCount));
const industries = resolveIndustries(args.industry ?? "both");
const markerPath = path.join(sampleDir, "sample-manifest.json");

if (args.reset) {
  fs.rmSync(sampleDir, { recursive: true, force: true });
}

if (fs.existsSync(markerPath) && !args.reset) {
  const existing = readJson(markerPath);
  if (existing?.libraryRoot === libraryRoot && existing?.dataDir === dataDir) {
    if (!args.skipIndex) {
      writeAndVerifySampleIndex(loadExistingResult(existing));
    }
    printSummary(existing, "已有样例资料库，保留现有文件并重新校验索引。");
  } else {
    throw new Error(`样例目录已存在且不是当前目标：${sampleDir}。如需重建，请显式传入 --reset。`);
  }
} else {
  const result = createSampleLibrary({
    sampleDir,
    libraryRoot,
    dataDir,
    count,
    industries,
  });
  writeJson(markerPath, result.manifest);
  if (!args.skipIndex) {
    writeAndVerifySampleIndex(result);
  }
  printSummary(result.manifest, args.skipIndex ? "已生成文件和标签；按 --skip-index 跳过运行时快照。" : "已生成、导出并完成标签校验。");
}

function createSampleLibrary({ sampleDir, libraryRoot, dataDir, count, industries }) {
  fs.mkdirSync(sampleDir, { recursive: true });
  fs.mkdirSync(libraryRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  if (fs.readdirSync(libraryRoot).length > 0 || fs.readdirSync(dataDir).length > 0) {
    throw new Error(`目标目录不为空：${sampleDir}。如需重建，请显式传入 --reset。`);
  }

  const generatedAt = new Date().toISOString();
  const records = [];
  const tagPaths = new Set();
  const folderTagPaths = new Map();
  const industryCounts = allocateCounts(count, industries);

  for (const [industryIndex, industryKey] of industries.entries()) {
    const industry = industryDefinitions[industryKey];
    const industryCount = industryCounts[industryKey];
    for (let index = 0; index < industryCount; index += 1) {
      const angle = industry.angles[index % industry.angles.length];
      const format = formatDefinitions[(index + industryIndex * 7) % formatDefinitions.length];
      const project = industry.projects[index % industry.projects.length];
      const statusTag = statusTags[(index + industryIndex) % statusTags.length];
      const sequence = String(index + 1).padStart(4, "0");
      const title = `${project} ${angle.aspect} ${angle.stage}样例 ${sequence}`;
      const relativePath = path.posix.join(
        industry.rootDir,
        angle.folder,
        `${sequence}-${format.slug}-${slugify(project)}.${format.extension}`,
      );
      const absolutePath = path.join(libraryRoot, ...relativePath.split("/"));
      const createdAt = makeSampleDate(index + industryIndex * industryCount, count);
      const modifiedAt = new Date(Date.parse(createdAt) + ((index % 17) + 1) * 60 * 60 * 1000).toISOString();
      const tags = [
        industry.industryTag,
        `阶段/${angle.stage}`,
        `视角/${angle.aspect}`,
        `格式/${format.label}`,
        statusTag,
        `项目/${project}`,
      ];

      for (const tagPath of tags) {
        tagPaths.add(tagPath);
      }
      const folderPath = path.posix.dirname(relativePath);
      const existingFolderTags = folderTagPaths.get(folderPath) ?? new Set();
      existingFolderTags.add(industry.industryTag);
      existingFolderTags.add(`阶段/${angle.stage}`);
      folderTagPaths.set(folderPath, existingFolderTags);

      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(
        absolutePath,
        buildContent({ industry, industryKey, angle, format, project, title, relativePath, tags, createdAt, modifiedAt, index }),
        "utf8",
      );
      fs.utimesSync(absolutePath, new Date(modifiedAt), new Date(modifiedAt));
      trySetCreationTime(absolutePath, createdAt);

      records.push({
        industry: industryKey,
        industryLabel: industry.label,
        relativePath,
        title,
        format: format.label,
        extension: `.${format.extension}`,
        project,
        stage: angle.stage,
        aspect: angle.aspect,
        tags,
        createdAt,
        modifiedAt,
      });
    }
  }

  const binding = {
    libraryId: "sample-industry-library",
    rootDir: libraryRoot,
    enabled: true,
    mirrorRoot: null,
    allowedExtensions: formatDefinitions.map((item) => `.${item.extension}`),
    includedHiddenPaths: [],
    hideDotFiles: true,
    hideSystemFolders: true,
    folderOpenBehavior: "double_click",
    configRelativePath: ".ai-index/doc-semantic-index.config.json",
    exportMode: "v2",
    initialized: true,
    initializedAt: generatedAt,
    updatedAt: generatedAt,
  };

  const tagDefinitions = buildTagDefinitions(tagPaths);
  const tagIdByPath = new Map(tagDefinitions.map((tag) => [tag.path, tag.id]));
  const documentTags = records.map((record) => ({
    documentId: stableDocumentId(record.relativePath),
    path: record.relativePath,
    title: record.title,
    manualTagIds: record.tags.map((tagPath) => tagIdByPath.get(tagPath)).filter(Boolean),
    updatedAt: record.modifiedAt,
  }));
  const folderTags = Array.from(folderTagPaths.entries()).map(([folderPath, paths]) => ({
    folderPath,
    bindingTagIds: Array.from(paths).map((tagPath) => tagIdByPath.get(tagPath)).filter(Boolean),
    updatedAt: generatedAt,
  }));
  const tagStore = {
    [libraryStoreKey(binding.libraryId, binding.rootDir)]: {
      libraryId: binding.libraryId,
      rootDir: binding.rootDir,
      tags: tagDefinitions,
      tagRules: [],
      documentTags,
      folderTags,
      deletedTags: [],
      updatedAt: generatedAt,
    },
  };
  const config = {
    libraryId: binding.libraryId,
    rootDir: binding.rootDir,
    enabled: true,
    mirrorRoot: null,
    allowedExtensions: binding.allowedExtensions,
    includedHiddenPaths: [],
    hideDotFiles: true,
    hideSystemFolders: true,
    folderOpenBehavior: "double_click",
    updatedAt: generatedAt,
  };

  fs.mkdirSync(path.join(libraryRoot, ".ai-index"), { recursive: true });
  writeJson(path.join(libraryRoot, ".ai-index", "doc-semantic-index.config.json"), config);
  writeJson(path.join(dataDir, "library-binding.json"), binding);
  writeJson(path.join(dataDir, "library-tags.json"), tagStore);

  const manifest = {
    version: 1,
    generatedAt,
    libraryRoot,
    dataDir,
    requestedCount: count,
    documentCount: records.length,
    industries: industries.map((key) => ({
      key,
      label: industryDefinitions[key].label,
      documentCount: records.filter((record) => record.industry === key).length,
    })),
    formatCounts: countBy(records, "format"),
    tagCount: tagDefinitions.length,
    documentTagBindingCount: documentTags.length,
    folderTagBindingCount: folderTags.length,
    files: records,
  };
  return { manifest, binding, records };
}

function loadExistingResult(manifest) {
  return {
    manifest,
    binding: readJson(path.join(manifest.dataDir, "library-binding.json")),
    records: manifest.files,
  };
}

function writeAndVerifySampleIndex(result) {
  const snapshotPath = path.join(result.binding.rootDir, ".ai-index", "runtime", "export-catalog-snapshot.json");
  const generatedAt = new Date().toISOString();
  const documents = result.records.map((record) => ({
    documentId: stableDocumentId(record.relativePath),
    path: record.relativePath,
    title: record.title,
    summary: `${record.industryLabel}样例资料：${record.stage} / ${record.aspect} / 项目 ${record.project}。`,
    tags: record.tags,
    derivedTags: [],
    mtime: record.modifiedAt,
  }));
  const snapshot = {
    version: 1,
    generatedAt,
    tags: buildSnapshotTags(documents),
    documents,
  };
  writeJson(snapshotPath, snapshot);
  writeJson(
    path.join(result.binding.rootDir, ".ai-index", "runtime", "active-file-state-snapshot.json"),
    {
      version: 1,
      generatedAt,
      files: result.records.map((record) => ({
        path: record.relativePath,
        extension: record.extension,
        size: fs.statSync(path.join(result.binding.rootDir, ...record.relativePath.split("/"))).size,
        mtime: record.modifiedAt,
        indexStatus: "indexed",
      })),
    },
  );
  writeJson(
    path.join(result.binding.rootDir, ".ai-index", "runtime", "index-state.json"),
    {
      version: 1,
      generatedAt,
      allowedExtensions: result.binding.allowedExtensions,
      failedDocuments: [],
      skippedDocuments: [],
      parserSkips: [],
    },
  );
  writeJson(
    path.join(result.binding.rootDir, ".ai-index", "runtime-status.json"),
    {
      state: "fresh",
      lastRequestedAt: generatedAt,
      lastStartedAt: generatedAt,
      lastCompletedAt: generatedAt,
      lastFailedAt: null,
      nextAllowedAt: null,
      runningStage: null,
      errorSummary: null,
      progress: {
        scannedCount: documents.length,
        indexedCount: documents.length,
        skippedCount: 0,
        failedCount: 0,
        unchangedCount: 0,
        totalCount: documents.length,
        maxConcurrency: null,
        activeTaskCount: 0,
        pendingTaskCount: 0,
        completedTaskCount: documents.length,
      },
    },
  );
  if (snapshot.documents?.length !== result.records.length) {
    throw new Error(`索引文档数不完整：期望 ${result.records.length}，实际 ${snapshot.documents?.length ?? 0}。`);
  }
  const expectedTagSets = new Map(result.records.map((record) => [record.relativePath, new Set(record.tags)]));
  const incomplete = snapshot.documents.filter((document) => {
    const expected = expectedTagSets.get(document.path);
    return !expected || !Array.from(expected).every((tagPath) => document.tags?.includes(tagPath));
  });
  if (incomplete.length > 0) {
    throw new Error(`标签分配不完整：${incomplete.length} 份文档缺少预期标签。`);
  }
}

function buildSnapshotTags(documents) {
  const tagPaths = new Set(documents.flatMap((document) => document.tags));
  return buildTagDefinitions(tagPaths).map((tag) => ({
    path: tag.path,
    name: tag.name,
    rootType: tag.rootType,
    parentPath: tag.parentPath,
    depth: tag.path.split("/").length - 1,
  }));
}

function buildTagDefinitions(tagPaths) {
  const orderedPaths = Array.from(tagPaths)
    .flatMap((tagPath) => ancestors(tagPath))
    .filter((tagPath, index, all) => all.indexOf(tagPath) === index)
    .sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right, "zh-CN"));
  return orderedPaths.map((tagPath) => {
    const parts = tagPath.split("/");
    const parentPath = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
    const id = `tag_${crypto.createHash("sha256").update(tagPath).digest("hex")}`;
    const now = new Date().toISOString();
    return {
      id,
      path: tagPath,
      name: parts.at(-1),
      rootType: parts[0],
      parentId: parentPath ? `tag_${crypto.createHash("sha256").update(parentPath).digest("hex")}` : null,
      parentPath,
      description: rootTagDescriptions[parts[0]] ?? `${parts[0]}维度标签。`,
      status: "active",
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
      childTagSelectionMode: "multiple",
    };
  });
}

function buildContent({ industry, industryKey, angle, format, project, title, relativePath, tags, createdAt, modifiedAt, index }) {
  const summary = `${industry.label}样例资料：${angle.stage} / ${angle.aspect} / 项目 ${project}。`;
  const metadata = {
    title,
    industry: industry.label,
    project,
    stage: angle.stage,
    aspect: angle.aspect,
    relativePath,
    createdAt,
    modifiedAt,
    tags,
    sampleIndex: index + 1,
  };
  switch (format.extension) {
    case "md":
      return `# ${title}\n\n${summary}\n\n## 样例说明\n\n这份文档用于演示 X-File 的全文索引、时间排序、格式筛选和多维标签浏览。\n\n- 行业：${industry.label}\n- 阶段：${angle.stage}\n- 视角：${angle.aspect}\n- 项目：${project}\n- 创建时间：${createdAt}\n- 修改时间：${modifiedAt}\n\n标签：${tags.join("、")}\n`;
    case "json":
      return `${JSON.stringify({ ...metadata, summary }, null, 2)}\n`;
    case "yaml":
      return `title: "${title}"\nindustry: "${industry.label}"\nproject: "${project}"\nstage: "${angle.stage}"\naspect: "${angle.aspect}"\nsummary: "${summary}"\ncreatedAt: "${createdAt}"\nmodifiedAt: "${modifiedAt}"\ntags:\n${tags.map((tag) => `  - "${tag}"`).join("\n")}\n`;
    case "html":
      return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${summary}</p><dl><dt>行业</dt><dd>${industry.label}</dd><dt>阶段</dt><dd>${angle.stage}</dd><dt>视角</dt><dd>${angle.aspect}</dd></dl><p>${tags.join(" / ")}</p></body></html>\n`;
    case "xml":
      return `<?xml version="1.0" encoding="UTF-8"?>\n<sample><title>${title}</title><industry>${industry.label}</industry><project>${project}</project><stage>${angle.stage}</stage><aspect>${angle.aspect}</aspect><summary>${summary}</summary><modifiedAt>${modifiedAt}</modifiedAt></sample>\n`;
    case "csv":
      return `field,value\n标题,"${title}"\n行业,"${industry.label}"\n项目,"${project}"\n阶段,"${angle.stage}"\n视角,"${angle.aspect}"\n修改时间,"${modifiedAt}"\n`;
    case "svg":
      return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#e9eef0"/><text x="32" y="80" font-size="28" fill="#17343b">${escapeXml(title)}</text><text x="32" y="132" font-size="20" fill="#42656d">${escapeXml(industry.label)} · ${escapeXml(angle.aspect)}</text><text x="32" y="184" font-size="18" fill="#42656d">${escapeXml(project)} · ${escapeXml(modifiedAt.slice(0, 10))}</text></svg>\n`;
    case "rtf":
      return `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Helvetica;}}\\f0\\fs28 ${escapeRtf(title)}\\par\\fs20 ${escapeRtf(summary)}\\par ${escapeRtf(tags.join(" / "))}}`;
    case "log":
      return `${modifiedAt} INFO sample.index=${index + 1} industry="${industryKey}" project="${project}" stage="${angle.stage}" aspect="${angle.aspect}"\\n${modifiedAt} INFO ${summary}\\n`;
    case "css":
    case "scss":
    case "less":
      return `.sample-card-${index + 1} {\\n  --sample-industry: "${industry.label}";\\n  --sample-stage: "${angle.stage}";\\n  content: "${escapeCss(title)}";\\n  color: #27464d;\\n}\\n`;
    case "js":
    case "ts":
    case "tsx":
      return `export const sampleRecord = ${JSON.stringify({ ...metadata, summary }, null, 2)};\\n\\nexport function describeSample() {\\n  return "${escapeJs(summary)}";\\n}\\n`;
    case "py":
      return `sample_record = ${JSON.stringify({ ...metadata, summary }, null, 2)}\\n\\ndef describe_sample():\\n    return "${escapePy(summary)}"\\n`;
    case "sql":
      return `-- ${title}\\nINSERT INTO sample_documents (industry, project, stage, aspect, modified_at) VALUES ('${escapeSql(industry.label)}', '${escapeSql(project)}', '${escapeSql(angle.stage)}', '${escapeSql(angle.aspect)}', '${modifiedAt}');\\n`;
    case "sh":
      return `#!/usr/bin/env bash\\n# ${title}\\nprintf '%s\\\\n' '${escapeSh(summary)}'\\n`;
    case "toml":
      return `[sample]\\ntitle = "${escapeToml(title)}"\\nindustry = "${escapeToml(industry.label)}"\\nproject = "${escapeToml(project)}"\\nstage = "${escapeToml(angle.stage)}"\\naspect = "${escapeToml(angle.aspect)}"\\nmodified_at = "${modifiedAt}"\\n`;
    case "ini":
      return `[sample]\\ntitle=${title}\\nindustry=${industry.label}\\nproject=${project}\\nstage=${angle.stage}\\naspect=${angle.aspect}\\nmodifiedAt=${modifiedAt}\\n`;
    case "c":
    case "cpp":
    case "go":
    case "rs":
    case "java":
      return `// ${title}\\n// ${summary}\\nconst char* sample_industry = "${escapeC(industry.label)}";\\nconst char* sample_project = "${escapeC(project)}";\\nconst char* sample_modified_at = "${modifiedAt}";\\n`;
    default:
      return `${title}\n\n${summary}\n\n${tags.join(" / ")}\n`;
  }
}

function makeSampleDate(index, total) {
  const end = Date.parse("2026-10-31T18:00:00.000Z");
  const span = 900 * 24 * 60 * 60 * 1000;
  const offset = Math.floor((index / Math.max(total - 1, 1)) * span);
  return new Date(end - span + offset).toISOString();
}

function trySetCreationTime(filePath, isoDate) {
  if (!setFilePath) {
    return;
  }
  const date = new Date(isoDate);
  const formatted = `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}/${date.getUTCFullYear()} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}`;
  spawnSync(setFilePath, ["-d", formatted, filePath], { stdio: "ignore" });
}

function resolveSetFilePath() {
  if (process.platform !== "darwin") {
    return null;
  }
  return spawnSync("sh", ["-lc", "command -v SetFile"], { encoding: "utf8" }).stdout?.trim() || null;
}

function parseArgs(rawArgs) {
  const result = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const value = rawArgs[index];
    if (value === "--") continue;
    if (value === "--reset") result.reset = true;
    else if (value === "--skip-index") result.skipIndex = true;
    else if (value === "--sample-dir") result.sampleDir = rawArgs[++index];
    else if (value === "--library-root") result.libraryRoot = rawArgs[++index];
    else if (value === "--data-dir") result.dataDir = rawArgs[++index];
    else if (value === "--count") result.count = rawArgs[++index];
    else if (value === "--industry") result.industry = rawArgs[++index];
    else if (value === "--help" || value === "-h") printHelpAndExit();
    else throw new Error(`未知参数：${value}`);
  }
  return result;
}

function parseCount(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1000) {
    throw new Error(`--count 必须是大于等于 1000 的整数，收到：${raw}`);
  }
  return value;
}

function resolveIndustries(raw) {
  if (raw === "both") return Object.keys(industryDefinitions);
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length !== 1 || !Object.hasOwn(industryDefinitions, values[0])) {
    throw new Error(`--industry 只能是 software-development、film-television-design 或 both。`);
  }
  return values;
}

function allocateCounts(count, industries) {
  const base = Math.floor(count / industries.length);
  const remainder = count % industries.length;
  return Object.fromEntries(industries.map((industry, index) => [industry, base + (index < remainder ? 1 : 0)]));
}

function ancestors(tagPath) {
  const segments = tagPath.split("/");
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

function stableDocumentId(relativePath) {
  return `doc_${crypto.createHash("sha256").update(relativePath).digest("hex").slice(0, 16)}`;
}

function libraryStoreKey(libraryId, rootDir) {
  return `${libraryId}:${rootDir}`;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function countBy(items, key) {
  return Object.fromEntries([...new Set(items.map((item) => item[key]))].sort().map((value) => [
    value,
    items.filter((item) => item[key] === value).length,
  ]));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function printSummary(manifest, message) {
  console.log(JSON.stringify({
    message,
    sampleDir: path.dirname(manifest.libraryRoot),
    libraryRoot: manifest.libraryRoot,
    dataDir: manifest.dataDir,
    documentCount: manifest.documentCount,
    tagCount: manifest.tagCount,
    documentTagBindingCount: manifest.documentTagBindingCount,
    folderTagBindingCount: manifest.folderTagBindingCount,
    industries: manifest.industries,
    formats: manifest.formatCounts,
  }, null, 2));
}

function printHelpAndExit() {
  console.log(`用法：node scripts/generate-sample-x-file-library.mjs [选项]

选项：
  --count <n>                    文档数量，最少 1000，默认 1200
  --industry <name>              software-development、film-television-design 或 both
  --sample-dir <path>            样例隔离目录
  --library-root <path>          文档库根目录
  --data-dir <path>              X-File 独立状态目录
  --skip-index                   只生成文件和标签，不调用原生索引
  --reset                        删除并重建当前样例隔离目录
`);
  process.exit(0);
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeRtf(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("{", "\\{").replaceAll("}", "\\}");
}

function escapeCss(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeJs(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function escapePy(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function escapeSql(value) {
  return value.replaceAll("'", "''");
}

function escapeSh(value) {
  return value.replaceAll("'", "'\"'\"'");
}

function escapeToml(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeC(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
