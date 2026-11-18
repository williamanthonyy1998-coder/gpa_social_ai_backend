import type { SocialPlatform } from '@prisma/client';

export type OAuthProviderConfig = {
  clientId: string; clientSecret: string; authorizationUrl: string; tokenUrl: string;
  redirectUri: string; scopes: string[]; profileUrl: string; usePkce: boolean;
  clientIdParam: string; tokenAuth: 'body' | 'basic'; tokenMethod: 'GET' | 'POST'; authParams: Record<string,string>;
};

const prefix: Record<SocialPlatform, string> = {
  FACEBOOK: 'META_FACEBOOK', INSTAGRAM: 'META_INSTAGRAM', LINKEDIN: 'LINKEDIN',
  X: 'X', TIKTOK: 'TIKTOK', YOUTUBE: 'GOOGLE', PINTEREST: 'PINTEREST',
};

export function getOAuthConfig(platform: SocialPlatform): OAuthProviderConfig | null {
  const p = prefix[platform];
  const get = (key: string) => process.env[`${p}_OAUTH_${key}`]?.trim() ?? '';
  const clientId = get('CLIENT_ID');
  const clientSecret = get('CLIENT_SECRET');
  const authorizationUrl = get('AUTHORIZATION_URL');
  const tokenUrl = get('TOKEN_URL');
  const redirectUri = get('REDIRECT_URI');
  const profileUrl = get('PROFILE_URL');
  const scopes = get('SCOPES').split(/[ ,]+/).filter(Boolean);
  if (![clientId, clientSecret, authorizationUrl, tokenUrl, redirectUri, profileUrl].every(Boolean)) return null;
  for (const value of [authorizationUrl, tokenUrl, redirectUri, profileUrl]) {
    if (value.includes('XX.X') || value.includes('REPLACE_')) return null;
    try { const u = new URL(value); if (u.protocol !== 'https:' && process.env.NODE_ENV === 'production') return null; }
    catch { return null; }
  }
  return {
    clientId, clientSecret, authorizationUrl, tokenUrl, redirectUri, profileUrl, scopes,
    usePkce: get('PKCE').toLowerCase() === 'true',
    clientIdParam: get('CLIENT_ID_PARAM') || 'client_id',
    tokenAuth: get('TOKEN_AUTH') === 'basic' ? 'basic' : 'body',
    tokenMethod: get('TOKEN_METHOD') === 'GET' ? 'GET' : 'POST',
    authParams: (() => { try { const value = JSON.parse(get('AUTH_PARAMS_JSON') || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string,string] => typeof entry[1] === 'string')) : {}; } catch { return {}; } })(),
  };
}
