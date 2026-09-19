import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";

const POSTGRES_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";

/** Resolve a fresh Entra token for an internal service audience. */
export function createAzureAccessTokenProvider(
  scope: string,
  credential: TokenCredential = new DefaultAzureCredential(),
): () => Promise<string> {
  if (!scope.trim()) throw new Error("identity.azure_token_scope_missing");
  return async () => {
    const token = await credential.getToken(scope);
    if (!token?.token) throw new Error("identity.azure_access_token_missing");
    return token.token;
  };
}

/**
 * Return a node-postgres password callback backed by the service's managed identity.
 *
 * node-postgres invokes this when it creates a physical connection, rather than once at
 * process startup. That matters because Entra access tokens expire while a long-running
 * pool is still replacing idle or failed connections.
 */
export function createPostgresAccessTokenProvider(
  credential: TokenCredential = new DefaultAzureCredential(),
): () => Promise<string> {
  return createAzureAccessTokenProvider(POSTGRES_SCOPE, credential);
}
