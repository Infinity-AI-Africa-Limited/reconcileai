import type { ReactNode } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";

/**
 * A count that opens the list it counted — or plain content when there is
 * nowhere the viewer may go (`href` null; see useReachableHref).
 */
export function CountLink({
  href,
  title,
  className,
  children,
}: {
  href: string | null;
  /** Says where the click goes, for the tooltip and screen readers. */
  title: string;
  className?: string;
  children: ReactNode;
}) {
  if (!href) return <div className={className}>{children}</div>;
  return (
    <Link
      href={href}
      title={title}
      aria-label={title}
      className={cn(
        "block cursor-pointer rounded-lg transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {children}
    </Link>
  );
}
