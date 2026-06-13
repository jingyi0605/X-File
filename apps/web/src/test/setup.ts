import "@testing-library/jest-dom/vitest";

const localStorageData = new Map<string, string>();
const testLocalStorage: Storage = {
  get length() {
    return localStorageData.size;
  },
  clear: () => localStorageData.clear(),
  getItem: (key) => localStorageData.get(key) ?? null,
  key: (index) => Array.from(localStorageData.keys())[index] ?? null,
  removeItem: (key) => {
    localStorageData.delete(key);
  },
  setItem: (key, value) => {
    localStorageData.set(key, String(value));
  },
};

Object.defineProperty(window, "localStorage", {
  writable: true,
  configurable: true,
  value: testLocalStorage,
});

Object.defineProperty(globalThis, "localStorage", {
  writable: true,
  configurable: true,
  value: testLocalStorage,
});

// jsdom 不实现 ResizeObserver，LibraryPage 虚拟列表测量需要一个稳定空实现。
class TestResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

Object.defineProperty(window, "ResizeObserver", {
  writable: true,
  configurable: true,
  value: TestResizeObserver,
});

Object.defineProperty(globalThis, "ResizeObserver", {
  writable: true,
  configurable: true,
  value: TestResizeObserver,
});

if (!window.requestAnimationFrame) {
  window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
}

if (!window.cancelAnimationFrame) {
  window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
}

if (!window.PointerEvent) {
  Object.defineProperty(window, "PointerEvent", {
    writable: true,
    configurable: true,
    value: MouseEvent,
  });
}

if (!globalThis.PointerEvent) {
  Object.defineProperty(globalThis, "PointerEvent", {
    writable: true,
    configurable: true,
    value: window.PointerEvent,
  });
}

Object.defineProperty(window.HTMLElement.prototype, "setPointerCapture", {
  writable: true,
  configurable: true,
  value: function setPointerCapture(): void {},
});

Object.defineProperty(window.HTMLElement.prototype, "scrollTo", {
  writable: true,
  configurable: true,
  value: function scrollTo(): void {},
});
