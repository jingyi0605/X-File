export async function createAssistantRuntimeModule() {
  throw new Error(
    "claude-code-integration 已迁移到 assistant.descriptor + external-sidecar-runtime；主包不再加载 backend/index.js"
  );
}
