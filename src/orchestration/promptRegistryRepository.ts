import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import type {
  Phase,
  PromptDependencyReference,
  PromptDraft,
  PromptPublishedVersion,
  PromptSetDetails,
  PromptSetSummary,
  PromptSetType,
  PromptValidationResult
} from "../../shared/types.js";
import { makeId, nowIso } from "../../shared/utils.js";
import type { PromptConfig, RolePromptConfig } from "./promptRegistry.js";
import { getBrainstormApiRoot } from "../packageRoot.js";

interface PromptSetRecord {
  id: string;
  type: PromptSetType;
  name: string;
  title: string;
  format: "text" | "json";
  currentVersionId?: string;
  createdAt: string;
  updatedAt: string;
}

interface DraftRecord {
  promptSetId: string;
  content: string;
  updatedAt: string;
}

interface VersionRecord extends PromptPublishedVersion {}

interface PromptSetRow {
  id: string;
  type: PromptSetType;
  name: string;
  title: string;
  format: "text" | "json";
  current_version_id?: string | null;
  created_at: string;
  updated_at: string;
}

interface ManifestPayload {
  phase: Phase;
  roles: string[];
  roleConfigVersion: string;
  templateVersion: string;
  schemaVersion: string;
  model?: string;
  timeoutSeconds: number;
  temperature?: number;
  templateRef: { type: "phase_prompt"; name: string };
  schemaRef: { type: "schema"; name: string };
  roleRefs: Record<string, { type: "role_prompt"; name: string }>;
}

interface StoredRegistry {
  sets: Map<string, PromptSetRecord>;
  drafts: Map<string, DraftRecord>;
  versions: Map<string, VersionRecord[]>;
}

const registryCache: StoredRegistry = {
  sets: new Map(),
  drafts: new Map(),
  versions: new Map()
};

let initialized = false;
let initPromise: Promise<void> | undefined;
let pool: Pool | undefined;

function setKey(type: PromptSetType, name: string) {
  return `${type}:${name}`;
}

function titleForSet(type: PromptSetType, name: string) {
  return `${type.replaceAll("_", " ")} ${name}`;
}

function getRolePromptConfig(roleId: string) {
  const published = getPublishedVersion("role_prompt", roleId);
  if (!published) return undefined;
  return parseJsonContent<RolePromptConfig>("role_prompt", roleId, published.content);
}

function findRoleIdByDisplayName(displayName: string) {
  const normalizedName = displayName.trim();
  for (const set of registryCache.sets.values()) {
    if (set.type !== "role_prompt") continue;
    const config = getRolePromptConfig(set.name);
    if (config?.name?.trim() === normalizedName) {
      return set.name;
    }
  }
  return undefined;
}

function resolveRoleId(value: string) {
  if (registryCache.sets.has(setKey("role_prompt", value))) {
    return value;
  }
  return findRoleIdByDisplayName(value) ?? value;
}

function normalizeManifestPayload(payload: ManifestPayload): ManifestPayload {
  const normalizedRoles = payload.roles.map((role) => resolveRoleId(role));
  const normalizedRoleRefs = Object.fromEntries(
    Object.entries(payload.roleRefs ?? {}).map(([role, ref]) => [resolveRoleId(role), ref])
  );

  return {
    ...payload,
    roles: normalizedRoles,
    roleRefs: normalizedRoleRefs
  };
}

function getPool() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return undefined;
  pool ??= new Pool({ connectionString });
  return pool;
}

function ensureInitializedSync() {
  if (initialized) return;
  seedRegistryFromFiles();
  initialized = true;
}

export async function initializePromptRegistryStore() {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const db = getPool();
    if (!db) {
      seedRegistryFromFiles();
      initialized = true;
      return;
    }

    const client = await db.connect();
    try {
      const setCount = await client.query("select count(*)::int as count from prompt_sets");
      if (Number(setCount.rows[0]?.count ?? 0) === 0) {
        const seed = buildSeedRegistry();
        await client.query("begin");
        try {
          for (const set of seed.sets.values()) {
            await client.query(
              `insert into prompt_sets (id, type, name, title, format, current_version_id, created_at, updated_at)
               values ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [set.id, set.type, set.name, set.title, set.format, set.currentVersionId ?? null, set.createdAt, set.updatedAt]
            );
          }
          for (const draft of seed.drafts.values()) {
            await client.query(
              `insert into prompt_drafts (prompt_set_id, content, updated_at) values ($1,$2,$3)`,
              [draft.promptSetId, draft.content, draft.updatedAt]
            );
          }
          for (const versions of seed.versions.values()) {
            for (const version of versions) {
              await client.query(
                `insert into prompt_versions (id, prompt_set_id, version_number, format, content, notes, created_at, published_at)
                 values ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [
                  version.id,
                  version.promptSetId,
                  version.versionNumber,
                  version.format,
                  version.content,
                  version.notes ?? null,
                  version.createdAt,
                  version.publishedAt
                ]
              );
              await client.query(
                `insert into prompt_publish_events (id, prompt_set_id, prompt_version_id, action, notes, created_at)
                 values ($1,$2,$3,$4,$5,$6)`,
                [makeId("prompt_event"), version.promptSetId, version.id, "publish", version.notes ?? null, version.publishedAt]
              );
            }
          }
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      }

      await loadRegistryFromDb(client);
      initialized = true;
    } finally {
      client.release();
    }
  })();

  try {
    await initPromise;
  } finally {
    initPromise = undefined;
  }
}

export function invalidatePromptRegistryStore() {
  initialized = false;
  initPromise = undefined;
  registryCache.sets.clear();
  registryCache.drafts.clear();
  registryCache.versions.clear();
}

function seedRegistryFromFiles() {
  const seed = buildSeedRegistry();
  registryCache.sets = seed.sets;
  registryCache.drafts = seed.drafts;
  registryCache.versions = seed.versions;
}

function buildSeedRegistry(): StoredRegistry {
  const store: StoredRegistry = { sets: new Map(), drafts: new Map(), versions: new Map() };
  const timestamp = nowIso();

  const addSet = (input: {
    type: PromptSetType;
    name: string;
    format: "text" | "json";
    content: string;
    title?: string;
    notes?: string;
  }) => {
    const id = makeId("promptset");
    const versionId = makeId("promptver");
    const key = setKey(input.type, input.name);
    store.sets.set(key, {
      id,
      type: input.type,
      name: input.name,
      title: input.title ?? titleForSet(input.type, input.name),
      format: input.format,
      currentVersionId: versionId,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    store.drafts.set(key, { promptSetId: id, content: input.content, updatedAt: timestamp });
    store.versions.set(key, [
      {
        id: versionId,
        promptSetId: id,
        versionNumber: 1,
        format: input.format,
        content: input.content,
        notes: input.notes,
        createdAt: timestamp,
        publishedAt: timestamp
      }
    ]);
  };

  const promptsRoot = join(getBrainstormApiRoot(), "prompts");
  const phaseManifestNames: Phase[] = ["diverge", "cluster", "challenge", "decide"];
  for (const phase of phaseManifestNames) {
    const manifest = JSON.parse(readFileSync(join(promptsRoot, "manifest", `${phase}.json`), "utf8")) as {
      phase: Phase;
      roles: string[];
      roleConfigVersion: string;
      templateVersion: string;
      schemaVersion: string;
      model?: string;
      timeoutSeconds: number;
      temperature?: number;
      templateFile: string;
      schemaFile: string;
      roleFiles: Record<string, string>;
    };

    const templateRefName = manifest.templateFile.split("/").at(-2) ?? phase;
    const schemaRefName = manifest.schemaFile.split("/").at(-1)?.replace(/\.json$/i, "") ?? manifest.schemaVersion;
    const roleRefs = Object.fromEntries(
      Object.entries(manifest.roleFiles).map(([role, filePath]) => [role, { type: "role_prompt" as const, name: filePath.split("/").at(-2) ?? role }])
    );

    const manifestPayload: ManifestPayload = {
      phase: manifest.phase,
      roles: manifest.roles,
      roleConfigVersion: manifest.roleConfigVersion,
      templateVersion: manifest.templateVersion,
      schemaVersion: manifest.schemaVersion,
      model: manifest.model,
      timeoutSeconds: manifest.timeoutSeconds,
      temperature: manifest.temperature,
      templateRef: { type: "phase_prompt", name: templateRefName },
      schemaRef: { type: "schema", name: schemaRefName },
      roleRefs
    };

    addSet({
      type: "manifest",
      name: phase,
      format: "json",
      content: JSON.stringify(manifestPayload, null, 2)
    });
  }

  const phasePromptNames = ["diverge", "cluster", "challenge", "decide"];
  for (const phase of phasePromptNames) {
    addSet({
      type: "phase_prompt",
      name: phase,
      format: "text",
      content: readFileSync(join(promptsRoot, "phases", phase, "v1.md"), "utf8").trim()
    });
  }

  const roleDir = join(promptsRoot, "roles");
  for (const roleFolder of readDirNames(roleDir)) {
    const filePath = join(roleDir, roleFolder, "v1.json");
    if (!existsSync(filePath)) continue;
    addSet({
      type: "role_prompt",
      name: roleFolder,
      format: "json",
      content: readFileSync(filePath, "utf8").trim()
    });
  }

  const schemaDir = join(promptsRoot, "schemas");
  for (const schemaFile of readDirNames(schemaDir)) {
    if (!schemaFile.endsWith(".json")) continue;
    addSet({
      type: "schema",
      name: schemaFile.replace(/\.json$/i, ""),
      format: "json",
      content: readFileSync(join(schemaDir, schemaFile), "utf8").trim()
    });
  }

  addSet({
    type: "tool_prompt",
    name: "improve-statement",
    format: "text",
    content: readFileSync(join(promptsRoot, "tools", "improve-statement", "v1.md"), "utf8").trim()
  });

  return store;
}

function readDirNames(dirPath: string) {
  return existsSync(dirPath) ? readdirSync(dirPath) : [];
}

async function loadRegistryFromDb(client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: PromptSetRow[] | any[] }> }) {
  registryCache.sets.clear();
  registryCache.drafts.clear();
  registryCache.versions.clear();

  const setRows = await client.query("select * from prompt_sets order by type, name");
  const draftRows = await client.query("select * from prompt_drafts");
  const versionRows = await client.query("select * from prompt_versions order by prompt_set_id, version_number desc");

  for (const row of setRows.rows as PromptSetRow[]) {
    registryCache.sets.set(setKey(row.type, row.name), {
      id: String(row.id),
      type: row.type,
      name: String(row.name),
      title: String(row.title),
      format: row.format,
      currentVersionId: row.current_version_id ? String(row.current_version_id) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    });
  }

  for (const row of draftRows.rows as Array<{ prompt_set_id: string; content: string; updated_at: string }>) {
    const set = [...registryCache.sets.values()].find((item) => item.id === String(row.prompt_set_id));
    if (!set) continue;
    registryCache.drafts.set(setKey(set.type, set.name), {
      promptSetId: set.id,
      content: String(row.content),
      updatedAt: String(row.updated_at)
    });
  }

  for (const row of versionRows.rows as Array<Record<string, unknown>>) {
    const set = [...registryCache.sets.values()].find((item) => item.id === String(row.prompt_set_id));
    if (!set) continue;
    const key = setKey(set.type, set.name);
    const versions = registryCache.versions.get(key) ?? [];
    versions.push({
      id: String(row.id),
      promptSetId: String(row.prompt_set_id),
      versionNumber: Number(row.version_number),
      format: row.format === "json" ? "json" : "text",
      content: String(row.content),
      notes: row.notes ? String(row.notes) : undefined,
      createdAt: String(row.created_at),
      publishedAt: String(row.published_at)
    });
    registryCache.versions.set(key, versions);
  }
}

function getSetRecord(type: PromptSetType, name: string) {
  ensureInitializedSync();
  const set = registryCache.sets.get(setKey(type, name));
  if (!set) throw new Error(`Prompt set not found: ${type}/${name}`);
  return set;
}

function getDraftRecord(type: PromptSetType, name: string) {
  const draft = registryCache.drafts.get(setKey(type, name));
  if (!draft) throw new Error(`Prompt draft not found: ${type}/${name}`);
  return draft;
}

function getPublishedVersion(type: PromptSetType, name: string) {
  const set = getSetRecord(type, name);
  const versions = registryCache.versions.get(setKey(type, name)) ?? [];
  return versions.find((item) => item.id === set.currentVersionId);
}

function summarizeSet(type: PromptSetType, name: string): PromptSetSummary {
  const set = getSetRecord(type, name);
  const draft = getDraftRecord(type, name);
  const published = getPublishedVersion(type, name);
  return {
    id: set.id,
    type: set.type,
    name: set.name,
    title: set.title,
    format: set.format,
    publishedVersionId: published?.id,
    publishedVersionNumber: published?.versionNumber,
    publishedAt: published?.publishedAt,
    draftUpdatedAt: draft.updatedAt,
    hasUnpublishedChanges: Boolean(published && published.content !== draft.content)
  };
}

function parseJsonContent<T>(type: PromptSetType, name: string, content: string): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new Error(`Invalid JSON for ${type}/${name}`);
  }
}

function validateDraft(type: PromptSetType, name: string, content: string): PromptValidationResult {
  ensureInitializedSync();
  const errors: string[] = [];
  const warnings: string[] = [];
  const dependencies: PromptDependencyReference[] = [];

  if (!content.trim()) {
    errors.push("Content must not be empty.");
  }

  if (type === "phase_prompt" || type === "tool_prompt") {
    return { valid: errors.length === 0, errors, warnings, dependencies };
  }

  if (type === "role_prompt") {
    const parsed = parseJsonContent<Partial<RolePromptConfig>>(type, name, content);
    if (!String(parsed.name ?? "").trim()) errors.push("Role prompt name is required.");
    if (!String(parsed.version ?? "").trim()) errors.push("Role prompt version is required.");
    if (!String(parsed.systemPrompt ?? "").trim()) errors.push("Role systemPrompt is required.");
    return { valid: errors.length === 0, errors, warnings, dependencies };
  }

  if (type === "schema") {
    const parsed = parseJsonContent<Record<string, unknown>>(type, name, content);
    if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
      errors.push("Schema must be a JSON object.");
    }
    return { valid: errors.length === 0, errors, warnings, dependencies };
  }

  const parsed = normalizeManifestPayload(parseJsonContent<ManifestPayload>(type, name, content));
  if (type === "manifest") {
    if (parsed.phase !== name) errors.push("Manifest phase must match prompt set name.");
    if (!Array.isArray(parsed.roles) || parsed.roles.length === 0) errors.push("Manifest roles must be a non-empty array.");
    if (!parsed.templateRef?.name) errors.push("Manifest templateRef is required.");
    if (!parsed.schemaRef?.name) errors.push("Manifest schemaRef is required.");
    if (!parsed.roleRefs || typeof parsed.roleRefs !== "object") errors.push("Manifest roleRefs are required.");
    if (typeof parsed.timeoutSeconds !== "number" || parsed.timeoutSeconds <= 0) errors.push("timeoutSeconds must be > 0.");
    if (parsed.temperature !== undefined && typeof parsed.temperature !== "number") {
      errors.push("temperature must be numeric.");
    }

    if (parsed.templateRef?.name) {
      dependencies.push({ type: "phase_prompt", name: parsed.templateRef.name, label: `Phase prompt ${parsed.templateRef.name}` });
      if (!registryCache.sets.has(setKey("phase_prompt", parsed.templateRef.name))) {
        errors.push(`Missing referenced phase prompt: ${parsed.templateRef.name}`);
      }
    }
    if (parsed.schemaRef?.name) {
      dependencies.push({ type: "schema", name: parsed.schemaRef.name, label: `Schema ${parsed.schemaRef.name}` });
      if (!registryCache.sets.has(setKey("schema", parsed.schemaRef.name))) {
        errors.push(`Missing referenced schema: ${parsed.schemaRef.name}`);
      }
    }
    for (const role of Object.keys(parsed.roleRefs ?? {})) {
      const roleRef = parsed.roleRefs[role];
      if (!roleRef?.name) {
        errors.push(`Missing role ref for ${role}`);
        continue;
      }
      dependencies.push({ type: "role_prompt", name: roleRef.name, label: `Role prompt ${roleRef.name}` });
      if (!registryCache.sets.has(setKey("role_prompt", roleRef.name))) {
        errors.push(`Missing referenced role prompt: ${roleRef.name}`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings, dependencies };
}

export function getPromptConfigForPhase(phase: Phase): PromptConfig {
  ensureInitializedSync();
  const manifest = normalizeManifestPayload(
    parseJsonContent<ManifestPayload>("manifest", phase, getPublishedVersion("manifest", phase)?.content ?? "")
  );
  const template = getPublishedVersion("phase_prompt", manifest.templateRef.name)?.content;
  const schemaContent = getPublishedVersion("schema", manifest.schemaRef.name)?.content;
  if (!template || !schemaContent) {
    throw new Error(`Incomplete prompt registry for phase ${phase}`);
  }
  const roleDefinitions = Object.fromEntries(
    manifest.roles.map((role) => {
      const roleSetName = manifest.roleRefs[role]?.name;
      if (!roleSetName) throw new Error(`Missing role prompt reference for ${role}`);
      const published = getPublishedVersion("role_prompt", roleSetName);
      if (!published) throw new Error(`Missing role prompt version for ${roleSetName}`);
      return [role, parseJsonContent<RolePromptConfig>("role_prompt", roleSetName, published.content)];
    })
  );

  return {
    phase: manifest.phase,
    roles: manifest.roles,
    roleConfigVersion: manifest.roleConfigVersion,
    templateVersion: manifest.templateVersion,
    schemaVersion: manifest.schemaVersion,
    model: String(manifest.model ?? ""),
    timeoutSeconds: manifest.timeoutSeconds,
    temperature: manifest.temperature,
    template,
    schema: parseJsonContent<Record<string, unknown>>("schema", manifest.schemaRef.name, schemaContent),
    roleDefinitions
  };
}

export function getPromptVersionRefsForPhase(phase: Phase) {
  ensureInitializedSync();
  const manifestVersion = getPublishedVersion("manifest", phase);
  const manifest = normalizeManifestPayload(parseJsonContent<ManifestPayload>("manifest", phase, manifestVersion?.content ?? ""));
  return {
    manifestVersionId: manifestVersion?.id,
    phasePromptVersionId: getPublishedVersion("phase_prompt", manifest.templateRef.name)?.id,
    rolePromptVersionIds: manifest.roles
      .map((role) => getPublishedVersion("role_prompt", manifest.roleRefs[role]?.name ?? "")?.id)
      .filter((item): item is string => Boolean(item)),
    schemaVersionId: getPublishedVersion("schema", manifest.schemaRef.name)?.id
  };
}

export function getToolPrompt(toolName: string) {
  ensureInitializedSync();
  return getPublishedVersion("tool_prompt", toolName)?.content ?? "";
}

export function getToolPromptVersionId(toolName: string) {
  ensureInitializedSync();
  return getPublishedVersion("tool_prompt", toolName)?.id;
}

export function normalizeRoleIds(roleIds: string[]) {
  ensureInitializedSync();
  return roleIds.map((roleId) => resolveRoleId(roleId));
}

export function getRoleDisplayName(roleId: string) {
  ensureInitializedSync();
  return getRolePromptConfig(resolveRoleId(roleId))?.name ?? roleId;
}

export function getDefaultRoleIdsForPhase(phase: Phase) {
  ensureInitializedSync();
  const manifest = normalizeManifestPayload(
    parseJsonContent<ManifestPayload>("manifest", phase, getPublishedVersion("manifest", phase)?.content ?? "")
  );
  return manifest.roles;
}

export async function listPromptSets(): Promise<Record<PromptSetType, PromptSetSummary[]>> {
  await initializePromptRegistryStore();
  const grouped: Record<PromptSetType, PromptSetSummary[]> = {
    manifest: [],
    phase_prompt: [],
    role_prompt: [],
    schema: [],
    tool_prompt: []
  };
  for (const set of [...registryCache.sets.values()].sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name))) {
    grouped[set.type].push(summarizeSet(set.type, set.name));
  }
  return grouped;
}

export async function getPromptSetDetails(type: PromptSetType, name: string): Promise<PromptSetDetails> {
  await initializePromptRegistryStore();
  const set = getSetRecord(type, name);
  const draft = getDraftRecord(type, name);
  const published = getPublishedVersion(type, name);
  const versions = (registryCache.versions.get(setKey(type, name)) ?? []).slice().sort((left, right) => right.versionNumber - left.versionNumber);
  return {
    summary: summarizeSet(type, name),
    draft: {
      promptSetId: set.id,
      type,
      name,
      title: set.title,
      format: set.format,
      content: draft.content,
      updatedAt: draft.updatedAt
    },
    publishedVersion: published,
    versions,
    validation: validateDraft(type, name, draft.content)
  };
}

export async function updatePromptDraft(type: PromptSetType, name: string, content: string) {
  await initializePromptRegistryStore();
  const set = getSetRecord(type, name);
  const updatedAt = nowIso();
  registryCache.drafts.set(setKey(type, name), { promptSetId: set.id, content, updatedAt });
  set.updatedAt = updatedAt;
  const db = getPool();
  if (db) {
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(`update prompt_drafts set content = $2, updated_at = $3 where prompt_set_id = $1`, [set.id, content, updatedAt]);
      await client.query(`update prompt_sets set updated_at = $2 where id = $1`, [set.id, updatedAt]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  return getPromptSetDetails(type, name);
}

export async function validatePromptSet(type: PromptSetType, name: string) {
  await initializePromptRegistryStore();
  const draft = getDraftRecord(type, name);
  return validateDraft(type, name, draft.content);
}

export async function publishPromptSet(type: PromptSetType, name: string, notes?: string) {
  await initializePromptRegistryStore();
  const validation = await validatePromptSet(type, name);
  if (!validation.valid) {
    throw new Error(validation.errors.join(" "));
  }

  const set = getSetRecord(type, name);
  const draft = getDraftRecord(type, name);
  const versions = registryCache.versions.get(setKey(type, name)) ?? [];
  const nextVersionNumber = Math.max(0, ...versions.map((item) => item.versionNumber)) + 1;
  const version: VersionRecord = {
    id: makeId("promptver"),
    promptSetId: set.id,
    versionNumber: nextVersionNumber,
    format: set.format,
    content: draft.content,
    notes,
    createdAt: nowIso(),
    publishedAt: nowIso()
  };
  registryCache.versions.set(setKey(type, name), [version, ...versions]);
  set.currentVersionId = version.id;
  set.updatedAt = version.publishedAt;

  const db = getPool();
  if (db) {
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into prompt_versions (id, prompt_set_id, version_number, format, content, notes, created_at, published_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [version.id, version.promptSetId, version.versionNumber, version.format, version.content, version.notes ?? null, version.createdAt, version.publishedAt]
      );
      await client.query(`update prompt_sets set current_version_id = $2, updated_at = $3 where id = $1`, [set.id, version.id, version.publishedAt]);
      await client.query(
        `insert into prompt_publish_events (id, prompt_set_id, prompt_version_id, action, notes, created_at)
         values ($1,$2,$3,$4,$5,$6)`,
        [makeId("prompt_event"), set.id, version.id, "publish", notes ?? null, version.publishedAt]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  return getPromptSetDetails(type, name);
}

export async function restorePromptVersion(type: PromptSetType, name: string, versionId: string) {
  await initializePromptRegistryStore();
  const version = (registryCache.versions.get(setKey(type, name)) ?? []).find((item) => item.id === versionId);
  if (!version) {
    throw new Error(`Prompt version not found: ${versionId}`);
  }
  return updatePromptDraft(type, name, version.content);
}
