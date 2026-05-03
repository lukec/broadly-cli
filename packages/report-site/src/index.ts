import type {
  AttestationManifest,
  ReportBundle,
  StatementBank,
  VoteRoundSummary
} from "@broadly/report-model";

export interface StaticReportRenderOptions {
  statementBank?: StatementBank | null;
  voteSummary?: VoteRoundSummary | null;
  attestation?: AttestationManifest | null;
}

export function renderStaticReportHtml(
  report: ReportBundle,
  options: StaticReportRenderOptions = {}
): string {
  const acceptedStatements =
    options.statementBank?.statements.filter((statement) => statement.moderationStatus === "accepted") ??
    [];

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(report.projectName)}</title>
    <style>
      :root {
        --bg: #f7f8fa;
        --card: #ffffff;
        --ink: #1a1d25;
        --muted: #5d6378;
        --line: #dcdfe7;
        --primary: #145688;
        --accent: #cc7418;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font: 16px/1.55 Inter, system-ui, sans-serif;
        color: var(--ink);
        background: linear-gradient(180deg, #f9fbfd, var(--bg));
      }
      main {
        max-width: 1120px;
        margin: 0 auto;
        padding: 32px 20px 64px;
      }
      .hero, .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 8px;
        box-shadow: 0 10px 24px rgba(0,0,0,0.06);
      }
      .hero {
        padding: 28px;
        margin-bottom: 24px;
      }
      .eyebrow {
        margin: 0 0 8px;
        color: var(--accent);
        font: 700 12px/1.2 ui-monospace, monospace;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      h1, h2, h3 { margin: 0 0 10px; }
      .meta, .lede {
        margin: 0;
        color: var(--muted);
      }
      .grid {
        display: grid;
        gap: 18px;
      }
      .perspectives {
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      }
      .card {
        padding: 22px;
      }
      .question-list, .quote-list {
        margin: 0;
        padding-left: 18px;
      }
      .cluster + .cluster {
        margin-top: 16px;
        padding-top: 16px;
        border-top: 1px solid var(--line);
      }
      blockquote {
        margin: 10px 0 0;
        padding: 12px 14px;
        border-left: 4px solid #b8def3;
        background: #f7fbfe;
        border-radius: 6px;
      }
      .stats {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 16px;
      }
      .stat {
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 8px 10px;
        background: #fafbfc;
        color: var(--muted);
      }
      .section {
        margin-top: 24px;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <p class="eyebrow">Broadly Report</p>
        <h1>${escapeHtml(report.projectName)}</h1>
        <p class="lede">Primary view: ${escapeHtml(report.primaryViewId)}</p>
        <p class="meta">Analysis run ${escapeHtml(report.analysisRunId)} · generated ${escapeHtml(report.createdAt)}</p>
      </section>
      <section class="card" style="margin-bottom: 24px;">
        <p class="eyebrow">Questions</p>
        <h2>What this report is answering</h2>
        <ul class="question-list">
          ${report.questions.map((question) => `<li>${escapeHtml(question)}</li>`).join("")}
        </ul>
      </section>
      <section class="grid perspectives">
        ${report.views
          .map(
            (view) => `<article class="card">
                <p class="eyebrow">${escapeHtml(view.viewId)}</p>
                <h2>${escapeHtml(view.title)}</h2>
                <p class="lede">${escapeHtml(view.summary)}</p>
                <div style="margin-top: 18px;">
                  ${view.clusters
                    .map(
                      (cluster) => `<section class="cluster">
                          <h3>${escapeHtml(cluster.label)}</h3>
                          <p class="meta">${escapeHtml(cluster.summary)}</p>
                          ${cluster.evidenceQuotes
                            .map(
                              (quote) => `<blockquote>${escapeHtml(quote.excerpt)}</blockquote>`
                            )
                            .join("")}
                        </section>`
                    )
                    .join("")}
                </div>
              </article>`
          )
          .join("")}
      </section>
      ${
        acceptedStatements.length === 0
          ? ""
          : `<section class="card section">
              <p class="eyebrow">Statements</p>
              <h2>Accepted Statement Bank</h2>
              ${acceptedStatements
                .map(
                  (statement) => `<section class="cluster">
                    <h3>${escapeHtml(statement.statementText)}</h3>
                    <p class="meta">${escapeHtml(statement.generationRationale)}</p>
                  </section>`
                )
                .join("")}
            </section>`
      }
      ${
        options.voteSummary === null || options.voteSummary === undefined
          ? ""
          : `<section class="card section">
              <p class="eyebrow">Voting Round</p>
              <h2>${escapeHtml(options.voteSummary.voteRoundId)}</h2>
              <div class="stats">
                <span class="stat">${options.voteSummary.participantCount} participant(s)</span>
                <span class="stat">${options.voteSummary.statementCount} statement(s)</span>
                <span class="stat">${options.voteSummary.highConsensusStatementIds.length} high consensus</span>
                <span class="stat">${options.voteSummary.highContentionStatementIds.length} high contention</span>
              </div>
              ${options.voteSummary.statements
                .slice(0, 12)
                .map(
                  (statement) => `<section class="cluster">
                    <h3>${escapeHtml(statement.statementText)}</h3>
                    <p class="meta">${escapeHtml(statement.classification)} · agree ${Math.round(statement.rates.agree * 100)}% · disagree ${Math.round(statement.rates.disagree * 100)}% · pass ${Math.round(statement.rates.pass * 100)}%</p>
                  </section>`
                )
                .join("")}
            </section>`
      }
      ${
        options.attestation === null || options.attestation === undefined
          ? ""
          : `<section class="card section">
              <p class="eyebrow">Attestation</p>
              <h2>${escapeHtml(options.attestation.attestationId)}</h2>
              <p class="meta">${options.attestation.artifacts.length} hashed artifact(s) · code ${escapeHtml(options.attestation.codeVersion)}</p>
            </section>`
      }
    </main>
  </body>
</html>`;
}

export function renderPlaceholderReportHtml(report: ReportBundle): string {
  return renderStaticReportHtml(report);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
