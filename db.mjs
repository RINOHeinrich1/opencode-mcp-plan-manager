// db.mjs — Couche PostgreSQL de plan-manager.
//
// Persistance des plans d'action (granularité atomique) dans la base partagée
// PostgreSQL (même base que task-orchestrator). Les tables `plans`, `plan_steps`,
// `plan_incidents`, `plan_inconsistencies`, `plan_counters` sont le MIRROIR exact
// de `mcp/task-orchestrator/schema.sql`.
import pg from "pg";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { loadGlobalEnv } from "../../scripts/load-env.mjs";

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

// Charge le .env global AVANT de résoudre DATABASE_URL.
loadGlobalEnv();
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://orchestrator:orchestrator@localhost:5432/task_registry";

// --- Schéma (miroir de mcp/task-orchestrator/schema.sql, tables plans) --------
// `tasks` est recréée (IF NOT EXISTS) uniquement pour satisfaire la FK
// `plans.task_id → tasks(id)` si plan-manager ouvre la base en premier.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  request        TEXT NOT NULL,
  project        TEXT NOT NULL,
  workspace      TEXT,
  type           TEXT NOT NULL DEFAULT 'feature',
  priority       TEXT NOT NULL DEFAULT 'normal',
  deadline       TEXT,
  budget_maxsteps INTEGER,
  budget_maxcost TEXT,
  scope          TEXT,
  acceptance_criteria TEXT,
  constraints    TEXT,
  dependencies   TEXT,
  created_at     TEXT NOT NULL,
  created_by     TEXT,
  session_id     TEXT,
  recette_status TEXT NOT NULL DEFAULT 'pending',
  version        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plans (
  id            TEXT PRIMARY KEY,
  task_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  objective     TEXT NOT NULL,
  file          TEXT,
  absolute_path TEXT,
  deliverables  TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  branch        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_task ON plans(task_id);

CREATE TABLE IF NOT EXISTS plan_steps (
  plan_id    TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  step_id    TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'todo',
  note       TEXT,
  files      TEXT,
  updated_at TEXT,
  PRIMARY KEY (plan_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id);

CREATE TABLE IF NOT EXISTS plan_incidents (
  seq         INTEGER GENERATED ALWAYS AS IDENTITY,
  id          TEXT PRIMARY KEY,
  plan_id     TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  step_id     TEXT,
  severity    TEXT NOT NULL DEFAULT 'medium',
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  resolution  TEXT
);
CREATE INDEX IF NOT EXISTS idx_plan_incidents_plan ON plan_incidents(plan_id);

CREATE TABLE IF NOT EXISTS plan_inconsistencies (
  seq             INTEGER GENERATED ALWAYS AS IDENTITY,
  id              TEXT PRIMARY KEY,
  plan_id         TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  step_id         TEXT,
  related_plan_id TEXT,
  description     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_inconsistencies_plan ON plan_inconsistencies(plan_id);

CREATE TABLE IF NOT EXISTS plan_counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
`;

let _pool = null;
function pool() {
  if (_pool) return _pool;
  _pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
  return _pool;
}

let _schemaReady = false;
let _schemaPromise = null;
async function ensureSchema() {
  if (_schemaReady) return;
  if (!_schemaPromise) {
    _schemaPromise = (async () => {
      await pool().query(SCHEMA);
      // Phase 3 : fichiers par étape de plan (colonnes ajoutées après coup).
      await pool().query("ALTER TABLE plan_steps ADD COLUMN IF NOT EXISTS files TEXT");
      _schemaReady = true;
    })();
  }
  await _schemaPromise;
}

async function withTransaction(fn) {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export function nowIso() {
  return new Date().toISOString();
}

// Un plan doit être rattaché à une tâche existante (règle « aucun plan sans tâche »).
export async function taskExists(taskId) {
  if (!taskId) return false;
  await ensureSchema();
  const res = await pool().query("SELECT id FROM tasks WHERE id = $1", [taskId]);
  return !!res.rows[0];
}

// --- Compteurs globaux (INC-### / INCO-###) ---------------------------------
export async function nextCounter(name) {
  await ensureSchema();
  const res = await pool().query(
    `INSERT INTO plan_counters (name, value) VALUES ($1, 1)
     ON CONFLICT(name) DO UPDATE SET value = plan_counters.value + 1
     RETURNING value`,
    [name],
  );
  return res.rows[0].value;
}

// --- Progressions -----------------------------------------------------------
// `progress` = { stepId: { status, note, updatedAt } }
export function progressStats(progress) {
  const steps = Object.keys(progress || {});
  const by = (s) => steps.filter((k) => progress[k].status === s).length;
  const done = by("done");
  const skipped = by("skipped");
  const total = steps.length;
  const pct = total === 0 ? 0 : Math.round(((done + skipped) / total) * 100);
  return {
    total,
    done,
    skipped,
    in_progress: by("in_progress"),
    blocked: by("blocked"),
    todo: by("todo"),
    pct,
  };
}

// --- Plans ------------------------------------------------------------------
async function planStepsRows(planId) {
  const res = await pool().query("SELECT * FROM plan_steps WHERE plan_id = $1 ORDER BY position ASC", [planId]);
  return res.rows;
}

function parseFiles(raw) {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter(Boolean) : []; } catch { return []; }
}

async function rowToPlan(row) {
  if (!row) return null;
  const progress = {};
  const steps = [];
  for (const s of await planStepsRows(row.id)) {
    steps.push(s.step_id);
    progress[s.step_id] = { status: s.status, note: s.note || "", updatedAt: s.updated_at || "", files: parseFiles(s.files) };
  }
  const incRes = await pool().query("SELECT id FROM plan_incidents WHERE plan_id = $1 ORDER BY seq", [row.id]);
  const incoRes = await pool().query("SELECT id FROM plan_inconsistencies WHERE plan_id = $1 ORDER BY seq", [row.id]);
  return {
    id: row.id,
    taskId: row.task_id,
    objective: row.objective,
    file: row.file,
    absolutePath: row.absolute_path,
    deliverables: row.deliverables ? JSON.parse(row.deliverables) : [],
    status: row.status,
    branch: row.branch,
    createdAt: row.created_at,
    steps,
    stepFiles: Object.fromEntries(steps.map((s) => [s, progress[s].files])),
    progress,
    incidents: incRes.rows.map((r) => r.id),
    inconsistencies: incoRes.rows.map((r) => r.id),
  };
}

export async function createPlan({ id, taskId, objective, file, absolutePath, deliverables, steps, stepFiles }) {
  await ensureSchema();
  const filesByStep = stepFiles || {};
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO plans (id, task_id, objective, file, absolute_path, deliverables, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7)`,
      [id, taskId ?? null, objective, file ?? null, absolutePath ?? null, deliverables && deliverables.length ? JSON.stringify(deliverables) : null, nowIso()],
    );
    const list = steps || [];
    for (let i = 0; i < list.length; i++) {
      const files = filesByStep[list[i]] || [];
      await client.query(
        `INSERT INTO plan_steps (plan_id, step_id, position, status, note, files, updated_at)
         VALUES ($1,$2,$3,'todo',NULL,$4,NULL)`,
        [id, list[i], i, files.length ? JSON.stringify(files) : null],
      );
    }
  });
  return getPlan(id);
}

export async function getPlan(id) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM plans WHERE id = $1", [id]);
  return rowToPlan(res.rows[0]);
}

export async function requirePlan(id) {
  const p = await getPlan(id);
  if (!p) throw new Error(`plan inconnu : ${id}`);
  return p;
}

// Associe la branche git de la sous-tâche au plan (renseignée par build-notify).
export async function setPlanBranch(planId, branch) {
  await ensureSchema();
  const plan = await getPlan(planId);
  if (!plan) return null;
  await pool().query("UPDATE plans SET branch = $1 WHERE id = $2", [branch ?? null, planId]);
  return getPlan(planId);
}

export async function listPlans() {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM plans ORDER BY created_at DESC");
  return Promise.all(res.rows.map((row) => rowToPlan(row)));
}

export async function getPlanSteps(id) {
  await ensureSchema();
  const rows = await planStepsRows(id);
  return rows.map((s) => ({ stepId: s.step_id, position: s.position, status: s.status, note: s.note || "", updatedAt: s.updated_at || "", files: parseFiles(s.files) }));
}

// Parse le fichier Plan-*.md pour extraire { stepId: [fichiers] } (Phase 3).
// Colonne fichier DÉTECTÉE par contenu (un chemin avec extension / un `…/…`),
// pas par position fixe (le tableau peut avoir 6 ou 7 colonnes selon le plan).
function extractStepFilesFromFile(absPath) {
  if (!existsSync(absPath)) return {};
  const txt = readFileSync(absPath, "utf8");
  const out = {};
  const FILE_RE = /`([^`]*(?:\.(?:tsx?|jsx?|mjs|cjs|json|md|feature|css|html|sql|yml|yaml|py|vue))[^`]*)`|`([^`]*\/[^`]*)`/gi;
  const plausible = (p) => {
    const s = String(p || "").trim();
    if (!s || /\s/.test(s)) return false;
    if (s.startsWith("npm") || s.startsWith("git") || s.startsWith("yarn")) return false;
    return /\.(tsx?|jsx?|mjs|cjs|json|md|css|html|sql|ya?ml|py|vue|feature|env)$/i.test(s) || /\*\.([a-z0-9]+)$/i.test(s);
  };
  for (const line of txt.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (!cells.length || !/^[A-Z]\d{3}$/.test(cells[0])) continue;
    const all = [];
    for (const c of cells) {
      for (const m of c.matchAll(FILE_RE)) { const v = m[1] || m[2]; if (v && plausible(v)) all.push(v.trim()); }
    }
    if (!all.length) {
      for (const c of cells) {
        const m = /([A-Za-z0-9_\-./]+\.(?:tsx?|jsx?|mjs|cjs|md|json|css|feature))/.exec(c);
        if (m && plausible(m[1])) all.push(m[1]);
      }
    }
    if (all.length) out[cells[0]] = [...new Set(all.map((p) => p.replace(/^\.?\//, "")))];
  }
  return out;
}

// Backfill Phase 3 : pour les plans dont les étapes n'ont pas encore de fichiers,
// met à jour `plan_steps.files` depuis le fichier Plan-*.md (chemin absolu).
// Idempotent : ne traite que les étapes `files IS NULL`. Appelé au démarrage.
export async function backfillStepFiles() {
  await ensureSchema();
  const { rows } = await pool().query(
    "SELECT DISTINCT pl.id, pl.absolute_path FROM plan_steps ps JOIN plans pl ON pl.id = ps.plan_id WHERE ps.files IS NULL",
  );
  let updated = 0;
  for (const plan of rows) {
    if (!plan.absolute_path) continue;
    let stepFiles = {};
    try {
      stepFiles = await extractStepFilesFromFile(plan.absolute_path);
    } catch { stepFiles = {}; }
    if (!Object.keys(stepFiles).length) continue;
    for (const [stepId, files] of Object.entries(stepFiles)) {
      const r = await pool().query(
        "UPDATE plan_steps SET files = $1 WHERE plan_id = $2 AND step_id = $3 AND files IS NULL",
        [JSON.stringify(files), plan.id, stepId],
      );
      updated += r.rowCount;
    }
  }
  return { updated };
}

export async function updateStepStatus(planId, stepId, status, note) {
  await ensureSchema();
  const step = (await pool().query("SELECT * FROM plan_steps WHERE plan_id = $1 AND step_id = $2", [planId, stepId])).rows[0];
  if (!step) return null;
  await pool().query(
    `UPDATE plan_steps SET status = $1, note = $2, updated_at = $3 WHERE plan_id = $4 AND step_id = $5`,
    [status, note || "", nowIso(), planId, stepId],
  );
  return getPlan(planId);
}

export async function setPlanStatus(planId, status) {
  await ensureSchema();
  await pool().query("UPDATE plans SET status = $1 WHERE id = $2", [status, planId]);
  return getPlan(planId);
}

// --- Incidents --------------------------------------------------------------
function rowToIncident(r) {
  if (!r) return null;
  return {
    id: r.id,
    planId: r.plan_id,
    stepId: r.step_id,
    severity: r.severity,
    title: r.title,
    description: r.description,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolution: r.resolution,
  };
}

export async function createIncident({ planId, stepId, severity, title, description }) {
  await ensureSchema();
  const n = await nextCounter("incident");
  const id = `INC-${String(n).padStart(3, "0")}`;
  await pool().query(
    `INSERT INTO plan_incidents (id, plan_id, step_id, severity, title, description, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'open',$7)`,
    [id, planId, stepId ?? null, severity || "medium", title, description, nowIso()],
  );
  return getIncident(id);
}

export async function getIncident(id) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM plan_incidents WHERE id = $1", [id]);
  return rowToIncident(res.rows[0]);
}

export async function resolveIncident(id, resolution) {
  await ensureSchema();
  await pool().query(
    `UPDATE plan_incidents SET status = 'resolved', resolution = $1, resolved_at = $2 WHERE id = $3`,
    [resolution, nowIso(), id],
  );
  return getIncident(id);
}

export async function listIncidents({ planId, status } = {}) {
  await ensureSchema();
  let res;
  if (planId && status) res = await pool().query("SELECT * FROM plan_incidents WHERE plan_id = $1 AND status = $2 ORDER BY seq", [planId, status]);
  else if (planId) res = await pool().query("SELECT * FROM plan_incidents WHERE plan_id = $1 ORDER BY seq", [planId]);
  else if (status) res = await pool().query("SELECT * FROM plan_incidents WHERE status = $1 ORDER BY seq", [status]);
  else res = await pool().query("SELECT * FROM plan_incidents ORDER BY seq");
  return res.rows.map(rowToIncident);
}

// --- Incohérences -----------------------------------------------------------
function rowToInconsistency(r) {
  if (!r) return null;
  return {
    id: r.id,
    planId: r.plan_id,
    stepId: r.step_id,
    relatedPlanId: r.related_plan_id,
    description: r.description,
    status: r.status,
    createdAt: r.created_at,
  };
}

export async function createInconsistency({ planId, stepId, relatedPlanId, description }) {
  await ensureSchema();
  const n = await nextCounter("inconsistency");
  const id = `INCO-${String(n).padStart(3, "0")}`;
  await pool().query(
    `INSERT INTO plan_inconsistencies (id, plan_id, step_id, related_plan_id, description, status, created_at)
     VALUES ($1,$2,$3,$4,$5,'open',$6)`,
    [id, planId, stepId ?? null, relatedPlanId ?? null, description, nowIso()],
  );
  return getInconsistency(id);
}

export async function getInconsistency(id) {
  await ensureSchema();
  const res = await pool().query("SELECT * FROM plan_inconsistencies WHERE id = $1", [id]);
  return rowToInconsistency(res.rows[0]);
}

export async function listInconsistencies({ planId } = {}) {
  await ensureSchema();
  const res = planId
    ? await pool().query("SELECT * FROM plan_inconsistencies WHERE plan_id = $1 ORDER BY seq", [planId])
    : await pool().query("SELECT * FROM plan_inconsistencies ORDER BY seq");
  return res.rows.map(rowToInconsistency);
}
