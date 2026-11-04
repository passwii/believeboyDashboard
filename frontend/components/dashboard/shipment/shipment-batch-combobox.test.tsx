import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ShipmentBatchCombobox } from "@/components/dashboard/shipment/shipment-batch-combobox";
import { NotificationsProvider } from "@/components/notifications";

const fetchMock = vi.fn();

function renderWithProviders(ui: React.ReactElement) {
  return render(<NotificationsProvider>{ui}</NotificationsProvider>);
}

beforeEach(() => {
  fetchMock.mockReset();
  // @ts-expect-error - global fetch mock
  global.fetch = fetchMock;
});

describe("ShipmentBatchCombobox", () => {
  it("拉取列表后渲染 ✕ 按钮，点击调 DELETE 端点 + 本地移除", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ batches: ["BATCH-OLD", "BATCH-NEW"] }),
    });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204 });

    const onChange = vi.fn();
    renderWithProviders(
      <ShipmentBatchCombobox
        value=""
        onChange={onChange}
        projectId="1"
        country="US"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await screen.findByRole("option", { name: "BATCH-OLD", exact: true });

    await user.click(screen.getByRole("button", { name: /隐藏 BATCH-OLD/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/shipment-schedules/batches/hidden"),
        expect.objectContaining({ method: "DELETE" }),
      );
    });
    expect(
      screen.queryByRole("option", { name: "BATCH-OLD", exact: true }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "BATCH-NEW", exact: true }),
    ).toBeInTheDocument();
  });

  it("新输入 value 立即出现在 options 第一位", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ batches: ["BATCH-OLD"] }),
    });

    const onChange = vi.fn();
    renderWithProviders(
      <ShipmentBatchCombobox
        value=""
        onChange={onChange}
        projectId="1"
        country="US"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await screen.findByRole("option", { name: "BATCH-OLD", exact: true });

    const input = screen.getByPlaceholderText("搜索或输入新批次…");
    input.focus();
    await user.keyboard("BATCH-NEWLY-TYPED");
    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith("BATCH-NEWLY-TYPED");

    await user.click(screen.getByRole("combobox"));
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("BATCH-NEWLY-TYPED");
  });
});