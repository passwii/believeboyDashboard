"use client";

import * as React from "react";

import { Combobox, type ComboboxOption } from "@/components/ui/combobox";

const API_BASE = "/api/backend";

interface ShipmentBatchComboboxProps {
  value: string;
  onChange: (value: string) => void;
  projectId: string;
  country: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
}

export function ShipmentBatchCombobox({
  value,
  onChange,
  projectId,
  country,
  placeholder = "选择或输入发货批次",
  disabled = false,
  className,
  testId,
}: ShipmentBatchComboboxProps) {
  const [batches, setBatches] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(false);

  const fetchKey = `${projectId}::${country}`;

  React.useEffect(() => {
    let cancelled = false;
    if (!projectId || !country) {
      setBatches([]);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    const params = new URLSearchParams({
      project_id: projectId,
      country,
    });
    fetch(`${API_BASE}/api/v1/shipment-schedules/batches?${params.toString()}`, {
      credentials: "include",
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: { batches?: string[] }) => {
        if (cancelled) return;
        setBatches(Array.isArray(data.batches) ? data.batches : []);
      })
      .catch(() => {
        if (cancelled) return;
        setBatches([]);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchKey]);

  const options = React.useMemo<ComboboxOption[]>(
    () =>
      batches.map((batch) => ({
        value: batch,
        label: batch,
      })),
    [batches],
  );

  const isDisabled = disabled || !projectId || !country;

  return (
    <Combobox
      value={value}
      onChange={onChange}
      options={options}
      placeholder={placeholder}
      emptyText={
        loading
          ? "加载中…"
          : !projectId
            ? "请先选择项目"
            : !country
              ? "请先选择国家"
              : "暂无历史批次，可直接输入新批次"
      }
      searchPlaceholder="搜索或输入新批次…"
      allowFreeInput
      disabled={isDisabled}
      className={className}
      triggerClassName={className}
      testId={testId}
    />
  );
}
