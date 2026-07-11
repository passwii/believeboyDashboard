import { describe, it, expect } from "vitest";
import { DURATION, EASE, SPRING, STAGGER, Z, isReducedMotionDefault } from "./tokens";

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

  it("SPRING uses Apple-tuned spring for page transition", () => {
    expect(SPRING.page.stiffness).toBe(260);
    expect(SPRING.page.damping).toBe(30);
    expect(SPRING.page.mass).toBe(1);
  });

  it("STAGGER step mirrors --stagger-step", () => {
    expect(STAGGER.step).toBe(0.07);
  });

  it("Z scale covers nav/overlay/modal/toast/grain", () => {
    expect(Z.nav).toBe(30);
    expect(Z.overlay).toBe(50);
    expect(Z.modal).toBe(60);
    expect(Z.toast).toBe(70);
    expect(Z.grain).toBe(80);
  });

  it("isReducedMotionDefault is false (caller must read media query)", () => {
    expect(isReducedMotionDefault).toBe(false);
  });
});