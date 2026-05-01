const API_BASE = "https://formulae.brew.sh/api";
const CACHE_VERSION = 3;
const POPULAR_PACKAGE_LIMIT = 60;
const POPULAR_PERIODS = ["30d", "90d", "365d"];

const state = {
  packages: [],
  installed: new Map(),
  outdated: new Map(),
  brew: {
    available: false,
    desktop: Boolean(window.cellarBrew),
    message: "Checking Homebrew..."
  },
  selected: null,
  filter: "all",
  subfilter: "all",
  allType: "type-all",
  libraryType: "type-all",
  popularPeriod: "30d",
  popularType: "all",
  popularCategory: "all",
  view: "discover",
  query: "",
  theme: readTheme()
};

const elements = {
  searchInput: document.querySelector("#searchInput"),
  refreshButton: document.querySelector("#refreshButton"),
  themeToggle: document.querySelector("#themeToggle"),
  statusBar: document.querySelector("#statusBar"),
  brewHealth: document.querySelector("#brewHealth"),
  formulaCount: document.querySelector("#formulaCount"),
  caskCount: document.querySelector("#caskCount"),
  installedCount: document.querySelector("#installedCount"),
  resultsTitle: document.querySelector("#resultsTitle"),
  subfilterBar: document.querySelector("#subfilterBar"),
  resultCount: document.querySelector("#resultCount"),
  catalogLayout: document.querySelector("#catalogLayout"),
  packageGrid: document.querySelector("#packageGrid"),
  detailPanel: document.querySelector("#detailPanel"),
  cardTemplate: document.querySelector("#packageCardTemplate")
};

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    state.view = button.dataset.view;
    state.filter = filterForView(state.view);
    state.subfilter = "all";
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
    render();
  });
});

elements.searchInput.addEventListener("input", (event) => {
  state.query = event.target.value.trim().toLowerCase();
  render();
});

elements.refreshButton.addEventListener("click", () => {
  loadCatalog({ force: true });
});

elements.themeToggle.addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  applyTheme();
});

initialize();

async function initialize() {
  applyTheme();
  await diagnoseHomebrew();
  await Promise.all([
    loadCatalog(),
    refreshLocalPackages()
  ]);
}

async function loadCatalog({ force = false } = {}) {
  setStatus("Loading the Homebrew catalog...");
  elements.refreshButton.disabled = true;

  try {
    const cached = force ? null : readCache();
    if (cached) {
      state.packages = cached;
      setStatus(`Loaded ${cached.length.toLocaleString()} packages from local cache. Refresh to fetch the latest catalog.`);
      updateStats();
      render();
    }

    const [formulae, casks, analytics] = await Promise.all([
      fetchJson(`${API_BASE}/formula.json`),
      fetchJson(`${API_BASE}/cask.json`),
      fetchPopularityAnalytics()
    ]);

    state.packages = [
      ...formulae.map((item) => normalizeFormula(item, analytics.formulae.get(item.name) || emptyPopularityScores())),
      ...casks.map((item) => {
        const token = item.token || item.full_token;
        return normalizeCask(item, analytics.casks.get(token) || emptyPopularityScores());
      })
    ].sort((a, b) => a.name.localeCompare(b.name));

    writeCache(state.packages);

    setStatus(`Catalog refreshed from formulae.brew.sh at ${new Date().toLocaleTimeString()}.`);
    updateStats();
    render();
  } catch (error) {
    console.error(error);
    setStatus("Could not load the Homebrew API. Check your connection and try refresh.");
    if (!state.packages.length) {
      elements.packageGrid.innerHTML = `<p class="small-text">No catalog data is available yet.</p>`;
    }
  } finally {
    elements.refreshButton.disabled = false;
  }
}

async function diagnoseHomebrew() {
  if (!window.cellarBrew) {
    state.brew = {
      available: false,
      desktop: false,
      message: "Open this as the Cellar desktop app to install, update, and remove packages. The browser version is catalog-only."
    };
    renderBrewHealth("missing");
    return;
  }

  try {
    const result = await window.cellarBrew.diagnose();
    state.brew = {
      available: Boolean(result.installed),
      desktop: true,
      message: result.installed ? `${result.message} ${result.version}` : result.message,
      path: result.path,
      installUrl: result.installUrl
    };
    renderBrewHealth(result.installed ? "ready" : "missing");
  } catch (error) {
    state.brew = {
      available: false,
      desktop: true,
      message: error.message || "Could not check Homebrew."
    };
    renderBrewHealth("error");
  }
}

async function refreshLocalPackages() {
  if (!window.cellarBrew || !state.brew.available) {
    updateStats();
    render();
    return;
  }

  try {
    const [installed, outdated] = await Promise.all([
      window.cellarBrew.installed(),
      window.cellarBrew.outdated()
    ]);
    state.installed = buildPackageMap([...(installed.formulae || []), ...(installed.casks || [])]);
    state.outdated = buildOutdatedMap(outdated);
    setStatus(`Found ${state.installed.size.toLocaleString()} installed Homebrew packages on this Mac.`);
  } catch (error) {
    setStatus(error.message || "Could not read installed Homebrew packages.");
  }

  updateStats();
  render();
}

function buildPackageMap(items) {
  return new Map(items.map((item) => [`${item.kind}:${item.token}`, item]));
}

function buildOutdatedMap(payload) {
  const formulae = (payload?.formulae || []).map((item) => ({
    kind: "formula",
    token: item.name,
    current: item.installed_versions?.join(", ") || "Installed",
    latest: item.current_version || "Latest"
  }));
  const casks = (payload?.casks || []).map((item) => ({
    kind: "cask",
    token: item.name || item.token,
    current: item.installed_versions?.join(", ") || "Installed",
    latest: item.current_version || "Latest"
  }));
  return new Map([...formulae, ...casks].map((item) => [`${item.kind}:${item.token}`, item]));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Homebrew API request failed: ${response.status} ${url}`);
  }

  return response.json();
}

async function fetchPopularityAnalytics() {
  const [formulaResults, caskResults] = await Promise.all([
    Promise.allSettled(POPULAR_PERIODS.map((period) => fetchJson(`${API_BASE}/analytics/install-on-request/${period}.json`))),
    Promise.allSettled(POPULAR_PERIODS.map((period) => fetchJson(`${API_BASE}/analytics/cask-install/homebrew-cask/${period}.json`)))
  ]);

  return {
    formulae: analyticsScoresByPeriod(formulaResults, formulaAnalyticsMap),
    casks: analyticsScoresByPeriod(caskResults, (payload) => groupedAnalyticsMap(payload, "cask"))
  };
}

function analyticsScoresByPeriod(results, mapper) {
  const scores = new Map();
  results.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    const period = POPULAR_PERIODS[index];
    mapper(result.value).forEach((count, token) => {
      const existing = scores.get(token) || emptyPopularityScores();
      existing[period] = count;
      scores.set(token, existing);
    });
  });
  return scores;
}

function formulaAnalyticsMap(payload) {
  const scores = new Map();
  (payload.items || []).forEach((item) => {
    if (item.formula) scores.set(item.formula, countFromAnalytics(item.count));
  });
  return scores;
}

function groupedAnalyticsMap(payload, key) {
  const scores = new Map();
  Object.entries(payload.formulae || {}).forEach(([token, events]) => {
    const total = (events || []).reduce((sum, event) => {
      const eventName = event[key] || "";
      if (eventName.includes(" --")) return sum;
      return sum + countFromAnalytics(event.count);
    }, 0);
    scores.set(token, total);
  });
  return scores;
}

function countFromAnalytics(value) {
  if (typeof value === "number") return value;
  return Number(String(value || "0").replaceAll(",", "")) || 0;
}

function emptyPopularityScores() {
  return { "30d": 0, "90d": 0, "365d": 0 };
}

function readCache() {
  try {
    const cached = JSON.parse(localStorage.getItem("homebrewCatalog"));
    const maxAge = 1000 * 60 * 60 * 12;
    if (cached?.version === CACHE_VERSION && Date.now() - cached.updatedAt < maxAge && Array.isArray(cached.packages)) {
      return cached.packages;
    }
  } catch {
    localStorage.removeItem("homebrewCatalog");
  }

  return null;
}

function writeCache(packages) {
  try {
    localStorage.setItem("homebrewCatalog", JSON.stringify({
      version: CACHE_VERSION,
      updatedAt: Date.now(),
      packages
    }));
  } catch {
    localStorage.removeItem("homebrewCatalog");
  }
}

function normalizeFormula(item, popularityScores = emptyPopularityScores()) {
  return {
    id: `formula:${item.name}`,
    token: item.name,
    name: item.full_name || item.name,
    displayName: item.name,
    kind: "formula",
    kindLabel: item.service ? "Service" : "CLI Tool",
    sourceLabel: "Homebrew Formula",
    sourceDescription: "Formulae install command-line tools, libraries, runtimes, and services into the Homebrew prefix.",
    installLocation: "Homebrew prefix",
    category: item.service ? "Background service" : "Command-line package",
    description: item.desc || "No description provided.",
    homepage: item.homepage,
    version: item.versions?.stable || "Unknown",
    tap: item.tap || "homebrew/core",
    license: item.license || "Unknown",
    dependencies: item.dependencies || [],
    warnings: buildFormulaWarnings(item),
    command: `brew install ${item.name}`,
    uninstallCommand: `brew uninstall ${item.name}`,
    service: Boolean(item.service),
    disabled: Boolean(item.disabled),
    deprecated: Boolean(item.deprecated),
    popularityScores,
    popularityScore: popularityScores[state.popularPeriod] || 0
  };
}

function normalizeCask(item, popularityScores = emptyPopularityScores()) {
  const names = Array.isArray(item.name) ? item.name : [item.name].filter(Boolean);
  const token = item.token || item.full_token;
  const isFont = token?.startsWith("font-");

  return {
    id: `cask:${token}`,
    token,
    name: token,
    displayName: names[0] || token,
    kind: "cask",
    kindLabel: isFont ? "Font" : "Mac App",
    sourceLabel: "Homebrew Cask",
    sourceDescription: "Casks install macOS apps, fonts, plugins, and other user-facing software bundles.",
    installLocation: isFont ? "macOS font locations" : "Applications or vendor-defined app locations",
    category: isFont ? "Font package" : "macOS app package",
    description: item.desc || "No description provided.",
    homepage: item.homepage,
    version: item.version || "Unknown",
    tap: item.tap || "homebrew/cask",
    license: "See vendor",
    dependencies: [],
    warnings: buildCaskWarnings(item),
    command: `brew install --cask ${token}`,
    uninstallCommand: `brew uninstall --cask ${token}`,
    service: hasBackgroundArtifacts(item),
    disabled: Boolean(item.disabled),
    deprecated: Boolean(item.deprecated),
    popularityScores,
    popularityScore: popularityScores[state.popularPeriod] || 0
  };
}

function buildFormulaWarnings(item) {
  const warnings = [];
  if (item.keg_only) warnings.push("This formula is keg-only and may not be linked into your default PATH.");
  if (item.service) warnings.push("This package can run a background service.");
  if (item.deprecated) warnings.push("This formula is deprecated.");
  if (item.disabled) warnings.push("This formula is disabled and may not install.");
  if (item.caveats) warnings.push("This package has Homebrew caveats to review after installation.");
  return warnings;
}

function buildCaskWarnings(item) {
  const warnings = [];
  if (hasBackgroundArtifacts(item)) warnings.push("This app installs background items or service components.");
  if (item.deprecated) warnings.push("This cask is deprecated.");
  if (item.disabled) warnings.push("This cask is disabled and may not install.");
  if (Array.isArray(item.depends_on?.macos)) warnings.push("This app has macOS version requirements.");
  return warnings;
}

function hasBackgroundArtifacts(item) {
  const text = JSON.stringify(item.artifacts || []);
  return /launchctl|login_item|service|privilegedhelpertools/i.test(text);
}

function filterForView(view) {
  const map = {
    discover: "all",
    all: "all",
    library: "library"
  };
  return map[view] || "all";
}

function render() {
  const packages = visiblePackages();
  elements.resultsTitle.textContent = titleForState();
  renderSubfilters();
  elements.resultCount.innerHTML = resultSummary(packages);
  elements.packageGrid.innerHTML = "";

  const updateAllButton = elements.resultCount.querySelector("[data-update-all]");
  if (updateAllButton) {
    updateAllButton.addEventListener("click", runBulkUpdate);
  }

  packages.slice(0, 120).forEach((pkg) => {
    elements.packageGrid.appendChild(renderCard(pkg));
  });

  if (!packages.length) {
    elements.packageGrid.innerHTML = `<p class="small-text">No packages match the current search.</p>`;
  }
}

function resultSummary(packages) {
  const countText = `${packages.length.toLocaleString()} item${packages.length === 1 ? "" : "s"}`;
  if (state.view === "library" && state.subfilter === "updates" && state.outdated.size > 0 && state.brew.available) {
    return `
      <span>${countText}</span>
      <button class="primary-action compact-action" data-update-all>Update All</button>
    `;
  }

  if (state.view === "library" && state.subfilter === "updates" && state.outdated.size > 0 && !state.brew.available) {
    return `<span>${countText}</span>`;
  }

  return `<span>${countText}</span>`;
}

function visiblePackages() {
  let packages = state.packages;

  if (!state.query && state.view === "discover" && state.filter === "all") {
    return popularPackages(packages);
  }

  if (state.view === "library") packages = libraryPackages(packages);
  if (state.view === "all") packages = applyPackageTypeFilter(packages, state.allType);

  if (state.query) {
    packages = packages.filter((pkg) => {
      const haystack = `${pkg.displayName} ${pkg.token} ${pkg.description} ${pkg.kindLabel} ${pkg.sourceLabel}`.toLowerCase();
      return haystack.includes(state.query);
    });
  }

  return packages.sort((a, b) => {
    if (state.query) return scoreSearch(b) - scoreSearch(a) || a.displayName.localeCompare(b.displayName);
    return popularityFor(b) - popularityFor(a) || a.displayName.localeCompare(b.displayName);
  });
}

function popularPackages(packages) {
  const ranked = packages
    .filter((pkg) => !pkg.disabled && !pkg.deprecated)
    .filter((pkg) => state.popularType === "all" || pkg.kind === state.popularType)
    .filter((pkg) => popularCategoryMatches(pkg))
    .sort((a, b) => popularityFor(b) - popularityFor(a) || a.displayName.localeCompare(b.displayName));

  const packagesWithAnalytics = ranked.filter((pkg) => popularityFor(pkg) > 0);
  return (packagesWithAnalytics.length ? packagesWithAnalytics : ranked).slice(0, POPULAR_PACKAGE_LIMIT);
}

function renderSubfilters() {
  if (state.view === "discover") {
    renderPopularFilters();
    return;
  }

  if (state.view === "all") {
    renderAllPackageFilters();
    return;
  }

  if (!usesSubfilters()) {
    elements.subfilterBar.innerHTML = "";
    elements.subfilterBar.hidden = true;
    return;
  }

  elements.subfilterBar.hidden = false;
  elements.subfilterBar.innerHTML = `
    <div class="filter-group" aria-label="Library state">
      ${[
        ["all", "Installed"],
        ["updates", "Updates"]
      ].map(([value, label]) => filterButton("subfilter", value, label, state.subfilter)).join("")}
    </div>
    <div class="filter-group" aria-label="Package type">
      ${[
        ["type-all", "All Types"],
        ["cask", "Casks"],
        ["formula", "Formulae"],
        ["service", "Services"],
        ["font", "Fonts"]
      ].map(([value, label]) => filterButton("library-type", value, label, state.libraryType)).join("")}
    </div>
  `;

  elements.subfilterBar.querySelectorAll("[data-subfilter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.subfilter = button.dataset.subfilter;
      render();
    });
  });

  elements.subfilterBar.querySelectorAll("[data-library-type]").forEach((button) => {
    button.addEventListener("click", () => {
      state.libraryType = button.dataset.libraryType;
      render();
    });
  });
}

function renderAllPackageFilters() {
  elements.subfilterBar.hidden = false;
  elements.subfilterBar.innerHTML = `
    <div class="filter-group" aria-label="Package type">
      ${[
        ["type-all", "All Types"],
        ["cask", "Casks"],
        ["formula", "Formulae"],
        ["service", "Services"],
        ["font", "Fonts"]
      ].map(([value, label]) => filterButton("all-type", value, label, state.allType)).join("")}
    </div>
  `;

  elements.subfilterBar.querySelectorAll("[data-all-type]").forEach((button) => {
    button.addEventListener("click", () => {
      state.allType = button.dataset.allType;
      render();
    });
  });
}

function renderPopularFilters() {
  elements.subfilterBar.hidden = false;
  elements.subfilterBar.innerHTML = `
    <div class="filter-group" aria-label="Popularity period">
      ${POPULAR_PERIODS.map((period) => filterButton("popular-period", period, periodLabel(period), state.popularPeriod)).join("")}
    </div>
    <div class="filter-group" aria-label="Package type">
      ${[
        ["all", "All"],
        ["cask", "Casks"],
        ["formula", "Formulae"]
      ].map(([value, label]) => filterButton("popular-type", value, label, state.popularType)).join("")}
    </div>
    <div class="filter-group" aria-label="Category">
      ${[
        ["all", "Any"],
        ["app", "Apps"],
        ["cli", "CLI"],
        ["service", "Services"],
        ["font", "Fonts"]
      ].map(([value, label]) => filterButton("popular-category", value, label, state.popularCategory, !popularCategoryAvailable(value))).join("")}
    </div>
  `;

  elements.subfilterBar.querySelectorAll("[data-popular-period]").forEach((button) => {
    button.addEventListener("click", () => {
      state.popularPeriod = button.dataset.popularPeriod;
      render();
    });
  });
  elements.subfilterBar.querySelectorAll("[data-popular-type]").forEach((button) => {
    button.addEventListener("click", () => {
      state.popularType = button.dataset.popularType;
      normalizePopularFilters();
      render();
    });
  });
  elements.subfilterBar.querySelectorAll("[data-popular-category]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      state.popularCategory = button.dataset.popularCategory;
      render();
    });
  });
}

function filterButton(kind, value, label, activeValue, disabled = false) {
  return `<button class="subfilter-button ${activeValue === value ? "active" : ""}" data-${kind}="${value}" type="button" ${disabled ? "disabled" : ""}>${label}</button>`;
}

function periodLabel(period) {
  if (period === "30d") return "30 days";
  if (period === "90d") return "90 days";
  return "1 year";
}

function popularityFor(pkg) {
  return pkg.popularityScores?.[state.popularPeriod] || pkg.popularityScore || 0;
}

function popularCategoryMatches(pkg) {
  if (state.popularCategory === "app") return pkg.kind === "cask" && pkg.kindLabel !== "Font";
  if (state.popularCategory === "cli") return pkg.kind === "formula" && !pkg.service;
  if (state.popularCategory === "service") return pkg.service;
  if (state.popularCategory === "font") return pkg.kindLabel === "Font";
  return true;
}

function normalizePopularFilters() {
  if (state.popularType === "formula" && ["app", "font"].includes(state.popularCategory)) {
    state.popularCategory = "all";
  }

  if (state.popularType === "cask" && ["cli", "service"].includes(state.popularCategory)) {
    state.popularCategory = "all";
  }
}

function popularCategoryAvailable(category) {
  if (category === "all") return true;
  if (state.popularType === "formula") return ["cli", "service"].includes(category);
  if (state.popularType === "cask") return ["app", "font"].includes(category);
  return true;
}

function usesSubfilters() {
  return state.view === "library";
}

function libraryPackages(packages) {
  let filtered = packages.filter((pkg) => state.installed.has(pkg.id));
  if (state.subfilter === "updates") filtered = filtered.filter((pkg) => state.outdated.has(pkg.id));
  return applyPackageTypeFilter(filtered, state.libraryType);
}

function applyPackageTypeFilter(packages, filter) {
  if (filter === "type-all") return packages;
  if (filter === "cask") return packages.filter((pkg) => pkg.kind === "cask");
  if (filter === "formula") return packages.filter((pkg) => pkg.kind === "formula");
  if (filter === "service") return packages.filter((pkg) => pkg.service);
  if (filter === "font") return packages.filter((pkg) => pkg.kindLabel === "Font");
  return packages;
}

function scoreSearch(pkg) {
  const query = state.query;
  if (pkg.token.toLowerCase() === query) return 100;
  if (pkg.displayName.toLowerCase() === query) return 90;
  if (pkg.token.toLowerCase().startsWith(query)) return 70;
  if (pkg.displayName.toLowerCase().startsWith(query)) return 60;
  return 10;
}

function renderCard(pkg) {
  const fragment = elements.cardTemplate.content.cloneNode(true);
  const button = fragment.querySelector(".package-card");
  button.dataset.id = pkg.id;
  button.classList.add(`${pkg.kind}-card`);
  button.classList.toggle("selected", state.selected?.id === pkg.id);
  fragment.querySelector(".package-icon").textContent = iconForPackage(pkg);
  fragment.querySelector(".package-kind").textContent = pkg.kindLabel;
  fragment.querySelector(".package-title").textContent = pkg.displayName;
  fragment.querySelector(".package-source").textContent = pkg.sourceLabel;
  fragment.querySelector(".package-desc").textContent = pkg.description;
  fragment.querySelector(".package-version").textContent = versionText(pkg);
  const installState = fragment.querySelector(".install-state");
  if (state.installed.has(pkg.id)) {
    installState.textContent = state.outdated.has(pkg.id) ? "Update available" : "Installed";
  } else {
    installState.remove();
  }
  button.addEventListener("click", () => selectPackage(pkg));
  return fragment;
}

function selectPackage(pkg) {
  if (state.selected?.id === pkg.id) {
    closeDetailPanel();
    return;
  }

  state.selected = pkg;
  renderDetail(pkg);
  openDetailPanel();
  document.querySelectorAll(".package-card").forEach((card) => {
    card.classList.toggle("selected", card.dataset.id === pkg.id);
  });
}

function openDetailPanel() {
  elements.catalogLayout.classList.add("inspector-open");
  elements.detailPanel.hidden = false;
}

function closeDetailPanel() {
  state.selected = null;
  elements.catalogLayout.classList.remove("inspector-open");
  elements.detailPanel.hidden = true;
  elements.detailPanel.innerHTML = "";
  document.querySelectorAll(".package-card").forEach((card) => {
    card.classList.remove("selected");
  });
}

function renderDetail(pkg) {
  const dependencyText = pkg.dependencies.length
    ? pkg.dependencies.slice(0, 16).map((dependency) => `<span class="tag">${escapeHtml(dependency)}</span>`).join("")
    : `<span class="small-text">No direct dependencies listed in the API.</span>`;

  const warnings = pkg.warnings.length
    ? pkg.warnings.map((warning) => `<p class="warning">${escapeHtml(warning)}</p>`).join("")
    : `<p class="small-text">No special warnings surfaced from catalog metadata.</p>`;

  elements.detailPanel.innerHTML = `
    <div class="detail-header">
      <div>
        <h2>${escapeHtml(pkg.displayName)}</h2>
        <p class="detail-meta">${escapeHtml(pkg.token)} · ${escapeHtml(pkg.tap)}</p>
      </div>
      <button class="panel-close-button" type="button" data-close-detail aria-label="Close package details">Close</button>
    </div>
    <div class="source-banner ${escapeHtml(pkg.kind)}">
      <strong>${escapeHtml(pkg.sourceLabel)}</strong><br>
      ${escapeHtml(pkg.sourceDescription)}
    </div>
    <p>${escapeHtml(pkg.description)}</p>
    <div class="detail-actions">
      ${actionButtons(pkg)}
      <button class="secondary-action" data-copy="${escapeHtml(pkg.command)}">Copy Command</button>
    </div>
    <div class="detail-section">
      <h3>Install preview</h3>
      <div class="command-box">${escapeHtml(pkg.command)}</div>
      <p class="small-text">${installExplanation(pkg)}</p>
    </div>
    <div class="detail-section">
      <h3>Package info</h3>
      <div class="detail-table">
        <div class="detail-row"><span>Type</span><strong>${escapeHtml(pkg.sourceLabel)}</strong></div>
        <div class="detail-row"><span>Category</span><strong>${escapeHtml(pkg.category)}</strong></div>
        <div class="detail-row"><span>Installs to</span><strong>${escapeHtml(pkg.installLocation)}</strong></div>
        <div class="detail-row"><span>Version</span><strong>${escapeHtml(pkg.version)}</strong></div>
        <div class="detail-row"><span>License</span><strong>${escapeHtml(pkg.license)}</strong></div>
        <div class="detail-row"><span>Website</span><a href="${escapeAttribute(pkg.homepage)}" target="_blank" rel="noreferrer">${escapeHtml(pkg.homepage || "Not listed")}</a></div>
      </div>
    </div>
    <div class="detail-section">
      <h3>Dependencies</h3>
      <div class="tag-list">${dependencyText}</div>
    </div>
    <div class="detail-section">
      <h3>Safety notes</h3>
      ${warnings}
    </div>
    <div class="detail-section">
      <h3>Activity</h3>
      <div class="command-box operation-log" id="operationLog">No package changes have run yet.</div>
    </div>
  `;

  elements.detailPanel.querySelector("[data-close-detail]").addEventListener("click", closeDetailPanel);

  elements.detailPanel.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => runPackageAction(button.dataset.action, pkg));
  });

  elements.detailPanel.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = "Copy Command";
      }, 1400);
    });
  });
}

function actionButtons(pkg) {
  const disabled = state.brew.available ? "" : "disabled";
  const isInstalled = state.installed.has(pkg.id);
  const hasUpdate = state.outdated.has(pkg.id);

  if (!state.brew.desktop) {
    return `<button class="primary-action" disabled>Open Desktop App to Install</button>`;
  }

  if (!state.brew.available) {
    return `<button class="primary-action" disabled>Install Homebrew First</button>`;
  }

  if (isInstalled) {
    return `
      ${hasUpdate ? `<button class="primary-action" data-action="upgrade" ${disabled}>Update</button>` : ""}
      <button class="danger-action" data-action="uninstall" ${disabled}>Remove</button>
    `;
  }

  return `<button class="primary-action" data-action="install" ${disabled}>Install</button>`;
}

async function runPackageAction(action, pkg) {
  const verb = {
    install: "install",
    uninstall: "remove",
    upgrade: "update"
  }[action];
  const warning = action === "uninstall"
    ? `Remove ${pkg.displayName}? This will run Homebrew's uninstall command for this ${pkg.kind}.`
    : `${verb[0].toUpperCase()}${verb.slice(1)} ${pkg.displayName}? Cellar will run the Homebrew command shown above.`;

  if (!confirm(warning)) return;

  const log = elements.detailPanel.querySelector("#operationLog");
  setOperationLog(log, `Running ${pkg.commandFor?.[action] || commandForAction(action, pkg)}...`);

  try {
    const result = await window.cellarBrew[action]({ kind: pkg.kind, token: pkg.token });
    setOperationLog(log, result.output || "Homebrew finished successfully.");
    await refreshLocalPackages();
    const updatedPackage = state.packages.find((item) => item.id === pkg.id) || pkg;
    state.selected = updatedPackage;
    renderDetail(updatedPackage);
  } catch (error) {
    setOperationLog(log, error.message || "Homebrew could not complete the request.");
  }
}

async function runBulkUpdate() {
  if (!window.cellarBrew || !state.brew.available || state.outdated.size === 0) return;

  const updateCount = state.outdated.size;
  const confirmation = `Update ${updateCount} Homebrew package${updateCount === 1 ? "" : "s"}? Cellar will run Homebrew's standard update command for all outdated formulae and casks.`;
  if (!confirm(confirmation)) return;

  renderBulkOperationPanel(updateCount);
  const log = elements.detailPanel.querySelector("#operationLog");
  setOperationLog(log, "Running brew upgrade...");
  setStatus(`Updating ${updateCount.toLocaleString()} Homebrew package${updateCount === 1 ? "" : "s"}...`);

  try {
    const result = await window.cellarBrew.upgradeAll();
    setOperationLog(log, result.output || "All available Homebrew updates finished successfully.");
    await refreshLocalPackages();
    setStatus("Bulk update finished.");
  } catch (error) {
    setOperationLog(log, error.message || "Homebrew could not complete the bulk update.");
    setStatus("Bulk update could not finish.");
  }
}

function renderBulkOperationPanel(updateCount) {
  openDetailPanel();
  elements.detailPanel.innerHTML = `
    <div class="detail-header">
      <div>
        <h2>Updating packages</h2>
        <p class="detail-meta">${updateCount.toLocaleString()} package${updateCount === 1 ? "" : "s"} selected by Homebrew</p>
      </div>
      <button class="panel-close-button" type="button" data-close-detail aria-label="Close package details">Close</button>
    </div>
    <div class="source-banner formula">
      <strong>Bulk update</strong><br>
      Cellar is using Homebrew's standard update behavior so dependencies and casks are handled the same way they are in Terminal.
    </div>
    <div class="detail-section">
      <h3>Command</h3>
      <div class="command-box">brew upgrade</div>
      <p class="small-text">This updates all outdated Homebrew formulae and casks that Homebrew considers eligible.</p>
    </div>
    <div class="detail-section">
      <h3>Activity</h3>
      <div class="command-box operation-log" id="operationLog">Waiting to start...</div>
    </div>
  `;

  elements.detailPanel.querySelector("[data-close-detail]").addEventListener("click", closeDetailPanel);
}

function commandForAction(action, pkg) {
  if (action === "uninstall") return pkg.uninstallCommand;
  if (action === "upgrade") return pkg.kind === "cask" ? `brew upgrade --cask ${pkg.token}` : `brew upgrade ${pkg.token}`;
  return pkg.command;
}

function setOperationLog(log, message) {
  if (log) log.textContent = message;
}

function installExplanation(pkg) {
  if (pkg.kind === "cask" && pkg.kindLabel !== "Font") {
    return "This is a cask. It installs a macOS app bundle through Homebrew Cask and may appear in Applications after installation.";
  }

  if (pkg.kindLabel === "Font") {
    return "This is a cask. It installs a font through Homebrew Cask and will not appear in Launchpad.";
  }

  if (pkg.service) {
    return "This is a formula. It installs a command-line package that can also run as a background service.";
  }

  return "This is a formula. It installs a command-line tool, runtime, or library into Homebrew and will not appear in Launchpad.";
}

function titleForState() {
  if (state.query) return "Search results";
  if (state.view === "all") return "All packages";
  if (state.view === "library") return "Library";
  return "Popular packages";
}

function updateStats() {
  const formulae = state.packages.filter((pkg) => pkg.kind === "formula");
  const casks = state.packages.filter((pkg) => pkg.kind === "cask");
  elements.formulaCount.textContent = formulae.length.toLocaleString();
  elements.caskCount.textContent = casks.length.toLocaleString();
  elements.installedCount.textContent = state.installed.size ? state.installed.size.toLocaleString() : "-";
}

function renderBrewHealth(status) {
  const actions = brewHealthActions();
  elements.brewHealth.className = `brew-health ${status}`;
  elements.brewHealth.innerHTML = `
    <strong>Homebrew status</strong>
    <span>${escapeHtml(state.brew.message)}</span>
    ${actions}
  `;

  const installButton = elements.brewHealth.querySelector("[data-homebrew-install]");
  if (installButton) {
    installButton.addEventListener("click", () => {
      const url = state.brew.installUrl || "https://brew.sh/";
      if (window.cellarBrew) window.cellarBrew.openLink(url);
      else window.open(url, "_blank", "noreferrer");
    });
  }

  const doctorButton = elements.brewHealth.querySelector("[data-brew-doctor]");
  if (doctorButton) {
    doctorButton.addEventListener("click", runDoctor);
  }
}

function brewHealthActions() {
  if (state.brew.available) {
    return `<button class="secondary-action compact-action" data-brew-doctor>Run Checkup</button>`;
  }

  if (state.brew.desktop) {
    return `<button class="primary-action compact-action" data-homebrew-install>Install Homebrew</button>`;
  }

  return "";
}

async function runDoctor() {
  if (!window.cellarBrew || !state.brew.available) return;
  setStatus("Running Homebrew checkup...");

  try {
    const result = await window.cellarBrew.doctor();
    const message = result.output || "Homebrew reports that your system is ready.";
    setStatus(message.split("\n")[0]);
    alert(message);
  } catch (error) {
    setStatus(error.message || "Homebrew checkup could not run.");
  }
}

function versionText(pkg) {
  const installed = state.installed.get(pkg.id);
  const outdated = state.outdated.get(pkg.id);
  if (outdated) return `Installed ${outdated.current} · Latest ${outdated.latest}`;
  if (installed) return `Installed ${installed.version}`;
  return `Latest ${pkg.version}`;
}

function iconForPackage(pkg) {
  if (pkg.kindLabel === "Mac App") return "A";
  if (pkg.kindLabel === "Font") return "F";
  if (pkg.kindLabel === "Service") return "S";
  return ">";
}

function setStatus(message) {
  elements.statusBar.textContent = message;
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  localStorage.setItem("cellarTheme", state.theme);
  elements.themeToggle.setAttribute("aria-pressed", String(state.theme === "dark"));
  elements.themeToggle.querySelector(".theme-toggle-text").textContent = state.theme === "dark" ? "Light Mode" : "Dark Mode";
}

function readTheme() {
  const saved = localStorage.getItem("cellarTheme");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value || "#");
}
