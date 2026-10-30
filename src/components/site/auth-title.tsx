export function AuthTitle({ title, intro }: { title: string; intro?: string }) {
  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
      {intro && <p className="mt-3 leading-relaxed text-muted">{intro}</p>}
    </div>
  );
}

export function AuthNotice({ tone = "status", children }: { tone?: "status" | "alert"; children: React.ReactNode }) {
  return (
    <div role={tone} className={`mt-6 rounded-xl border p-4 text-sm leading-relaxed ${tone === "alert" ? "pub-bad border-current" : "border-border bg-surface"}`}>
      {children}
    </div>
  );
}

export const textLink = "pub-ink font-medium underline underline-offset-2";
