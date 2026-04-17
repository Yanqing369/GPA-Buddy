/**
 * visitor.js - FingerprintJS Pro + OSS fallback + visitor credit system
 */

const Visitor = {
    id: null,
    fpType: null, // 'pro' | 'oss' | 'temp'
    credits: 0,
    initialized: false,

    // 配置：请替换为你的 FingerprintJS Pro Public API Key
    PRO_API_KEY: 'YOUR_PRO_API_KEY',
    PRO_REGION: 'ap', // 'ap' | 'us' | 'eu'

    getApiBase() {
        if (typeof API_BASE !== 'undefined') return API_BASE;
        return '';
    },

    async init() {
        if (this.initialized) return;

        // 1. 尝试读取缓存（7天）
        const cached = this._getCache();
        if (cached && cached.visitorId) {
            this.id = cached.visitorId;
            this.fpType = cached.fpType || 'oss';
            this.initialized = true;
            await this._syncBackend();
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
        this._setCache(result.visitorId, result.fpType);
        this.initialized = true;

        await this._syncBackend();
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

        // 如果 window.FingerprintJS 已存在且是 Pro 加载的，直接使用
        let FingerprintJS = window.FingerprintJS;
        if (!FingerprintJS) {
            try {
                await this._loadScript(`https://fpcdn.io/v3/${this.PRO_API_KEY}`);
                FingerprintJS = window.FingerprintJS;
            } catch (e) {
                console.warn('[Visitor] Failed to load Pro script:', e);
            }
        }
        if (!FingerprintJS) return null;

        const fp = await FingerprintJS.load({
            apiKey: this.PRO_API_KEY,
            region: this.PRO_REGION,
            cache: {
                timeToLive: 60 * 60 * 24 * 3 // 3天
            }
        });
        const result = await fp.get();
        return {
            visitorId: result.visitorId,
            fpType: 'pro',
            requestId: result.requestId || null
        };
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
            const data = {
                visitorId,
                fpType,
                expires: Date.now() + 1000 * 60 * 60 * 24 * 7 // 7天
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
                this.credits = data.credits ?? 0;
                this._updateUI();
            }
        } catch (e) {
            console.warn('[Visitor] Backend sync failed:', e);
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
            el.textContent = this.credits;
        });
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
