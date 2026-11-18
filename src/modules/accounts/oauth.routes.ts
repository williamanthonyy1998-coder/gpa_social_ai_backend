import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { decryptToken, encryptToken } from '../../lib/token-vault.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { getOAuthConfig } from './oauth.config.js';
import type { SocialPlatform } from '@prisma/client';

export const oauthRouter = Router();
const allowed = new Set<SocialPlatform>(['FACEBOOK','INSTAGRAM','LINKEDIN','X','TIKTOK','YOUTUBE','PINTEREST']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const b64url = (value: Buffer) => value.toString('base64url');
const frontend = () => process.env.WEB_ORIGIN ?? 'http://localhost:5173';
oauthRouter.get('/configured', requireAuth, requirePermission('accounts.manage'), (_req,res) => {
  const platforms = Array.from(allowed);
  return res.json({ success:true, data: platforms.map(platform => ({ platform, configured: Boolean(getOAuthConfig(platform)) })) });
});

// Authenticated initiation: state is random, stored only as a hash, short-lived and one-time.
oauthRouter.post('/:platform/start', requireAuth, requirePermission('accounts.manage'), async (req, res) => {
  const platform = String(req.params.platform).toUpperCase() as SocialPlatform;
  if (!allowed.has(platform)) return res.status(400).json({ success:false, error:{code:'UNSUPPORTED_PLATFORM',message:'Unsupported social platform.'} });
  const config = getOAuthConfig(platform);
  if (!config) return res.status(503).json({ success:false, error:{code:'OAUTH_NOT_CONFIGURED',message:`OAuth configuration for ${platform} is incomplete.`} });
  await prisma.socialOAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const state = b64url(randomBytes(32));
  const verifier = config.usePkce ? b64url(randomBytes(48)) : null;
  await prisma.socialOAuthState.create({ data: {
    stateHash: hash(state), platform, organizationId: req.auth!.organizationId,
    userId: req.auth!.userId, codeVerifier: verifier, expiresAt: new Date(Date.now()+10*60*1000),
  }});
  const url = new URL(config.authorizationUrl);
  url.searchParams.set('response_type','code');
  url.searchParams.set(config.clientIdParam,config.clientId);
  url.searchParams.set('redirect_uri',config.redirectUri);
  url.searchParams.set('state',state);
  for (const [key,value] of Object.entries(config.authParams)) url.searchParams.set(key,value);
  if (config.scopes.length) url.searchParams.set('scope',config.scopes.join(' '));
  if (verifier) url.searchParams.set('code_challenge',b64url(createHash('sha256').update(verifier).digest()));
  if (verifier) url.searchParams.set('code_challenge_method','S256');
  return res.json({ success:true, data:{ authorizationUrl:url.toString() } });
});

// Public callback: only the one-time, short-lived state record authorizes the callback.
oauthRouter.get('/:platform/callback', async (req,res) => {
  const platform = String(req.params.platform).toUpperCase() as SocialPlatform;
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const providerError = typeof req.query.error === 'string' ? req.query.error : '';
  const finish = (status: string) => res.redirect(`${frontend()}/accounts?oauth=${encodeURIComponent(status)}`);
  if (!allowed.has(platform) || !state) return finish('invalid_state');
  const stateRow = await prisma.socialOAuthState.findUnique({ where: { stateHash: hash(state) } });
  if (!stateRow || stateRow.platform !== platform || stateRow.consumedAt || stateRow.expiresAt <= new Date()) return finish('invalid_state');
  const consumed = await prisma.socialOAuthState.updateMany({ where: { id: stateRow.id, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
  if (consumed.count !== 1) return finish('invalid_state');
  if (providerError || !code) return finish('provider_denied');
  const config = getOAuthConfig(platform);
  if (!config) return finish('provider_not_configured');
  try {
    const form = new URLSearchParams({ grant_type:'authorization_code', code, redirect_uri:config.redirectUri });
    if (config.tokenAuth === 'body') {
      form.set(config.clientIdParam,config.clientId);
      form.set('client_secret',config.clientSecret);
    }
    if (stateRow.codeVerifier) form.set('code_verifier',stateRow.codeVerifier);
    const headers: Record<string,string> = { 'Content-Type':'application/x-www-form-urlencoded', 'Accept':'application/json' };
    if (config.tokenAuth === 'basic') headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
    const tokenUrl = new URL(config.tokenUrl);
    const tokenResponse = config.tokenMethod === 'GET'
      ? await fetch((tokenUrl.search = form.toString(), tokenUrl.toString()), { method:'GET', headers })
      : await fetch(config.tokenUrl,{method:'POST',headers,body:form,signal:AbortSignal.timeout(15000)});
    const tokenData = await tokenResponse.json() as Record<string,any>;
    const tokenPayload = (tokenData.data && typeof tokenData.data === 'object' ? tokenData.data : tokenData) as Record<string,unknown>;
    if (!tokenResponse.ok || typeof tokenPayload.access_token !== 'string') throw new Error('Token exchange rejected by provider.');
    const accessToken = tokenPayload.access_token;
    const refreshToken = typeof tokenPayload.refresh_token === 'string' ? tokenPayload.refresh_token : undefined;
    const expiresIn = Number(tokenPayload.expires_in);
    const profileResponse = await fetch(config.profileUrl,{headers:{Authorization:`Bearer ${accessToken}`,Accept:'application/json'},signal:AbortSignal.timeout(15000)});
    if (!profileResponse.ok) throw new Error(`Provider profile lookup failed (${profileResponse.status}).`);
    const profile = await profileResponse.json() as any;
    // Normalize provider response envelopes instead of assuming one generic shape.
    const candidate = platform === 'YOUTUBE'
      ? (Array.isArray(profile?.items) ? profile.items[0] : null)
      : platform === 'TIKTOK'
        ? (profile?.data?.user ?? null)
        : platform === 'PINTEREST'
          ? (profile?.data ?? profile)
          : (profile?.data?.user ?? profile?.data ?? profile);
    const externalId = String(
      platform === 'YOUTUBE' ? candidate?.id :
      platform === 'PINTEREST' ? (candidate?.id ?? candidate?.username) :
      (candidate?.id ?? candidate?.sub ?? candidate?.open_id ?? '')
    );
    if (!externalId || externalId === 'undefined') throw new Error('Provider profile response did not contain a stable account identifier.');
    const name = String(candidate?.snippet?.title ?? candidate?.name ?? candidate?.display_name ?? candidate?.username ?? candidate?.email ?? `${platform} account`).slice(0,120);
    const handleValue = candidate?.username ?? candidate?.unique_id ?? candidate?.snippet?.customUrl ?? null;
    const profileUrl = candidate?.link ?? candidate?.profile_url ?? (platform === 'YOUTUBE' ? `https://www.youtube.com/channel/${externalId}` : null);
    const scopesRaw = typeof tokenPayload.scope === 'string' ? tokenPayload.scope.split(/[ ,]+/).filter(Boolean) : config.scopes;
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now()+expiresIn*1000) : null;
    const existing = await prisma.socialAccount.findFirst({where:{organizationId:stateRow.organizationId,platform,externalAccountId:externalId}});
    const account = existing ? await prisma.socialAccount.update({where:{id:existing.id},data:{accountName:name,handle:handleValue?String(handleValue).slice(0,120):null,profileUrl:profileUrl?String(profileUrl).slice(0,500):null,status:'CONNECTED',accessTokenCiphertext:encryptToken(accessToken),refreshTokenCiphertext:refreshToken?encryptToken(refreshToken):null,tokenExpiresAt:expiresAt,scopes:scopesRaw,lastVerifiedAt:new Date(),lastError:null}}) : await prisma.socialAccount.create({data:{organizationId:stateRow.organizationId,platform,externalAccountId:externalId,accountName:name,handle:handleValue?String(handleValue).slice(0,120):null,profileUrl:profileUrl?String(profileUrl).slice(0,500):null,status:'CONNECTED',accessTokenCiphertext:encryptToken(accessToken),refreshTokenCiphertext:refreshToken?encryptToken(refreshToken):null,tokenExpiresAt:expiresAt,scopes:scopesRaw,lastVerifiedAt:new Date()}});
    await prisma.auditLog.create({data:{organizationId:stateRow.organizationId,userId:stateRow.userId,entityType:'SocialAccount',entityId:account.id,action:'SOCIAL_ACCOUNT_OAUTH_CONNECTED',newValue:{platform,externalAccountId:externalId},correlationId:undefined}});
    return finish('connected');
  } catch (error) {
    console.error('Social OAuth callback failed:',error instanceof Error?error.message:'unknown error');
    return finish('connection_failed');
  }
});


// Meta asset discovery: list Facebook Pages the authorized person can manage.
// The user token is never returned to the browser.
oauthRouter.get('/meta/:accountId/assets', requireAuth, requirePermission('accounts.manage'), async (req,res) => {
  const account = await prisma.socialAccount.findFirst({
    where:{id:String(req.params.accountId),organizationId:req.auth!.organizationId,platform:'FACEBOOK',status:'CONNECTED'},
  });
  if (!account?.accessTokenCiphertext) return res.status(404).json({success:false,error:{code:'ACCOUNT_NOT_FOUND',message:'Connected Facebook account not found.'}});
  const version = process.env.META_GRAPH_API_VERSION?.trim() ?? '';
  if (!/^v\d+\.\d+$/.test(version)) return res.status(503).json({success:false,error:{code:'META_VERSION_REQUIRED',message:'Set META_GRAPH_API_VERSION to a supported Graph API version.'}});
  try {
    const token = decryptToken(account.accessTokenCiphertext);
    const url = new URL(`https://graph.facebook.com/${version}/me/accounts`);
    url.searchParams.set('fields','id,name,access_token,category,instagram_business_account{id,username,name}');
    url.searchParams.set('access_token',token);
    const response = await fetch(url,{signal:AbortSignal.timeout(15000)});
    const payload = await response.json() as any;
    if(!response.ok || payload.error) return res.status(502).json({success:false,error:{code:'META_ASSET_LOOKUP_FAILED',message:'Meta could not return managed Pages. Verify app review and pages_show_list/pages_read_engagement permissions.'}});
    const pages = Array.isArray(payload.data) ? payload.data : [];
    return res.json({success:true,data:pages.map((p:any)=>({
      id:String(p.id),name:String(p.name??'Facebook Page'),
      category:typeof p.category==='string'?p.category:null,
      hasInstagramBusinessAccount:Boolean(p.instagram_business_account?.id),
      instagram:p.instagram_business_account?{id:String(p.instagram_business_account.id),username:p.instagram_business_account.username??null,name:p.instagram_business_account.name??null}:null,
      // The page access token is intentionally not sent to the browser.
    }))});
  } catch(error) {
    console.error('Meta asset discovery failed:',error instanceof Error?error.message:'unknown error');
    return res.status(502).json({success:false,error:{code:'META_ASSET_LOOKUP_FAILED',message:'Unable to retrieve Facebook Pages.'}});
  }
});

// Select a managed Facebook Page; its page token is encrypted at rest.
// If an Instagram professional account is linked, it is registered separately using its own IG id.
oauthRouter.post('/meta/:accountId/assets/:pageId/select', requireAuth, requirePermission('accounts.manage'), async (req,res) => {
  const account = await prisma.socialAccount.findFirst({
    where:{id:String(req.params.accountId),organizationId:req.auth!.organizationId,platform:'FACEBOOK',status:'CONNECTED'},
  });
  if (!account?.accessTokenCiphertext) return res.status(404).json({success:false,error:{code:'ACCOUNT_NOT_FOUND',message:'Connected Facebook account not found.'}});
  const version = process.env.META_GRAPH_API_VERSION?.trim() ?? '';
  if (!/^v\d+\.\d+$/.test(version)) return res.status(503).json({success:false,error:{code:'META_VERSION_REQUIRED',message:'Set META_GRAPH_API_VERSION to a supported Graph API version.'}});
  try {
    const token = decryptToken(account.accessTokenCiphertext);
    const url = new URL(`https://graph.facebook.com/${version}/me/accounts`);
    url.searchParams.set('fields','id,name,access_token,category,instagram_business_account{id,username,name}');
    url.searchParams.set('access_token',token);
    const response = await fetch(url,{signal:AbortSignal.timeout(15000)});
    const payload = await response.json() as any;
    if(!response.ok || payload.error) return res.status(502).json({success:false,error:{code:'META_ASSET_LOOKUP_FAILED',message:'Meta Page lookup failed.'}});
    const page = (Array.isArray(payload.data)?payload.data:[]).find((p:any)=>String(p.id)===String(req.params.pageId));
    if(!page || typeof page.access_token!=='string') return res.status(404).json({success:false,error:{code:'PAGE_NOT_MANAGED',message:'The selected Page is not available to this connected user.'}});
    const pageRow = await prisma.socialAccount.upsert({
      where:{organizationId_platform_externalAccountId:{organizationId:account.organizationId,platform:'FACEBOOK',externalAccountId:String(page.id)}},
      update:{accountName:String(page.name??'Facebook Page'),status:'CONNECTED',accessTokenCiphertext:encryptToken(page.access_token),refreshTokenCiphertext:null,tokenExpiresAt:null,scopes:account.scopes,lastVerifiedAt:new Date(),lastError:null,metadata:{assetType:'FACEBOOK_PAGE',parentAccountId:account.id,category:page.category??null}},
      create:{organizationId:account.organizationId,platform:'FACEBOOK',externalAccountId:String(page.id),accountName:String(page.name??'Facebook Page'),status:'CONNECTED',accessTokenCiphertext:encryptToken(page.access_token),scopes:account.scopes,lastVerifiedAt:new Date(),metadata:{assetType:'FACEBOOK_PAGE',parentAccountId:account.id,category:page.category??null}},
    });
    let instagramRow = null;
    const ig = page.instagram_business_account;
    if(ig?.id) {
      instagramRow = await prisma.socialAccount.upsert({
        where:{organizationId_platform_externalAccountId:{organizationId:account.organizationId,platform:'INSTAGRAM',externalAccountId:String(ig.id)}},
        update:{accountName:String(ig.name??ig.username??'Instagram Professional Account'),handle:ig.username?String(ig.username):null,status:'CONNECTED',accessTokenCiphertext:encryptToken(page.access_token),refreshTokenCiphertext:null,tokenExpiresAt:null,scopes:account.scopes,lastVerifiedAt:new Date(),lastError:null,metadata:{assetType:'INSTAGRAM_PROFESSIONAL',facebookPageId:String(page.id),parentAccountId:account.id}},
        create:{organizationId:account.organizationId,platform:'INSTAGRAM',externalAccountId:String(ig.id),accountName:String(ig.name??ig.username??'Instagram Professional Account'),handle:ig.username?String(ig.username):null,status:'CONNECTED',accessTokenCiphertext:encryptToken(page.access_token),scopes:account.scopes,lastVerifiedAt:new Date(),metadata:{assetType:'INSTAGRAM_PROFESSIONAL',facebookPageId:String(page.id),parentAccountId:account.id}},
      });
    }
    await prisma.auditLog.create({data:{organizationId:account.organizationId,userId:req.auth!.userId,entityType:'SocialAccount',entityId:pageRow.id,action:'META_PAGE_SELECTED',newValue:{pageId:String(page.id),instagramAccountId:instagramRow?.id??null}}});
    return res.json({success:true,data:{facebookPage:{id:pageRow.id,name:pageRow.accountName},instagram:instagramRow?{id:instagramRow.id,name:instagramRow.accountName,handle:instagramRow.handle}:null}});
  } catch(error) {
    console.error('Meta Page selection failed:',error instanceof Error?error.message:'unknown error');
    return res.status(502).json({success:false,error:{code:'META_PAGE_SELECTION_FAILED',message:'Unable to save the selected Page.'}});
  }
});
