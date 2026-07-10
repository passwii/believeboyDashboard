"use client";

import * as React from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

export type ComboboxOption = {
  value: string;
  label: string;
};

interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  emptyText?: string;
  searchPlaceholder?: string;
  allowFreeInput?: boolean;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  testId?: string;
}

export function Combobox({
  value,
  onChange,
  options,
  placeholder = "请选择…",
  emptyText = "未找到匹配项",
  searchPlaceholder = "搜索…",
  allowFreeInput = false,
  disabled = false,
  className,
  triggerClassName,
  testId,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (!open) {
      setQuery("");
    }
  }, [open]);

  const displayLabel = React.useMemo(() => {
    const matched = options.find((opt) => opt.value === value);
    return matched ? matched.label : value;
  }, [options, value]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (opt) =>
        opt.value.toLowerCase().includes(q) ||
        opt.label.toLowerCase().includes(q),
    );
  }, [options, query]);

  const hasExactMatch = options.some(
    (opt) => opt.value === query.trim() && query.trim().length > 0,
  );
  const showFreeInputRow =
    allowFreeInput && query.trim().length > 0 && !hasExactMatch;

  const commitValue = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const handleClear = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onChange("");
    setQuery("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={disabled}
          data-testid={testId}
          onClick={() => {
            if (disabled) return;
            setOpen((prev) => !prev);
          }}
          className={cn(
            "h-10 w-full min-w-0 justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm font-normal text-foreground shadow-sm shadow-black/5",
            "hover:bg-background focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20",
            "data-[placeholder]:text-muted-foreground/70",
            "dark:border-border/95 dark:bg-[hsl(var(--surface-soft)/0.96)]",
            triggerClassName,
          )}
        >
          <span
            className={cn(
              "truncate text-left",
              !value && "text-muted-foreground/70",
            )}
          >
            {value ? displayLabel : placeholder}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {value && !disabled ? (
              <span
                role="button"
                tabIndex={-1}
                onClick={handleClear}
                className="rounded-sm p-0.5 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
                aria-label="清除"
              >
                <X className="h-3.5 w-3.5" />
              </span>
            ) : null}
            <ChevronsUpDown className="h-4 w-4 text-muted-foreground/70" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className={cn(
          "w-[var(--radix-popover-trigger-width)] p-0",
          className,
        )}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
      >
        <Command shouldFilter={false}>
          <CommandInput
            ref={inputRef}
            value={query}
            onValueChange={setQuery}
            placeholder={searchPlaceholder}
          />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {filtered.map((option) => {
                const isSelected = option.value === value;
                return (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    onSelect={() => commitValue(option.value)}
                  >
                    <Check
                      className={cn(
                        "h-4 w-4 shrink-0",
                        isSelected ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="truncate">{option.label}</span>
                  </CommandItem>
                );
              })}
              {showFreeInputRow ? (
                <CommandItem
                  value={`__free__${query.trim()}`}
                  onSelect={() => commitValue(query.trim())}
                  forceMount
                >
                  <Check className="h-4 w-4 shrink-0 opacity-0" />
                  <span className="truncate">
                    使用 &ldquo;{query.trim()}&rdquo;
                  </span>
                </CommandItem>
              ) : null}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
