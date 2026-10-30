import { Skeleton, SkeletonGroup } from "@/components/setup/Skeleton";

/** Same shape as the loaded dashboard so nothing jumps when the data arrives. */
export function DashboardSkeleton() {
  return (
    <SkeletonGroup label="Loading your dashboard" className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-36" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-5">
        <Skeleton className="h-56 lg:col-span-3" />
        <Skeleton className="h-56 lg:col-span-2" />
      </div>
    </SkeletonGroup>
  );
}
