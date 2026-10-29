import { describe, it, expect } from "vitest";
import { getNestedValue, setNestedValue } from "./nested";

describe("nested config paths", () => {
  it.each([
    "__proto__.polluted",
    "constructor.prototype.polluted",
    "prototype.polluted",
    "safe.__proto__.polluted",
    "safe.constructor.polluted",
    "safe.prototype.polluted",
    "safe.__proto__",
    "safe.constructor",
    "safe.prototype",
  ])("rejects %s before reading or cloning input", (path) => {
    let reads = 0;
    const source = { get safe() { reads++; return {}; } };
    expect(() => getNestedValue(source, path)).toThrow(TypeError);
    expect(() => setNestedValue(source, path, "canary")).toThrow(TypeError);
    expect(reads).toBe(0);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it("reads only own properties and never follows inherited getters", () => {
    let reads = 0;
    const inherited = { get branch() { reads++; return { value: "inherited" }; } };
    const source = Object.create(inherited) as Record<string, unknown>;
    source.own = { value: "kept" };
    expect(getNestedValue(source, "branch.value")).toBeUndefined();
    expect(getNestedValue(source, "toString")).toBeUndefined();
    expect(getNestedValue(source, "own.value")).toBe("kept");
    expect(reads).toBe(0);
  });

  it("updates ordinary form and reset paths without mutating input", () => {
    const source = { memory: { enabled: false }, auxiliary: { model: "before" } };
    const next = setNestedValue(source, "memory.enabled", true);
    expect(getNestedValue(next, "memory.enabled")).toBe(true);
    expect(source.memory.enabled).toBe(false);
    expect(next.auxiliary).toEqual({ model: "before" });
    expect(next).not.toBe(source);
    const defaults = { memory: { enabled: false } };
    const reset = setNestedValue(next, "memory.enabled", getNestedValue(defaults, "memory.enabled"));
    expect(reset).toEqual(source);
    expect(next.memory).toEqual({ enabled: true });
  });

  it("preserves indexed arrays and their untouched entries", () => {
    const source = { items: [{ enabled: false }, { enabled: true }] };
    const next = setNestedValue(source, "items.0.enabled", true);
    expect(Array.isArray(next.items)).toBe(true);
    expect(getNestedValue(next, "items.0.enabled")).toBe(true);
    expect(getNestedValue(next, "items.1.enabled")).toBe(true);
    expect(source.items[0].enabled).toBe(false);
  });

  it("creates missing ordinary containers and replaces scalar containers", () => {
    expect(setNestedValue({}, "agent.model.name", "local")).toEqual({ agent: { model: { name: "local" } } });
    expect(setNestedValue({ agent: null }, "agent.model", "local")).toEqual({ agent: { model: "local" } });
    expect(setNestedValue({ agent: 2 }, "agent.model", "local")).toEqual({ agent: { model: "local" } });
    expect(getNestedValue({ agent: 2 }, "agent.model")).toBeUndefined();
  });

  it("can create a harmless own property shadowing an inherited ordinary name", () => {
    const next = setNestedValue({}, "toString.label", "local");
    expect(Object.hasOwn(next, "toString")).toBe(true);
    expect(getNestedValue(next, "toString.label")).toBe("local");
    expect(Object.hasOwn(Object.prototype.toString, "label")).toBe(false);
  });

  it("retains existing empty ordinary segment behavior", () => {
    expect(setNestedValue({}, "custom..value", 3)).toEqual({ custom: { "": { value: 3 } } });
    expect(getNestedValue({ custom: { "": { value: 3 } } }, "custom..value")).toBe(3);
  });
});