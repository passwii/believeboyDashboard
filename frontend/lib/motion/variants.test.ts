import { describe, it, expect } from "vitest";
import {
  pageTransitionContainer,
  fadeUp,
  staggerContainer,
  staggerItem,
  pressTap,
} from "./variants";

describe("motion variants", () => {
  it("pageTransitionContainer uses C form: scale + blur + opacity spring", () => {
    const v = pageTransitionContainer();
    expect(v.initial).toMatchObject({ opacity: 0, scale: 0.985, y: 6 });
    expect(v.initial.filter).toBe("blur(8px)");
    expect(v.animate).toMatchObject({ opacity: 1, scale: 1, y: 0 });
    expect(v.animate.filter).toBe("blur(0px)");
    expect(v.exit).toMatchObject({ opacity: 0, scale: 0.99, y: -4 });
    expect(v.exit.filter).toBe("blur(4px)");
  });

  it("pageTransitionContainer transition uses spring from tokens", () => {
    const v = pageTransitionContainer();
    expect((v.transition as { type: string }).type).toBe("spring");
    expect(v.transition).toMatchObject({ stiffness: 260, damping: 30 });
  });

  it("fadeUp is opacity+y with ease out", () => {
    const v = fadeUp();
    expect(v.initial).toEqual({ opacity: 0, y: 10 });
    expect(v.animate).toEqual({ opacity: 1, y: 0 });
    expect(v.transition).toMatchObject({ duration: 0.24 });
  });

  it("staggerContainer uses staggerChildren 0.07", () => {
    expect(staggerContainer().animate.transition).toMatchObject({ staggerChildren: 0.07 });
  });

  it("staggerItem uses fadeUp + ease out", () => {
    const v = staggerItem();
    expect(v.initial).toEqual({ opacity: 0, y: 10 });
    expect(v.animate).toEqual({ opacity: 1, y: 0 });
  });

  it("pressTap scales to 0.97 on tap", () => {
    expect(pressTap().whileTap).toEqual({ scale: 0.97 });
  });
});