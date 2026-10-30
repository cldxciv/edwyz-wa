import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormField,
  Input,
  KeyboardKey,
  PageHeader,
  ProgressBar,
  Select,
  Skeleton,
  Spinner,
  Stat,
  StatusPill,
  Tabs,
  Textarea,
  cn,
} from "@/components/ui";

const h = (type: unknown, props?: unknown, ...children: unknown[]) => createElement(type as never, props as never, ...(children as never[]));
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

describe("existing primitives keep their contract", () => {
  it("cn drops falsy parts", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });

  it("Button renders variants and sizes and forwards props", () => {
    const out = html(h(Button, { variant: "danger", size: "sm", type: "button", "aria-label": "Delete" }, "Delete"));
    expect(out).toContain("<button");
    expect(out).toContain('type="button"');
    expect(out).toContain('aria-label="Delete"');
    expect(out).toContain("bg-danger");
    expect(out).not.toContain('aria-busy="');
  });

  it("Button loading disables and marks busy", () => {
    const out = html(h(Button, { loading: true }, "Save"));
    expect(out).toContain("disabled");
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("Save");
  });

  it("Card, Badge, EmptyState, Spinner, PageHeader still render their content", () => {
    expect(html(h(Card, { className: "x" }, "body"))).toContain("body");
    expect(html(h(Badge, { tone: "good" }, "Ok"))).toContain("Ok");
    const empty = html(h(EmptyState, { title: "No contacts", body: "Add one", action: h("a", null, "Go") }));
    expect(empty).toContain("No contacts");
    expect(empty).toContain("Add one");
    expect(empty).toContain("Go");
    expect(html(h(Spinner, { label: "Loading team" }))).toContain('role="status"');
    expect(html(h(Spinner, { label: "Loading team" }))).toContain("Loading team");
    const header = html(h(PageHeader, { title: "Contacts", description: "People", actions: h("button", null, "Add") }));
    expect(header).toContain("<h1");
    expect(header).toContain("Add");
  });

  it("Input, Textarea and Select forward attributes", () => {
    const input = html(h(Input, { id: "a", name: "a", placeholder: "p", className: "extra" }));
    expect(input).toContain('id="a"');
    expect(input).toContain('placeholder="p"');
    expect(input).toMatch(/class="[^"]*extra/);
    expect(html(h(Textarea, { rows: 3 }))).toContain('rows="3"');
    expect(html(h(Select, null, h("option", { value: "1" }, "One")))).toContain("<option");
  });

  it("Card header, description, actions and footer are optional additions", () => {
    const out = html(h(Card, { title: "Plan", description: "Billing", actions: h("button", null, "Edit"), footer: "Footer" }, "Body"));
    expect(out).toContain("<h2");
    expect(out).toContain("Billing");
    expect(out).toContain("Edit");
    expect(out).toContain("Footer");
  });
});

describe("Field wiring", () => {
  it("links hint and error to the control and marks it invalid", () => {
    const out = html(h(Field, { label: "Phone", htmlFor: "phone", hint: "With country code", error: "Enter a valid number", required: true }, h(Input, { id: "phone" })));
    expect(out).toContain('for="phone"');
    expect(out).toContain('aria-describedby="phone-hint phone-error"');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('aria-required="true"');
    expect(out).toContain('id="phone-error"');
    expect(out).toContain('role="alert"');
  });

  it("leaves a control alone when nothing needs wiring", () => {
    const out = html(h(Field, { label: "Name", htmlFor: "name" }, h(Input, { id: "name" })));
    expect(out).not.toContain("aria-describedby");
    expect(out).not.toContain('aria-invalid="');
  });

  it("does not touch a child whose id differs from htmlFor", () => {
    const out = html(h(Field, { label: "Name", htmlFor: "name", hint: "Hint" }, h("div", { id: "other" })));
    expect(out).not.toContain("aria-describedby");
  });

  it("FormField generates an id and wires the control", () => {
    const out = html(h(FormField, { label: "Email", error: "Required", optional: false, required: true }, h(Input, { type: "email" })));
    const id = /<input[^>]*\sid="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`for="${id}"`);
    expect(out).toContain(`aria-describedby="${id}-error"`);
    expect(out).toContain('aria-invalid="true"');
  });

  it("shows an optional marker", () => {
    expect(html(h(FormField, { label: "Notes", optional: true }, h(Textarea)))).toContain("(optional)");
  });
});

describe("status and feedback", () => {
  it("StatusPill uses the shared map and sentence-case label", () => {
    const failed = html(h(StatusPill, { status: "failed" }));
    expect(failed).toContain("Failed");
    expect(failed).toContain("bg-bad-soft");
    const inProgress = html(h(StatusPill, { status: "in_progress" }));
    expect(inProgress).toContain("In progress");
    expect(inProgress).toContain("bg-info-soft");
    expect(html(h(StatusPill, { status: "mystery" }))).toContain("bg-surface");
    expect(html(h(StatusPill, { status: "x", label: "Custom", tone: "good" }))).toContain("Custom");
  });

  it("Alert announces errors assertively and others politely", () => {
    expect(html(h(Alert, { tone: "bad", title: "Failed" }))).toContain('role="alert"');
    expect(html(h(Alert, { tone: "info", title: "Note" }))).toContain('role="status"');
  });

  it("ErrorState and Skeleton render", () => {
    expect(html(h(ErrorState, { message: "Try again" }))).toContain('role="alert"');
    expect(html(h(Skeleton, {}))).toContain('aria-hidden="true"');
  });

  it("Stat shows direction in text, not only colour", () => {
    const out = html(h(Stat, { label: "Replies", value: "42", delta: { value: "8%", direction: "down", good: false } }));
    expect(out).toContain("Down");
    expect(out).toContain("8%");
    expect(out).toContain("text-bad-fg");
  });

  it("KeyboardKey renders kbd elements", () => {
    const out = html(h(KeyboardKey, { keys: ["Ctrl", "K"] }));
    expect(out.match(/<kbd/g)).toHaveLength(2);
    expect(html(h(KeyboardKey, null, "Esc"))).toContain("Esc");
  });
});

describe("ProgressBar", () => {
  it("exposes progressbar semantics", () => {
    const out = html(h(ProgressBar, { value: 45, label: "Messages used", max: 100 }));
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuenow="45"');
    expect(out).toContain('aria-valuemax="100"');
    expect(out).toContain('aria-label="Messages used"');
    expect(out).toContain("width:45%");
  });

  it("auto tone escalates and indeterminate omits the value", () => {
    expect(html(h(ProgressBar, { value: 95, label: "Quota", tone: "auto" }))).toContain("bg-bad");
    expect(html(h(ProgressBar, { value: 75, label: "Quota", tone: "auto" }))).toContain("bg-warn");
    const indeterminate = html(h(ProgressBar, { label: "Working" }));
    expect(indeterminate).not.toContain("aria-valuenow");
    expect(indeterminate).toContain("ui-skeleton");
  });

  it("links the visible label when shown", () => {
    const out = html(h(ProgressBar, { value: 10, label: "Sent", showLabel: true, showValue: true }));
    expect(out).toMatch(/aria-labelledby="[^"]+"/);
    expect(out).toContain("10%");
  });
});

describe("DataTable and Tabs (server render)", () => {
  type Row = { id: string; name: string; n: number };
  const rows: Row[] = [
    { id: "a", name: "Beta", n: 2 },
    { id: "b", name: "Alpha", n: 3 },
  ];
  const columns = [
    { key: "name", header: "Name", accessor: (r: Row) => r.name, sortable: true, primary: true },
    { key: "n", header: "Count", accessor: (r: Row) => r.n, sortable: true, align: "right" as const },
  ];

  it("renders an accessible table with aria-sort and card labels", () => {
    const out = html(h(DataTable<Row>, { columns, rows, rowKey: (r: Row) => r.id, caption: "People", defaultSort: { key: "name", dir: "asc" } }));
    expect(out).toContain("<caption");
    expect(out).toContain('aria-sort="ascending"');
    expect(out).toContain('aria-sort="none"');
    expect(out.indexOf("Alpha")).toBeLessThan(out.indexOf("Beta"));
    expect(out).toContain('data-label="Count"');
    expect(out).toContain("ui-dt-cards");
  });

  it("shows skeleton rows while loading and the empty state when there is nothing", () => {
    const loading = html(h(DataTable<Row>, { columns, rows: [], rowKey: (r: Row) => r.id, caption: "People", loading: true, skeletonRows: 2 }));
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("Loading People");
    const empty = html(h(DataTable<Row>, { columns, rows: [], rowKey: (r: Row) => r.id, caption: "People", empty: h(EmptyState, { title: "No people yet" }) }));
    expect(empty).toContain("No people yet");
  });

  it("applies sticky header and honours controlled sort without reordering", () => {
    const out = html(h(DataTable<Row>, { columns, rows, rowKey: (r: Row) => r.id, caption: "People", stickyHeader: true, sort: { key: "name", dir: "desc" }, onSortChange: () => {} }));
    expect(out).toContain("ui-dt-sticky");
    expect(out.indexOf("Beta")).toBeLessThan(out.indexOf("Alpha"));
    expect(out).toContain('aria-sort="descending"');
  });

  it("Tabs renders a tablist with roving tabindex and a labelled panel", () => {
    const out = html(
      h(Tabs, {
        label: "Sections",
        idPrefix: "t",
        defaultValue: "b",
        tabs: [
          { id: "a", label: "First", content: "A body" },
          { id: "b", label: "Second", content: "B body" },
          { id: "c", label: "Third", disabled: true, content: "C body" },
        ],
      }),
    );
    expect(out).toContain('role="tablist"');
    expect(out).toContain('aria-label="Sections"');
    expect(out).toMatch(/id="t-tab-b"[^>]*aria-selected="true"[^>]*tabindex="0"/);
    expect(out).toMatch(/id="t-tab-a"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
    expect(out).toContain('aria-labelledby="t-tab-b"');
    expect(out).toContain("B body");
    expect(out).not.toContain("A body");
  });
});
