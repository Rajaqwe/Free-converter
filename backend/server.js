const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const archiver = require("archiver");
const { spawnSync, execFile } = require("child_process");
const os = require("os");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");

const MAX_FILE_SIZE_MB = Math.max(1, Number(process.env.MAX_FILE_SIZE_MB || 50));
const configuredPenColors = Number.parseInt(process.env.HPGL_MAX_PEN_COLORS || "16", 10);
const HPGL_MAX_PEN_COLORS = Number.isFinite(configuredPenColors)
  ? Math.min(256, Math.max(2, configuredPenColors))
  : 16;
const RUNTIME = process.env.TEMP_DIR
  ? path.resolve(process.env.TEMP_DIR, "plt_runtime")
  : path.join(ROOT, "runtime");

const TMP = path.join(RUNTIME, "tmp");
const SOURCES = path.join(RUNTIME, "sources");

fs.mkdirSync(RUNTIME, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(SOURCES, { recursive: true });

app.disable("x-powered-by");

// CORS Configuration
const allowedOriginsEnv = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true;
  const o = origin.toLowerCase();
  if (allowedOriginsEnv.includes("*") || allowedOriginsEnv.includes(o)) return true;
  if (/^https:\/\/rajaqwe\.github\.io$/i.test(o)) return true;
  if (/^https:\/\/([a-z0-9-]+\.)?github\.io$/i.test(o)) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o)) return true;
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-File-Name, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// JSON body parser with limit
app.use(express.json({ limit: "15mb" }));

// Static public directory (fallback health/info page)
if (fs.existsSync(PUBLIC)) {
  app.use(express.static(PUBLIC));
}

const SOURCE_CACHE = new Map();

// Process-local executable discovery cache. The Render container does not change its
// converter installation during a process lifetime, so avoid repeatedly spawning
// "pstoedit -help"/"gs -version" for every request.
let CACHED_GS = null;
let CACHED_PSTOEDIT = null;
let CACHED_INKSCAPE = null;

function safeName(value) {
  return String(value || "output")
    .replace(/[\\/:*?"<>|\0]/g, "_")
    .replace(/\.\.+/g, ".")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "output";
}

function removeLater(file, ms = 30 * 60 * 1000) {
  setTimeout(() => {
    try { fs.rmSync(file, { force: true, recursive: true }); } catch {}
  }, ms).unref?.();
}

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}

function decodeHeaderName(value) {
  try { return decodeURIComponent(String(value || "artwork")); }
  catch { return String(value || "artwork"); }
}

function commandWorks(command, kind = "generic") {
  try {
    const lower = String(command).toLowerCase();
    if (kind === "pstoedit" || lower.includes("pstoedit")) {
      const r = spawnSync(command, ["-help"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      const text = String(r.stdout || "") + "\n" + String(r.stderr || "");
      return /pstoedit:\s*version|pstoedit.*dll interface|pstoedit/i.test(text);
    }
    const args = kind === "inkscape" || lower.includes("inkscape") ? ["--version"] : ["-version"];
    const r = spawnSync(command, args, { stdio: "ignore", windowsHide: true, timeout: 10000 });
    return !r.error && r.status === 0;
  } catch { return false; }
}

function whereCandidates(exeNames) {
  if (process.platform !== "win32") return [];
  const out = [];
  for (const name of exeNames) {
    try {
      const r = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      if (!r.error && r.status === 0) {
        for (const line of String(r.stdout || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean)) out.push(line);
      }
    } catch {}
  }
  return out;
}

function registryCandidates(exeName) {
  if (process.platform !== "win32") return [];
  const out = [];
  const keys = [
    `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
    `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`
  ];
  for (const key of keys) {
    try {
      const r = spawnSync("reg.exe", ["query", key, "/ve"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      if (r.error || r.status !== 0) continue;
      const lines = String(r.stdout || "").split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/REG_SZ\s+(.+)$/i);
        if (m) out.push(m[1].trim().replace(/^"|"$/g, ""));
      }
    } catch {}
  }
  return out;
}

function winProgramRoots() {
  return [process.env.ProgramFiles, process.env.ProgramW6432, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA, process.env.ProgramData].filter(Boolean);
}

function discoverCommand(envNames = [], commandNames = [], rootSpecs = []) {
  const candidates = [];
  const add = value => {
    const v = String(value || "").trim().replace(/^"|"$/g, "");
    if (v) candidates.push(v);
  };

  for (const envName of envNames || []) add(process.env[envName]);

  if (process.platform === "win32") {
    for (const value of whereCandidates(commandNames)) add(value);
    for (const name of commandNames || []) {
      const exe = /\.exe$/i.test(name) ? name : `${name}.exe`;
      for (const value of registryCandidates(exe)) add(value);
    }
  } else {
    for (const name of commandNames || []) {
      add(name);
      add(`/usr/bin/${name}`);
      add(`/usr/local/bin/${name}`);
    }
  }

  const roots = process.platform === "win32"
    ? winProgramRoots()
    : ["/usr", "/usr/local", "/opt", "/snap"];
  for (const root of roots.filter(Boolean)) {
    for (const spec of rootSpecs || []) {
      const folder = spec?.folder || "";
      const files = Array.isArray(spec?.files) ? spec.files : [];
      const base = path.join(root, folder);
      for (const file of files) add(path.join(base, file));
      if (process.platform === "win32" && fs.existsSync(base)) {
        try {
          for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const versionBase = path.join(base, entry.name);
            for (const file of files) add(path.join(versionBase, file));
          }
        } catch {}
      }
    }
  }

  for (const name of commandNames || []) add(name);

  const seen = new Set();
  for (const candidate of candidates) {
    const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    if (commandWorks(candidate, inferCommandKind(candidate))) return candidate;
  }
  return null;
}

function inferCommandKind(command) {
  const lower = String(command || "").toLowerCase();
  if (lower.includes("pstoedit")) return "pstoedit";
  if (lower.includes("inkscape")) return "inkscape";
  if (lower.includes("gswin") || lower === "gs" || /(^|[\\/])gs([\\/]|$)/i.test(command)) return "ghostscript";
  return "generic";
}

function findPstoedit() {
  if (CACHED_PSTOEDIT) return CACHED_PSTOEDIT;
  if (process.platform !== "win32") {
    CACHED_PSTOEDIT = discoverCommand(["PSTOEDIT_EXE", "PSTOEDIT"], ["pstoedit"], []);
    return CACHED_PSTOEDIT;
  }
  const candidates = [];
  if (process.env.PSTOEDIT_EXE) candidates.push(process.env.PSTOEDIT_EXE);
  candidates.push(...whereCandidates(["pstoedit.exe", "pstoedit"]));
  candidates.push(...registryCandidates("pstoedit.exe"));
  for (const root of winProgramRoots()) {
    const dirs = [
      "pstoedit", "pstoedit\\bin", "pstoedit 4.02", "pstoedit 4.01", "pstoedit 4.00",
      "pstoedit-4.02", "pstoedit-4.01", "pstoedit-4.00", "pstoedit_4.02", "pstoedit_4.01"
    ];
    for (const d of dirs) {
      const base = path.join(root, d);
      candidates.push(path.join(base, "pstoedit.exe"));
      candidates.push(path.join(base, "bin", "pstoedit.exe"));
      candidates.push(path.join(base, "x64", "pstoedit.exe"));
    }
  }
  const seen = new Set();
  for (const command of candidates) {
    if (!command || seen.has(command)) continue;
    seen.add(command);
    if (fs.existsSync(command) && commandWorks(command, "pstoedit")) {
      CACHED_PSTOEDIT = command;
      return command;
    }
  }
  return null;
}

function findGhostscript() {
  if (CACHED_GS) return CACHED_GS;
  CACHED_GS = discoverCommand(
    ["GSWIN64C", "GSWIN32C", "GS_EXE", "GS"],
    process.platform === "win32" ? ["gswin64c.exe", "gswin32c.exe", "gswin64c", "gswin32c"] : ["gs"],
    [{ folder: "gs", files: [path.join("bin", "gswin64c.exe"), path.join("bin", "gswin32c.exe"), "gswin64c.exe", "gswin32c.exe"] }]
  );
  return CACHED_GS;
}

function findInkscape() {
  if (CACHED_INKSCAPE) return CACHED_INKSCAPE;
  CACHED_INKSCAPE = discoverCommand(
    ["INKSCAPE_EXE"],
    process.platform === "win32" ? ["inkscape.exe", "inkscape"] : ["inkscape"],
    [{ folder: "Inkscape", files: [path.join("bin", "inkscape.exe"), "inkscape.exe"] }]
  );
  return CACHED_INKSCAPE;
}

function makeTempPath(ext) {
  return path.join(TMP, `${makeId()}${ext}`);
}

function isPdfBuffer(buffer) {
  return Buffer.isBuffer(buffer) && /^%PDF-/i.test(buffer.subarray(0, Math.min(32, buffer.length)).toString("latin1"));
}

function isPdfFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(8);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    return /^%PDF-/i.test(header.subarray(0, bytesRead).toString("latin1"));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 32 * 1024 * 1024,
      ...options
    }, (error, stdout, stderr) => {
      if (error) {
        const tail = String(stderr || stdout || error.message).trim().slice(-1000);
        reject(new Error(`Conversion tool failed: ${tail}`));
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

async function convertAiToPdf(inputPath, outputPath) {
  const gs = findGhostscript();
  if (gs) {
    await execFileAsync(gs, ["-dBATCH", "-dNOPAUSE", "-dSAFER", "-dUseCropBox", "-sDEVICE=pdfwrite", `-sOutputFile=${outputPath}`, inputPath]);
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100) return { engine: "Ghostscript", outputPath };
  }
  const inkscape = findInkscape();
  if (inkscape) {
    await execFileAsync(inkscape, [inputPath, "--export-type=pdf", `--export-filename=${outputPath}`]);
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100) return { engine: "Inkscape", outputPath };
  }
  throw new Error("AI files require Ghostscript or Inkscape for conversion. Service is not configured for native AI.");
}

async function convertCdrToPdf(inputPath, outputPath) {
  const inkscape = findInkscape();
  if (!inkscape) {
    throw new Error("CDR import requires Inkscape with libcdr support, which is not available on this server.");
  }

  try {
    // Export all imported pages where supported. Compatibility varies by CDR
    // version and effects, so validate the resulting PDF below.
    await execFileAsync(inkscape, [
      inputPath,
      "--export-page=all",
      "--export-type=pdf",
      `--export-filename=${outputPath}`
    ], { timeout: 180000 });

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100 && isPdfFile(outputPath)) {
      return { engine: "Inkscape/libcdr", outputPath };
    }
  } catch (e) {
    fs.rmSync(outputPath, { force: true });
    throw new Error(`Inkscape could not import this CDR file. Try re-saving it from CorelDRAW 2022 or exporting it as PDF. Details: ${e.message}`);
  }

  fs.rmSync(outputPath, { force: true });
  throw new Error("CDR import did not produce a valid PDF. This CDR version or one of its effects may not be supported by the hosted importer.");
}

async function makePreviewPdf(sourcePath, sourceType, outputPath) {
  if (sourceType === "PDF") {
    fs.copyFileSync(sourcePath, outputPath);
    return { engine: "Original PDF" };
  }
  if (sourceType === "AI") return convertAiToPdf(sourcePath, outputPath);
  if (sourceType === "CDR") return convertCdrToPdf(sourcePath, outputPath);
  throw new Error(`Unsupported source format: ${sourceType}`);
}

function sanitizeUnits(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 40;
  return Math.min(500, Math.max(1, n));
}

function hpglHasDrawing(text) {
  return /(?:^|;)PD-?\d/i.test(text) || /PD-?\d/i.test(text);
}

function pagePsBody(psText) {
  const pageMatch = psText.match(/%%Page:\s*1\s+1[\s\S]*?%%EndPageSetup([\s\S]*?)%%PageTrailer/);
  const body = pageMatch ? pageMatch[1] : psText;
  const streams = [...body.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map(m => m[1]);
  return streams.length ? streams.join("\n") : body;
}

function rasterStatsFromPs(psText) {
  const content = pagePsBody(psText);
  const inlineImageOps = (content.match(/(?:^|[\s;])BI(?:[\s]|$)/g) || []).length;
  const imageOperators = (content.match(/(?:^|[\s;])(?:image|colorimage|imagemask)(?:[\s]|$)/gi) || []).length;
  const imageDefinitions = (content.match(/\/Subtype\s*\/Image\b/gi) || []).length;
  const imageOps = inlineImageOps + imageOperators + imageDefinitions;
  return { imageOps, hasRaster: imageOps > 0 };
}

function fallbackVectorStatsFromPs(psText) {
  const content = pagePsBody(psText);
  const pathOps = (content.match(/(?:^|[\s])(?:m|l|c|v|y|h|re|moveto|lineto|curveto|closepath)(?=[\s]|$)/g) || []).length;
  const paintOps = (content.match(/(?:^|[\s])(?:S|s|f|F|f\*|B|b|B\*|b\*)(?=[\s]|$)/g) || []).length;
  const { imageOps, hasRaster } = rasterStatsFromPs(psText);
  const textOps = (content.match(/(?:^|[\s])(?:BT|ET|Tj|TJ|show)(?=[\s]|$)/g) || []).length;
  return { pathOps, paintOps, imageOps, textOps, hasRaster, cuttable: pathOps > 0 && paintOps > 0 && !hasRaster };
}

async function pageToPs(source, page, outPs) {
  const gs = findGhostscript();
  if (!gs) throw new Error("Ghostscript is not installed or available on the server.");

  source.psCache = source.psCache || new Map();
  source.psPromises = source.psPromises || new Map();

  if (source.psCache.has(page)) {
    const cached = source.psCache.get(page);
    if (cached && fs.existsSync(cached)) return cached;
    source.psCache.delete(page);
  }

  if (source.psPromises.has(page)) return source.psPromises.get(page);

  const promise = (async () => {
    await execFileAsync(gs, [
      "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET", "-dUseCropBox",
      `-dFirstPage=${page}`, `-dLastPage=${page}`,
      "-sDEVICE=ps2write", `-sOutputFile=${outPs}`, source.pdfPath
    ]);
    if (!fs.existsSync(outPs) || fs.statSync(outPs).size < 100) {
      fs.rmSync(outPs, { force: true });
      throw new Error("Ghostscript produced no usable vector page data.");
    }
    source.psCache.set(page, outPs);
    source.tempFiles.add(outPs);
    return outPs;
  })();

  source.psPromises.set(page, promise);
  try {
    return await promise;
  } finally {
    source.psPromises.delete(page);
  }
}

async function pstoeditPage(source, page, unitsPerMm) {
  const psto = findPstoedit();
  if (!psto) return null;
  const gs = findGhostscript();
  if (!gs) throw new Error("Ghostscript is required by pstoedit for vector conversion.");

  // HP-GL's conventional coordinate density is 40 plotter units/mm. The UI's
  // Units/mm value is retained for compatibility but must NOT scale the physical
  // artwork size. The previous units/40 factor caused 80 to become 2x geometry.
  sanitizeUnits(unitsPerMm);
  const cacheKey = String(page);

  source.pltCache = source.pltCache || new Map();
  source.pltPromises = source.pltPromises || new Map();

  const cached = source.pltCache.get(cacheKey);
  if (cached && fs.existsSync(cached.outPath)) {
    return {
      hpgl: fs.readFileSync(cached.outPath, "utf8"),
      engine: "pstoedit",
      outPath: cached.outPath,
      hasRaster: cached.hasRaster,
      imageOps: cached.imageOps
    };
  }

  if (source.pltPromises.has(cacheKey)) return source.pltPromises.get(cacheKey);

  const out = makeTempPath(".plt");
  const promise = (async () => {
    const tempPs = await pageToPs(source, page, makeTempPath(".ps"));
    try {
      // Deliberately omit -xscale/-yscale. This keeps physical dimensions
      // identical whether the UI shows 40, 80, or another Units/mm value.
      // Preserve distinct source stroke colours as separate HPGL pen selections
      // (SP1, SP2, ...), allowing common cutline/bleed colour separations.
      // Actual physical/display colours depend on the receiving software's pen map.
      await execFileAsync(psto, [
        "-q", "-f", `hpgl:-pencolors ${HPGL_MAX_PEN_COLORS}`, "-gs", gs,
        "-page", "1", tempPs, out
      ]);
      if (!fs.existsSync(out)) throw new Error("pstoedit did not generate output file.");

      const hpgl = fs.readFileSync(out, "utf8");
      const raster = rasterStatsFromPs(fs.readFileSync(tempPs, "utf8"));
      source.pltCache.set(cacheKey, {
        outPath: out,
        hasRaster: raster.hasRaster,
        imageOps: raster.imageOps
      });
      source.tempFiles.add(out);

      return { hpgl, engine: "pstoedit", outPath: out, hasRaster: raster.hasRaster, imageOps: raster.imageOps };
    } catch (e) {
      fs.rmSync(out, { force: true });
      throw e;
    }
  })();

  source.pltPromises.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    source.pltPromises.delete(cacheKey);
  }
}

async function analyzePage(source, page) {
  source.analysisCache = source.analysisCache || new Map();
  if (source.analysisCache.has(page)) return source.analysisCache.get(page);

  // Page analysis only needs path/raster statistics. Avoid generating a full
  // PLT for every page before the user selects it. The cached PostScript page
  // is reused later by pstoedit when conversion is requested.
  const psPath = await pageToPs(source, page, makeTempPath(".ps"));
  const stats = fallbackVectorStatsFromPs(fs.readFileSync(psPath, "utf8"));
  const result = {
    ...stats,
    painted: stats.paintOps,
    drawingCommands: stats.pathOps,
    images: stats.imageOps,
    raster: stats.hasRaster,
    engine: "Ghostscript vector analysis"
  };
  source.analysisCache.set(page, result);
  return result;
}

async function generatePlt(source, page, unitsPerMm) {
  const p = await pstoeditPage(source, page, unitsPerMm);
  if (p) {
    if (p.hasRaster) {
      fs.rmSync(p.outPath, { force: true });
      throw new Error("This page contains raster/bitmap artwork which cannot be converted to vector PLT.");
    }
    if (!hpglHasDrawing(p.hpgl)) {
      fs.rmSync(p.outPath, { force: true });
      throw new Error("No cuttable vector paths found on this page.");
    }
    const stat = fs.statSync(p.outPath);
    return { hpgl: p.hpgl, engine: "pstoedit", bytes: stat.size, temp: null };
  }
  throw new Error("Conversion engine (pstoedit + Ghostscript) is unavailable on the server.");
}

function storePlt(name, content) {
  const id = makeId();
  const finalName = safeName(name).replace(/\.(plt|hpgl)$/i, "") + ".PLT";
  const diskPath = path.join(RUNTIME, `${id}__${finalName}`);
  fs.writeFileSync(diskPath, content, "utf8");
  removeLater(diskPath);
  return { id, name: finalName, diskPath };
}

function uniqueZipName(name, used) {
  const base = safeName(name).replace(/\.plt$/i, "") || "output";
  let candidate = `${base}.PLT`;
  let i = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base} (${i++}).PLT`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function sourceById(id) {
  if (!/^[a-f0-9]{24}$/i.test(String(id || ""))) throw new Error("Invalid source id.");
  const source = SOURCE_CACHE.get(String(id));
  if (!source) throw new Error("Source file expired or not found. Please upload again.");
  return source;
}

function cleanupSource(source) {
  SOURCE_CACHE.delete(source.id);
  const files = new Set([
    source.originalPath,
    source.pdfPath,
    ...(source.tempFiles || [])
  ]);
  for (const file of files) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
}

function sweepOldFiles() {
  const maxAge = 30 * 60 * 1000;
  const now = Date.now();
  for (const [id, src] of SOURCE_CACHE.entries()) {
    if (now - src.createdAt > maxAge) {
      cleanupSource(src);
    }
  }
  for (const dir of [TMP, SOURCES, RUNTIME]) {
    try {
      const files = fs.readdirSync(dir, { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile()) continue;
        const p = path.join(dir, f.name);
        try {
          const s = fs.statSync(p);
          if (now - s.mtimeMs > maxAge) {
            fs.rmSync(p, { force: true });
          }
        } catch {}
      }
    } catch {}
  }
}
setInterval(sweepOldFiles, 10 * 60 * 1000).unref?.();

function safeEngineCall(fn) {
  try { return fn() || null; } catch (e) { return null; }
}

// ----------------- ROUTES -----------------

app.get("/", (req, res) => {
  const gs = !!safeEngineCall(findGhostscript);
  const psto = !!safeEngineCall(findPstoedit);
  res.json({
    ok: true,
    service: "pdf-ai-cdr-to-plt-backend",
    status: gs && psto ? "operational" : "degraded",
    pltReady: gs && psto,
    health: "/api/health"
  });
});

app.get("/api/ping", (req, res) => res.json({ ok: true, timestamp: Date.now() }));

app.get("/api/health", (req, res) => {
  try {
    const gs = safeEngineCall(findGhostscript);
    const psto = safeEngineCall(findPstoedit);
    const inkscape = safeEngineCall(findInkscape);
    const pltReady = !!psto && !!gs;

    res.json({
      ok: true,
      service: "pdf-ai-cdr-to-plt-backend",
      pltReady,
      converters: {
        ghostscript: !!gs,
        ghostscriptPath: gs ? path.basename(gs) : null,
        pstoedit: !!psto,
        pstoeditPath: psto ? path.basename(psto) : null,
        inkscape: !!inkscape,
        inkscapePath: inkscape ? path.basename(inkscape) : null,
        cdrImporter: !!inkscape
      },
      aiReady: !!gs || !!inkscape,
      cdrImporterReady: !!inkscape,
      hpglMaxPenColors: HPGL_MAX_PEN_COLORS,
      platform: os.platform(),
      uptime: Math.floor(process.uptime()),
      maxFileSizeMb: MAX_FILE_SIZE_MB
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Upload route with raw parser and payload size limit
const rawUploadParser = express.raw({
  type: "*/*",
  limit: `${MAX_FILE_SIZE_MB}mb`
});

app.post("/api/source", (req, res, next) => {
  rawUploadParser(req, res, err => {
    if (err) {
      if (err.type === "entity.too.large") {
        return res.status(413).json({ error: `File too large. Maximum allowed size is ${MAX_FILE_SIZE_MB}MB.` });
      }
      return res.status(400).json({ error: "Malformed upload request." });
    }
    next();
  });
}, async (req, res) => {
  try {
    const originalName = safeName(decodeHeaderName(req.get("x-file-name") || "artwork"));
    const type = /\.cdr$/i.test(originalName) ? "CDR" : /\.ai$/i.test(originalName) ? "AI" : /\.pdf$/i.test(originalName) ? "PDF" : null;
    if (!type) return res.status(400).json({ error: "Only .PDF, .AI and .CDR files are accepted." });

    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!data.length) return res.status(400).json({ error: "Uploaded file is empty." });
    if (type === "PDF" && !isPdfBuffer(data)) {
      return res.status(422).json({ error: "The file does not contain a valid PDF structure." });
    }

    const id = makeId();
    const originalExt = type === "CDR" ? ".cdr" : type === "AI" ? ".ai" : ".pdf";
    const originalPath = path.join(SOURCES, `${id}${originalExt}`);
    const pdfPath = path.join(SOURCES, `${id}.pdf`);
    fs.writeFileSync(originalPath, data);

    try {
      let previewEngine = "Original PDF";
      if (type === "PDF") {
        fs.copyFileSync(originalPath, pdfPath);
      } else {
        const converted = await makePreviewPdf(originalPath, type, pdfPath);
        previewEngine = converted.engine;
      }
      const source = {
        id,
        name: originalName,
        type,
        originalPath,
        pdfPath,
        previewEngine,
        createdAt: Date.now(),
        psCache: new Map(),
        psPromises: new Map(),
        pltCache: new Map(),
        pltPromises: new Map(),
        analysisCache: new Map(),
        tempFiles: new Set()
      };
      SOURCE_CACHE.set(id, source);
      setTimeout(() => cleanupSource(source), 30 * 60 * 1000).unref?.();

      res.json({
        ok: true,
        id,
        name: originalName,
        type,
        pdfUrl: `/api/source/${id}/pdf`,
        previewEngine,
        pstoedit: !!findPstoedit()
      });
    } catch (e) {
      fs.rmSync(originalPath, { force: true });
      fs.rmSync(pdfPath, { force: true });
      res.status(422).json({ error: e.message || "Failed to process source file." });
    }
  } catch (err) {
    res.status(500).json({ error: "Internal processing error." });
  }
});

app.get("/api/source/:id/pdf", (req, res) => {
  try {
    const source = sourceById(req.params.id);
    if (!fs.existsSync(source.pdfPath)) throw new Error("File expired. Please upload again.");
    res.sendFile(source.pdfPath);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.get("/api/source/:id/analyze/:page", async (req, res) => {
  try {
    const source = sourceById(req.params.id);
    const page = Number(req.params.page);
    if (!Number.isInteger(page) || page < 1) return res.status(400).json({ error: "Invalid page parameter." });
    const stats = await analyzePage(source, page);
    res.json({ ok: true, ...stats });
  } catch (e) {
    res.status(422).json({ error: e.message || "Vector analysis failed." });
  }
});

app.get("/api/source/:id/plt/:page", async (req, res) => {
  try {
    const source = sourceById(req.params.id);
    const page = Number(req.params.page);
    if (!Number.isInteger(page) || page < 1) return res.status(400).json({ error: "Invalid page parameter." });
    if (!findPstoedit() || !findGhostscript()) {
      return res.status(503).json({ error: "PLT conversion engine (pstoedit + Ghostscript) is currently unavailable on this server." });
    }
    const units = sanitizeUnits(req.query.units);
    const result = await generatePlt(source, page, units);
    const base = safeName(source.name.replace(/\.(pdf|ai|cdr)$/i, ""));
    const name = `${base}_page_${String(page).padStart(2, "0")}.PLT`;
    const stored = storePlt(name, result.hpgl);
    // Keep the generated/cached PLT alive until the normal runtime cleanup. The cache uses temp: null.
    res.json({
      ok: true,
      id: stored.id,
      name: stored.name,
      downloadUrl: `/api/file/${stored.id}/${encodeURIComponent(stored.name)}`,
      bytes: result.bytes,
      engine: result.engine
    });
  } catch (e) {
    res.status(422).json({ error: e.message || "PLT conversion failed." });
  }
});

app.get("/api/file/:id/:name", (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[a-f0-9]{24}$/i.test(id)) return res.status(400).json({ error: "Invalid file identifier." });
  const match = fs.readdirSync(RUNTIME).find(x => x.startsWith(id + "__"));
  if (!match) return res.status(404).json({ error: "File expired or not found." });
  res.download(path.join(RUNTIME, match), safeName(req.params.name));
});

app.post("/api/batch-zip", async (req, res) => {
  try {
    const jobs = Array.isArray(req.body?.jobs) ? req.body.jobs : [];
    if (!jobs.length) return res.status(400).json({ error: "No pages selected for batch export." });
    if (jobs.length > 100) return res.status(400).json({ error: "Batch export is limited to 100 pages per request." });
    if (!findPstoedit() || !findGhostscript()) {
      return res.status(503).json({ error: "Conversion engine (pstoedit + Ghostscript) is unavailable." });
    }
    const units = sanitizeUnits(req.body?.units);
    const zipId = makeId();
    const zipPath = path.join(RUNTIME, `PLT-Batch-${zipId}.zip`);
    const output = fs.createWriteStream(zipPath);
    // Speed up temporary HPGL ZIP creation; PLT is already compact vector text.
    const archive = archiver("zip", { zlib: { level: 1 } });

    let settled = false;
    const fail = err => {
      if (settled) return;
      settled = true;
      try { archive.abort(); } catch {}
      try { output.destroy(); } catch {}
      try { fs.rmSync(zipPath, { force: true }); } catch {}
      if (!res.headersSent) res.status(500).json({ error: err.message || "ZIP archiving error" });
    };

    output.on("close", () => {
      if (settled) return;
      settled = true;
      removeLater(zipPath);
      res.json({ ok: true, fileCount: jobs.length, downloadUrl: `/api/zip/${zipId}` });
    });
    archive.on("error", fail);
    output.on("error", fail);
    archive.pipe(output);

    const workerCount = 2;
    let nextJob = 0;
    const used = new Set();

    async function batchWorker() {
      while (true) {
        const i = nextJob++;
        if (i >= jobs.length) return;
        const job = jobs[i] || {};
        let source;
        try { source = sourceById(job.sourceId); } catch (e) { throw new Error(`Batch item ${i + 1}: ${e.message}`); }
        const page = Number(job.page);
        if (!Number.isInteger(page) || page < 1) throw new Error(`Batch item ${i + 1}: invalid page.`);
        const result = await generatePlt(source, page, units);
        if (settled) return;
        const base = safeName(source.name.replace(/\.(pdf|ai|cdr)$/i, ""));
        const name = uniqueZipName(`${base}_page_${String(page).padStart(2, "0")}.PLT`, used);
        // Append as each conversion completes instead of retaining all HPGL
        // strings until the slowest conversion finishes.
        archive.append(result.hpgl, { name });
      }
    }

    try {
      await Promise.all(
        Array.from({ length: Math.min(workerCount, jobs.length) }, () => batchWorker())
      );
      await archive.finalize();
    } catch (e) {
      fail(e);
    }
  } catch (e) {
    if (!res.headersSent) res.status(422).json({ error: e.message || "Batch export failed." });
  }
});

app.get("/api/zip/:id", (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[a-f0-9]{24}$/i.test(id)) return res.status(400).json({ error: "Invalid ZIP identifier." });
  const zip = path.join(RUNTIME, `PLT-Batch-${id}.zip`);
  if (!fs.existsSync(zip)) return res.status(404).json({ error: "ZIP file expired or not found." });
  res.download(zip, "PLT-Batch.zip");
});

// Generic 404 handler for API routes
app.all("/api/*", (req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});

app.listen(PORT, HOST, () => {
  const gs = safeEngineCall(findGhostscript);
  const psto = safeEngineCall(findPstoedit);
  console.log(`PDF + AI -> PLT backend running on http://${HOST}:${PORT}`);
  console.log(`Ghostscript: ${gs || "NOT FOUND"}`);
  console.log(`pstoedit: ${psto || "NOT FOUND"}`);
});
