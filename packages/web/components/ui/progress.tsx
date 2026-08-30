import { cn } from "@/lib/utils";

export function Progress({ value, className }: { value: number; className?: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  const color = clamped >= 95 ? "bg-red-500" : clamped >= 80 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800", className)}>
      <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${clamped}%` }} />
    </div>
  );
}
