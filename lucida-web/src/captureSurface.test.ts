// @vitest-environment happy-dom
//
// The `?render=1` predicate (issue #923). Cheap, but it gates whether a
// headless run writes into a user's workspace, so the exact match matters.

import { describe, it, expect, afterEach } from "vitest";
import { isCaptureSurface } from "./captureSurface.ts";

describe("isCaptureSurface", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("is true for render=1", () => {
    expect(isCaptureSurface("?render=1")).toBe(true);
  });

  it("is true alongside other params, in any order", () => {
    expect(isCaptureSurface("?w=abc&render=1")).toBe(true);
    expect(isCaptureSurface("?render=1&w=abc")).toBe(true);
  });

  it("is false when absent", () => {
    expect(isCaptureSurface("")).toBe(false);
    expect(isCaptureSurface("?w=abc")).toBe(false);
  });

  it("is false for any value other than 1 — no truthiness guessing", () => {
    expect(isCaptureSurface("?render=0")).toBe(false);
    expect(isCaptureSurface("?render=true")).toBe(false);
    expect(isCaptureSurface("?render")).toBe(false);
    expect(isCaptureSurface("?render=")).toBe(false);
  });

  it("reads window.location when no search is passed", () => {
    window.history.replaceState(null, "", "/?render=1");
    expect(isCaptureSurface()).toBe(true);
    window.history.replaceState(null, "", "/");
    expect(isCaptureSurface()).toBe(false);
  });
});
