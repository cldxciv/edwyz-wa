"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Dialog, FormField, ProgressBar, Stat, Textarea, toast, DataTable, type Column } from "@/components/ui";
import {
  type ImportAnalysis,
  type ImportReport,
  MAX_IMPORT_BYTES,
  addChunkReport,
  analyzeImport,
  buildImportChunks,
  emptyReport,
  friendlyError,
  importProgress,
  importSummary,
  sampleCsv,
} from "./helpers";
import { Disclosure } from "./Disclosure";

type Ok = Extract<ImportAnalysis, { ok: true }>;
type Preview = Ok["preview"][number];
type Step = "choose" | "review" | "importing" | "done";
type Outcome = { report: ImportReport; imported: number; total: number; stopped: "user" | "error" | null; message: string };

const previewColumns: Column<Preview>[] = [
  { key: "name", header: "Name", primary: true, cell: (r) => r.name || <span className="text-muted">No name</span> },
  { key: "phone", header: "Phone number", cell: (r) => <span className="whitespace-nowrap">{r.phone}</span> },
  { key: "tags", header: "Tags", cell: (r) => r.tags || <span className="text-muted">None</span> },
  { key: "optIn", header: "Agreed to messages", cell: (r) => (r.optIn ? "Yes" : "No") },
];

const n = (value: number) => value.toLocaleString();

function StepHeading({ headingRef, children }: { headingRef: React.RefObject<HTMLHeadingElement | null>; children: React.ReactNode }) {
  return (
    <h3 ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
      {children}
    </h3>
  );
}

export function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<Step>("choose");
  const [text, setText] = useState("");
  const [analysis, setAnalysis] = useState<Ok | null>(null);
  const [problem, setProblem] = useState("");
  const [fileName, setFileName] = useState("");
  const [consent, setConsent] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [stopping, setStopping] = useState(false);
  const stopRef = useRef<AbortController | null>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef<Step>("choose");

  // Each step has its own heading. Moving focus to it tells keyboard and screen-reader users the step changed,
  // even when the control they were on (file input, footer button) is gone.
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    stepHeading.current?.focus();
  }, [step]);

  function review(csv: string) {
    const result = analyzeImport(csv);
    if (!result.ok) return setProblem(result.problem);
    setProblem("");
    setConsent(false);
    setAnalysis(result);
    setStep("review");
  }

  function downloadSample() {
    const url = URL.createObjectURL(new Blob([sampleCsv()], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "contacts-sample.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) return setProblem("That file is larger than 2 MB. Split it into smaller files and import them one at a time.");
    try {
      const csv = await file.text();
      setText(csv);
      setFileName(file.name);
      review(csv);
    } catch {
      setProblem("We could not read that file. Make sure it is a CSV file and try again.");
    }
  }

  async function run() {
    if (!analysis) return;
    const chunks = buildImportChunks(analysis);
    const controller = new AbortController();
    stopRef.current = controller;
    let report = emptyReport();
    report.skipped = analysis.duplicates;
    report.errors = analysis.rows.filter((r) => r.status === "invalid").map((r) => ({ row: r.row, reason: r.reason ?? "Not a valid phone number" }));
    let imported = 0;
    let stopped: Outcome["stopped"] = null;
    let message = "";
    setProgress({ done: 0, total: analysis.ready });
    setStopping(false);
    setStep("importing");

    for (const chunk of chunks) {
      if (controller.signal.aborted) {
        stopped = "user";
        break;
      }
      try {
        const res = await fetch("/api/contacts/import", { method: "POST", headers: { "content-type": "text/csv" }, body: chunk.csv, credentials: "same-origin" });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((json as { error?: string }).error ?? "");
        report = addChunkReport(report, (json as { report: ImportReport }).report, chunk.rows);
        imported += chunk.rows.length;
        setProgress({ done: imported, total: analysis.ready });
      } catch (err) {
        stopped = "error";
        message = friendlyError(err, "Something went wrong while importing. Check your connection and try again.");
        break;
      }
    }

    stopRef.current = null;
    setOutcome({ report, imported, total: analysis.ready, stopped, message });
    setStep("done");
    if (imported > 0) onDone();
    if (!stopped) toast.success("Import finished", { description: importSummary(report) });
    else if (stopped === "error") toast.error("Import stopped", { description: message });
  }

  const busy = step === "importing";

  let footer: React.ReactNode;
  if (step === "choose") {
    footer = (
      <>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => review(text)} disabled={!text.trim()}>
          Review contacts
        </Button>
      </>
    );
  } else if (step === "review" && analysis) {
    const needsConsent = analysis.optInYes > 0;
    footer = (
      <>
        <Button variant="secondary" onClick={() => setStep("choose")}>
          Back
        </Button>
        <Button onClick={() => void run()} disabled={analysis.ready === 0 || (needsConsent && !consent)}>
          {analysis.ready === 0 ? "Nothing to import" : `Import ${n(analysis.ready)} ${analysis.ready === 1 ? "contact" : "contacts"}`}
        </Button>
      </>
    );
  } else if (step === "importing") {
    footer = (
      <Button
        variant="secondary"
        onClick={() => {
          setStopping(true);
          stopRef.current?.abort();
          stepHeading.current?.focus();
        }}
        disabled={stopping}
      >
        {stopping ? "Stopping after this batch" : "Stop import"}
      </Button>
    );
  } else {
    footer = <Button onClick={onClose}>Done</Button>;
  }

  return (
    <Dialog
      title="Import contacts from a CSV file"
      description={step === "choose" ? "Add many people at once. You will see a summary to check before anything is imported." : undefined}
      onClose={onClose}
      size="lg"
      dismissible={!busy}
      footer={footer}
    >
      {step === "choose" && (
        <div className="space-y-4">
          <StepHeading headingRef={stepHeading}>Choose your file</StepHeading>
          <Alert tone="warn" title="Only include people who agreed to hear from you">
            Mark someone as opted in only if they really agreed to get WhatsApp messages from your business, and you can prove it. People who opted out are never opted in again by an import.
          </Alert>

          <FormField label="CSV file" hint="Up to 10,000 contacts and 2 MB. Export from Excel or Google Sheets as CSV.">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => void onFile(e.target.files?.[0])}
              className="block min-h-10 w-full text-sm file:mr-3 file:min-h-10 file:cursor-pointer file:rounded-full file:border file:border-border-strong file:bg-raised file:px-4 file:py-2 file:text-sm file:font-semibold file:text-foreground hover:file:bg-surface-2"
            />
          </FormField>
          {fileName && !problem && <p className="text-sm text-muted">Selected: {fileName}</p>}

          <Disclosure title="How should the file look?">
            <div className="mt-1 space-y-2 text-muted">
              <p>The first row names the columns. Only phone is required.</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <b className="text-foreground">phone</b>: with country code, like +919876543210
                </li>
                <li>
                  <b className="text-foreground">name</b>: the person&rsquo;s name
                </li>
                <li>
                  <b className="text-foreground">tags</b>: groups, separated by semicolons, like vip;north
                </li>
                <li>
                  <b className="text-foreground">opt_in</b>: yes, true or 1 if they agreed to receive messages
                </li>
                <li>
                  <b className="text-foreground">opt_in_source</b>: where they agreed, like website form
                </li>
              </ul>
              <p>Any other column is saved as extra details on the contact.</p>
              <Button type="button" variant="secondary" size="sm" className="max-sm:min-h-10" onClick={downloadSample}>
                Download sample file
              </Button>
            </div>
          </Disclosure>

          <Disclosure title="Or paste your contacts">
            <FormField label="CSV text">
              <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-xs" spellCheck={false} />
            </FormField>
          </Disclosure>

          {problem && (
            <Alert tone="bad" title="We cannot use this file yet">
              {problem}
            </Alert>
          )}
        </div>
      )}

      {step === "review" && analysis && (
        <div className="space-y-4">
          <StepHeading headingRef={stepHeading}>Check before importing</StepHeading>
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-3">
            <Stat label="Ready to import" value={n(analysis.ready)} />
            <Stat label="Duplicates skipped" value={n(analysis.duplicates)} />
            <Stat label="Need fixing" value={n(analysis.invalid)} />
          </div>

          {analysis.ready === 0 ? (
            <Alert tone="bad" title="There is nothing to import">
              None of the {n(analysis.total)} rows has a usable phone number. Fix the file and choose it again.
            </Alert>
          ) : (
            <Alert tone="good">
              {n(analysis.ready)} of {n(analysis.total)} {analysis.total === 1 ? "row is" : "rows are"} ready. People already in your contacts are updated, not duplicated. Numbers without a country code are treated as Indian (+91).
            </Alert>
          )}

          {analysis.invalid > 0 && (
            <Alert tone="warn" title={`${n(analysis.invalid)} ${analysis.invalid === 1 ? "row needs" : "rows need"} fixing`}>
              <p>These rows will be left out. Fix them in your file and import again if you want them included.</p>
              <ul className="mt-2 max-h-40 divide-y divide-warn-line overflow-y-auto rounded-md border border-warn-line">
                {analysis.rows
                  .filter((r) => r.status === "invalid")
                  .slice(0, 50)
                  .map((r) => (
                    <li key={r.row} className="px-3 py-1.5">
                      Row {r.row}: {r.reason}
                    </li>
                  ))}
              </ul>
              {analysis.invalid > 50 && <p className="mt-1 text-xs">Showing the first 50.</p>}
            </Alert>
          )}

          {analysis.ready > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Preview of the first {analysis.preview.length}</h3>
              <DataTable caption="Preview of contacts to import" columns={previewColumns} rows={analysis.preview} rowKey={(r) => String(r.row)} />
            </div>
          )}

          {analysis.extraColumns.length > 0 && (
            <p className="text-sm text-muted">Extra columns saved as details on each contact: {analysis.extraColumns.join(", ")}.</p>
          )}

          {analysis.optInYes > 0 && (
            <label className="flex min-h-10 items-start gap-3 rounded-lg border border-border-strong p-3 text-sm">
              <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-(--accent)" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>
                I confirm that the {n(analysis.optInYes)} {analysis.optInYes === 1 ? "person" : "people"} marked as opted in agreed to receive WhatsApp messages from my business.
              </span>
            </label>
          )}
        </div>
      )}

      {step === "importing" && (
        <div className="space-y-3 py-2">
          <StepHeading headingRef={stepHeading}>{stopping ? "Stopping after this batch" : "Importing your contacts"}</StepHeading>
          <ProgressBar label="Import progress" showLabel showValue value={progress.done} max={Math.max(progress.total, 1)} valueText={`${importProgress(progress.done, progress.total)}%`} />
          <p role="status" aria-live="polite" className="text-sm text-muted">
            Importing {n(progress.done)} of {n(progress.total)} contacts. Keep this window open until it finishes.
          </p>
        </div>
      )}

      {step === "done" && outcome && (
        <div className="space-y-4">
          <StepHeading headingRef={stepHeading}>Import results</StepHeading>
          {outcome.stopped === "user" && (
            <Alert tone="warn" title="Import stopped">
              {n(outcome.imported)} of {n(outcome.total)} contacts were imported before you stopped. Import the file again to add the rest; people already added will not be duplicated.
            </Alert>
          )}
          {outcome.stopped === "error" && (
            <Alert tone="bad" title="Import stopped early">
              {outcome.message} {n(outcome.imported)} of {n(outcome.total)} contacts were imported. Fix the problem and import the file again; people already added will not be duplicated.
            </Alert>
          )}
          {!outcome.stopped && (
            <Alert tone="good" title="Import finished">
              {importSummary(outcome.report)}
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-3 min-[520px]:grid-cols-4">
            <Stat label="Added" value={n(outcome.report.created)} />
            <Stat label="Updated" value={n(outcome.report.updated)} />
            <Stat label="Duplicates skipped" value={n(outcome.report.skipped)} />
            <Stat label="Left out" value={n(outcome.report.errors.length)} />
          </div>
          {outcome.report.errors.length > 0 && (
            <Disclosure title={`Rows that were left out (${n(outcome.report.errors.length)})`}>
              <ul className="max-h-48 divide-y divide-border overflow-y-auto">
                {outcome.report.errors.slice(0, 200).map((er) => (
                  <li key={er.row} className="py-1.5">
                    Row {er.row}: {er.reason}
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
        </div>
      )}
    </Dialog>
  );
}
