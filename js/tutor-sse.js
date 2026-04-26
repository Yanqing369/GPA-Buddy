/**
 * tutor-sse.js - 处理 Worker SSE 流式响应
 * 复用 DocGenerate.js 中的 SSE 读取逻辑
 */

const TutorSSE = {
    decoder: new TextDecoder(),

    async stream(formData, callbacks, url = `${API_BASE}/api/tutor/generate`) {
        const { onSkeleton, onNodeStart, onNodeDone, onComplete, onError, onProgress } = callbacks;

        try {
            const controller = new AbortController();
            const token = localStorage.getItem('auth_token');
            const response = await fetch(url, {
                method: 'POST',
                body: formData,
                signal: controller.signal,
                headers: token ? { 'Authorization': `Bearer ${token}` } : {}
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.error || 'Network error');
            }

            const reader = response.body.getReader();
            let sseBuffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = this.decoder.decode(value, { stream: true });
                sseBuffer += chunk;

                let messageEnd = sseBuffer.indexOf('\n\n');
                while (messageEnd !== -1) {
                    const message = sseBuffer.substring(0, messageEnd);
                    sseBuffer = sseBuffer.substring(messageEnd + 2);
                    this.handleMessage(message, { onSkeleton, onNodeStart, onNodeDone, onComplete, onError, onProgress });
                    messageEnd = sseBuffer.indexOf('\n\n');
                }

                if (sseBuffer.length > 1000000) {
                    console.warn('[TutorSSE] Buffer too large, clearing');
                    sseBuffer = '';
                }
            }

            // Process remaining buffer
            if (sseBuffer.trim()) {
                this.handleMessage(sseBuffer, { onSkeleton, onNodeStart, onNodeDone, onComplete, onError, onProgress });
            }
        } catch (err) {
            if (onError) onError(err.message);
        }
    },

    handleMessage(message, callbacks) {
        const lines = message.split('\n');
        let dataLine = '';
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                dataLine += line.substring(6);
            }
        }
        if (!dataLine) return;

        try {
            const data = JSON.parse(dataLine);
            switch (data.type) {
                case 'skeleton_done':
                    if (callbacks.onSkeleton) callbacks.onSkeleton(data.data);
                    break;
                case 'node_start':
                    if (callbacks.onNodeStart) callbacks.onNodeStart(data.nodeId, data.name);
                    break;
                case 'node_done':
                    if (callbacks.onNodeDone) callbacks.onNodeDone(data.nodeId, data.data);
                    break;
                case 'complete':
                    if (callbacks.onComplete) callbacks.onComplete();
                    break;
                case 'error':
                    if (callbacks.onError) callbacks.onError(data.message);
                    break;
                case 'progress':
                    if (callbacks.onProgress) callbacks.onProgress(data.current, data.total);
                    break;
            }
        } catch (e) {
            console.error('[TutorSSE] Parse error:', e, dataLine.substring(0, 200));
        }
    }
};
