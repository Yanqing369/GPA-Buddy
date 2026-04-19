/**
 * visitor.js - FingerprintJS Pro + OSS fallback + visitor credit system
 */

const Visitor = {
    id: null,
    fpType: null, // 'pro' | 'oss' | 'temp'
    credits: 0,
    userBalance: null, // 登录后的 user balance（null 表示未登录）
    initialized: false,

    // 配置：请替换为你的 FingerprintJS Pro Public API Key
    PRO_API_KEY: '9BbMO16WgqT8N6L9FGHw',
    PRO_REGION: 'us', // 'ap' | 'us' | 'eu'
    // Cloudflare Proxy Integration 路径（配置完成后填入，例如 'VWmFUKL1dfIjc8gg'）
    // 留空则使用默认 CDN (fpjscdn.net)，Edge/Safari 可能被拦截
    PRO_PROXY_PATH: '6Gnc7iPx4pM8O81c',

    getApiBase() {
        if (typeof API_BASE !== 'undefined') return API_BASE;
        return '';
    },

    async init() {
        if (this.initialized) return;
        
        // 检查 URL 中的邀请码
        this._checkInviteParam();

        // 1. 尝试读取缓存（7天）
        const cached = this._getCache();
        if (cached && cached.visitorId) {
            this.id = cached.visitorId;
            this.fpType = cached.fpType || 'oss';
            const source = this.fpType === 'pro' ? 'FingerprintPro' : this.fpType === 'oss' ? 'FingerprintJS OSS' : 'random temporary';
            console.log(`[Visitor] Using cached ${source}, visitor id=${this.id}`);
            this.initialized = true;
            await this._syncBackend();
            await this._checkAuthStatus();
            this._tryAddCreditFromUrl();
            return;
        }

        // 2. 优先尝试 Pro
        let result = null;
        try {
            result = await this._getProFingerprint();
        } catch (e) {
            console.warn('[Visitor] Pro failed:', e.message);
        }

        // 3. Fallback 到开源版
        if (!result) {
            try {
                result = await this._getOssFingerprint();
            } catch (e) {
                console.warn('[Visitor] OSS failed:', e.message);
            }
        }

        // 4. 最终兜底：临时随机 ID
        if (!result) {
            result = {
                visitorId: 'temp_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36),
                fpType: 'temp'
            };
        }

        this.id = result.visitorId;
        this.fpType = result.fpType;

        if (this.fpType === 'pro') {
            console.log(`[Visitor] Using FingerprintPro, visitor id=${this.id}`);
        } else if (this.fpType === 'oss') {
            console.log(`[Visitor] Using FingerprintJS OSS, visitor id=${this.id}`);
        } else if (this.fpType === 'temp') {
            console.log(`[Visitor] Using random temporary id=${this.id}`);
        }

        this._setCache(result.visitorId, result.fpType);
        this.initialized = true;

        await this._syncBackend();
        await this._checkAuthStatus();
        this._tryAddCreditFromUrl();
    },

    getId() {
        return this.id || localStorage.getItem('visitor_id_fallback');
    },

    appendHeaders(headers = {}) {
        const id = this.getId();
        if (id) headers['X-Visitor-ID'] = id;
        return headers;
    },

    appendToFormData(formData = new FormData()) {
        const id = this.getId();
        if (id) formData.append('visitorId', id);
        return formData;
    },

    async _getProFingerprint() {
        if (typeof window === 'undefined') return null;
        if (this.PRO_API_KEY === 'YOUR_PRO_API_KEY') {
            console.log('[Visitor] Pro API Key not set, skipping Pro.');
            return null;
        }

        try {
            let Fingerprint, fp;
            if (this.PRO_PROXY_PATH) {
                // Cloudflare Proxy Integration：第一方路径，绕过 Edge/Safari 拦截
                const baseUrl = `https://moyuxiaowu.org/${this.PRO_PROXY_PATH}`;
                Fingerprint = await import(`${baseUrl}/web/v4/${this.PRO_API_KEY}`);
                fp = await Fingerprint.start({
                    endpoints: `${baseUrl}/?region=${this.PRO_REGION}`
                });
                console.log('[Visitor] Pro loaded via Cloudflare Proxy');
            } else {
                // 默认 CDN 方式（可能被 Edge 跟踪防护拦截）
                Fingerprint = await import(`https://fpjscdn.net/v4/${this.PRO_API_KEY}`);
                fp = await Fingerprint.start();
            }
            const result = await fp.get();
            return {
                visitorId: result.visitor_id,
                fpType: 'pro',
                requestId: result.event_id || null
            };
        } catch (e) {
            console.warn('[Visitor] Pro fingerprint failed:', e);
            return null;
        }
    },

    async _getOssFingerprint() {
        if (typeof window === 'undefined') return null;
        let FingerprintJS = window.FingerprintJS;
        if (!FingerprintJS) {
            try {
                await this._loadScript('https://openfpcdn.io/fingerprintjs/v5');
                FingerprintJS = window.FingerprintJS;
            } catch (e) {
                console.warn('[Visitor] Failed to load OSS script:', e);
            }
        }
        if (!FingerprintJS) return null;

        const fp = await FingerprintJS.load({ monitoring: false });
        const result = await fp.get();
        return {
            visitorId: result.visitorId,
            fpType: 'oss'
        };
    },

    _loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Script load failed: ' + src));
            document.head.appendChild(script);
        });
    },

    _getCache() {
        try {
            const raw = localStorage.getItem('visitor_fp_cache');
            if (!raw) return null;
            const data = JSON.parse(raw);
            if (data.expires && data.expires > Date.now()) {
                return data;
            }
        } catch (e) {}
        return null;
    },

    _setCache(visitorId, fpType) {
        try {
            // temp ID 只缓存 1 小时，Pro/OSS 缓存 7 天
            const ttl = fpType === 'temp' ? 1000 * 60 * 60 : 1000 * 60 * 60 * 24 * 7;
            const data = {
                visitorId,
                fpType,
                expires: Date.now() + ttl
            };
            localStorage.setItem('visitor_fp_cache', JSON.stringify(data));
            localStorage.setItem('visitor_id_fallback', visitorId);
        } catch (e) {}
    },

    async _syncBackend() {
        try {
            const res = await fetch(`${this.getApiBase()}/api/visitor/init`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...this.appendHeaders() },
                body: JSON.stringify({ visitorId: this.id, fpType: this.fpType })
            });
            if (res.status === 429) {
                const data = await res.json().catch(() => ({}));
                this._showRateLimitNotice(data.error || 'The server is too popular now! Please refresh 1 minute later to get your free credits, thanks!');
                return;
            }
            if (res.ok) {
                const data = await res.json();
                if (data.requiresLogin) {
                    // 已绑定用户，未登录状态
                    this.credits = null;
                } else {
                    this.credits = data.credits ?? 0;
                }
                this._updateUI();
            }
        } catch (e) {
            console.warn('[Visitor] Backend sync failed:', e);
        }
    },

    async _checkAuthStatus() {
        const token = localStorage.getItem('auth_token');
        if (!token) return;
        try {
            const res = await fetch(`${this.getApiBase()}/auth/me`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const user = await res.json();
                const bal = user.balance;
                const total = bal ? (bal.amount || 0) + (bal.freeQuotaLeft || 0) : 0;
                this.setUserBalance(total);
            } else if (res.status === 401 || res.status === 403) {
                localStorage.removeItem('auth_token');
                this.clearUserBalance();
            }
        } catch (e) {
            console.warn('[Visitor] Auth check failed:', e);
        }
    },

    _showRateLimitNotice(msg) {
        const el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#fee2e2;color:#991b1b;padding:12px 20px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:9999;font-size:14px;font-weight:500;max-width:90%;text-align:center;';
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 8000);
    },

    _updateUI() {
        document.querySelectorAll('[data-visitor-credits]').forEach(el => {
            if (this.userBalance !== null) {
                el.textContent = this.userBalance;
            } else if (this.credits === null) {
                el.textContent = (typeof t === 'function') ? t('creditLoginToView') : 'Login to view';
            } else {
                el.textContent = this.credits;
            }
        });
    },

    _checkInviteParam() {
        if (typeof window === 'undefined') return;
        const params = new URLSearchParams(window.location.search);
        const inviter = params.get('inviter');
        if (inviter) {
            sessionStorage.setItem('pending_inviter', inviter);
        }
    },

    getInviteCode() {
        return sessionStorage.getItem('pending_inviter') || '';
    },

    clearInviteCode() {
        sessionStorage.removeItem('pending_inviter');
    },

    setUserBalance(balance) {
        this.userBalance = balance;
        this._updateUI();
    },

    clearUserBalance() {
        this.userBalance = null;
        this._updateUI();
    },

    _tryAddCreditFromUrl() {
        if (typeof window === 'undefined') return;
        const params = new URLSearchParams(window.location.search);
        const addCredit = params.get('addcredit');
        const key = params.get('key');
        if (!addCredit || isNaN(parseInt(addCredit)) || !key) return;
        const amount = parseInt(addCredit);
        fetch(`${this.getApiBase()}/api/visitor/addcredit?addcredit=${amount}&key=${encodeURIComponent(key)}`, {
            method: 'GET',
            headers: this.appendHeaders()
        })
        .then(r => r.json())
        .then(data => {
            if (data.credits !== undefined) {
                this.credits = data.credits;
                this._updateUI();
                console.log(`[Visitor] Added ${amount} credits. Total: ${data.credits}`);
            }
        })
        .catch(e => console.warn('[Visitor] Add credit failed:', e));
    }
};

if (typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => Visitor.init());
    } else {
        Visitor.init();
    }
}
