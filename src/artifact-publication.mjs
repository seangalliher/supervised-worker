import { compileCampaignRelease, serializeCampaignRelease } from "./campaign-release.mjs";
import { validateArtifactPublication, withCampaignPublication } from "./core.mjs";
import { failureFromError, supervisorFailure } from "./supervisor-diagnostics.mjs";

export const MAX_PUBLICATION_REQUEST_BYTES = 65_536;
export const MAX_PUBLICATION_RECEIPT_BYTES = 4_194_304;

export function publishCampaignRelease(cwd, request, authority) {
  let started = false;
  try {
    if (validateArtifactPublication(request, "request").length) throw new Error("PUBLICATION_REQUEST_INVALID");
    const input = { session_id: request.session_id, ...(request.transcript_path === undefined ? {} : { transcript_path: request.transcript_path }) };
    const manifest = structuredClone(request.manifest);
    return withCampaignPublication(cwd, input, authority, (publication) => {
      const receipt = compileCampaignRelease(cwd, input, manifest, authority);
      const bytes = Buffer.from(serializeCampaignRelease(receipt));
      if (bytes.length > MAX_PUBLICATION_RECEIPT_BYTES) throw new Error("PUBLICATION_RECEIPT_TOO_LARGE");
      const requireCandidate = () => {
        publication.authorize();
        const current = compileCampaignRelease(cwd, input, manifest, authority);
        if (current.inputHash !== receipt.inputHash || current.planHash !== receipt.planHash ||
          !Buffer.from(serializeCampaignRelease(current)).equals(bytes)) throw new Error("PUBLICATION_CANDIDATE_CHANGED");
      };
      requireCandidate();
      started = true;
      const result = publication.publish(bytes, requireCandidate);
      requireCandidate();
      const value = { schemaVersion: 1, kind: "artifact-publication", ...result, inputHash: receipt.inputHash, planHash: receipt.planHash };
      if (validateArtifactPublication(value, "result").length) throw new Error("PUBLICATION_RESULT_INVALID");
      return value;
    });
  } catch (error) {
    return { schemaVersion: 1, kind: "artifact-publication",
      status: error?.publicationConflict || error?.transitionCode ? "conflict" : started ? "unconfirmed" : "blocked",
      failure: failureFromError(error, "publication") ?? supervisorFailure(started ? "RECOVERY_PERSISTENCE_UNCONFIRMED" : "RECOVERY_LINEAGE_AMBIGUOUS", started ? "publication" : "admission") };
  }
}
