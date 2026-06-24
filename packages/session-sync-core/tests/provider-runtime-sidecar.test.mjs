import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdapterOptions,
  createRuntimeAdapterFromModule,
  readSidecarProviderConfig,
} from "../dist/runtime/provider-runtime-sidecar.js";

test("runtime sidecar 通过环境变量解析通用 adapter 配置", () => {
  const config = readSidecarProviderConfig({
    X_FILE_PROVIDER_ID: "codex",
    X_FILE_PROVIDER_RUNTIME_ADAPTER_EXPORT: "CodexRuntimeAdapter",
    X_FILE_PROVIDER_RUNTIME_PERMISSION_PROTOCOL: "codex-server-request-v1",
    X_FILE_RUNTIME_HOME_DIR: "/tmp/codex-home",
    X_FILE_PROVIDER_RUNTIME_ADAPTER_OPTIONS_JSON: JSON.stringify({
      providerId: "custom-codex"
    })
  });

  assert.deepEqual(config, {
    providerId: "codex",
    adapterExport: "CodexRuntimeAdapter",
    permissionProtocol: "codex-server-request-v1",
    runtimeHomeDir: "/tmp/codex-home",
    adapterOptions: {
      providerId: "custom-codex"
    }
  });
});

test("runtime sidecar 按 adapterExport 构造 runtime adapter，而不是写死 provider 类", async () => {
  class FakeRuntimeAdapter {
    constructor(options) {
      this.options = options;
      this.providerId = String(options.providerId ?? "fake");
    }

    async startSession() {
      throw new Error("not implemented");
    }

    async continueSession() {
      throw new Error("not implemented");
    }
  }

  const adapter = createRuntimeAdapterFromModule(
    {
      FakeRuntimeAdapter
    },
    {
      providerId: "fake-provider",
      adapterExport: "FakeRuntimeAdapter",
      permissionProtocol: "none",
      runtimeHomeDir: "/tmp/fake-home",
      adapterOptions: {
        providerId: "fake-provider",
        extraFlag: true
      }
    }
  );

  assert.equal(adapter.providerId, "fake-provider");
  assert.equal(adapter.options.homeDir, "/tmp/fake-home");
  assert.equal(adapter.options.extraFlag, true);
});

test("codex permission protocol 会注入 handleServerRequest 兼容桥", async () => {
  const options = buildAdapterOptions({
    providerId: "codex",
    adapterExport: "CodexRuntimeAdapter",
    permissionProtocol: "codex-server-request-v1",
    runtimeHomeDir: "/tmp/codex-home",
    adapterOptions: {}
  });

  assert.equal(options.homeDir, "/tmp/codex-home");
  assert.equal(typeof options.handleServerRequest, "function");
});
