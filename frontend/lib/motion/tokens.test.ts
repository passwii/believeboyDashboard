import { describe, it, expect } from "vitest";
import { DURATION, EASE, SPRING, STAGGER, BEZIER, isReducedMotionDefault } from "./tokens";

describe("motion tokens", () => {
  it("DURATION mirrors CSS motion tokens", () => {
    expect(DURATION.fast).toBe(0.18);
    expect(DURATION.base).toBe(0.24);
    expect(DURATION.slow).toBe(0.32);
    expect(DURATION.springPress).toBe(0.22);
  });

  it("EASE exposes cubic-bezier arrays", () => {
    expect(EASE.out).toEqual([0.22, 1, 0.36, 1]);
    expect(EASE.standard).toEqual([0.16, 1, 0.3, 1]);
  });

  it("motion token groups expose active keys only", () => {
    expect(Object.keys(EASE)).toEqual(["out", "standard"]);
    expect(Object.keys(SPRING)).toEqual(["page"]);
  });

  it("SPRING uses Apple-tuned spring for page transition", () => {
    expect(SPRING.page.stiffness).toBe(260);
    expect(SPRING.page.damping).toBe(30);
    expect(SPRING.page.mass).toBe(1);
  });

  it("STAGGER step mirrors --stagger-step", () => {
    expect(STAGGER.step).toBe(0.07);
  });

  it("BEZIER exposes reveal curves for second-level menu", () => {
    expect(BEZIER.panelReveal).toEqual([0.34, 1.4, 0.64, 1]);
    expect(BEZIER.itemReveal).toEqual([0.22, 1, 0.36, 1]);
    // 过冲曲线：控制点 y>1 才会回弹
    expect(BEZIER.panelReveal[1]).toBeGreaterThan(1);
  });

  it("isReducedMotionDefault is false (caller must read media query)", () => {
    expect(isReducedMotionDefault).toBe(false);
  });
});