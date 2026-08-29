#!/usr/bin/env node
/**
 * plan-manager MCP — Gestion des plans générés par l'agent `atomic-plan`.
 *
 * Principes :
 *  - Les plans (Plan-<objectif>-<date>.md) sont IMMUABLES : ce serveur ne les
 *    modifie jamais.
 *  - La source de vérité de la persistance des plans est désormais la base
 *    SQLite partagée `registry.db` (tables plans/plan_steps/plan_incidents/
 *    plan_inconsistencies/plan_counters — cf. db.mjs). Les documents markdown
 *    (progression, incidents, incohérences, rapports) ne sont plus que des
 *    artefacts TRANSITOIRES (pièces jointes d'email), écrits sous
 *    /tmp/opencode/plan-manager/.
 *  - Les incidents et incohérences déclenchent une notification email.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { resolve, join, basename, isAbsolute } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import {
  createPlan,
  getPlan,
  requirePlan,
  listPlans,
  updateStepStatus,
  setPlanStatus,
  progressStats,
  createIncident,
  resolveIncident,
  listIncidents,
  createInconsistency,
  listInconsistencies,
  taskExists,
  setPlanBranch,
} from "./db.mjs";

const MAIL_SCRIPT = join(homedir(), ".config", "opencode", "scripts", "send-mail.mjs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function text(content) {
  return { content: [{ type: "text", text: content }] };
}

function err(content) {
  return { content: [{ type: "text", text: `ERREUR : ${content}` }], isError: true };
}

function nowIso() {
  return new Date().toISOString();
}

function stamp() {
  // YYYYMMDD-HHMMSS (même format que les plans atomic-plan)
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sendMail(subject, body, attachment) {
  try {
    const args = ["--subject", subject, "--body", body];
    if (attachment) args.push("--attachment", attachment);
    execFileSync("node", [MAIL_SCRIPT, ...args], { stdio: "pipe" });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// Documents transitoires (non persistants) — uniquement pour pièces jointes.
function tmpDir(...sub) {
  return join("/tmp", "opencode", "plan-manager", ...sub);
}

function resolvePlanFile(rootPath, planFile) {
  if (isAbsolute(planFile)) return planFile;
  const direct = resolve(rootPath, planFile);
  if (existsSync(direct)) return direct;
  return resolve(rootPath, "plans", planFile);
}

function planIdOf(planFile) {
  return basename(planFile).replace(/\.md$/i, "");
}

function extractSteps(absPath) {
  if (!existsSync(absPath)) return [];
  const txt = readFileSync(absPath, "utf8");
  const ids = [...txt.matchAll(/\b[A-Z]\d{3}\b/g)].map((m) => m[0]);
  return [...new Set(ids)];
}

// --- Générateurs de documents markdown (transitoires) ----------------------
function writeProgressionDoc(plan) {
  const lines = [];
  lines.push(`# Progression — ${plan.id}`);
  lines.push("");
  lines.push(`- **Objectif** : ${plan.objective || "(non renseigné)"}`);
  lines.push(`- **Plan** : ${plan.file || plan.absolutePath}`);
  const st = progressStats(plan.progress);
  lines.push(`- **Avancement** : ${st.pct}% (${st.done + st.skipped}/${st.total} terminé)`);
  lines.push(`- **Dernière mise à jour** : ${nowIso()}`);
  lines.push("");
  lines.push("| Étape | Statut | Note | Mis à jour |");
  lines.push("|---|---|---|---|");
  for (const step of plan.steps) {
    const p = plan.progress[step] || { status: "todo", note: "", updatedAt: "" };
    lines.push(`| ${step} | ${p.status} | ${(p.note || "").replace(/\|/g, "\\|")} | ${p.updatedAt || ""} |`);
  }
  lines.push("");
  const dir = tmpDir("progression");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${plan.id}.md`);
  writeFileSync(f, lines.join("\n"));
  return f;
}

function writeIncidentDoc(incident) {
  const lines = [];
  lines.push(`# Incident ${incident.id}`);
  lines.push("");
  lines.push(`- **Plan** : ${incident.planId}`);
  if (incident.stepId) lines.push(`- **Étape** : ${incident.stepId}`);
  lines.push(`- **Sévérité** : ${incident.severity}`);
  lines.push(`- **Statut** : ${incident.status}`);
  lines.push(`- **Créé le** : ${incident.createdAt}`);
  if (incident.resolution) lines.push(`- **Résolution** : ${incident.resolution} (${incident.resolvedAt || ""})`);
  lines.push("");
  lines.push(`## Titre`);
  lines.push("");
  lines.push(incident.title);
  lines.push("");
  lines.push(`## Description`);
  lines.push("");
  lines.push(incident.description);
  lines.push("");
  const dir = tmpDir("incidents");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${incident.id}.md`);
  writeFileSync(f, lines.join("\n"));
  return f;
}

function writeInconsistencyDoc(inco) {
  const lines = [];
  lines.push(`# Incohérence ${inco.id}`);
  lines.push("");
  lines.push(`- **Plan** : ${inco.planId}`);
  if (inco.stepId) lines.push(`- **Étape** : ${inco.stepId}`);
  if (inco.relatedPlanId) lines.push(`- **Plan lié** : ${inco.relatedPlanId}`);
  lines.push(`- **Statut** : ${inco.status}`);
  lines.push(`- **Créé le** : ${inco.createdAt}`);
  lines.push("");
  lines.push(`## Description`);
  lines.push("");
  lines.push(inco.description);
  lines.push("");
  const dir = tmpDir("inconsistencies");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${inco.id}.md`);
  writeFileSync(f, lines.join("\n"));
  return f;
}

// ---------------------------------------------------------------------------
// Serveur
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "plan-manager", version: "0.1.0" });

// === plan_register ===
server.registerTool("plan_register", {
  description: "Enregistre un plan immuable (Plan-*.md produit par atomic-plan) dans la base partagée du Plan Manager (source de vérité). Ne modifie PAS le fichier plan : il initialise seulement son suivi (étapes à todo).",
  inputSchema: {
    rootPath: z.string().describe("Racine du projet (contient le dossier plans/)."),
    planFile: z.string().describe("Chemin du fichier plan (relatif à <rootPath>/plans/ ou absolu)."),
    objective: z.string().optional().describe("Objectif du plan (sinon extrait du nom de fichier)."),
    steps: z.array(z.string()).optional().describe("Liste des identifiants d'étapes (ex: A001). Sinon auto-extraite du fichier plan."),
    deliverables: z.array(z.string()).optional().describe("Liste des livrables attendus du plan."),
    taskId: z.string().describe("Identifiant de la tâche orchestrée à rattacher (OBLIGATOIRE)."),
  },
}, async ({ rootPath, planFile, objective, steps, deliverables, taskId }) => {
  try {
    if (!await taskExists(taskId)) {
      return err(`tâche inconnue : ${taskId || "(vide)"} — un plan doit être rattaché à une tâche existante`);
    }
    const abs = resolvePlanFile(rootPath, planFile);
    if (!existsSync(abs)) return err(`fichier plan introuvable : ${abs}`);
    const id = planIdOf(planFile);
    if (await getPlan(id)) return err(`plan déjà enregistré : ${id}`);
    const list = (steps && steps.length ? steps : extractSteps(abs));
    const plan = await createPlan({
      id,
      taskId,
      objective: objective || id.replace(/^Plan-/, "").replace(/-\d{8}-\d{6}$/, "").replace(/-/g, " "),
      file: planFile,
      absolutePath: abs,
      deliverables: deliverables || [],
      steps: list,
    });
    const progDoc = writeProgressionDoc(plan);
    return text(JSON.stringify({ ok: true, planId: id, steps: list, progressionDoc: progDoc }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === plan_list ===
server.registerTool("plan_list", {
  description: "Liste tous les plans enregistrés avec leur avancement, incidents et incohérences.",
  inputSchema: { rootPath: z.string().describe("Racine du projet.") },
}, async () => {
  try {
    const plans = (await listPlans()).map((p) => ({
      id: p.id,
      taskId: p.taskId,
      objective: p.objective,
      status: p.status,
      deliverables: p.deliverables,
      progress: progressStats(p.progress),
      incidents: p.incidents.length,
      inconsistencies: p.inconsistencies.length,
    }));
    return text(JSON.stringify({ plans }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === plan_get ===
server.registerTool("plan_get", {
  description: "Renvoie le détail d'un plan (étapes, progression, incidents et incohérences rattachés).",
  inputSchema: { rootPath: z.string(), planId: z.string() },
}, async ({ planId }) => {
  try {
    const p = await requirePlan(planId);
    return text(JSON.stringify(p, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === plan_set_branch ===
server.registerTool("plan_set_branch", {
  description: "Associe la branche git de la sous-tâche au plan (renseignée par build-notify en fin de sous-tâche).",
  inputSchema: {
    rootPath: z.string(),
    planId: z.string(),
    branch: z.string(),
  },
}, async ({ planId, branch }) => {
  try {
    const p = await setPlanBranch(planId, branch);
    if (!p) return err(`plan inconnu : ${planId}`);
    return text(JSON.stringify({ ok: true, plan: p }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === progress_update ===
server.registerTool("progress_update", {
  description: "Marque l'avancement d'une étape du plan (todo/in_progress/done/blocked/skipped). Met à jour la base (source de vérité) et recalcule le % en temps réel. Ne modifie jamais le plan.",
  inputSchema: {
    rootPath: z.string(),
    planId: z.string(),
    stepId: z.string().describe("Identifiant d'étape (ex: A001)."),
    status: z.enum(["todo", "in_progress", "done", "blocked", "skipped"]),
    note: z.string().optional().describe("Note libre sur cette étape."),
  },
}, async ({ planId, stepId, status, note }) => {
  try {
    const before = await requirePlan(planId);
    if (!before.progress[stepId]) return err(`étape inconnue : ${stepId} (étapes du plan : ${before.steps.join(", ")})`);
    let plan = await updateStepStatus(planId, stepId, status, note || "");
    if (!plan) return err(`plan inconnu : ${planId}`);
    if (status === "done" || status === "skipped") {
      const st = progressStats(plan.progress);
      if (st.todo === 0 && st.in_progress === 0 && st.blocked === 0 && st.done + st.skipped > 0) {
        plan = await setPlanStatus(planId, "completed");
      } else {
        plan = await setPlanStatus(planId, "active");
      }
    }
    const doc = writeProgressionDoc(plan);
    return text(JSON.stringify({ ok: true, planId, stepId, status, progress: progressStats(plan.progress), progressionDoc: doc }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === progress_get ===
server.registerTool("progress_get", {
  description: "Renvoie l'avancement actuel d'un plan (statut par étape + pourcentage).",
  inputSchema: { rootPath: z.string(), planId: z.string() },
}, async ({ planId }) => {
  try {
    const p = await requirePlan(planId);
    return text(JSON.stringify({ planId, objective: p.objective, status: p.status, progress: progressStats(p.progress), steps: p.progress }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === incident_create ===
server.registerTool("incident_create", {
  description: "Crée un incident rattaché à un plan (et optionnellement à une étape), persisté en base. Génère un document transitoire + notification email. Ne modifie jamais le plan.",
  inputSchema: {
    rootPath: z.string(),
    planId: z.string(),
    stepId: z.string().optional(),
    severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
    title: z.string().describe("Titre court de l'incident."),
    description: z.string().describe("Description de l'incident."),
  },
}, async ({ planId, stepId, severity, title, description }) => {
  try {
    await requirePlan(planId);
    const incident = await createIncident({ planId, stepId: stepId || null, severity, title, description });
    const doc = writeIncidentDoc(incident);
    const mail = sendMail(`[PLAN] Incident ${incident.id} — ${title}`, `Incident rattaché au plan ${planId}${stepId ? ` (étape ${stepId})` : ""}\nSévérité : ${severity}\n\n${description}\n\nDocument : ${doc}`);
    return text(JSON.stringify({ ok: true, incidentId: incident.id, document: doc, notified: mail.ok, mailError: mail.error || null }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === incident_resolve ===
server.registerTool("incident_resolve", {
  description: "Clôt un incident avec une résolution, persisté en base. Notification email envoyée.",
  inputSchema: { rootPath: z.string(), incidentId: z.string(), resolution: z.string() },
}, async ({ incidentId, resolution }) => {
  try {
    const inc = await resolveIncident(incidentId, resolution);
    if (!inc) return err(`incident inconnu : ${incidentId}`);
    const doc = writeIncidentDoc(inc);
    const mail = sendMail(`[PLAN] Incident ${incidentId} résolu`, `Résolution : ${resolution}\n\nDocument : ${doc}`);
    return text(JSON.stringify({ ok: true, incidentId, status: "resolved", document: doc, notified: mail.ok }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === incident_list ===
server.registerTool("incident_list", {
  description: "Liste les incidents (tous ou filtrés par plan / statut).",
  inputSchema: {
    rootPath: z.string(),
    planId: z.string().optional(),
    status: z.enum(["open", "resolved"]).optional(),
  },
}, async ({ planId, status }) => {
  try {
    const incidents = await listIncidents({ planId, status });
    return text(JSON.stringify({ incidents }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === inconsistency_create ===
server.registerTool("inconsistency_create", {
  description: "Signale une incohérence détectée à l'exécution d'un plan (contradiction, conflit inter-plans...), persistée en base. Génère un document transitoire + notification email. Ne modifie jamais le plan.",
  inputSchema: {
    rootPath: z.string(),
    planId: z.string(),
    stepId: z.string().optional(),
    description: z.string().describe("Description de l'incohérence."),
    relatedPlanId: z.string().optional().describe("Plan lié si l'incohérence est inter-plans."),
  },
}, async ({ planId, stepId, description, relatedPlanId }) => {
  try {
    await requirePlan(planId);
    const inco = await createInconsistency({ planId, stepId: stepId || null, relatedPlanId: relatedPlanId || null, description });
    const doc = writeInconsistencyDoc(inco);
    const mail = sendMail(`[PLAN] Incohérence ${inco.id}`, `Incohérence détectée sur le plan ${planId}${stepId ? ` (étape ${stepId})` : ""}${relatedPlanId ? ` — plan lié : ${relatedPlanId}` : ""}\n\n${description}\n\nDocument : ${doc}`);
    return text(JSON.stringify({ ok: true, inconsistencyId: inco.id, document: doc, notified: mail.ok, mailError: mail.error || null }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === inconsistency_list ===
server.registerTool("inconsistency_list", {
  description: "Liste les incohérences (toutes ou filtrées par plan).",
  inputSchema: { rootPath: z.string(), planId: z.string().optional() },
}, async ({ planId }) => {
  try {
    const inconsistencies = await listInconsistencies({ planId });
    return text(JSON.stringify({ inconsistencies }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === treatments_list ===
server.registerTool("treatments_list", {
  description: "Renvoie la liste des traitements à effectuer (étapes non terminées) pour un plan ou l'ensemble des plans. C'est la réponse directe à « quels traitements reste-t-il à faire ? ».",
  inputSchema: { rootPath: z.string(), planId: z.string().optional() },
}, async ({ planId }) => {
  try {
    const rows = [];
    for (const p of await listPlans()) {
      if (planId && p.id !== planId) continue;
      for (const step of p.steps) {
        const st = (p.progress[step] || {}).status || "todo";
        if (st === "done" || st === "skipped") continue;
        rows.push({ planId: p.id, objective: p.objective, stepId: step, status: st });
      }
    }
    return text(JSON.stringify({ count: rows.length, treatments: rows }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === plan_report ===
server.registerTool("plan_report", {
  description: "Génère un rapport de statut markdown pour un plan (progression + incidents + incohérences) depuis la base. Écrit sous /tmp/opencode/plan-manager/reports/ (artefact transitoire, pièce jointe email uniquement). Ne modifie jamais le plan.",
  inputSchema: { rootPath: z.string(), planId: z.string() },
}, async ({ planId }) => {
  try {
    const p = await requirePlan(planId);
    const st = progressStats(p.progress);
    const incs = await listIncidents({ planId });
    const incos = await listInconsistencies({ planId });
    const lines = [];
    lines.push(`# Rapport de statut — ${planId}`);
    lines.push("");
    lines.push(`- **Objectif** : ${p.objective}`);
    lines.push(`- **Plan** : ${p.file || p.absolutePath}`);
    lines.push(`- **Statut** : ${p.status}`);
    lines.push(`- **Avancement** : ${st.pct}% (${st.done + st.skipped}/${st.total} terminé)`);
    lines.push(`- **Généré le** : ${nowIso()}`);
    lines.push("");
    lines.push("## Progression par étape");
    lines.push("");
    lines.push("| Étape | Statut | Note |");
    lines.push("|---|---|---|");
    for (const step of p.steps) {
      const pr = p.progress[step] || {};
      lines.push(`| ${step} | ${pr.status || "todo"} | ${(pr.note || "").replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
    lines.push(`## Incidents (${incs.length})`);
    lines.push("");
    if (incs.length === 0) lines.push("Aucun incident.");
    else for (const i of incs) lines.push(`- ${i.id} [${i.severity}] **${i.status}** — ${i.title}`);
    lines.push("");
    lines.push(`## Incohérences (${incos.length})`);
    lines.push("");
    if (incos.length === 0) lines.push("Aucune incohérence.");
    else for (const i of incos) lines.push(`- ${i.id} [${i.status}] — ${i.description.slice(0, 120)}`);
    lines.push("");
    const dir = tmpDir("reports");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `report-${planId}-${stamp()}.md`);
    writeFileSync(f, lines.join("\n"));
    return text(JSON.stringify({ ok: true, reportPath: f, summary: { objective: p.objective, status: p.status, progress: st, incidents: incs.length, inconsistencies: incos.length } }, null, 2));
  } catch (e) {
    return err(e.message);
  }
});

// === notify ===
server.registerTool("notify", {
  description: "Envoie une notification email (subject/body, pièce jointe optionnelle) via le script send-mail.mjs.",
  inputSchema: {
    subject: z.string(),
    body: z.string(),
    attachment: z.string().optional().describe("Chemin absolu d'une pièce jointe (optionnel)."),
  },
}, async ({ subject, body, attachment }) => {
  const r = sendMail(subject, body, attachment);
  return text(JSON.stringify({ ok: r.ok, error: r.error || null }, null, 2));
});

// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("Erreur fatale du MCP server plan-manager:", e);
  process.exit(1);
});
