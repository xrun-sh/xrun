import { afterEach, mock } from "bun:test";
import { clearMocks } from "@tauri-apps/api/mocks";
import { JSDOM } from "jsdom";
import { setLanguage } from "../src/i18n";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
for (const name of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "SVGElement",
  "ShadowRoot",
  "HTMLFormElement",
  "HTMLSelectElement",
  "HTMLInputElement",
  "HTMLDialogElement",
  "DocumentFragment",
  "NodeFilter",
  "Node",
  "Event",
  "MouseEvent",
  "CustomEvent",
  "KeyboardEvent",
  "MutationObserver",
] as const) {
  const value = name === "window" ? dom.window : dom.window[name];
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
Object.defineProperty(globalThis, "getComputedStyle", {
  configurable: true,
  value: dom.window.getComputedStyle.bind(dom.window),
});
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  writable: true,
  value: true,
});
// jsdom does not implement native modal dialogs.
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function (value) {
  if (value !== undefined) this.returnValue = value;
  this.open = false;
  this.dispatchEvent(new Event("close"));
};
// The browser implements these layout/pointer APIs; jsdom has no layout engine.
HTMLElement.prototype.hasPointerCapture = () => false;
HTMLElement.prototype.releasePointerCapture = () => {};
HTMLElement.prototype.scrollIntoView = () => {};
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: ResizeObserverMock,
});
Object.defineProperty(window, "ResizeObserver", {
  configurable: true,
  value: ResizeObserverMock,
});
/** Nothing intersects until a test scrolls an observed element into view. */
class IntersectionObserverMock {
  static observers = new Set<IntersectionObserverMock>();
  readonly targets = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.targets.add(target);
    IntersectionObserverMock.observers.add(this);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    IntersectionObserverMock.observers.delete(this);
  }
  takeRecords() {
    return [];
  }
}
export function intersect(target: Element, isIntersecting: boolean) {
  for (const observer of IntersectionObserverMock.observers)
    if (observer.targets.has(target))
      observer.callback(
        [{ target, isIntersecting } as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver,
      );
}
for (const scope of [globalThis, window])
  Object.defineProperty(scope, "IntersectionObserver", {
    configurable: true,
    value: IntersectionObserverMock,
  });

const { cleanup } = await import("@testing-library/react");
afterEach(() => {
  cleanup();
  clearMocks();
  mock.restore();
  setLanguage("en");
  window.localStorage.clear();
  Reflect.deleteProperty(globalThis, "isTauri");
});
