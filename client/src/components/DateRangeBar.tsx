import { CalendarDays, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { DATE_PRESETS, type DateRangeState } from "@/hooks/useDateRange";

/**
 * Preset pills and a calendar range, shared by every list screen that filters
 * by date. Three pages carried their own copy, which is how one of them came to
 * have no presets at all while the others did.
 */
export function DateRangeBar({ range }: { range: DateRangeState }) {
  const defaultLabel = DATE_PRESETS.find((p) => p.key === range.defaultPreset)?.label ?? "default";
  return (
    <>
      <div className="flex items-center gap-1 rounded-lg border bg-muted/30 p-1">
        {DATE_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => range.applyPreset(p.key)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              range.activePreset === p.key
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 bg-muted/40 border rounded-lg px-3 py-2">
        <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            aria-label="From date"
            value={range.dateFrom}
            max={range.dateTo || undefined}
            onChange={(e) => range.setDateFrom(e.target.value)}
            className="h-7 w-36 text-xs border-0 bg-transparent p-0 focus-visible:ring-0"
          />
          <span className="text-xs text-muted-foreground">→</span>
          <Input
            type="date"
            aria-label="To date"
            value={range.dateTo}
            min={range.dateFrom || undefined}
            onChange={(e) => range.setDateTo(e.target.value)}
            className="h-7 w-36 text-xs border-0 bg-transparent p-0 focus-visible:ring-0"
          />
        </div>
        {range.isDefault ? null : (
          <button
            type="button"
            onClick={range.resetToDefault}
            className="ml-1 text-muted-foreground hover:text-foreground"
            title={`Reset to ${defaultLabel.toLowerCase()}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </>
  );
}
