import { sha256, validateArtifactPublication, validateRecovery } from "./core.mjs";
import { recoveryValueHash, serializeQuarantineMetadata, serializeRecovery } from "./recovery-state.mjs";

const root = ".supervised-worker/recovery";
const actionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalid() {
  throw new Error("RELEASE_RECOVERY_BUNDLE_INVALID");
}

export function captureReleaseRecovery({ list, read, repositoryHash }) {
  const entries = new Map();
  const grants = new Map();
  const actions = new Map();
  let bytes = 0;
  const capture = (locator, opaque = false) => {
    if (entries.has(locator)) return entries.get(locator);
    let entry;
    try {
      entry = read(locator, opaque);
    } catch (error) {
      if (error?.code === "ENOENT") invalid();
      throw error;
    }
    bytes += entry.bytes.length;
    if (entries.size >= 8192 || bytes > 16_777_216) throw new Error("RELEASE_RECOVERY_INVENTORY_TOO_LARGE");
    entries.set(locator, entry);
    return entry;
  };
  const record = (locator, definition) => {
    const entry = capture(locator);
    if (validateRecovery(entry.value, definition).length ||
      !serializeRecovery(entry.value, definition).equals(entry.bytes)) invalid();
    return entry;
  };
  const frontier = (hash) => {
    const entry = record(`${root}/frontiers/${hash}.json`, "frontier");
    if (entry.reference.sha256 !== hash || entry.value.repositoryHash !== repositoryHash) invalid();
    return entry.value;
  };
  const authorization = (hash) => {
    if (grants.has(hash)) return grants.get(hash);
    if (!/^[0-9a-f]{64}$/.test(hash)) invalid();
    const entry = record(`${root}/authorizations/${hash}.json`, "authorization");
    const grant = entry.value;
    const proposal = grant.proposal;
    if (entry.reference.sha256 !== hash || grant.proposalHash !== recoveryValueHash(proposal) ||
      proposal.expectedHash !== recoveryValueHash(proposal.expected) ||
      proposal.expected.repositoryHash !== repositoryHash ||
      proposal.expected.sessionHash !== sha256(proposal.session.session_id) ||
      Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt) !== 600_000) invalid();
    grants.set(hash, grant);
    if (proposal.expected.frontierHash !== null) frontier(proposal.expected.frontierHash);
    return grant;
  };
  for (const id of list(`${root}/actions`)) {
    if (!actionId.test(id)) invalid();
    const prefix = `${root}/actions/${id}`;
    const names = list(prefix);
    if (!names.includes("intent.json") || names.some(name => !["intent.json", "outcome.json", "quarantine.json", "confirmation.json"].includes(name))) invalid();
    const intent = record(`${prefix}/intent.json`, "actionIntent").value;
    const grant = authorization(intent.authorizationHash);
    if (!grant || intent.actionId !== id || grant.proposal.actionId !== id ||
      intent.proposalHash !== grant.proposalHash || intent.expectedHash !== grant.proposal.expectedHash ||
      recoveryValueHash(intent.action) !== recoveryValueHash(grant.proposal.action)) invalid();
    const action = intent.action;
    let metadata = null;
    let payload = null;
    if (names.includes("quarantine.json")) {
      const entry = capture(`${prefix}/quarantine.json`);
      metadata = entry.value;
      if (validateArtifactPublication(metadata, "quarantineIntent").length ||
        !serializeQuarantineMetadata(metadata).equals(entry.bytes) || action.kind !== "quarantine-journal-entry" ||
        metadata.actionId !== id || metadata.authorizationHash !== intent.authorizationHash ||
        metadata.entryHash !== action.entryHash ||
        recoveryValueHash(metadata.source) !== action.entryHash ||
        !grant.proposal.expected.files.some(file => recoveryValueHash(file) === action.entryHash) ||
        metadata.source.area !== "repository" || metadata.source.kind !== "file" ||
        !/^\.supervised-worker\/runs\/[^/]+$/.test(metadata.source.path) ||
        metadata.source.identity.nlink !== "1" || Number(metadata.source.identity.size) > 4_194_304 ||
        metadata.locator !== `${root}/quarantine/${id}/${metadata.source.sha256}.quarantined`) invalid();
      const expectedEntries = grant.proposal.expected.files.filter(file =>
        file.area === "repository" && /^\.supervised-worker\/runs\/[^/]+$/.test(file.path));
      if (recoveryValueHash(metadata.entries) !== recoveryValueHash(expectedEntries)) invalid();
    }
    const payloadNames = list(`${root}/quarantine/${id}`);
    if (payloadNames.length > 1 || (payloadNames.length && metadata === null)) invalid();
    if (payloadNames.length) {
      if (payloadNames[0] !== `${metadata.source.sha256}.quarantined`) invalid();
      payload = capture(metadata.locator, true);
      if (payload.reference.sha256 !== metadata.source.sha256 ||
        payload.bytes.length !== Number(metadata.source.identity.size) ||
        ["dev", "ino", "size"].some(key => payload.identity?.[key] !== metadata.source.identity[key])) invalid();
    }
    let outcome = null;
    if (names.includes("outcome.json")) {
      outcome = record(`${prefix}/outcome.json`, "actionReceipt").value;
      if (outcome.actionId !== id || outcome.authorizationHash !== intent.authorizationHash ||
        outcome.proposalHash !== intent.proposalHash || outcome.beforeHash !== intent.expectedHash) invalid();
      if (outcome.status === "applied" && outcome.afterHash === null) invalid();
      if (action.kind === "quarantine-journal-entry") {
        if (!metadata || (outcome.status === "applied" && !payload) ||
          outcome.locator !== metadata.locator || outcome.sha256 !== metadata.source.sha256 || outcome.frontierHash !== null) invalid();
      } else {
        if (outcome.locator !== null || outcome.sha256 !== null) invalid();
        if (["legacy-reconcile", "finish-release"].includes(action.kind)) {
          if (outcome.frontierHash === null) invalid();
          const selected = frontier(outcome.frontierHash);
          if (selected.authorizationHash !== intent.authorizationHash) invalid();
          if (action.kind === "legacy-reconcile" && (selected.phase !== "reconciled" || selected.transitionId !== id)) invalid();
          if (action.kind === "finish-release" && (selected.phase !== "detached" || selected.previousHash !== action.frontierHash)) invalid();
        } else if (outcome.frontierHash !== null) invalid();
      }
    }
    if (names.includes("confirmation.json")) {
      const confirmation = record(`${prefix}/confirmation.json`, "actionConfirmation").value;
      const fresh = authorization(confirmation.authorizationHash);
      if (action.kind !== "quarantine-journal-entry" || !metadata || !payload || !fresh ||
        confirmation.targetActionId !== id || confirmation.targetIntentHash !== entries.get(`${prefix}/intent.json`).reference.sha256 ||
        confirmation.quarantineMetadataHash !== entries.get(`${prefix}/quarantine.json`).reference.sha256 ||
        confirmation.originalAuthorizationHash !== intent.authorizationHash ||
        confirmation.actionId !== fresh.proposal.actionId || confirmation.proposalHash !== fresh.proposalHash ||
        confirmation.postStateHash !== fresh.proposal.expectedHash ||
        recoveryValueHash(fresh.proposal.action) !== recoveryValueHash({ kind: "confirm-completed-action",
          targetActionId: id, targetIntentHash: confirmation.targetIntentHash }) ||
        confirmation.locator !== metadata.locator || confirmation.sha256 !== metadata.source.sha256 ||
        Date.parse(confirmation.confirmedAt) < Date.parse(fresh.issuedAt) ||
        Date.parse(confirmation.confirmedAt) >= Date.parse(fresh.expiresAt)) invalid();
    }
    actions.set(id, { metadata, payload, outcome });
  }
  for (const id of list(`${root}/quarantine`)) {
    if (!actionId.test(id) || !actions.has(id)) invalid();
    const bundle = actions.get(id);
    if (!bundle.metadata && list(`${root}/quarantine/${id}`).length) invalid();
  }
  // The live head and unrelated tool frontiers change during publication itself.
  // Only immutable action dependencies belong to this evidence inventory.
  return [...entries.values()];
}
