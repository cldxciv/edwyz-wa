import type { DropdownItem } from "@/components/app/Dropdown";

/** The All projects page. */
export const PROJECTS_HREF = "/app/projects";
/** All projects with the New project form open (the page reads ?new=1). */
export const NEW_PROJECT_HREF = "/app/projects?new=1";

/** What the workspace switcher shows under the list of workspaces: the overview, and starting a new project. */
export function projectMenuItems(): DropdownItem[] {
  return [
    { separator: true },
    { label: "All projects", description: "See every project and how it is doing", icon: "grid", href: PROJECTS_HREF },
    { label: "New project", description: "A new workspace with its own free trial", icon: "plus", href: NEW_PROJECT_HREF },
  ];
}
