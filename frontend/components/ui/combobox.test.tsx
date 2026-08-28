import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Combobox } from "@/components/ui/combobox";

const baseOptions = [
  { value: "A", label: "A" },
  { value: "B", label: "B" },
];

describe("Combobox onHide", () => {
  it("不传 onHide 时不渲染隐藏按钮", async () => {
    const user = userEvent.setup();
    render(<Combobox value="" onChange={() => {}} options={baseOptions} />);
    await user.click(screen.getByRole("combobox"));
    expect(screen.queryByRole("button", { name: /隐藏/ })).toBeNull();
  });

  it("传 onHide 时点 ✕ 只触发 onHide 不触发 onChange", async () => {
    const user = userEvent.setup();
    const onHide = vi.fn();
    const onChange = vi.fn();
    const options = [
      { value: "A", label: "A", onHide },
      { value: "B", label: "B" },
    ];
    render(<Combobox value="" onChange={onChange} options={options} />);
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("button", { name: /隐藏 A/ }));
    expect(onHide).toHaveBeenCalledWith("A");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Combobox 暗黑聚焦辉光（BLF-574）", () => {
  it("触发器带 u-focus-glow（暗黑聚焦态蓝辉光钩子）", () => {
    render(<Combobox value="" onChange={() => {}} options={baseOptions} />);
    const trigger = screen.getByRole("combobox");
    expect(trigger.className).toMatch(/\bu-focus-glow\b/);
  });
});

describe("Combobox Terminal 收口（BLF-870）", () => {
  it("触发器为 h-8 零圆角 + term 令牌（无 h-10/rounded-md/border-input/shadow）", () => {
    render(<Combobox value="" onChange={() => {}} options={baseOptions} />);
    const trigger = screen.getByRole("combobox");
    expect(trigger.className).toContain("h-8");
    expect(trigger.className).toContain("rounded-none");
    expect(trigger.className).toContain("border-term-border");
    expect(trigger.className).toContain("bg-term-bg");
    expect(trigger.className).toContain("font-mono");
    expect(trigger.className).toContain("shadow-none");
    expect(trigger.className).not.toContain("h-10");
    expect(trigger.className).not.toContain("rounded-md");
    expect(trigger.className).not.toContain("border-input");
  });
});
