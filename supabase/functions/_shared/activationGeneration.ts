/**
 * Activation generations (migration 20261123100000_flow_activation_generation).
 *
 * Every genuine transition of a flow activation to "active" is a NEW generation
 * (automation_flow_activations.activation_generation, bumped by a trigger). A run
 * is stamped, when it is created, with the generation it was created under
 * (automation_flow_runs.activation_generation). A run - and every effect that
 * belongs to it - is eligible only while its stamp equals the CURRENT generation
 * of its flow's active activation. The SQL functions enforce the same rule; this
 * module is the TypeScript mirror used by the workers and the durable ingress.
 *
 * Stamp meaning on a run:
 *   null / undefined  legacy row (created before the migration, or a database
 *                     that does not have the column): previous behaviour - eligible
 *                     while its revision is active (SQL does the same).
 *   0                 dead: it was inactive when the migration ran. Never matches.
 *   n >= 1            eligible only while the activation is on generation n.
 * A malformed stamp, or a stamped run whose activation has no readable
 * generation, is NOT eligible (fail closed).
 */

/** bigint arrives as a JSON number, or as a string for very large values. */
export function parseGeneration(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^[0-9]{1,15}$/.test(value)) {
    return Number(value);
  }
  return null;
}

/** Does a run created under `runGeneration` belong to the activation's generation? */
export function generationMatches(runGeneration: unknown, activationGeneration: unknown): boolean {
  if (runGeneration === null || runGeneration === undefined) return true; // legacy NULL stamp
  const run = parseGeneration(runGeneration);
  if (run === null || run === 0) return false; // malformed, or the migration's "dead" stamp
  const current = parseGeneration(activationGeneration);
  return current !== null && run === current;
}

interface ActivationLike {
  revision?: unknown;
  is_active?: unknown;
  activation_generation?: unknown;
}
interface RunLike {
  publication_revision?: unknown;
  activation_generation?: unknown;
}

/**
 * True only when the activation row is active, is on the run's revision, and the
 * run belongs to the activation's current generation.
 */
export function revisionLive(
  activation: ActivationLike | null | undefined,
  run: RunLike | null | undefined,
): boolean {
  if (!activation || !run) return false;
  if (activation.is_active !== true) return false;
  if (Number(activation.revision) !== Number(run.publication_revision)) return false;
  return generationMatches(run.activation_generation, activation.activation_generation);
}
