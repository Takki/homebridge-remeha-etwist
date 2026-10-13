import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
// Endpoints and identifiers used by the official Remeha Home app.
// Reverse engineered by https://github.com/msvisser/remeha_home.
const API_BASE = 'https://api.bdrthermea.net/Mobile/api';
const SUBSCRIPTION_KEY = 'df605c5470d846fc91e848b1cc653ddf';
const LOGIN_BASE = 'https://remehalogin.bdrthermea.net/bdrb2cprod.onmicrosoft.com';
const POLICY = 'B2C_1A_RPSignUpSignInNewRoomV3.1';
const CLIENT_ID = '6ce007c6-0628-419e-88f4-bee2e6418eec';
const REDIRECT_URI = 'com.b2c.remehaapp://login-callback';
const SCOPE = 'openid https://bdrb2cprod.onmicrosoft.com/iotdevice/user_impersonation offline_access';
const REQUEST_TIMEOUT_MS = 30_000;
export class RemehaAuthError extends Error {
}
export class RemehaApi {
    email;
    password;
    tokenFile;
    debug;
    token;
    tokenPromise;
    constructor(email, password, tokenFile, debug) {
        this.email = email;
        this.password = password;
        this.tokenFile = tokenFile;
        this.debug = debug;
    }
    getDashboard() {
        return this.request('GET', `/homes/dashboard?t=${Date.now()}`);
    }
    setClimateManual(zoneId, setpoint) {
        return this.request('POST', `/climate-zones/${zoneId}/modes/manual`, { roomTemperatureSetPoint: setpoint });
    }
    setClimateTemporaryOverride(zoneId, setpoint) {
        return this.request('POST', `/climate-zones/${zoneId}/modes/temporary-override`, { roomTemperatureSetPoint: setpoint });
    }
    setClimateSchedule(zoneId, heatingProgramId) {
        return this.request('POST', `/climate-zones/${zoneId}/modes/schedule`, { heatingProgramId });
    }
    setClimateOff(zoneId) {
        return this.request('POST', `/climate-zones/${zoneId}/modes/anti-frost`);
    }
    setHotWaterComfort(zoneId) {
        return this.request('POST', `/hot-water-zones/${zoneId}/modes/continuous-comfort`);
    }
    setHotWaterSchedule(zoneId) {
        return this.request('POST', `/hot-water-zones/${zoneId}/modes/schedule`);
    }
    setHotWaterEco(zoneId) {
        return this.request('POST', `/hot-water-zones/${zoneId}/modes/anti-frost`);
    }
    setHotWaterComfortSetpoint(zoneId, comfortSetpoint) {
        return this.request('POST', `/hot-water-zones/${zoneId}/comfort-setpoint`, { comfortSetpoint });
    }
    async request(method, path, body, retried = false) {
        const token = await this.getToken();
        const res = await fetch(API_BASE + path, {
            method,
            headers: {
                'Authorization': `Bearer ${token.accessToken}`,
                'Ocp-Apim-Subscription-Key': SUBSCRIPTION_KEY,
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.status === 401 && !retried) {
            this.debug('API returned 401, refreshing token');
            this.token = { ...token, expiresAt: 0 };
            return this.request(method, path, body, true);
        }
        if (!res.ok) {
            throw new Error(`${method} ${path.split('?')[0]} failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
        }
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined);
    }
    /** Returns a valid token, refreshing or logging in as needed. Concurrent callers share one attempt. */
    async getToken() {
        if (this.token && this.token.expiresAt > Date.now() + 60_000) {
            return this.token;
        }
        this.tokenPromise ??= this.obtainToken().finally(() => {
            this.tokenPromise = undefined;
        });
        return this.tokenPromise;
    }
    async obtainToken() {
        this.token ??= await this.loadToken();
        if (this.token?.refreshToken) {
            try {
                this.debug('Refreshing access token');
                return await this.saveToken(await this.tokenRequest({
                    grant_type: 'refresh_token',
                    refresh_token: this.token.refreshToken,
                    client_id: CLIENT_ID,
                }));
            }
            catch (err) {
                this.debug(`Token refresh failed, logging in again: ${err.message}`);
            }
        }
        return this.saveToken(await this.login());
    }
    async login() {
        this.debug('Logging in to Remeha Home');
        const cookies = new Map();
        const collect = (res) => {
            for (const c of res.headers.getSetCookie()) {
                const [pair] = c.split(';');
                const i = pair.indexOf('=');
                cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
            }
        };
        const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
        const state = b64url(randomBytes(32));
        const verifier = b64url(randomBytes(64));
        const challenge = b64url(createHash('sha256').update(verifier).digest());
        // 1. Start a login transaction. Follow redirects ourselves to keep the cookies.
        let url = `${LOGIN_BASE}/oauth2/v2.0/authorize?` + new URLSearchParams({
            response_type: 'code',
            client_id: CLIENT_ID,
            redirect_uri: REDIRECT_URI,
            scope: SCOPE,
            state,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            p: POLICY,
            brand: 'remeha',
            lang: 'en',
            nonce: 'defaultNonce',
            prompt: 'login',
            signUp: 'False',
        });
        let res;
        for (let hops = 0;; hops++) {
            res = await fetch(url, {
                headers: { cookie: cookieHeader() },
                redirect: 'manual',
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            collect(res);
            const location = res.headers.get('location');
            if (res.status < 300 || res.status >= 400 || !location || hops >= 5) {
                break;
            }
            url = new URL(location, url).toString();
        }
        if (!res.ok) {
            throw new Error(`Login page request failed: HTTP ${res.status}`);
        }
        const requestId = res.headers.get('x-request-id');
        const csrf = cookies.get('x-ms-cpim-csrf');
        if (!requestId || !csrf) {
            throw new Error('Login page did not return a request id or CSRF token; the Remeha login flow may have changed');
        }
        const tx = 'StateProperties=' + b64url(Buffer.from(JSON.stringify({ TID: requestId })));
        // 2. Submit the credentials.
        res = await fetch(`${LOGIN_BASE}/${POLICY}/SelfAsserted?` + new URLSearchParams({ tx, p: POLICY }), {
            method: 'POST',
            headers: {
                'cookie': cookieHeader(),
                'x-csrf-token': csrf,
                'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ request_type: 'RESPONSE', signInName: this.email, password: this.password }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        collect(res);
        const result = JSON.parse(await res.text());
        if (result.status !== '200') {
            throw new RemehaAuthError(`Login rejected: ${result.message ?? 'check your email and password'}`);
        }
        // 3. Confirm, which redirects to the app callback with the authorization code.
        res = await fetch(`${LOGIN_BASE}/${POLICY}/api/CombinedSigninAndSignup/confirmed?` + new URLSearchParams({
            rememberMe: 'false',
            csrf_token: csrf,
            tx,
            p: POLICY,
        }), {
            headers: { cookie: cookieHeader() },
            redirect: 'manual',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const location = res.headers.get('location');
        const code = location ? new URL(location).searchParams.get('code') : null;
        if (!code) {
            throw new Error(`Login did not return an authorization code (HTTP ${res.status})`);
        }
        // 4. Exchange the code for tokens.
        return this.tokenRequest({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
            client_id: CLIENT_ID,
        });
    }
    async tokenRequest(params) {
        const res = await fetch(`${LOGIN_BASE}/oauth2/v2.0/token?p=${POLICY}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(params),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
            throw new Error(`Token request failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
        }
        const json = await res.json();
        return {
            accessToken: json.access_token,
            refreshToken: json.refresh_token,
            expiresAt: Date.now() + json.expires_in * 1000,
        };
    }
    async loadToken() {
        try {
            return JSON.parse(await fs.readFile(this.tokenFile, 'utf8'));
        }
        catch {
            return undefined;
        }
    }
    async saveToken(token) {
        this.token = token;
        try {
            await fs.writeFile(this.tokenFile, JSON.stringify(token), { mode: 0o600 });
        }
        catch (err) {
            this.debug(`Could not save token: ${err.message}`);
        }
        return token;
    }
}
function b64url(buf) {
    return buf.toString('base64url');
}
//# sourceMappingURL=remehaApi.js.map