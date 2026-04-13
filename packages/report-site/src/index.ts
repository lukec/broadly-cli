import type { ReportBundle } from "@broadly/report-model";

export function renderPlaceholderReportHtml(report: ReportBundle): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(report.projectName)}</title>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(report.projectName)}</h1>
      <p>Primary perspective: ${escapeHtml(report.primaryPerspectiveId)}</p>
      <p>This is a placeholder report renderer for Phase 0.</p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
