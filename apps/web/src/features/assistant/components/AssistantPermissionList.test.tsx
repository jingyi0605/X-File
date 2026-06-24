import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AssistantPermissionList } from "./AssistantPermissionList";

describe("AssistantPermissionList", () => {
  it("会展示命令权限请求的结构化字段", () => {
    render(
      <AssistantPermissionList
        requests={[
          {
            requestId: "req-1",
            sessionId: "session-1",
            kind: "command",
            title: "Codex 请求执行命令",
            summary: "rm -rf /tmp/demo",
            detail: "需要删除测试目录",
            metadata: {
              kind: "command",
              command: "rm -rf /tmp/demo",
              reason: "需要删除测试目录",
              cwd: "/Users/test/project"
            },
            status: "pending",
            createdAt: "2026-06-16T10:00:00.000Z"
          }
        ]}
        onReply={vi.fn()}
      />
    );

    expect(screen.getByText("命令：")).toBeInTheDocument();
    expect(screen.getAllByText("rm -rf /tmp/demo")).toHaveLength(2);
    expect(screen.getByText("原因：需要删除测试目录")).toBeInTheDocument();
    expect(screen.getByText("工作目录：")).toBeInTheDocument();
    expect(screen.getByText("/Users/test/project", { selector: "code" })).toBeInTheDocument();
  });

  it("会展示文件改动权限请求的目标路径", () => {
    render(
      <AssistantPermissionList
        requests={[
          {
            requestId: "req-2",
            sessionId: "session-1",
            kind: "file_change",
            title: "Codex 请求改动文件",
            summary: "docs/spec.md",
            detail: null,
            metadata: {
              kind: "file_change",
              primaryPath: "docs/spec.md",
              changes: [
                { path: "docs/spec.md", action: "update" },
                { path: "docs/new.md", action: "add" }
              ],
              diffSummary: "*** Update File: docs/spec.md"
            },
            status: "pending",
            createdAt: "2026-06-16T10:00:00.000Z"
          }
        ]}
        onReply={vi.fn()}
      />
    );

    expect(screen.getByText("目标路径：")).toBeInTheDocument();
    expect(screen.getAllByText("docs/spec.md", { selector: "code" })).toHaveLength(2);
    expect(screen.getByText("变更列表：")).toBeInTheDocument();
    expect(screen.getByText("修改")).toBeInTheDocument();
    expect(screen.getByText("新增")).toBeInTheDocument();
    expect(screen.getByText("docs/new.md", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText("*** Update File: docs/spec.md")).toBeInTheDocument();
  });

  it("会展示 other 权限请求的方法和摘要负载", () => {
    render(
      <AssistantPermissionList
        requests={[
          {
            requestId: "req-3",
            sessionId: "session-1",
            kind: "other",
            title: "Codex 请求：workspace/custom",
            summary: "workspace/custom",
            detail: "{\"foo\":\"bar\"}",
            metadata: {
              kind: "other",
              method: "workspace/custom",
              payloadText: "{\"foo\":\"bar\"}"
            },
            status: "pending",
            createdAt: "2026-06-16T10:00:00.000Z"
          }
        ]}
        onReply={vi.fn()}
      />
    );

    expect(screen.getByText("方法：")).toBeInTheDocument();
    expect(screen.getByText("workspace/custom", { selector: "code" })).toBeInTheDocument();
    expect(screen.getAllByText('{"foo":"bar"}')).toHaveLength(2);
  });
});
