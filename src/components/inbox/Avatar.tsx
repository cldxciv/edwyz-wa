import { cn } from "@/components/ui";
import { avatarColor, initials } from "./ux";

export function Avatar({ id, name, phone, size = "md", title }: { id: string; name: string | null; phone?: string | null; size?: "sm" | "md" | "lg"; title?: string }) {
  const dims = size === "sm" ? "h-6 w-6 text-[10px]" : size === "lg" ? "h-12 w-12 text-base" : "h-10 w-10 text-sm";
  return (
    <span
      aria-hidden
      title={title}
      style={avatarColor(id)}
      className={cn("inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold", dims)}
    >
      {initials(name, phone ?? "")}
    </span>
  );
}

const PATHS = {
  check: "M5 13l4 4L19 7",
  userPlus: "M15 19a4 4 0 00-8 0M11 11a3 3 0 100-6 3 3 0 000 6zM19 8v6M16 11h6",
  paperclip: "M21 11l-9 9a5 5 0 01-7-7l9-9a3.5 3.5 0 015 5l-9 9a2 2 0 01-3-3l8-8",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16z",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z",
  template: "M7 3h8l4 4v14H7V3zM15 3v4h4M10 12h6M10 16h6",
  back: "M15 5l-7 7 7 7",
  panel: "M4 5h16v14H4V5zM15 5v14",
  close: "M6 6l12 12M18 6L6 18",
  search: "M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5",
  note: "M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4",
  keyboard: "M3 6h18v12H3V6zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
  retry: "M4 4v6h6M20 20v-6h-6M5.6 15A8 8 0 0019 13M18.4 9A8 8 0 005 11",
  play: "M8 5l11 7-11 7V5z",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3",
  lock: "M6 11h12v9H6v-9zM8 11V8a4 4 0 018 0v3",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3z",
  plus: "M12 5v14M5 12h14",
  bell: "M6 9a6 6 0 0112 0c0 6 2 7 2 7H4s2-1 2-7zM10 20a2 2 0 004 0",
  download: "M12 4v11M7 11l5 5 5-5M5 20h14",
} as const;

export function Icon({ name, className }: { name: keyof typeof PATHS; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={cn("h-4 w-4 shrink-0", className)}>
      <path d={PATHS[name]} />
    </svg>
  );
}

export function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="WhatsApp" className={cn("h-3.5 w-3.5 shrink-0 text-emerald-600", className)} fill="currentColor">
      <path d="M12 2a10 10 0 00-8.6 15.1L2 22l5-1.3A10 10 0 1012 2zm0 18.2a8.2 8.2 0 01-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1112 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 01-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.5l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 00-.7.3 3 3 0 00-.9 2.2c0 1.3.9 2.5 1 2.7.1.2 1.8 2.8 4.4 3.9 1.6.7 2.3.7 3.1.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.2-.3-.2-.5-.3z" />
    </svg>
  );
}
