import type { RunTextIndexExecutorOptions, TextIndexExecutor } from "./text-indexer.js";

let defaultTextIndexExecutor: TextIndexExecutor | null = null;

/**
 * 允许宿主注册默认文本索引执行器。
 * 这样 packages/indexer 的公开主入口不再把 Node 类实现硬编码成唯一执行面。
 */
export function registerDefaultTextIndexExecutor(executor: TextIndexExecutor | null): void {
  defaultTextIndexExecutor = executor;
}

export function getRegisteredDefaultTextIndexExecutor(): TextIndexExecutor | null {
  return defaultTextIndexExecutor;
}

export function resolveDefaultTextIndexExecutor(
  fallback: TextIndexExecutor,
): TextIndexExecutor {
  if (defaultTextIndexExecutor) {
    return defaultTextIndexExecutor;
  }
  return async (options) => {
    void fallback;
    throw new Error(
      `未注册默认 TextIndexExecutor：默认主路径已经不再允许隐式回落到 in-process Node 执行面。` +
      `如需兼容 fallback，请显式调用 executeTextIndexInProcess()。rootDir=${options.config.rootDir}`,
    );
  };
}

/**
 * 兼容辅助：只在需要时按调用参数临时切换默认执行器。
 * 主要给同包内服务保留注入点，避免继续直接 new TextIndexer。
 */
export async function withDefaultTextIndexExecutor<T>(
  executor: TextIndexExecutor | null,
  run: () => Promise<T>,
): Promise<T> {
  const previous = defaultTextIndexExecutor;
  defaultTextIndexExecutor = executor;
  try {
    return await run();
  } finally {
    defaultTextIndexExecutor = previous;
  }
}

export type { RunTextIndexExecutorOptions };
