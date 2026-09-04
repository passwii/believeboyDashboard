import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { FunnelChart } from "@/components/ui/funnel-chart";

// jsdom 不实现 ResizeObserver，FunnelChart 内部依赖它来测量容器尺寸
// 这里给一个最小桩让首次 measure 不抛错
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("FunnelChart", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("data 为空时返回 null，不挂载任何 svg", () => {
    const { container } = render(<FunnelChart data={[]} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("传入 4 档数据时，container 存在并应用 aspectRatio", () => {
    const data = [
      { label: "A", value: 100 },
      { label: "B", value: 60 },
      { label: "C", value: 30 },
      { label: "D", value: 10 },
    ];
    const { container } = render(<FunnelChart data={data} />);
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    // aspectRatio 通过 style 注入
    expect(root?.getAttribute("style") ?? "").toMatch(/aspect-ratio/i);
  });

  it("orientation='vertical' 时使用竖向 aspect ratio", () => {
    const data = [{ label: "A", value: 100 }];
    const { container } = render(
      <FunnelChart data={data} orientation="vertical" />
    );
    const style = container.firstElementChild?.getAttribute("style") ?? "";
    expect(style).toMatch(/1\s*\/\s*1\.8/);
  });

  it("非空数据时即使容器尚未测量也立即渲染漏斗（SSR 不空白）", () => {
    const data = [
      { label: "A", value: 100 },
      { label: "B", value: 60 },
      { label: "C", value: 30 },
      { label: "D", value: 10 },
    ];
    // ResizeObserverStub 不回写尺寸，模拟 SSR / 首屏未测量场景；
    // 标称尺寸兜底应让漏斗 svg 立即出现，而非空白等测量后再弹出。
    const { container } = render(<FunnelChart data={data} />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("onStageClick 存在时点击某档触发对应 index（BLF-518）", () => {
    const data = [
      { label: "A", value: 100 },
      { label: "B", value: 60 },
      { label: "C", value: 30 },
      { label: "D", value: 10 },
    ];
    const onStageClick = vi.fn();
    const { getAllByRole } = render(<FunnelChart data={data} onStageClick={onStageClick} />);
    // 每档 label overlay 都是一个 button（共 4 个）
    const stageBtns = getAllByRole("button");
    expect(stageBtns).toHaveLength(4);
    expect(stageBtns[3]).toHaveAttribute("title", "查看D阶段明细");
    fireEvent.click(stageBtns[3]);
    expect(onStageClick).toHaveBeenCalledWith(3);
  });

  it("未传 onStageClick 时不渲染 button 角色（纯展示）", () => {
    const data = [{ label: "A", value: 100 }];
    const { queryByRole } = render(<FunnelChart data={data} />);
    expect(queryByRole("button")).toBeNull();
  });

  it("键盘 Enter 触发 onStageClick（可访问性）", () => {
    const data = [{ label: "A", value: 100 }];
    const onStageClick = vi.fn();
    const { getByRole } = render(<FunnelChart data={data} onStageClick={onStageClick} />);
    const btn = getByRole("button");
    fireEvent.keyDown(btn, { key: "Enter" });
    expect(onStageClick).toHaveBeenCalledWith(0);
  });
});