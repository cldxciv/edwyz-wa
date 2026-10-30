"use client";

import type { ReactNode } from "react";
import { Button, ErrorState, Skeleton } from "@/components/ui";
import { useMyRole } from "./useMyRole";

/**
 * Shows its children to owners and admins only. While the role loads it shows a skeleton, and when the request fails it
 * offers Try again, so a short outage is never reported as "you do not have permission".
 */
export function RoleGate({ loadingLabel, skeletonClass = "h-64", denied, children }: { loadingLabel: string; skeletonClass?: string; denied: ReactNode; children: ReactNode }) {
  const { role, error, retry } = useMyRole();
  if (error) {
    return <ErrorState title="We could not check your access" message="Check your connection and try again." action={<Button onClick={retry}>Try again</Button>} />;
  }
  if (role === null) {
    return (
      <div aria-busy="true" className="space-y-4">
        <Skeleton className={`${skeletonClass} w-full`} />
        <span role="status" className="sr-only">
          {loadingLabel}
        </span>
      </div>
    );
  }
  return <>{role === "owner" || role === "admin" ? children : denied}</>;
}
