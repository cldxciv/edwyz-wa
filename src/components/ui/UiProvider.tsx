"use client";

import type { ReactNode } from "react";
import { ConfirmProvider } from "./ConfirmDialog";
import { ToastProvider } from "./Toast";

/** Mount once in the app layout. Toasts and confirm dialogs also work without it, but this keeps them inside the React tree. */
export function UiProvider({ children }: { children?: ReactNode }) {
  return (
    <ToastProvider>
      <ConfirmProvider>{children}</ConfirmProvider>
    </ToastProvider>
  );
}
