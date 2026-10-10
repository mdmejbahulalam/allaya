import { describe, expect, it } from 'vitest';
import { OAUTH_REDIRECT_URL } from '@lite/shared/mcp-presets';
import { SecretStore } from '@lite/main/core/secrets';
import { openDb } from '@lite/main/core/db';
import { StoredOAuthProvider, mcpSecretNames, newState } from '@lite/main/mcp/oauth';
import { FakeCipher } from '../helpers/cipher';

const make = (options: { ownClient?: boolean } = {}) => {
  const secrets = new SecretStore(openDb(':memory:'), new FakeCipher());
  const redirects: string[] = [];
  const provider = new StoredOAuthProvider(secrets, 'srv', {
    ownClient: options.ownClient ?? false,
    state: 'fixed-state',
    onRedirect: (url) => redirects.push(url.toString()),
  });
  return { secrets, provider, redirects, names: mcpSecretNames('srv') };
};

describe('what signing in needs from Allaya', () => {
  it('says who it is, where to come back to, and what it holds', () => {
    const { provider } = make();
    expect(provider.redirectUrl).toBe(OAUTH_REDIRECT_URL);
    expect(provider.clientMetadata).toMatchObject({
      client_name: 'Allaya',
      redirect_uris: [OAUTH_REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(provider.state()).toBe('fixed-state');
    expect(newState()).toMatch(/^[0-9a-f]{48}$/);
    expect(newState()).not.toBe(newState());
  });

  it('keeps a service’s registration of Allaya, and its tokens, in the encrypted store only', () => {
    const { provider, secrets, names } = make();
    expect(provider.clientInformation()).toBeUndefined();
    expect(provider.tokens()).toBeUndefined();
    provider.saveClientInformation({ client_id: 'c-1', redirect_uris: [OAUTH_REDIRECT_URL] });
    provider.saveTokens({ access_token: 'at-1', token_type: 'Bearer', refresh_token: 'rt-1' });
    expect(provider.clientInformation()).toMatchObject({ client_id: 'c-1' });
    expect(provider.tokens()).toMatchObject({ access_token: 'at-1', refresh_token: 'rt-1' });
    expect(secrets.has(names.client)).toBe(true);
    expect(secrets.has(names.tokens)).toBe(true);
  });

  it('forgets what it is told to: the tokens, the registration, or the sign-in in progress', () => {
    const { provider, secrets, names } = make();
    provider.saveClientInformation({ client_id: 'c-1', redirect_uris: [OAUTH_REDIRECT_URL] });
    provider.saveTokens({ access_token: 'at-1', token_type: 'Bearer' });
    provider.saveCodeVerifier('verifier');
    expect(provider.codeVerifier()).toBe('verifier');
    provider.invalidateCredentials('tokens');
    expect(secrets.has(names.tokens)).toBe(false);
    expect(secrets.has(names.client)).toBe(true);
    provider.invalidateCredentials('verifier');
    expect(provider.codeVerifier()).toBe('');
    provider.invalidateCredentials('client');
    expect(secrets.has(names.client)).toBe(false);
    provider.saveClientInformation({ client_id: 'c-2', redirect_uris: [OAUTH_REDIRECT_URL] });
    provider.saveTokens({ access_token: 'at-2', token_type: 'Bearer' });
    provider.invalidateCredentials('all');
    expect(secrets.has(names.client)).toBe(false);
    expect(secrets.has(names.tokens)).toBe(false);
  });

  it('hands the address to go to over to whoever opens the browser', () => {
    const { provider, redirects } = make();
    provider.redirectToAuthorization(new URL('https://example.com/authorize?x=1'));
    expect(redirects).toEqual(['https://example.com/authorize?x=1']);
  });

  it('treats a damaged saved sign-in as none, not as a crash', () => {
    const { provider, secrets, names } = make();
    secrets.set(names.tokens, '{not json');
    secrets.set(names.client, 'nonsense');
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toBeUndefined();
  });

  it('with the person’s own app: uses their client ID and secret, and never saves a registration over them', () => {
    const { provider, secrets, names } = make({ ownClient: true });
    expect(provider.clientInformation()).toBeUndefined();
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none');
    secrets.set(names.clientId, 'my-id');
    expect(provider.clientInformation()).toEqual({ client_id: 'my-id' });
    secrets.set(names.clientSecret, 'my-secret');
    expect(provider.clientInformation()).toEqual({
      client_id: 'my-id',
      client_secret: 'my-secret',
    });
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('client_secret_post');
    provider.saveClientInformation({ client_id: 'registered-by-service', redirect_uris: [] });
    expect(secrets.has(names.client)).toBe(false);
    expect(provider.clientInformation()).toMatchObject({ client_id: 'my-id' });
    // Forgetting the registration leaves their app alone.
    provider.invalidateCredentials('all');
    expect(secrets.get(names.clientId)).toBe('my-id');
    expect(secrets.get(names.clientSecret)).toBe('my-secret');
  });
});
