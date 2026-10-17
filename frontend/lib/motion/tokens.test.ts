import { describe, it, expect } from "vitest";
import {
  BLUR,
  DISTANCE,
  DURATION,
  EASE,
  SCALE,
  SPRING,
  STAGGER,
  isReducedMotionDefault,
} from "./tokens";

describe("motion tokens", () => {
  it("DURATION mirrors the transitions.dev duration scale (ms ÷ 1000)", () => {
    expect(DURATION.stagger).toBe(0.04);
    expect(DURATION.micro).toBe(0.08);
    expect(DURATION.quick).toBe(0.15);
    expect(DURATION.fast).toBe(0.25);
    expect(DURATION.medium).toBe(0.35);
    expect(DURATION.slow).toBe(0.4);
    expect(DURATION.verySlow).toBe(0.5);
  });

  it("EASE exposes the transitions.dev easing set", () => {
    expect(EASE.smoothOut).toEqual([0.22, 1, 0.36, 1]);
    expect(EASE.bounce).toEqual([0.34, 1.36, 0.64, 1]);
    expect(EASE.bounceStrong).toEqual([0.34, 3.85, 0.64, 1]);
    expect(EASE.inOut).toBe("ease-in-out");
    expect(EASE.out).toBe("ease-out");
    expect(EASE.linear).toBe("linear");
  });

  it("DISTANCE / SCALE / BLUR expose the geometry scales", () => {
    expect(DISTANCE).toEqual({ micro: 4, small: 6, base: 8, medium: 12, large: 30 });
    expect(SCALE).toEqual({ large: 0.96, medium: 0.97, small: 0.98, tiny: 0.99 });
    expect(BLUR).toEqual({ small: 2, medium: 3, large: 8 });
  });

  it("motion token groups expose active keys only", () => {
    expect(Object.keys(DURATION)).toEqual([
      "stagger",
      "micro",
      "quick",
      "fast",
      "medium",
      "slow",
      "verySlow",
    ]);
    expect(Object.keys(EASE)).toEqual([
      "smoothOut",
      "inOut",
      "out",
      "linear",
      "bounce",
      "bounceStrong",
    ]);
    expect(Object.keys(SPRING)).toEqual(["page"]);
    expect(Object.keys(STAGGER)).toEqual(["step"]);
  });

  it("SPRING uses Apple-tuned spring for page transition", () => {
    expect(SPRING.page.stiffness).toBe(260);
    expect(SPRING.page.damping).toBe(30);
    expect(SPRING.page.mass).toBe(1);
  });

  it("STAGGER step is the single stagger档, mirroring --duration-stagger", () => {
    expect(STAGGER.step).toBe(0.04);
    expect(DURATION.stagger).toBe(STAGGER.step);
  });

  it("isReducedMotionDefault is false (caller must read media query)", () => {
    expect(isReducedMotionDefault).toBe(false);
  });
});
