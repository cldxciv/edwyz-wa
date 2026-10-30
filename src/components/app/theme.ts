"use client";

import { useSyncExternalStore } from "react";
import { readStored, writeStored } from "./storage";
import { resolveTheme, THEME_KEY, type Theme } from "./theme-core";

const EVENT = "wa:theme";

function currentTheme(): Theme {
  const attr = document.documentElement.dataset.theme;
  if (attr === "light" || attr === "dark") return attr;
  return resolveTheme(readStored(THEME_KEY), window.matchMedia("(prefers-color-scheme: dark)").matches);
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  writeStored(THEME_KEY, theme);
  window.dispatchEvent(new Event(EVENT));
}

export const toggleTheme = () => setTheme(currentTheme() === "dark" ? "light" : "dark");

function subscribe(onChange: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  media.addEventListener("change", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
    media.removeEventListener("change", onChange);
  };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme, () => "light");
}
