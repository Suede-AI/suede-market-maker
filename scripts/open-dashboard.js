#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.DASHBOARD_PORT || 8787);
const url = `http://localhost:${port}`;
const dashboardEntry = path.join(root, "dist", "dashboard.js");
const logPath = path.join(root, "dashboard.log");

function requestStatus() {
  return new Promise((resolve) => {
    const req = http.get(`${url}/api/status`, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ ok: res.statusCode === 200, body });
      });
    });

    req.on("error", () => resolve({ ok: false, body: "" }));
    req.setTimeout(700, () => {
      req.destroy();
      resolve({ ok: false, body: "" });
    });
  });
}

async function waitForDashboard(timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await requestStatus();
    if (status.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function openBrowser() {
  const opener = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(opener, args, { detached: true, stdio: "ignore" }).unref();
}

async function main() {
  if (!fs.existsSync(dashboardEntry)) {
    console.log("Building dashboard...");
    run("npm", ["run", "build"]);
  }

  const current = await requestStatus();
  if (!current.ok) {
    const out = fs.openSync(logPath, "a");
    const err = fs.openSync(logPath, "a");
    const child = spawn(process.execPath, [dashboardEntry], {
      cwd: root,
      detached: true,
      env: process.env,
      stdio: ["ignore", out, err],
    });
    child.unref();

    const ready = await waitForDashboard();
    if (!ready) {
      console.error(`Dashboard did not start. Check ${logPath}`);
      process.exit(1);
    }
    console.log(`Started Suede Market Maker dashboard on ${url}`);
  } else {
    console.log(`Suede Market Maker dashboard already running on ${url}`);
  }

  openBrowser();
  console.log("Opened local website. Start/stop the market maker from the dashboard.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
