import { randomBytes } from 'node:crypto';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { OAUTH_REDIRECT_URL } from '../../shared/mcp-presets';
import type { SecretStore } from '../core/secrets';

/** Where each secret of a connection is kept (all of them in the encrypted store). */
export const mcpSecretNames = (id: string) => ({
  token: `mcp:${id}:token`,
  env: `mcp:${id}:env`,
  tokens: `mcp:${id}:oauth-tokens`,
  client: `mcp:${id}:oauth-client`,
  clientId: `mcp:${id}:client-id`,
  clientSecret: `mcp:${id}:client-secret`,
});

const parse = <T>(text: string | undefined): T | undefined => {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

/**
 * What signing in to a service needs from Allaya: who we are, where to be sent back to, and somewhere safe to keep
 * what comes back (the encrypted store, never a plain file). A service that lets apps register themselves gets
 * registered on the first sign-in; one that does not (Google's) is given the app the person made in its console.
 */
export class StoredOAuthProvider implements OAuthClientProvider {
  private verifier = '';

  constructor(
    private readonly secrets: SecretStore,
    private readonly serverId: string,
    private readonly options: {
      /** The person's own app, when the service needs one. */
      ownClient?: boolean;
      /** The secret that ties the sign-in to this attempt. */
      state: string;
      /** Where to take the person to sign in. */
      onRedirect: (url: URL) => void;
    },
  ) {}

  get redirectUrl(): string {
    return OAUTH_REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    const secret = this.options.ownClient
      ? this.secrets.get(mcpSecretNames(this.serverId).clientSecret)
      : undefined;
    return {
      client_name: 'Allaya',
      redirect_uris: [OAUTH_REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: secret ? 'client_secret_post' : 'none',
    };
  }

  state(): string {
    return this.options.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const names = mcpSecretNames(this.serverId);
    if (this.options.ownClient) {
      const clientId = this.secrets.get(names.clientId);
      if (!clientId) return undefined;
      const clientSecret = this.secrets.get(names.clientSecret);
      return { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) };
    }
    return parse<OAuthClientInformationMixed>(this.secrets.get(names.client));
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    if (this.options.ownClient) return;
    this.secrets.set(mcpSecretNames(this.serverId).client, JSON.stringify(info));
  }

  tokens(): OAuthTokens | undefined {
    return parse<OAuthTokens>(this.secrets.get(mcpSecretNames(this.serverId).tokens));
  }

  saveTokens(tokens: OAuthTokens): void {
    this.secrets.set(mcpSecretNames(this.serverId).tokens, JSON.stringify(tokens));
  }

  redirectToAuthorization(url: URL): void {
    this.options.onRedirect(url);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const names = mcpSecretNames(this.serverId);
    if (scope === 'all' || scope === 'tokens') this.secrets.remove(names.tokens);
    if ((scope === 'all' || scope === 'client') && !this.options.ownClient)
      this.secrets.remove(names.client);
    if (scope === 'all' || scope === 'verifier') this.verifier = '';
  }
}

export const newState = (): string => randomBytes(24).toString('hex');
