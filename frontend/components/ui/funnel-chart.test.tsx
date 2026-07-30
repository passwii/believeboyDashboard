import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
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
});