import { isValidElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { t } from "../../i18n";

declare global {
  interface Window {
    DocsAPI?: {
      DocEditor: new (elementId: string, config: Record<string, unknown>) => {
        destroyEditor?: () => void;
      };
    };
  }
}

type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "keyword"
  | "number"
  | "operator"
  | "tag"
  | "attr"
  | "boolean"
  | "null";

interface CodeToken {
  text: string;
  kind: TokenKind;
}

type LineChangeKind = "add" | "modify";

interface FileOverviewMarker {
  line: number;
  span: number;
  kind: LineChangeKind;
}

function CopyBlockButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  async function copyContent(): Promise<void> {
    await navigator.clipboard?.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <button type="button" className="file-viewer-copy-button" onClick={() => void copyContent()}>
      {copied ? "已复制" : "复制"}
    </button>
  );
}

function OverviewRuler(_props: {
  markers: FileOverviewMarker[];
  totalLines: number;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}) {
  return null;
}

const ONLY_OFFICE_SCRIPT_CACHE = new Map<string, Promise<void>>();

function OnlyOfficePreview({
  onlyOffice,
  filePath,
}: {
  onlyOffice: {
    apiScriptUrl: string;
    editorConfig: Record<string, unknown>;
  } | null;
  filePath: string;
}) {
  const editorInstanceRef = useRef<{ destroyEditor?: () => void } | null>(null);
  const containerId = useMemo(
    () => `x-file-onlyoffice-${filePath.replace(/[^a-zA-Z0-9_-]+/g, "-")}-${Math.random().toString(36).slice(2, 8)}`,
    [filePath],
  );
  const [errorText, setErrorText] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!onlyOffice) {
      setErrorText(t("fileViewerOfficeUnavailable"));
      setReady(false);
      return;
    }

    setErrorText(null);
    setReady(false);

    void loadOnlyOfficeScript(onlyOffice.apiScriptUrl)
      .then(() => {
        if (cancelled) {
          return;
        }

        if (!window.DocsAPI?.DocEditor) {
          throw new Error(t("fileViewerOfficeScriptUnavailable"));
        }

        editorInstanceRef.current?.destroyEditor?.();
        editorInstanceRef.current = new window.DocsAPI.DocEditor(
          containerId,
          onlyOffice.editorConfig,
        );
        setReady(true);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setErrorText(
          error instanceof Error ? error.message : t("fileViewerOfficeUnavailable"),
        );
      });

    return () => {
      cancelled = true;
      editorInstanceRef.current?.destroyEditor?.();
      editorInstanceRef.current = null;
    };
  }, [containerId, onlyOffice]);

  if (!onlyOffice) {
    return <p className="status-text">{t("fileViewerOfficeUnavailable")}</p>;
  }

  return (
    <div className="file-viewer-office-shell">
      {!ready && !errorText ? (
        <p className="status-text">{t("fileViewerOfficeLoading")}</p>
      ) : null}
      {errorText ? <p className="status-text">{errorText}</p> : null}
      <div
        id={containerId}
        className="file-viewer-office-stage"
        data-testid="file-viewer-office-preview"
        aria-label={filePath}
      />
    </div>
  );
}

function loadOnlyOfficeScript(src: string): Promise<void> {
  const cached = ONLY_OFFICE_SCRIPT_CACHE.get(src);
  if (cached) {
    return cached;
  }

  const pending = new Promise<void>((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error(t("fileViewerOfficeUnavailable")));
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-onlyoffice-script="${src}"]`,
    );
    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }

    const script = existing ?? document.createElement("script");
    const cleanup = () => {
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
    };
    const handleLoad = () => {
      script.dataset.loaded = "true";
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(t("fileViewerOfficeScriptUnavailable")));
    };

    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });

    if (!existing) {
      script.src = src;
      script.async = true;
      script.dataset.onlyofficeScript = src;
      document.head.appendChild(script);
    }
  });

  ONLY_OFFICE_SCRIPT_CACHE.set(src, pending);
  return pending;
}


function MarkdownPreview({ content }: { content: string }) {
  const markdownComponents = useMemo(() => buildMarkdownComponents(), []);

  return (
    <div className="markdown-content file-viewer-markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </Markdown>
    </div>
  );
}

function buildMarkdownComponents(): Components {
  return {
    pre(props) {
      const blockProps = extractCodeBlockProps(props.children);

      if (!blockProps) {
        return <pre>{props.children}</pre>;
      }

      return (
        <MarkdownCopyBlock
          content={blockProps.content}
          language={blockProps.language}
          codeClassName={blockProps.codeClassName}
        />
      );
    },
    code(props) {
      const codeClassName = typeof props.className === "string" ? props.className : "";
      return <code className={codeClassName || undefined}>{props.children}</code>;
    },
  };
}

interface MarkdownCodeBlockProps {
  content: string;
  language: string | null;
  codeClassName?: string;
}

function extractCodeBlockProps(children: ReactNode): MarkdownCodeBlockProps | null {
  if (!isValidElement(children)) {
    return null;
  }

  const props = children.props as { className?: unknown; children?: ReactNode };
  const codeClassName = typeof props.className === "string" ? props.className : "";
  const languageMatch = /language-([\w-]+)/.exec(codeClassName);
  return {
    content: flattenReactNodeText(props.children ?? ""),
    language: languageMatch?.[1] ?? null,
    codeClassName: codeClassName || undefined,
  };
}

function MarkdownCopyBlock({
  content,
  language,
  codeClassName,
}: MarkdownCodeBlockProps) {
  const normalizedLanguage = language ? normalizeLanguage(language) : null;

  return (
    <div className="file-viewer-markdown-copy-block">
      <div className="file-viewer-markdown-copy-header">
        <span className="file-viewer-markdown-copy-label">
          {normalizedLanguage ? formatLanguageLabel(normalizedLanguage) : t("fileViewerPlainText")}
        </span>
        <CopyBlockButton content={content} />
      </div>
      <pre className={codeClassName}>
        <code>{content}</code>
      </pre>
    </div>
  );
}

function flattenReactNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((item) => flattenReactNodeText(item)).join("");
  }

  if (isValidElement(node)) {
    return flattenReactNodeText((node.props as { children?: ReactNode }).children ?? "");
  }

  return "";
}

function CodePreview({
  content,
  language,
  overviewMarkers = [],
  overviewTotalLines,
  editable = false,
  onContentChange
}: {
  content: string;
  language: string;
  overviewMarkers?: FileOverviewMarker[];
  overviewTotalLines: number;
  editable?: boolean;
  onContentChange?: (content: string) => void;
}) {
  const lines = content.split(/\r?\n/);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const lineChangeMap = useMemo(() => {
    const map = new Map<number, "add" | "modify">();
    for (const marker of overviewMarkers) {
      for (let i = 0; i < marker.span; i++) {
        map.set(marker.line + i, marker.kind);
      }
    }
    return map;
  }, [overviewMarkers]);

  return (
    <div className="file-viewer-code-block">
      <div className="file-viewer-code-header">
        <span className="file-viewer-code-header-label">{formatLanguageLabel(language)}</span>
        <CopyBlockButton content={content} />
      </div>
      <div className="file-viewer-scroll-shell">
        <div className="file-viewer-code-body" data-editable={editable ? "true" : undefined} ref={bodyRef}>
          {editable ? (
            <EditableCodeContent
              content={content}
              language={language}
              onContentChange={onContentChange}
              lineChangeMap={lineChangeMap}
            />
          ) : (
            lines.map((line, index) => {
              const tokens = tokenizeLine(line, language);
              const lineNo = index + 1;
              const changeKind = lineChangeMap.get(lineNo);

              return (
                <div
                  key={`${index}-${line}`}
                  className={`file-viewer-code-line${changeKind ? ` diff-line-${changeKind}` : ""}`}
                >
                  <span className="file-viewer-code-gutter">{lineNo}</span>
                  <code className="file-viewer-code-content">
                    {tokens.length ? (
                      tokens.map((token, tokenIndex) => (
                        <span
                          key={`${index}-${tokenIndex}-${token.text}`}
                          className={`code-token ${token.kind}`}
                        >
                          {token.text}
                        </span>
                      ))
                    ) : (
                      <span className="code-token plain"> </span>
                    )}
                  </code>
                </div>
              );
            })
          )}
        </div>
        <OverviewRuler
          markers={overviewMarkers}
          totalLines={overviewTotalLines}
          scrollContainerRef={bodyRef}
        />
      </div>
    </div>
  );
}

function EditableCodeContent({
  content,
  language,
  onContentChange,
  lineChangeMap
}: {
  content: string;
  language: string;
  onContentChange?: (content: string) => void;
  lineChangeMap: Map<number, "add" | "modify">;
}) {
  const renderRef = useRef<HTMLDivElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const [lineHeights, setLineHeights] = useState<number[]>([]);

  useLayoutEffect(() => {
    const renderElement = renderRef.current;

    if (!renderElement) {
      return;
    }

    let frameId = 0;

    const measureTarget = renderElement;

    function measureLineHeights() {
      const nextHeights = Array.from(
        measureTarget.querySelectorAll<HTMLElement>("[data-editor-line-index]")
      ).map((lineElement) => Math.max(24, Math.ceil(lineElement.getBoundingClientRect().height)));

      setLineHeights((previousHeights) => {
        if (previousHeights.length === nextHeights.length
          && previousHeights.every((height, index) => height === nextHeights[index])) {
          return previousHeights;
        }

        return nextHeights;
      });
    }

    const animationFrame = globalThis.window;

    function requestMeasure() {
      if (!animationFrame) {
        measureLineHeights();
        return;
      }

      animationFrame.cancelAnimationFrame(frameId);
      frameId = animationFrame.requestAnimationFrame(measureLineHeights);
    }

    requestMeasure();

    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(requestMeasure);
    resizeObserver?.observe(measureTarget);

    return () => {
      animationFrame?.cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
    };
  }, [content, language]);

  function handleScroll(event: { currentTarget: HTMLTextAreaElement }) {
    const renderElement = renderRef.current;
    const gutterElement = gutterRef.current;

    if (!renderElement) {
      return;
    }

    renderElement.scrollTop = event.currentTarget.scrollTop;
    renderElement.scrollLeft = event.currentTarget.scrollLeft;

    if (gutterElement) {
      gutterElement.scrollTop = event.currentTarget.scrollTop;
    }
  }

  const lines = content.split(/\r?\n/);

  return (
    <div className="file-viewer-code-editor-shell">
      <div
        ref={gutterRef}
        className="file-viewer-code-editor-gutter"
        aria-hidden="true"
      >
        {lines.map((line, index) => {
          const lineNo = index + 1;
          const changeKind = lineChangeMap.get(lineNo);

          return (
            <div
              key={`gutter-${index}-${line}`}
              className={`file-viewer-code-editor-gutter-line${changeKind ? ` diff-line-${changeKind}` : ""}`}
              style={lineHeights[index] ? { height: `${lineHeights[index]}px` } : undefined}
            >
              <span className="file-viewer-code-gutter">{lineNo}</span>
            </div>
          );
        })}
      </div>
      <div className="file-viewer-code-editor-pane">
      <div
        ref={renderRef}
        className="file-viewer-code-editor-render"
        data-testid="file-viewer-inline-render"
        aria-hidden="true"
      >
        {lines.map((line, index) => {
          const tokens = tokenizeLine(line, language);
          const lineNo = index + 1;
          const changeKind = lineChangeMap.get(lineNo);

          return (
            <div
              key={`${index}-${line}`}
              className={`file-viewer-code-editor-line${changeKind ? ` diff-line-${changeKind}` : ""}`}
              data-editor-line-index={index}
            >
              <code className="file-viewer-code-content">
                {tokens.length ? (
                  tokens.map((token, tokenIndex) => (
                    <span
                      key={`${index}-${tokenIndex}-${token.text}`}
                      className={`code-token ${token.kind}`}
                    >
                      {token.text}
                    </span>
                  ))
                ) : (
                  <span className="code-token plain"> </span>
                )}
              </code>
            </div>
          );
        })}
      </div>
      <textarea
        className="file-viewer-editor file-viewer-code-editor-input"
        data-testid="file-viewer-editor"
        value={content}
        onChange={(event) => onContentChange?.(event.target.value)}
        onScroll={handleScroll}
        spellCheck={false}
      />
      </div>
    </div>
  );
}

const SCRIPT_KEYWORDS = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield"
]);

const PYTHON_KEYWORDS = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "False",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "None",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "True",
  "try",
  "while",
  "with",
  "yield"
]);

const SHELL_KEYWORDS = new Set([
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "export",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "local",
  "readonly",
  "return",
  "then",
  "until",
  "while"
]);

const SQL_KEYWORDS = new Set([
  "add",
  "alter",
  "and",
  "as",
  "asc",
  "between",
  "by",
  "create",
  "delete",
  "desc",
  "drop",
  "from",
  "group",
  "having",
  "insert",
  "into",
  "join",
  "left",
  "like",
  "limit",
  "not",
  "null",
  "offset",
  "on",
  "or",
  "order",
  "right",
  "select",
  "set",
  "table",
  "union",
  "update",
  "values",
  "where"
]);

const DOCKERFILE_KEYWORDS = new Set([
  "add",
  "arg",
  "cmd",
  "copy",
  "entrypoint",
  "env",
  "expose",
  "from",
  "healthcheck",
  "label",
  "maintainer",
  "onbuild",
  "run",
  "shell",
  "stopsignal",
  "user",
  "volume",
  "workdir",
  "as"
]);

const LOG_LEVELS = new Set([
  "trace",
  "debug",
  "info",
  "warn",
  "warning",
  "error",
  "fatal"
]);


function tokenizeLine(line: string, language: string): CodeToken[] {
  const normalizedLanguage = normalizeLanguage(language);

  if (normalizedLanguage === "json") {
    return tokenizeJsonLine(line);
  }

  if (normalizedLanguage === "yaml") {
    return tokenizeYamlLine(line);
  }

  if (normalizedLanguage === "toml") {
    return tokenizeTomlLine(line);
  }

  if (normalizedLanguage === "ini") {
    return tokenizeIniLine(line);
  }

  if (normalizedLanguage === "env") {
    return tokenizeEnvLine(line);
  }

  if (normalizedLanguage === "properties") {
    return tokenizePropertiesLine(line);
  }

  if (normalizedLanguage === "conf") {
    return tokenizeConfLine(line);
  }

  if (normalizedLanguage === "editorconfig") {
    return tokenizeEditorConfigLine(line);
  }

  if (normalizedLanguage === "dockerfile") {
    return tokenizeDockerfileLine(line);
  }

  if (normalizedLanguage === "gitignore") {
    return tokenizeGitIgnoreLine(line);
  }

  if (normalizedLanguage === "log") {
    return tokenizeLogLine(line);
  }

  if (normalizedLanguage === "python") {
    return tokenizeWithWordSet(line, PYTHON_KEYWORDS, "#");
  }

  if (normalizedLanguage === "shell") {
    return tokenizeWithWordSet(line, SHELL_KEYWORDS, "#");
  }

  if (normalizedLanguage === "sql") {
    return tokenizeSqlLine(line);
  }

  if (normalizedLanguage === "html" || normalizedLanguage === "xml") {
    return tokenizeMarkupLine(line);
  }

  if (normalizedLanguage === "css") {
    return tokenizeCssLine(line);
  }

  if (normalizedLanguage === "markdown") {
    return [{ text: line, kind: "plain" }];
  }

  return tokenizeWithWordSet(line, SCRIPT_KEYWORDS, "//");
}

function tokenizeWithWordSet(line: string, keywords: ReadonlySet<string>, commentPrefix: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let index = 0;

  while (index < line.length) {
    const rest = line.slice(index);

    if (rest.startsWith(commentPrefix)) {
      tokens.push({ text: rest, kind: "comment" });
      break;
    }

    const stringMatch = /^(?:'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"|`[^`\\]*(?:\\.[^`\\]*)*`)/.exec(rest);

    if (stringMatch) {
      tokens.push({ text: stringMatch[0], kind: "string" });
      index += stringMatch[0].length;
      continue;
    }

    const numberMatch = /^(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/.exec(rest);

    if (numberMatch) {
      tokens.push({ text: numberMatch[0], kind: "number" });
      index += numberMatch[0].length;
      continue;
    }

    const wordMatch = /^[A-Za-z_][\w$-]*/.exec(rest);

    if (wordMatch) {
      const word = wordMatch[0];
      const lowerWord = word.toLowerCase();

      if (word === "true" || word === "false" || lowerWord === "true" || lowerWord === "false") {
        tokens.push({ text: word, kind: "boolean" });
      } else if (word === "null" || word === "None" || lowerWord === "none") {
        tokens.push({ text: word, kind: "null" });
      } else if (keywords.has(word) || keywords.has(lowerWord)) {
        tokens.push({ text: word, kind: "keyword" });
      } else {
        tokens.push({ text: word, kind: "plain" });
      }

      index += word.length;
      continue;
    }

    const operatorMatch = /^(?:===|!==|==|!=|<=|>=|=>|&&|\|\||[+\-*/%=<>!?:|&^~]+)/.exec(rest);

    if (operatorMatch) {
      tokens.push({ text: operatorMatch[0], kind: "operator" });
      index += operatorMatch[0].length;
      continue;
    }

    tokens.push({ text: rest[0] ?? "", kind: "plain" });
    index += 1;
  }

  return tokens;
}

function tokenizeJsonLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let index = 0;

  while (index < line.length) {
    const rest = line.slice(index);
    const stringMatch = /^"(?:[^"\\]|\\.)*"/.exec(rest);

    if (stringMatch) {
      const nextChar = line.slice(index + stringMatch[0].length).trimStart()[0];
      tokens.push({
        text: stringMatch[0],
        kind: nextChar === ":" ? "attr" : "string"
      });
      index += stringMatch[0].length;
      continue;
    }

    const numberMatch = /^(?:-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(rest);

    if (numberMatch) {
      tokens.push({ text: numberMatch[0], kind: "number" });
      index += numberMatch[0].length;
      continue;
    }

    const literalMatch = /^(?:true|false|null)\b/.exec(rest);

    if (literalMatch) {
      const kind = literalMatch[0] === "null" ? "null" : "boolean";
      tokens.push({ text: literalMatch[0], kind });
      index += literalMatch[0].length;
      continue;
    }

    const operatorMatch = /^(?::|,|\{|\}|\[|\])/.exec(rest);

    if (operatorMatch) {
      tokens.push({ text: operatorMatch[0], kind: "operator" });
      index += operatorMatch[0].length;
      continue;
    }

    tokens.push({ text: rest[0] ?? "", kind: "plain" });
    index += 1;
  }

  return tokens;
}

function tokenizeMarkupLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let index = 0;

  while (index < line.length) {
    const rest = line.slice(index);

    if (rest.startsWith("<!--")) {
      tokens.push({ text: rest, kind: "comment" });
      break;
    }

    const tagMatch = /^(<\/?[\w:-]+)/.exec(rest);

    if (tagMatch) {
      tokens.push({ text: tagMatch[0], kind: "tag" });
      index += tagMatch[0].length;
      continue;
    }

    const attrMatch = /^([\w:-]+)(=)/.exec(rest);

    if (attrMatch) {
      tokens.push({ text: attrMatch[1] ?? "", kind: "attr" });
      tokens.push({ text: attrMatch[2] ?? "", kind: "operator" });
      index += attrMatch[0].length;
      continue;
    }

    const stringMatch = /^(?:'[^']*'|"[^"]*")/.exec(rest);

    if (stringMatch) {
      tokens.push({ text: stringMatch[0], kind: "string" });
      index += stringMatch[0].length;
      continue;
    }

    const operatorMatch = /^(?:\/?>)/.exec(rest);

    if (operatorMatch) {
      tokens.push({ text: operatorMatch[0], kind: "operator" });
      index += operatorMatch[0].length;
      continue;
    }

    tokens.push({ text: rest[0] ?? "", kind: "plain" });
    index += 1;
  }

  return tokens;
}

function tokenizeCssLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let index = 0;

  while (index < line.length) {
    const rest = line.slice(index);

    if (rest.startsWith("/*")) {
      tokens.push({ text: rest, kind: "comment" });
      break;
    }

    const stringMatch = /^(?:'[^']*'|"[^"]*")/.exec(rest);

    if (stringMatch) {
      tokens.push({ text: stringMatch[0], kind: "string" });
      index += stringMatch[0].length;
      continue;
    }

    const attrMatch = /^([A-Za-z-]+)(\s*:)/.exec(rest);

    if (attrMatch) {
      tokens.push({ text: attrMatch[1] ?? "", kind: "attr" });
      tokens.push({ text: attrMatch[2] ?? "", kind: "operator" });
      index += attrMatch[0].length;
      continue;
    }

    const numberMatch = /^(?:#(?:[\da-fA-F]{3,8})|\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%)?)/.exec(rest);

    if (numberMatch) {
      tokens.push({ text: numberMatch[0], kind: "number" });
      index += numberMatch[0].length;
      continue;
    }

    const keywordMatch = /^(?:@media|@supports|@import|@keyframes)\b/.exec(rest);

    if (keywordMatch) {
      tokens.push({ text: keywordMatch[0], kind: "keyword" });
      index += keywordMatch[0].length;
      continue;
    }

    const operatorMatch = /^(?:[{}:;(),.>])/.exec(rest);

    if (operatorMatch) {
      tokens.push({ text: operatorMatch[0], kind: "operator" });
      index += operatorMatch[0].length;
      continue;
    }

    tokens.push({ text: rest[0] ?? "", kind: "plain" });
    index += 1;
  }

  return tokens;
}

function tokenizeSqlLine(line: string): CodeToken[] {
  return tokenizeWithWordSet(line, SQL_KEYWORDS, "--");
}

function tokenizeYamlLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let index = 0;

  while (index < line.length) {
    const rest = line.slice(index);

    if (rest.startsWith("#")) {
      tokens.push({ text: rest, kind: "comment" });
      break;
    }

    const keyMatch = /^([A-Za-z0-9_.-]+)(\s*:)/.exec(rest);

    if (keyMatch) {
      tokens.push({ text: keyMatch[1] ?? "", kind: "attr" });
      tokens.push({ text: keyMatch[2] ?? "", kind: "operator" });
      index += keyMatch[0].length;
      continue;
    }

    const stringMatch = /^(?:'[^']*'|"[^"]*")/.exec(rest);

    if (stringMatch) {
      tokens.push({ text: stringMatch[0], kind: "string" });
      index += stringMatch[0].length;
      continue;
    }

    const numberMatch = /^(?:-?\d+(?:\.\d+)?)/.exec(rest);

    if (numberMatch) {
      tokens.push({ text: numberMatch[0], kind: "number" });
      index += numberMatch[0].length;
      continue;
    }

    const literalMatch = /^(?:true|false|yes|no|null|~)\b/i.exec(rest);

    if (literalMatch) {
      const lowerLiteral = literalMatch[0].toLowerCase();
      const kind: TokenKind =
        lowerLiteral === "null" || lowerLiteral === "~" ? "null" : "boolean";
      tokens.push({ text: literalMatch[0], kind });
      index += literalMatch[0].length;
      continue;
    }

    const operatorMatch = /^(?:[-?:,[\]{}|>])/.exec(rest);

    if (operatorMatch) {
      tokens.push({ text: operatorMatch[0], kind: "operator" });
      index += operatorMatch[0].length;
      continue;
    }

    tokens.push({ text: rest[0] ?? "", kind: "plain" });
    index += 1;
  }

  return tokens;
}

function tokenizeTomlLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let index = 0;

  while (index < line.length) {
    const rest = line.slice(index);

    if (rest.startsWith("#")) {
      tokens.push({ text: rest, kind: "comment" });
      break;
    }

    const sectionMatch = /^(\[\[?[^\]]+\]?\])/.exec(rest);

    if (sectionMatch) {
      tokens.push({ text: sectionMatch[0], kind: "tag" });
      index += sectionMatch[0].length;
      continue;
    }

    const keyMatch = /^([A-Za-z0-9_.-]+)(\s*=)/.exec(rest);

    if (keyMatch) {
      tokens.push({ text: keyMatch[1] ?? "", kind: "attr" });
      tokens.push({ text: keyMatch[2] ?? "", kind: "operator" });
      index += keyMatch[0].length;
      continue;
    }

    const valueTokens = readConfigScalar(rest, {
      trueValues: ["true"],
      falseValues: ["false"],
      nullValues: []
    });

    if (valueTokens) {
      tokens.push(...valueTokens.tokens);
      index += valueTokens.length;
      continue;
    }

    const operatorMatch = /^(?:[,[\]{}])/.exec(rest);

    if (operatorMatch) {
      tokens.push({ text: operatorMatch[0], kind: "operator" });
      index += operatorMatch[0].length;
      continue;
    }

    tokens.push({ text: rest[0] ?? "", kind: "plain" });
    index += 1;
  }

  return tokens;
}

function tokenizeIniLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let index = 0;

  while (index < line.length) {
    const rest = line.slice(index);
    const trimmedRest = rest.trimStart();

    if (trimmedRest.startsWith(";") || trimmedRest.startsWith("#")) {
      tokens.push({ text: rest, kind: "comment" });
      break;
    }

    const sectionMatch = /^(\[[^\]]+\])/.exec(rest);

    if (sectionMatch) {
      tokens.push({ text: sectionMatch[0], kind: "tag" });
      index += sectionMatch[0].length;
      continue;
    }

    const keyMatch = /^([A-Za-z0-9_.-]+)(\s*[=:])/.exec(rest);

    if (keyMatch) {
      tokens.push({ text: keyMatch[1] ?? "", kind: "attr" });
      tokens.push({ text: keyMatch[2] ?? "", kind: "operator" });
      index += keyMatch[0].length;
      continue;
    }

    const valueTokens = readConfigScalar(rest, {
      trueValues: ["true", "yes", "on"],
      falseValues: ["false", "no", "off"],
      nullValues: ["null"]
    });

    if (valueTokens) {
      tokens.push(...valueTokens.tokens);
      index += valueTokens.length;
      continue;
    }

    tokens.push({ text: rest[0] ?? "", kind: "plain" });
    index += 1;
  }

  return tokens;
}

function tokenizeEnvLine(line: string): CodeToken[] {
  const trimmedLine = line.trimStart();

  if (trimmedLine.startsWith("#")) {
    return [{ text: line, kind: "comment" }];
  }

  const exportMatch = /^(\s*)(export)(\s+)/.exec(line);
  const keyStart = exportMatch ? exportMatch[0].length : 0;
  const tokens: CodeToken[] = [];

  if (exportMatch) {
    tokens.push({ text: exportMatch[1] ?? "", kind: "plain" });
    tokens.push({ text: exportMatch[2] ?? "", kind: "keyword" });
    tokens.push({ text: exportMatch[3] ?? "", kind: "plain" });
  }

  const rest = line.slice(keyStart);
  const keyMatch = /^([A-Za-z_][A-Za-z0-9_]*)(=)/.exec(rest);

  if (!keyMatch) {
    return tokenizeIniLine(line);
  }

  tokens.push({ text: keyMatch[1] ?? "", kind: "attr" });
  tokens.push({ text: keyMatch[2] ?? "", kind: "operator" });

  const valueText = rest.slice(keyMatch[0].length);
  const valueTokens = readConfigScalar(valueText, {
    trueValues: ["true"],
    falseValues: ["false"],
    nullValues: ["null"]
  });

  if (valueTokens) {
    tokens.push(...valueTokens.tokens);
    return tokens;
  }

  tokens.push({ text: valueText, kind: "plain" });
  return tokens;
}

function tokenizePropertiesLine(line: string): CodeToken[] {
  return tokenizeConfigEntryLine(line, {
    commentPrefixes: ["#", "!"],
    allowSection: false,
    delimiters: ["=", ":"]
  });
}

function tokenizeConfLine(line: string): CodeToken[] {
  return tokenizeConfigEntryLine(line, {
    commentPrefixes: ["#", ";"],
    allowSection: true,
    delimiters: ["=", ":"]
  });
}

function tokenizeEditorConfigLine(line: string): CodeToken[] {
  return tokenizeConfigEntryLine(line, {
    commentPrefixes: ["#", ";"],
    allowSection: true,
    delimiters: ["="]
  });
}

function tokenizeDockerfileLine(line: string): CodeToken[] {
  return tokenizeWithWordSet(line, DOCKERFILE_KEYWORDS, "#");
}

function tokenizeGitIgnoreLine(line: string): CodeToken[] {
  const trimmedLine = line.trimStart();

  if (!trimmedLine) {
    return [];
  }

  if (trimmedLine.startsWith("#")) {
    return [{ text: line, kind: "comment" }];
  }

  if (trimmedLine.startsWith("!")) {
    const leadingWhitespaceLength = line.length - trimmedLine.length;
    const leadingWhitespace = line.slice(0, leadingWhitespaceLength);
    const pattern = trimmedLine.slice(1);

    return [
      { text: leadingWhitespace, kind: "plain" },
      { text: "!", kind: "operator" },
      { text: pattern, kind: "string" }
    ];
  }

  return [{ text: line, kind: "string" }];
}

function tokenizeLogLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let index = 0;

  while (index < line.length) {
    const rest = line.slice(index);

    if (rest.startsWith("#")) {
      tokens.push({ text: rest, kind: "comment" });
      break;
    }

    const timestampMatch =
      /^(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{3,6})?(?:Z|[+-]\d{2}:\d{2})?)/.exec(rest);

    if (timestampMatch) {
      tokens.push({ text: timestampMatch[0], kind: "tag" });
      index += timestampMatch[0].length;
      continue;
    }

    const bracketLevelMatch = /^(?:\[(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\])/.exec(rest);

    if (bracketLevelMatch) {
      tokens.push({ text: rest.slice(0, bracketLevelMatch[0].length), kind: "keyword" });
      index += bracketLevelMatch[0].length;
      continue;
    }

    const wordMatch = /^[A-Za-z_][\w-]*/.exec(rest);

    if (wordMatch) {
      const word = wordMatch[0];

      if (LOG_LEVELS.has(word.toLowerCase())) {
        tokens.push({ text: word, kind: "keyword" });
      } else {
        tokens.push({ text: word, kind: "plain" });
      }

      index += word.length;
      continue;
    }

    const numberMatch = /^(?:\d+(?:\.\d+)?)/.exec(rest);

    if (numberMatch) {
      tokens.push({ text: numberMatch[0], kind: "number" });
      index += numberMatch[0].length;
      continue;
    }

    tokens.push({ text: rest[0] ?? "", kind: "plain" });
    index += 1;
  }

  return tokens;
}

function tokenizeConfigEntryLine(
  line: string,
  options: {
    commentPrefixes: string[];
    allowSection: boolean;
    delimiters: string[];
  }
): CodeToken[] {
  const trimmedLine = line.trimStart();

  if (options.commentPrefixes.some((prefix) => trimmedLine.startsWith(prefix))) {
    return [{ text: line, kind: "comment" }];
  }

  if (options.allowSection) {
    const sectionMatch = /^(\[[^\]]+\])/.exec(line);

    if (sectionMatch) {
      return [{ text: sectionMatch[0], kind: "tag" }];
    }
  }

  const keyMatch = /^([A-Za-z0-9_.\-*?]+)(\s*(?:=|:))/.exec(line);

  if (!keyMatch) {
    return [{ text: line, kind: "plain" }];
  }

  const delimiter = (keyMatch[2] ?? "").trim();

  if (!options.delimiters.includes(delimiter)) {
    return [{ text: line, kind: "plain" }];
  }

  const tokens: CodeToken[] = [
    { text: keyMatch[1] ?? "", kind: "attr" },
    { text: keyMatch[2] ?? "", kind: "operator" }
  ];
  const valueText = line.slice(keyMatch[0].length);
  const valueTokens = tokenizeConfigValue(valueText);

  if (valueTokens.length) {
    tokens.push(...valueTokens);
  }

  return tokens;
}

function tokenizeConfigValue(text: string): CodeToken[] {
  if (!text) {
    return [];
  }

  const tokens: CodeToken[] = [];
  let index = 0;

  while (index < text.length) {
    const rest = text.slice(index);
    const valueTokens = readConfigScalar(rest, {
      trueValues: ["true", "yes", "on"],
      falseValues: ["false", "no", "off"],
      nullValues: ["null"]
    });

    if (valueTokens) {
      tokens.push(...valueTokens.tokens);
      index += valueTokens.length;
      continue;
    }

    if (rest.startsWith("#") || rest.startsWith(";")) {
      tokens.push({ text: rest, kind: "comment" });
      break;
    }

    tokens.push({ text: rest[0] ?? "", kind: "plain" });
    index += 1;
  }

  return tokens;
}

function readConfigScalar(
  text: string,
  literals: {
    trueValues: string[];
    falseValues: string[];
    nullValues: string[];
  }
): { tokens: CodeToken[]; length: number } | null {
  const stringMatch = /^(?:'[^']*'|"[^"]*")/.exec(text);

  if (stringMatch) {
    return {
      tokens: [{ text: stringMatch[0], kind: "string" }],
      length: stringMatch[0].length
    };
  }

  const numberMatch = /^(?:-?\d+(?:\.\d+)?)/.exec(text);

  if (numberMatch) {
    return {
      tokens: [{ text: numberMatch[0], kind: "number" }],
      length: numberMatch[0].length
    };
  }

  const wordMatch = /^[A-Za-z0-9_.:+/-]+/.exec(text);

  if (!wordMatch) {
    return null;
  }

  const word = wordMatch[0];
  const lowerWord = word.toLowerCase();

  if (literals.trueValues.includes(lowerWord)) {
    return {
      tokens: [{ text: word, kind: "boolean" }],
      length: word.length
    };
  }

  if (literals.falseValues.includes(lowerWord)) {
    return {
      tokens: [{ text: word, kind: "boolean" }],
      length: word.length
    };
  }

  if (literals.nullValues.includes(lowerWord)) {
    return {
      tokens: [{ text: word, kind: "null" }],
      length: word.length
    };
  }

  return {
    tokens: [{ text: word, kind: "plain" }],
    length: word.length
  };
}

function detectLanguage(filePath: string | null): string {
  if (!filePath) {
    return "plain";
  }

  const fileName = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";

  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return "env";
  }

  if (fileName === ".editorconfig") {
    return "editorconfig";
  }

  if (fileName === "dockerfile" || fileName.endsWith(".dockerfile")) {
    return "dockerfile";
  }

  if (fileName === ".gitignore") {
    return "gitignore";
  }

  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";

  switch (extension) {
    case "md":
    case "markdown":
      return "markdown";
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
      return "json";
    case "log":
      return "log";
    case "properties":
      return "properties";
    case "toml":
      return "toml";
    case "ini":
      return "ini";
    case "conf":
      return "conf";
    case "dockerfile":
      return "dockerfile";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "xml":
    case "svg":
      return "xml";
    case "py":
      return "python";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "sql":
      return "sql";
    case "yml":
    case "yaml":
      return "yaml";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "java":
      return "java";
    case "c":
    case "h":
    case "cpp":
    case "cc":
    case "hpp":
      return "cpp";
    default:
      return "plain";
  }
}

function normalizeLanguage(language: string): string {
  const lowerLanguage = language.toLowerCase();

  switch (lowerLanguage) {
    case "ts":
    case "tsx":
    case "typescript":
      return "typescript";
    case "js":
    case "jsx":
    case "javascript":
      return "javascript";
    case "bash":
    case "shell":
    case "sh":
    case "zsh":
      return "shell";
    case "md":
    case "markdown":
      return "markdown";
    case "properties":
      return "properties";
    case "toml":
      return "toml";
    case "ini":
      return "ini";
    case "env":
      return "env";
    case "conf":
      return "conf";
    case "editorconfig":
      return "editorconfig";
    case "dockerfile":
      return "dockerfile";
    case "gitignore":
      return "gitignore";
    case "log":
      return "log";
    default:
      return lowerLanguage;
  }
}

function formatLanguageLabel(language: string): string {
  const normalizedLanguage = normalizeLanguage(language);

  switch (normalizedLanguage) {
    case "typescript":
      return "TypeScript";
    case "javascript":
      return "JavaScript";
    case "markdown":
      return "Markdown";
    case "json":
      return "JSON";
    case "properties":
      return "Properties";
    case "toml":
      return "TOML";
    case "ini":
      return "INI";
    case "env":
      return "ENV";
    case "conf":
      return "CONF";
    case "editorconfig":
      return "EditorConfig";
    case "dockerfile":
      return "Dockerfile";
    case "gitignore":
      return "GitIgnore";
    case "log":
      return "Log";
    case "css":
      return "CSS";
    case "html":
      return "HTML";
    case "xml":
      return "XML";
    case "python":
      return "Python";
    case "shell":
      return "Shell";
    case "sql":
      return "SQL";
    case "yaml":
      return "YAML";
    case "rust":
      return "Rust";
    case "go":
      return "Go";
    case "java":
      return "Java";
    case "cpp":
      return "C/C++";
    default:
      return t("fileViewerPlainText");
  }
}

export { CodePreview, MarkdownPreview, OnlyOfficePreview, detectLanguage, formatLanguageLabel };
