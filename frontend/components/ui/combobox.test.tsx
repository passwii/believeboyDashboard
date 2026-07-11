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