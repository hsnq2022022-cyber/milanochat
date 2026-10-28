/**
 * PostgREST resolves requests that fail SQL constraints with {error}, rather
 * than throwing exceptions. Check that response before replying to Meta.
 */
export type InboundInsertResponse = {
  error?: {code?:string|null}|null;
};
export type InboundStoreResult = "saved" | "duplicate" | "failed";

export async function persistInboundOnce(
  insert: () => Promise<InboundInsertResponse|null|undefined>
): Promise<InboundStoreResult> {
  try {
    const response = await insert();
    if (!response) return "failed";
    if (!response.error) return "saved";
    return response.error.code === "23505" ? "duplicate" : "failed";
  } catch {
    return "failed";
  }
}
