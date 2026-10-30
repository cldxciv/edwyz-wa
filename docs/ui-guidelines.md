# Edwyz WA UI guidelines

Goal: a product that feels fast and obvious. Plain words, few choices per screen, nothing that needs a manual. Everything below is implemented in `src/components/ui.tsx` (entry point), `src/components/ui/*` and `src/app/globals.css` (tokens). Import from `@/components/ui` only.

## 1. Tokens

All colour, radius, shadow, motion and layering come from CSS variables in `src/app/globals.css`, exposed to Tailwind as utilities. Never hard-code hex values or Tailwind palette colours (`red-700`, `emerald-50`) in new code; the palette classes still work in dark mode only because globals.css remaps the shades the app used before.

| Purpose | Tailwind utilities |
|---|---|
| Page and text | `bg-background`, `text-foreground`, `text-muted` (secondary text, AA on every surface) |
| Surfaces | `bg-surface` (quiet panel), `bg-surface-2` (hover, sunken, track), `bg-raised` (cards, popovers, inputs) |
| Borders | `border-border` (separators), `border-border-strong` (controls: inputs, secondary buttons; 3:1 against the page) |
| Brand | `bg-accent text-on-accent` (fills), `hover:bg-accent-strong`, `text-accent-ink` (accent as text), `bg-accent-soft` |
| Danger button | `bg-danger text-on-accent hover:bg-danger-strong` |
| Status tones | `bg-{good,warn,bad,info}-soft text-{tone}-fg border-{tone}-line` for pills and notices, `bg-{tone}` for fills such as progress bars |
| Focus | `--ring`; applied globally to every `:focus-visible` element. Do not remove outlines. |
| Radius | `rounded-control` (inputs, 8 px), `rounded-pop` (menus, toasts, 12 px), `rounded-card` (cards, dialogs, 16 px), `rounded-full` (buttons, pills) |
| Shadow | `shadow-raised` (cards, inputs), `shadow-pop` (menus, toasts, tooltips), `shadow-modal` (dialogs) |
| Motion | `duration-(--dur-fast)` 120 ms, `--dur-base` 200 ms, `--dur-slow` 320 ms, `ease-(--ease-out)` |
| Layering | `z-(--z-sticky)` 10, `--z-dropdown` 20, `--z-overlay` 40, `--z-modal` 50, `--z-popover` 60, `--z-toast` 70, `--z-tooltip` 80. Never use raw `z-[999]`. |
| Spacing | Tailwind's 4 px scale. Page padding 16 px on phones, 32 px on desktop. Gap between form fields 16 px. Control heights: 32 / 40 / 44 px. |

Themes. `<html data-theme="light|dark">` (set by `src/components/app/theme.ts`, saved as `wa-theme`) forces a theme; without the attribute the OS setting (`prefers-color-scheme`) applies. Do not write `dark:` variants: use tokens and the page follows. `tests/ui-system-tokens.test.ts` fails the build if any text pairing drops under 4.5:1, any control or focus colour under 3:1, or the two dark blocks drift apart. If you add a token, add its pairing to that test.

Motion. Animations and transitions collapse under `prefers-reduced-motion` (see globals.css); spinners switch to a slow pulse instead of rotating. Do not animate layout properties; fade and translate only. Nothing should flash more than three times a second.

## 2. Components

All exports come from `@/components/ui`.

| Component | Use it for |
|---|---|
| `Button` | `variant`: primary (one per view), secondary, danger, ghost. `size`: sm, md, lg. `loading` shows a spinner, disables and sets `aria-busy`. |
| `Input`, `Textarea`, `Select` | Styled controls. `aria-invalid` turns the border red. Always give them a label. |
| `Field` / `FormField` | Label, hint, error, required and optional markers. `FormField` generates the id and wires `aria-describedby`, `aria-invalid`, `aria-required` into its single child. `Field` does the same when the control has `id={htmlFor}`. |
| `Card` | Container. Optional `title`, `description`, `actions`, `footer`; `padded={false}` for tables. |
| `Stat` | One headline number with a label, optional `delta` (`direction` and `good` decide the arrow and colour) and `loading`. |
| `Badge`, `StatusPill` | `Badge` for free-form tags (`tone`: neutral, good, warn, bad, info). `StatusPill status="in_progress"` for any record status: it picks the tone and the label from one map. |
| `ProgressBar` | Determinate (`value`, `max`) or indeterminate. `tone="auto"` goes amber at 70 percent and red at 90 for quotas. `label` is required for screen readers. |
| `Alert` | Inline notice in a page or form. Use `tone="bad"` for errors (announced immediately). |
| `EmptyState`, `ErrorState` | Nothing to show yet, or the request failed. See section 4. |
| `Spinner`, `Skeleton`, `SkeletonText` | Loading. Skeletons for page and table content, spinners for short actions. |
| `DataTable` | Lists of records. See below. |
| `Tabs` | Switching views of the same record. Arrow keys, Home and End move between tabs. |
| `Dialog` | Modal: portal, focus trap, Escape, focus restore, scroll lock, bottom sheet on phones. Pass `footer` for the action row. |
| `useConfirm()` / `ConfirmDialog` | `const ok = await confirm({ title, body, confirmLabel, tone: "danger" })`. |
| `useToast()` | `toast.success("Template submitted")`, `toast.error(...)`, `toast.promise(p, { loading, success, error })`. |
| `Tooltip` | Hint for icon-only buttons and truncated text. Never essential information. |
| `CopyButton` | Copy a value (keys, links, IDs). Announces "Copied". |
| `KeyboardKey` (`Kbd`) | Show shortcuts: `<KeyboardKey keys={["Ctrl", "K"]} />`. |
| `PageHeader` | Page title, one-sentence description, actions on the right. |
| `statusTone`, `statusLabel`, `sortRows`, `nextSort`, `meterTone` | Pure helpers behind the components. |

Mounting. `toast` and `confirm` work from any client component with no setup (they create their own host on first use). To keep them inside the React tree, render `<UiProvider>` once in the app layout.

`DataTable` rules:
- Give every column a `header`; add `accessor` (and `sortable`) when sorting makes sense; add `cell` for custom content.
- Mark one column `primary`: on phones (under 640 px) each row becomes a card, the primary column is its title and every other cell shows its header as a label.
- `caption` names the table for screen readers.
- Server-side sorting: pass `sort` and `onSortChange`; rows are shown in the order you give.
- `loading` shows skeleton rows, `empty` renders when there are no rows, `stickyHeader` keeps the header visible inside `maxHeight`, `onRowClick` makes rows keyboard-activatable (put a real link in the first cell when the row navigates).
- Put row actions in the last column with `srOnlyHeader`.

## 3. Status colours

One map, `STATUS_TONE` in `src/components/ui/status.ts`. Do not write local `tone()` helpers.

- good (green): active, applied, approved, completed, connected, delivered, live, paid, published, qualified, read, resolved, sent, solved, won
- info (blue): contacted, in progress, new, open, processing, publishing, queued, running, scheduled, sending, started, trialing
- warn (amber): expiring, partial, past due, paused, pending, proposed, retry, snoozed, unconfigured
- bad (red): blocked, disconnected, error, expired, failed, locked, lost, opted out, rejected, revoked, suspended, unpaid
- neutral (grey): archived, canceled, closed, disabled, draft, inactive, not started, reverted, stopped, unknown

Meaning, not decoration: green = done or healthy, blue = moving or waiting on the system, amber = a human should look soon, red = something failed or is blocked, grey = inactive. Unknown statuses render grey with a sentence-case label, never snake_case. Colour is never the only signal: the pill always carries its text. To add a status, add one line to the map and a case to `tests/ui-system.test.ts`.

## 4. Writing

Tone: plain, calm, specific. Write for a shop owner, not an engineer.

- Sentence case everywhere (titles, buttons, tabs, table headers). Proper nouns keep their capitals (WhatsApp, Meta).
- Buttons start with a verb and name the object: "Add contact", "Send broadcast", "Delete template". Never "OK", "Submit", "Yes". The confirm button of a dialog repeats the action; the cancel button says "Cancel".
- One primary button per view. Destructive actions are secondary until confirmed, then `tone: "danger"`.
- Say what happened and what to do next. Avoid "Oops", exclamation marks, jargon (payload, webhook, token) unless the audience is a developer page.
- Numbers and dates: use the user's locale for display; never invent prices, rates or limits that are not configured. Show "Not set" instead.
- Do not use emojis or decorative symbols in copy.

Empty states have three parts: a title that says what is missing ("No contacts yet"), one sentence of why or what it unlocks ("Add people you can message. Marketing messages go only to contacts who opted in."), and one action ("Add contact"). Filtered-empty states say what was filtered: "No contacts match 'priya'" with a "Clear search" action.

Error messages: what went wrong in human words, then the fix. "We could not save the template. Check your connection and try again." Inline field errors say how to correct the value ("Enter a number with country code, like +91 98765 43210"), appear under the field, and are linked to it. Never show raw server errors, stack traces, IDs, tokens or message content. Page-level load failures use `ErrorState` with a "Try again" action. Results of an action (saved, sent, failed) use toasts; problems the user must fix before continuing stay inline as `Alert` or field errors.

Loading: use `Skeleton` or `DataTable loading` for first load, keep old content visible while refreshing, show `Button loading` while saving. Under 300 ms show nothing extra.

Confirmations: ask only for destructive or irreversible actions (delete, send to many people, disconnect). Name the thing and the consequence: "Delete 'Order update'? Broadcasts that use it will stop sending." Prefer undo (a toast with an action) over confirm for reversible actions.

## 5. Accessibility rules

- Every control has a visible label or `aria-label`. Icon-only buttons need `aria-label` and a `Tooltip`.
- Everything works with the keyboard alone, in a logical order. Never remove focus outlines; the global ring meets 3:1 in both themes. Never use positive `tabindex`.
- Contrast: text 4.5:1, large text and control borders 3:1. Use tokens and the contrast test guards them.
- Do not rely on colour: pair it with text, icons or position. Required fields have an asterisk and `aria-required`; errors have text.
- Dialogs: use `Dialog` / `ConfirmDialog` (focus trapped, Escape closes, focus returns to the trigger). Do not build ad-hoc modals.
- Live updates: toasts use polite live regions, errors assertive. Spinners use `role="status"`. Tell screen readers when a list finishes loading (`DataTable` does).
- Tables use real `<table>` semantics with a caption and `scope`d headers; sort state is in `aria-sort`.
- Targets are at least 32 px high (buttons `sm`), 40 px by default, 44 px for primary mobile actions.
- Layouts work at 360 px wide, with no horizontal page scroll. Wide tables scroll inside their container or use the card layout.
- Respect `prefers-reduced-motion` and `prefers-color-scheme`. Never autoplay motion that cannot be paused. Toasts pause on hover and focus and stay for at least 4 seconds; anything with an action stays until dismissed.
- Language and headings: one `h1` per page (`PageHeader`), headings in order, link text that makes sense out of context ("View broadcast", not "Click here").
- Forced-colours mode: do not depend on background colours alone to draw boundaries; keep borders on interactive elements.

## 6. Adopting the system in a module

1. Replace local `tone()` helpers and hand-written badges with `StatusPill`.
2. Replace `window.confirm` and ad-hoc modals with `useConfirm()` and `Dialog`.
3. Replace inline success and error `<p>` messages after actions with `toast`.
4. Replace hand-written tables with `DataTable`; replace spinner-only loading with `Skeleton`.
5. Wrap form controls in `FormField` and pass `error` instead of rendering your own message.
6. Remove hard-coded palette classes in favour of tokens when you touch the line anyway.
