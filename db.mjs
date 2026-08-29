// db.mjs — Couche SQLite de plan-manager.
//
// Persistance des plans d'action (granularité atomique) dans la base partagée
// `registry.db` (même base que task-orchestrator). La nature des plans ne
// change pas : seul le support de persistance passe des fichiers
// (`plans/.plan-manager/*`) à SQLite. Les tables `plans`, `plan_steps`,
// `plan_incidents`, `plan_inconsistencies`, `plan_counters` sont le MIRROIR
// exact de `mcp/task-orchestrator/schema.sql`.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadGlobalEnv } from "../../scripts/load-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(homedir(), ".config", "opencode", "task-registry");

// Charge le .env global AVANT de résoudre DB_PATH (TASK_REGISTRY_DB).
loadGlobalEnv();
const DB_PATH = process.env.TASK_REGISTRY_DB || join(DATA_DIR, "registry.db");

// --- Schéma (miroir de mcp/task-orchestrator/schema.sql) --------------------
// `tasks` est recréée (IF NOT EXISTS) uniquement pour satisfaire la FK
// `plans.task_id → tasks(id)` si plan-manager ouvre la base en premier.
const SCHEMA = `
PRAGMA foreign_keys = ON;

-- Miroir: mcp/task-orchestrator/schema.sql
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
  updated_at TEXT,
  PRIMARY KEY (plan_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id);

CREATE TABLE IF NOT EXISTS plan_incidents (
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

let _db = null;

export function nowIso() {
  return new Date().toISOString();
}

export function openDb() {
  if (_db) return _db;
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.exec(SCHEMA);
  migrate(_db);
  return _db;
}

// Migrations idempotentes (colonnes ajoutées après coup).
function migrate(db) {
  const cols = db.prepare("PRAGMA table_info(plans)").all().map((c) => c.name);
  if (!cols.includes("branch")) {
    db.exec("ALTER TABLE plans ADD COLUMN branch TEXT");
  }
}

// Un plan doit être rattaché à une tâche existante (règle « aucun plan sans tâche »).
export function taskExists(taskId) {
  if (!taskId) return false;
  return !!openDb().prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
}

// --- Compteurs globaux (INC-### / INCO-###) ---------------------------------
export function nextCounter(name) {
  const db = openDb();
  const row = db
    .prepare(
      `INSERT INTO plan_counters (name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get(name);
  return row.value;
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
function planStepsRows(db, planId) {
  return db.prepare("SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY position ASC").all(planId);
}

function rowToPlan(db, row) {
  if (!row) return null;
  const progress = {};
  const steps = [];
  for (const s of planStepsRows(db, row.id)) {
    steps.push(s.step_id);
    progress[s.step_id] = { status: s.status, note: s.note || "", updatedAt: s.updated_at || "" };
  }
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
    progress,
    incidents: db.prepare("SELECT id FROM plan_incidents WHERE plan_id = ? ORDER BY rowid").all(row.id).map((r) => r.id),
    inconsistencies: db.prepare("SELECT id FROM plan_inconsistencies WHERE plan_id = ? ORDER BY rowid").all(row.id).map((r) => r.id),
  };
}

export function createPlan({ id, taskId, objective, file, absolutePath, deliverables, steps }) {
  const db = openDb();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO plans (id, task_id, objective, file, absolute_path, deliverables, status, created_at)
       VALUES (@id, @task_id, @objective, @file, @absolute_path, @deliverables, 'active', @created_at)`,
    ).run({
      id,
      task_id: taskId ?? null,
      objective,
      file: file ?? null,
      absolute_path: absolutePath ?? null,
      deliverables: deliverables && deliverables.length ? JSON.stringify(deliverables) : null,
      created_at: nowIso(),
    });
    const ins = db.prepare(
      `INSERT INTO plan_steps (plan_id, step_id, position, status, note, updated_at)
       VALUES (@plan_id, @step_id, @position, 'todo', NULL, NULL)`,
    );
    (steps || []).forEach((s, i) => ins.run({ plan_id: id, step_id: s, position: i }));
  });
  tx();
  return getPlan(id);
}

export function getPlan(id) {
  const db = openDb();
  return rowToPlan(db, db.prepare("SELECT * FROM plans WHERE id = ?").get(id));
}

export function requirePlan(id) {
  const p = getPlan(id);
  if (!p) throw new Error(`plan inconnu : ${id}`);
  return p;
}

// Associe la branche git de la sous-tâche au plan (renseignée par build-notify).
export function setPlanBranch(planId, branch) {
  const db = openDb();
  const plan = getPlan(planId);
  if (!plan) return null;
  db.prepare("UPDATE plans SET branch = @branch WHERE id = @id").run({ branch: branch ?? null, id: planId });
  return getPlan(planId);
}

export function listPlans() {
  const db = openDb();
  return db
    .prepare("SELECT * FROM plans ORDER BY created_at DESC")
    .all()
    .map((row) => rowToPlan(db, row));
}

export function getPlanSteps(id) {
  const db = openDb();
  return planStepsRows(db, id).map((s) => ({ stepId: s.step_id, position: s.position, status: s.status, note: s.note || "", updatedAt: s.updated_at || "" }));
}

export function updateStepStatus(planId, stepId, status, note) {
  const db = openDb();
  const step = db.prepare("SELECT * FROM plan_steps WHERE plan_id = ? AND step_id = ?").get(planId, stepId);
  if (!step) return null;
  db.prepare(
    `UPDATE plan_steps SET status = @status, note = @note, updated_at = @updated_at
     WHERE plan_id = @plan_id AND step_id = @step_id`,
  ).run({ status, note: note || "", updated_at: nowIso(), plan_id: planId, step_id: stepId });
  return getPlan(planId);
}

export function setPlanStatus(planId, status) {
  openDb().prepare("UPDATE plans SET status = @status WHERE id = @id").run({ status, id: planId });
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

export function createIncident({ planId, stepId, severity, title, description }) {
  const db = openDb();
  const n = nextCounter("incident");
  const id = `INC-${String(n).padStart(3, "0")}`;
  db.prepare(
    `INSERT INTO plan_incidents (id, plan_id, step_id, severity, title, description, status, created_at)
     VALUES (@id, @plan_id, @step_id, @severity, @title, @description, 'open', @created_at)`,
  ).run({ id, plan_id: planId, step_id: stepId ?? null, severity: severity || "medium", title, description, created_at: nowIso() });
  return getIncident(id);
}

export function getIncident(id) {
  return rowToIncident(openDb().prepare("SELECT * FROM plan_incidents WHERE id = ?").get(id));
}

export function resolveIncident(id, resolution) {
  const db = openDb();
  db.prepare(
    `UPDATE plan_incidents SET status = 'resolved', resolution = @resolution, resolved_at = @ts WHERE id = @id`,
  ).run({ resolution, ts: nowIso(), id });
  return getIncident(id);
}

export function listIncidents({ planId, status } = {}) {
  const db = openDb();
  let rows;
  if (planId && status) rows = db.prepare("SELECT * FROM plan_incidents WHERE plan_id = ? AND status = ? ORDER BY rowid").all(planId, status);
  else if (planId) rows = db.prepare("SELECT * FROM plan_incidents WHERE plan_id = ? ORDER BY rowid").all(planId);
  else if (status) rows = db.prepare("SELECT * FROM plan_incidents WHERE status = ? ORDER BY rowid").all(status);
  else rows = db.prepare("SELECT * FROM plan_incidents ORDER BY rowid").all();
  return rows.map(rowToIncident);
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

export function createInconsistency({ planId, stepId, relatedPlanId, description }) {
  const db = openDb();
  const n = nextCounter("inconsistency");
  const id = `INCO-${String(n).padStart(3, "0")}`;
  db.prepare(
    `INSERT INTO plan_inconsistencies (id, plan_id, step_id, related_plan_id, description, status, created_at)
     VALUES (@id, @plan_id, @step_id, @related_plan_id, @description, 'open', @created_at)`,
  ).run({ id, plan_id: planId, step_id: stepId ?? null, related_plan_id: relatedPlanId ?? null, description, created_at: nowIso() });
  return getInconsistency(id);
}

export function getInconsistency(id) {
  return rowToInconsistency(openDb().prepare("SELECT * FROM plan_inconsistencies WHERE id = ?").get(id));
}

export function listInconsistencies({ planId } = {}) {
  const db = openDb();
  const rows = planId
    ? db.prepare("SELECT * FROM plan_inconsistencies WHERE plan_id = ? ORDER BY rowid").all(planId)
    : db.prepare("SELECT * FROM plan_inconsistencies ORDER BY rowid").all();
  return rows.map(rowToInconsistency);
}
