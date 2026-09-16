const MAX_JOBS = 128;
const MAX_OBSERVED_JOBS = 256;
const MAX_STEPS = 128;

function record(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function name(value) {
  return typeof value === "string" && [...value].length <= 256 &&
    /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u.test(value) && /\S/u.test(value);
}

function names(values) {
  return Array.isArray(values) && values.length <= MAX_STEPS &&
    values.every(name) && new Set(values).size === values.length;
}

export function validateRepositoryCiPolicy(policy) {
  if (!record(policy, ["requiredJobs"]) || !Array.isArray(policy.requiredJobs) ||
    policy.requiredJobs.length < 1 || policy.requiredJobs.length > MAX_JOBS ||
    policy.requiredJobs.some(job => !record(job, ["name", "requiredSteps"]) ||
      !name(job.name) || !names(job.requiredSteps)) ||
    new Set(policy.requiredJobs.map(job => job.name)).size !== policy.requiredJobs.length) {
    return ["validation.ci requires bounded unique jobs and step names"];
  }
  return [];
}

export function verifyRepositoryCiObservation(ci, policy, workflowHash, commit) {
  if (validateRepositoryCiPolicy(policy).length > 0 ||
    typeof workflowHash !== "string" || !/^[0-9a-f]{64}$/.test(workflowHash)) {
    throw new Error("RELEASE_CI_POLICY_REQUIRED");
  }
  if (!record(ci, ["kind", "workflowHash", "runId", "commit", "complete", "conclusion", "jobs"]) ||
    ci.kind !== "repository-ci" || ci.workflowHash !== workflowHash || ci.commit !== commit ||
    typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit) ||
    !Number.isSafeInteger(ci.runId) || ci.runId < 1 || ci.complete !== true || ci.conclusion !== "success" ||
    !Array.isArray(ci.jobs) || ci.jobs.length < 1 || ci.jobs.length > MAX_OBSERVED_JOBS) {
    throw new Error("RELEASE_CI_OBSERVATION_INVALID");
  }
  const jobs = new Map();
  for (const job of ci.jobs) {
    if (!record(job, ["name", "commit", "conclusion", "steps"]) || !name(job.name) ||
      jobs.has(job.name) || job.commit !== commit || job.conclusion !== "success" ||
      !Array.isArray(job.steps) || job.steps.length > MAX_STEPS) {
      throw new Error("RELEASE_CI_OBSERVATION_INVALID");
    }
    const steps = new Set();
    for (const step of job.steps) {
      if (!record(step, ["name", "status", "conclusion"]) || !name(step.name) || steps.has(step.name) ||
        step.status !== "completed" || step.conclusion !== "success") {
        throw new Error("RELEASE_CI_OBSERVATION_INVALID");
      }
      steps.add(step.name);
    }
    jobs.set(job.name, steps);
  }
  for (const required of policy.requiredJobs) {
    const steps = jobs.get(required.name);
    if (steps === undefined || required.requiredSteps.some(step => !steps.has(step))) {
      throw new Error("RELEASE_CI_OBSERVATION_INVALID");
    }
  }
}
