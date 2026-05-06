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
      .report-map-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 320px;
        gap: 18px;
        align-items: stretch;
        margin-top: 16px;
      }
      .report-map-controls {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
        margin-top: 16px;
      }
      .map-view-button,
      .map-toggle {
        border: 1px solid var(--line);
        border-radius: 999px;
        background: #fff;
        color: var(--muted);
        padding: 9px 12px;
        font: 700 12px/1.2 ui-monospace, monospace;
      }
      .map-view-button {
        cursor: pointer;
      }
      .map-view-button.active {
        color: #fff;
        border-color: var(--primary);
        background: var(--primary);
      }
      .map-toggle {
        display: inline-flex;
        gap: 8px;
        align-items: center;
      }
      .report-map-shell {
        min-height: 460px;
        border: 1px solid var(--line);
        border-radius: 8px;
        overflow: hidden;
        background: linear-gradient(180deg, #ffffff, #f3f7fb);
      }
      .report-map {
        display: block;
        width: 100%;
        height: 100%;
        min-height: 460px;
      }
      .report-map-point {
        cursor: pointer;
        transition: transform 650ms cubic-bezier(.2,.8,.2,1), opacity 180ms ease, fill 180ms ease, r 180ms ease;
      }
      .report-map-point.selected {
        stroke: #111827;
        stroke-width: 2.2;
      }
      .cluster-shape {
        transition: opacity 180ms ease;
        pointer-events: none;
      }
      .report-map.hide-shapes .cluster-shape {
        opacity: 0 !important;
      }
      .map-inspector {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 16px;
        background: #fff;
        min-height: 460px;
      }
      .map-inspector blockquote {
        margin-top: 12px;
      }
      .cluster-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 14px;
      }
      .cluster-chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: #fff;
        padding: 7px 10px;
        color: var(--muted);
        font: 700 12px/1.2 ui-monospace, monospace;
      }
      .cluster-chip-swatch {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: var(--cluster-color, var(--primary));
      }
      @media (max-width: 840px) {
        .report-map-layout {
          grid-template-columns: 1fr;
        }
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
      ${renderStaticReviewBoundarySection(report)}
      ${renderStaticInterpretationMap(report)}
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
                <span class="stat">${options.voteSummary.initialQuestions.length} initial question(s)</span>
                <span class="stat">${options.voteSummary.statementCount} statement(s)</span>
                <span class="stat">${options.voteSummary.highConsensusStatementIds.length} high consensus</span>
                <span class="stat">${options.voteSummary.highContentionStatementIds.length} high contention</span>
              </div>
              ${
                options.voteSummary.initialQuestions.length === 0
                  ? ""
                  : options.voteSummary.initialQuestions
                      .map(
                        (question) => `<section class="cluster">
                          <h3>${escapeHtml(question.questionText)}</h3>
                          <p class="meta">yes ${Math.round(question.rates.yes * 100)}% · no ${Math.round(question.rates.no * 100)}% · skip ${Math.round(question.rates.skip * 100)}%</p>
                        </section>`
                      )
                      .join("")
              }
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
    ${renderStaticReportBehaviorScript(report)}
  </body>
</html>`;
}

export function renderPlaceholderReportHtml(report: ReportBundle): string {
  return renderStaticReportHtml(report);
}

export function renderReportInterpretationMap(report: ReportBundle): string {
  return renderStaticInterpretationMap(report);
}

export function renderReportInterpretationMapScript(report: ReportBundle): string {
  return renderStaticReportBehaviorScript(report);
}

function renderStaticInterpretationMap(report: ReportBundle): string {
  const plottedViews = report.views.filter((view) => (view.plot?.points.length ?? 0) > 0);

  if (plottedViews.length === 0) {
    return "";
  }

  const initialView =
    plottedViews.find((view) => view.viewId === report.primaryViewId) ?? plottedViews[0];

  return `<section class="card section" data-report-map data-active-view-id="${escapeHtml(initialView?.viewId ?? plottedViews[0]?.viewId ?? "")}">
    <p class="eyebrow">Interpretation Map</p>
    <h2>How opinions move between views</h2>
    <p class="meta">Switch views to see the same opinion points move into the selected report interpretation. Click a point to inspect the opinion behind it.</p>
    <div class="report-map-controls">
      ${plottedViews
        .map(
          (view) => `<button type="button" class="map-view-button ${
            view.viewId === initialView?.viewId ? "active" : ""
          }" data-report-map-view="${escapeHtml(view.viewId)}">${escapeHtml(view.title)}</button>`
        )
        .join("")}
      <label class="map-toggle"><input type="checkbox" data-report-map-shapes checked /> Cluster shapes</label>
    </div>
    <div class="report-map-layout">
      <div class="report-map-shell">
        <svg class="report-map" data-report-map-svg viewBox="0 0 900 520" role="img" aria-label="Animated opinion map">
          <rect x="0" y="0" width="900" height="520" fill="transparent"></rect>
          <g data-report-map-shape-layer></g>
          <g data-report-map-point-layer></g>
        </svg>
      </div>
      <aside class="map-inspector" data-report-map-inspector>
        <p class="eyebrow">Opinion</p>
        <h3>Select a point</h3>
        <p class="meta">The panel will show the opinion text, source id, and current cluster.</p>
      </aside>
    </div>
    <div class="cluster-legend" data-report-map-legend></div>
    <script type="application/json" data-report-map-data>${escapeScriptJson(plottedViews)}</script>
  </section>`;
}

function renderStaticReportBehaviorScript(report: ReportBundle): string {
  if (!report.views.some((view) => (view.plot?.points.length ?? 0) > 0)) {
    return "";
  }

  return `<script>
    (() => {
      const palette = ["#145688", "#2A8DC8", "#CC7418", "#15794F", "#A85E12", "#6E4FF6", "#C53F7B", "#008B8B", "#8D5E2B", "#51606F", "#8D5A97", "#F4A261"];
      const width = 900;
      const height = 520;
      const padding = 36;

      const colorForCluster = (clusterId) => {
        const numeric = Number(clusterId);
        const index = Number.isFinite(numeric) ? Math.abs(numeric) % palette.length : 0;
        return palette[index] || palette[0];
      };

      const escapeText = (value) => String(value || "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char] || char);

      const scalePoints = (view) => {
        const points = view.plot && Array.isArray(view.plot.points) ? view.plot.points : [];
        const xs = points.map((point) => Number(point.x) || 0);
        const ys = points.map((point) => Number(point.y) || 0);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const xSpan = maxX - minX || 1;
        const ySpan = maxY - minY || 1;

        return points.map((point) => ({
          ...point,
          sx: padding + (((Number(point.x) || 0) - minX) / xSpan) * (width - padding * 2),
          sy: height - padding - (((Number(point.y) || 0) - minY) / ySpan) * (height - padding * 2)
        }));
      };

      const cross = (origin, a, b) => (a.sx - origin.sx) * (b.sy - origin.sy) - (a.sy - origin.sy) * (b.sx - origin.sx);

      const convexHull = (points) => {
        const unique = [...new Map(points.map((point) => [point.sx.toFixed(2) + "," + point.sy.toFixed(2), point])).values()]
          .sort((a, b) => a.sx - b.sx || a.sy - b.sy);
        if (unique.length <= 2) return unique;
        const lower = [];
        for (const point of unique) {
          while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
            lower.pop();
          }
          lower.push(point);
        }
        const upper = [];
        for (let index = unique.length - 1; index >= 0; index -= 1) {
          const point = unique[index];
          while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
            upper.pop();
          }
          upper.push(point);
        }
        lower.pop();
        upper.pop();
        return lower.concat(upper);
      };

      const clusterPath = (points) => {
        if (points.length === 0) return "";
        const minX = Math.min(...points.map((point) => point.sx));
        const maxX = Math.max(...points.map((point) => point.sx));
        const minY = Math.min(...points.map((point) => point.sy));
        const maxY = Math.max(...points.map((point) => point.sy));
        if (points.length < 3) {
          const pad = 16;
          return "M " + (minX - pad) + " " + (minY - pad) + " L " + (maxX + pad) + " " + (minY - pad) + " L " + (maxX + pad) + " " + (maxY + pad) + " L " + (minX - pad) + " " + (maxY + pad) + " Z";
        }
        const hull = convexHull(points);
        const cx = hull.reduce((sum, point) => sum + point.sx, 0) / hull.length;
        const cy = hull.reduce((sum, point) => sum + point.sy, 0) / hull.length;
        const expanded = hull.map((point) => {
          const dx = point.sx - cx;
          const dy = point.sy - cy;
          const distance = Math.sqrt(dx * dx + dy * dy) || 1;
          return {
            sx: point.sx + (dx / distance) * 14,
            sy: point.sy + (dy / distance) * 14
          };
        });
        return expanded.map((point, index) => (index === 0 ? "M " : "L ") + point.sx.toFixed(1) + " " + point.sy.toFixed(1)).join(" ") + " Z";
      };

      const renderMap = (root, viewId) => {
        const data = root.__reportMapViews || [];
        const view = data.find((item) => item.viewId === viewId) || data[0];
        if (!view || !view.plot) return;
        root.dataset.activeViewId = view.viewId;
        const points = scalePoints(view);
        const pointById = new Map(points.map((point) => [point.opinionId, point]));
        const pointLayer = root.querySelector("[data-report-map-point-layer]");
        const shapeLayer = root.querySelector("[data-report-map-shape-layer]");
        const legend = root.querySelector("[data-report-map-legend]");
        const svg = root.querySelector("[data-report-map-svg]");
        const inspector = root.querySelector("[data-report-map-inspector]");
        if (!pointLayer || !shapeLayer || !legend || !svg || !inspector) return;

        root.querySelectorAll("[data-report-map-view]").forEach((button) => {
          button.classList.toggle("active", button.getAttribute("data-report-map-view") === view.viewId);
        });

        shapeLayer.replaceChildren();
        const pointsByCluster = new Map();
        for (const point of points) {
          const group = pointsByCluster.get(point.clusterId) || [];
          group.push(point);
          pointsByCluster.set(point.clusterId, group);
        }
        const clusters = [...(view.plot.clusters || [])].sort((a, b) => (b.size || 0) - (a.size || 0));
        for (const cluster of clusters) {
          const clusterPoints = pointsByCluster.get(cluster.clusterId) || [];
          const path = clusterPath(clusterPoints);
          if (!path) continue;
          const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
          shape.setAttribute("class", "cluster-shape");
          shape.setAttribute("d", path);
          shape.setAttribute("fill", colorForCluster(cluster.clusterId));
          shape.setAttribute("fill-opacity", cluster.highlighted ? "0.16" : "0.08");
          shape.setAttribute("stroke", colorForCluster(cluster.clusterId));
          shape.setAttribute("stroke-opacity", cluster.highlighted ? "0.42" : "0.24");
          shape.setAttribute("stroke-width", "1.4");
          shapeLayer.appendChild(shape);
        }

        pointLayer.querySelectorAll(".report-map-point").forEach((node) => {
          const point = pointById.get(node.getAttribute("data-opinion-id"));
          if (!point) {
            node.style.opacity = "0";
            return;
          }
          node.dataset.clusterId = point.clusterId;
          node.style.transform = "translate(" + point.sx.toFixed(1) + "px, " + point.sy.toFixed(1) + "px)";
          node.style.opacity = point.highlighted ? "0.96" : "0.46";
          node.setAttribute("fill", colorForCluster(point.clusterId));
          node.setAttribute("r", point.highlighted ? "4.8" : "3.4");
        });

        for (const point of points) {
          if (pointLayer.querySelector('[data-opinion-id="' + CSS.escape(point.opinionId) + '"]')) {
            continue;
          }
          const node = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          node.setAttribute("class", "report-map-point");
          node.setAttribute("data-opinion-id", point.opinionId);
          node.setAttribute("data-cluster-id", point.clusterId);
          node.setAttribute("cx", "0");
          node.setAttribute("cy", "0");
          node.setAttribute("fill", colorForCluster(point.clusterId));
          node.setAttribute("r", point.highlighted ? "4.8" : "3.4");
          node.style.transform = "translate(" + point.sx.toFixed(1) + "px, " + point.sy.toFixed(1) + "px)";
          node.style.opacity = point.highlighted ? "0.96" : "0.46";
          pointLayer.appendChild(node);
        }

        legend.innerHTML = clusters.map((cluster) =>
          '<button type="button" class="cluster-chip" data-map-cluster="' + escapeText(cluster.clusterId) + '" style="--cluster-color:' + colorForCluster(cluster.clusterId) + '">' +
          '<span class="cluster-chip-swatch"></span><span>#' + escapeText(cluster.clusterId) + " " + escapeText(cluster.label) + "</span></button>"
        ).join("");

        const selectedId = root.dataset.selectedOpinionId;
        if (selectedId && pointById.has(selectedId)) {
          showInspector(root, pointById.get(selectedId), view);
        } else {
          inspector.innerHTML = '<p class="eyebrow">Opinion</p><h3>' + escapeText(view.title) + '</h3><p class="meta">' + points.length + ' plotted opinions. Click a point to inspect it.</p>';
        }
      };

      const showInspector = (root, point, view) => {
        const inspector = root.querySelector("[data-report-map-inspector]");
        if (!inspector || !point) return;
        root.dataset.selectedOpinionId = point.opinionId;
        root.querySelectorAll(".report-map-point").forEach((node) => {
          node.classList.toggle("selected", node.getAttribute("data-opinion-id") === point.opinionId);
        });
        const cluster = (view.plot.clusters || []).find((item) => item.clusterId === point.clusterId);
        inspector.innerHTML = '<p class="eyebrow">Opinion ' + escapeText(point.opinionId) + '</p>' +
          '<h3>#' + escapeText(point.clusterId) + ' ' + escapeText(cluster ? cluster.label : "Cluster") + '</h3>' +
          '<p class="meta">' + escapeText(view.title) + (point.sourceId ? " · source " + escapeText(point.sourceId) : "") + '</p>' +
          '<blockquote>' + escapeText(point.opinionText || point.excerpt || "No opinion text available.") + '</blockquote>' +
          (point.excerpt && point.excerpt !== point.opinionText ? '<p class="meta" style="margin-top:12px;">Excerpt: ' + escapeText(point.excerpt) + '</p>' : '');
      };

      document.querySelectorAll("[data-report-map]").forEach((root) => {
        const dataNode = root.querySelector("[data-report-map-data]");
        if (!dataNode) return;
        try {
          root.__reportMapViews = JSON.parse(dataNode.textContent || "[]");
        } catch {
          root.__reportMapViews = [];
        }
        const initialView = root.dataset.activeViewId || (root.__reportMapViews[0] && root.__reportMapViews[0].viewId);
        renderMap(root, initialView);

        root.addEventListener("click", (event) => {
          if (!(event.target instanceof Element)) return;
          const pointNode = event.target.closest(".report-map-point");
          if (pointNode instanceof SVGElement) {
            const view = root.__reportMapViews.find((item) => item.viewId === root.dataset.activeViewId) || root.__reportMapViews[0];
            const point = scalePoints(view).find((item) => item.opinionId === pointNode.getAttribute("data-opinion-id"));
            showInspector(root, point, view);
            return;
          }
          const viewButton = event.target.closest("[data-report-map-view]");
          if (viewButton instanceof HTMLElement) {
            renderMap(root, viewButton.getAttribute("data-report-map-view"));
            return;
          }
          const clusterButton = event.target.closest("[data-map-cluster]");
          if (clusterButton instanceof HTMLElement) {
            const clusterId = clusterButton.getAttribute("data-map-cluster");
            root.querySelectorAll(".report-map-point").forEach((node) => {
              const matches = node.getAttribute("data-cluster-id") === clusterId;
              node.style.opacity = matches ? "0.98" : "0.14";
            });
          }
        });

        const shapeToggle = root.querySelector("[data-report-map-shapes]");
        if (shapeToggle instanceof HTMLInputElement) {
          shapeToggle.addEventListener("change", () => {
            const svg = root.querySelector("[data-report-map-svg]");
            if (svg) {
              svg.classList.toggle("hide-shapes", !shapeToggle.checked);
            }
          });
        }
      });

      document.addEventListener("click", (event) => {
        if (!(event.target instanceof Element)) return;
        const viewButton = event.target.closest("[data-report-map-view]");
        if (!(viewButton instanceof HTMLElement)) return;
        const viewId = viewButton.getAttribute("data-report-map-view");
        if (!viewId) return;

        document.querySelectorAll("[data-report-map]").forEach((root) => {
          const views = root.__reportMapViews || [];
          if (views.some((view) => view.viewId === viewId)) {
            renderMap(root, viewId);
          }
        });

        if (!viewButton.hasAttribute("data-perspective-target")) {
          const perspectiveButton = document.querySelector('[data-perspective-target="' + CSS.escape("perspective-" + viewId) + '"]');
          if (perspectiveButton instanceof HTMLElement && !perspectiveButton.classList.contains("active")) {
            perspectiveButton.click();
          }
        }
      });
    })();
  </script>`;
}

function renderStaticReviewBoundarySection(report: ReportBundle): string {
  const review = report.review;

  if (review === undefined) {
    return "";
  }

  const excludedStatuses = Object.entries(review.excludedByStatus)
    .filter(([, count]) => count > 0)
    .sort(([leftStatus], [rightStatus]) => leftStatus.localeCompare(rightStatus));

  return `<section class="card section">
    <p class="eyebrow">Review Boundary</p>
    <h2>What evidence this report included</h2>
    <p class="meta">This report reflects the review config captured by the analysis run. Excluded content still exists in the project; it was outside this report's inclusion boundary.</p>
    <div class="stats">
      <span class="stat">${review.includedOpinions} of ${review.totalOpinionsAvailable} opinion(s) included</span>
      <span class="stat">${review.excludedOpinions} opinion(s) excluded</span>
      <span class="stat">comment statuses: ${escapeHtml(renderStatusSummary(review.includeCommentStatuses))}</span>
      <span class="stat">opinion statuses: ${escapeHtml(renderStatusSummary(review.includeOpinionStatuses))}</span>
      <span class="stat">config: ${escapeHtml(renderPortableReviewConfigPath(review.configPath))}</span>
    </div>
    <section class="cluster">
      <h3>Excluded by status</h3>
      ${
        excludedStatuses.length === 0
          ? `<p class="meta">No opinions were excluded by status.</p>`
          : `<ul class="quote-list">
              ${excludedStatuses
                .map(
                  ([status, count]) => `<li>${escapeHtml(status)}: ${count}</li>`
                )
                .join("")}
            </ul>`
      }
    </section>
  </section>`;
}

function renderStatusSummary(statuses: string[]): string {
  return statuses.length === 0 ? "none" : statuses.join(", ");
}

function renderPortableReviewConfigPath(configPath: string): string {
  const dataIndex = configPath.lastIndexOf("/data/");
  return dataIndex === -1 ? configPath : configPath.slice(dataIndex + 1);
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
