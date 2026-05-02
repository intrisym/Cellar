const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const path = require("node:path");

const BREW_PATHS = [
  "/opt/homebrew/bin/brew",
  "/usr/local/bin/brew"
];

const MAX_BUFFER = 1024 * 1024 * 16;

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: "Cellar",
    backgroundColor: "#f5f5f7",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.loadFile("index.html");
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("brew:diagnose", async () => {
  const brewPath = findBrew();
  if (!brewPath) {
    return {
      installed: false,
      message: "Homebrew is not installed yet.",
      installUrl: "https://brew.sh/"
    };
  }

  const version = await runBrew(brewPath, ["--version"]);
  return {
    installed: true,
    path: brewPath,
    version: firstLine(version.stdout),
    message: "Homebrew is ready."
  };
});

ipcMain.handle("brew:installed", async () => {
  const brewPath = requireBrew();
  const [formulae, casks] = await Promise.all([
    runBrew(brewPath, ["info", "--json=v2", "--installed"]),
    runBrew(brewPath, ["info", "--json=v2", "--installed", "--cask"])
  ]);

  return {
    formulae: parseInstalledFormulae(formulae.stdout),
    casks: parseInstalledCasks(casks.stdout)
  };
});

ipcMain.handle("brew:outdated", async () => {
  const brewPath = requireBrew();
  const result = await runBrew(brewPath, ["outdated", "--json=v2"], { allowFailure: true });
  if (!result.stdout.trim()) return { formulae: [], casks: [] };
  return JSON.parse(result.stdout);
});

ipcMain.handle("brew:install", async (event, packageInfo) => {
  const brewPath = requireBrew();
  validatePackageInfo(packageInfo);
  const args = packageInfo.kind === "cask"
    ? ["install", "--cask", packageInfo.token]
    : ["install", packageInfo.token];
  return operationResult(await runBrewStreaming(event, brewPath, args, packageInfo.operationId));
});

ipcMain.handle("brew:uninstall", async (event, packageInfo) => {
  const brewPath = requireBrew();
  validatePackageInfo(packageInfo);
  const args = packageInfo.kind === "cask"
    ? ["uninstall", "--cask", packageInfo.token]
    : ["uninstall", packageInfo.token];
  return operationResult(await runBrewStreaming(event, brewPath, args, packageInfo.operationId));
});

ipcMain.handle("brew:upgrade", async (event, packageInfo) => {
  const brewPath = requireBrew();
  validatePackageInfo(packageInfo);
  const args = packageInfo.kind === "cask"
    ? ["upgrade", "--cask", packageInfo.token]
    : ["upgrade", packageInfo.token];
  return operationResult(await runBrewStreaming(event, brewPath, args, packageInfo.operationId));
});

ipcMain.handle("brew:upgrade-all", async (event, operationInfo = {}) => {
  const brewPath = requireBrew();
  return operationResult(await runBrewStreaming(event, brewPath, ["upgrade"], operationInfo.operationId));
});

ipcMain.handle("brew:doctor", async () => {
  const brewPath = requireBrew();
  return operationResult(await runBrew(brewPath, ["doctor"], { allowFailure: true }));
});

ipcMain.handle("link:open", (_event, url) => {
  if (typeof url === "string" && /^https:\/\/[a-z0-9.-]+\//i.test(url)) {
    shell.openExternal(url);
  }
});

function findBrew() {
  return BREW_PATHS.find((candidate) => {
    try {
      require("node:fs").accessSync(candidate);
      return true;
    } catch {
      return false;
    }
  });
}

function requireBrew() {
  const brewPath = findBrew();
  if (!brewPath) {
    throw new Error("Homebrew is not installed. Install Homebrew first, then reopen Cellar.");
  }
  return brewPath;
}

function runBrew(brewPath, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(brewPath, args, { maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      if (error && !options.allowFailure) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }

      resolve({
        code: error?.code || 0,
        stdout,
        stderr
      });
    });
  });
}

function runBrewStreaming(event, brewPath, args, operationId) {
  return new Promise((resolve, reject) => {
    const child = spawn(brewPath, args, {
      env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1" }
    });
    let stdout = "";
    let stderr = "";

    sendOperationProgress(event, operationId, {
      stage: "Preparing",
      progress: 8,
      output: `brew ${args.join(" ")}`
    });

    child.stdout.on("data", (chunk) => {
      const output = chunk.toString();
      stdout += output;
      sendOperationProgress(event, operationId, progressFromOutput(output));
    });

    child.stderr.on("data", (chunk) => {
      const output = chunk.toString();
      stderr += output;
      sendOperationProgress(event, operationId, progressFromOutput(output));
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      sendOperationProgress(event, operationId, {
        stage: code === 0 ? "Finished" : "Needs attention",
        progress: code === 0 ? 100 : 100,
        output: code === 0 ? "Homebrew finished successfully." : "Homebrew stopped before completing successfully.",
        done: true
      });

      if (code !== 0) {
        reject(new Error((stderr || stdout || `Homebrew exited with code ${code}`).trim()));
        return;
      }

      resolve({ code, stdout, stderr });
    });
  });
}

function sendOperationProgress(event, operationId, payload) {
  if (!operationId || event.sender.isDestroyed()) return;
  event.sender.send("brew:operation-progress", {
    operationId,
    ...payload
  });
}

function progressFromOutput(output) {
  const cleanOutput = output.trim();
  const percentMatch = cleanOutput.match(/(\d{1,3}(?:\.\d+)?)%/);
  if (percentMatch) {
    return {
      stage: "Downloading",
      progress: Math.min(92, Math.max(12, Number(percentMatch[1]))),
      output: cleanOutput
    };
  }

  return {
    stage: stageFromOutput(cleanOutput),
    progress: progressValueFromOutput(cleanOutput),
    output: cleanOutput
  };
}

function stageFromOutput(output) {
  if (/downloading|curl|fetching/i.test(output)) return "Downloading";
  if (/pouring|installing|linking|copying|moving/i.test(output)) return "Installing";
  if (/cleanup|caveats|summary|linking binary/i.test(output)) return "Finalizing";
  if (/removing|uninstalling|zap/i.test(output)) return "Removing";
  if (/upgrading|updating/i.test(output)) return "Updating";
  return "Working";
}

function progressValueFromOutput(output) {
  if (/downloading|curl|fetching/i.test(output)) return 32;
  if (/pouring|installing|linking|copying|moving/i.test(output)) return 68;
  if (/cleanup|caveats|summary|linking binary/i.test(output)) return 88;
  if (/removing|uninstalling|zap/i.test(output)) return 72;
  if (/upgrading|updating/i.test(output)) return 48;
  return 18;
}

function validatePackageInfo(packageInfo) {
  if (!packageInfo || !["formula", "cask"].includes(packageInfo.kind)) {
    throw new Error("Cellar can only install or remove Homebrew formulae and casks.");
  }

  if (typeof packageInfo.token !== "string" || !/^[a-zA-Z0-9_.+@-]+$/.test(packageInfo.token)) {
    throw new Error("Package token is not valid.");
  }
}

function parseInstalledFormulae(stdout) {
  const payload = JSON.parse(stdout || "{}");
  return (payload.formulae || []).map((item) => ({
    token: item.name,
    kind: "formula",
    version: item.installed?.[0]?.version || item.versions?.stable || "Unknown"
  }));
}

function parseInstalledCasks(stdout) {
  const payload = JSON.parse(stdout || "{}");
  return (payload.casks || []).map((item) => ({
    token: item.token,
    kind: "cask",
    version: item.installed || item.version || "Unknown"
  }));
}

function operationResult(result) {
  return {
    ok: result.code === 0,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
  };
}

function firstLine(value) {
  return String(value || "").split("\n").find(Boolean) || "Homebrew";
}
