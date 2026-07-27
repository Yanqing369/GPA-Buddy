/**
 * BankMigration - 本地零散题库 → 云端课程体系 的幂等迁移
 *
 * 背景：visitor 时代的题库存在本地 IndexedDB（manage.html 管理）。
 * 用户注册/登录后，把这些本地题库迁到云端一个 default 课程下：
 *   阶段 1：题目 JSON 快速上云（用户立刻可以做题）
 *   阶段 2：源文件后台逐个上传为课程资料，并回填云题库的 source_*
 *
 * 幂等设计：
 *   - 成功上云的 bank 在本地记录上写 migratedCloudId，重跑时跳过
 *   - default 课程 id 存 localStorage.default_course_id，重跑时复用
 *   - 任意阶段失败，下次调用会从未完成处继续
 *
 * 用法（普通 script，非 ES module）：
 *   BankMigration.migrate({ apiBase, onStatus })  // 不 await，后台执行
 */
(function () {
    const DB_NAME = 'ExamBuddyDB_Clean_v2';
    const COURSE_KEY = 'default_course_id';

    function openDb() {
        const db = new Dexie(DB_NAME);
        // schema 必须与 personal-center.html / index.html 的 version(8) 一致
        db.version(8).stores({
            questionBanks: '++id, name, createdAt, updatedAt',
            practiceProgress: '++id, bankId, lastPracticeAt',
            sourceFiles: '++id, name, fileName, markerFileName, bankId, graphId, data, createdAt, [graphId+name]',
            settings: 'key',
            knowledgeGraphs: '++id, name, createdAt, updatedAt',
            graphNodes: '++id, graphId, nodeId, [graphId+nodeId]',
            graphProgress: '++id, graphId, nodeId, [graphId+nodeId]'
        });
        return db;
    }

    function apiFetch(apiBase, path, options = {}) {
        const token = localStorage.getItem('auth_token');
        options.headers = options.headers || {};
        if (token) options.headers['Authorization'] = `Bearer ${token}`;
        return fetch(`${apiBase}${path}`, options);
    }

    // 复用已有 default 课程；不存在则新建 "default XXXXXX"
    async function ensureDefaultCourse(apiBase) {
        const existingId = parseInt(localStorage.getItem(COURSE_KEY)) || null;
        if (existingId) {
            try {
                const res = await apiFetch(apiBase, '/api/courses');
                if (res.ok) {
                    const data = await res.json();
                    if ((data.courses || []).some(c => c.id === existingId)) {
                        return existingId;
                    }
                }
            } catch (e) {
                console.warn('[BankMigration] check courses failed:', e);
            }
            localStorage.removeItem(COURSE_KEY);
        }

        const name = `default ${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`;
        const res = await apiFetch(apiBase, '/api/courses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        if (!res.ok) throw new Error(`创建默认课程失败 (${res.status})`);
        const data = await res.json();
        localStorage.setItem(COURSE_KEY, String(data.course.id));
        return data.course.id;
    }

    // 阶段 1：题目 JSON 上云
    async function uploadBank(apiBase, db, bank, courseId) {
        const res = await apiFetch(apiBase, '/api/cloud-banks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: bank.name,
                content: JSON.stringify(bank),
                is_public: false,
                course_id: courseId
            })
        });
        if (!res.ok) throw new Error(`题库「${bank.name}」上云失败 (${res.status})`);
        const data = await res.json();
        await db.questionBanks.update(bank.id, { migratedCloudId: data.bank.id });
        return data.bank.id;
    }

    // 阶段 2：后台上传源文件并回填云题库 source_*
    async function uploadSourceFiles(apiBase, db, bank, courseId) {
        const files = await db.sourceFiles.where('bankId').equals(bank.id).toArray();
        for (const f of files) {
            try {
                if (!f.data) continue;
                const fileName = f.fileName || f.name || 'source';
                const file = new File([f.data], fileName, { type: f.data.type || 'application/octet-stream' });
                const form = new FormData();
                form.append('file', file);
                form.append('name', fileName);

                const upRes = await apiFetch(apiBase, `/api/courses/${courseId}/materials`, {
                    method: 'POST',
                    body: form
                });
                if (!upRes.ok) throw new Error(`上传资料失败 (${upRes.status})`);
                const upData = await upRes.json();
                const material = upData.material;
                if (!material || !material.r2_key) throw new Error('资料无 r2_key');

                const srcRes = await apiFetch(apiBase, `/api/cloud-banks/${bank.migratedCloudId}/source`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        source_r2_key: material.r2_key,
                        source_name: fileName,
                        source_type: file.type,
                        source_size: file.size
                    })
                });
                if (!srcRes.ok) throw new Error(`回填源文件失败 (${srcRes.status})`);
            } catch (e) {
                // 单文件失败不阻塞后续；查看原文对未回填的题库报错即可
                console.warn(`[BankMigration] 源文件「${f.fileName || f.name}」迁移失败:`, e);
            }
        }
    }

    let running = false;

    async function migrate({ apiBase, onStatus } = {}) {
        if (running) return;
        if (!localStorage.getItem('auth_token')) return;
        if (typeof Dexie === 'undefined') return;
        running = true;

        const notify = (msg, type) => {
            try { onStatus && onStatus(msg, type); } catch (e) { /* ignore */ }
        };

        try {
            const db = openDb();
            await db.open();

            const pending = await db.questionBanks
                .filter(b => !b.migratedCloudId)
                .toArray();

            if (pending.length === 0) {
                return;
            }

            const courseId = await ensureDefaultCourse(apiBase);

            // 拉取云端已有题库做去重：以前从云端下载/上传过的本地题库不再重复上云，
            // 只回写 migratedCloudId；若该云题库还没有课程，则归入 default 课程
            const cloudIndex = new Map(); // `${title}|${count}` -> { id, course_id }
            try {
                const res = await apiFetch(apiBase, '/api/cloud-banks');
                if (res.ok) {
                    const data = await res.json();
                    for (const b of (data.banks || [])) {
                        cloudIndex.set(`${b.title}|${b.questions_count}`, { id: b.id, course_id: b.course_id });
                    }
                }
            } catch (e) {
                console.warn('[BankMigration] 拉取云端题库失败，跳过去重:', e);
            }

            // 阶段 1：题目先上云，失败单个跳过（下次续传）
            let migratedCount = 0;
            for (const bank of pending) {
                try {
                    const key = `${bank.name}|${(bank.questions || []).length}`;
                    const existing = cloudIndex.get(key);
                    if (existing) {
                        await db.questionBanks.update(bank.id, { migratedCloudId: existing.id });
                        if (!existing.course_id) {
                            // 无课程的旧云题库归入 default 课程（仅 owner 会成功）
                            apiFetch(apiBase, `/api/cloud-banks/${existing.id}/source`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ course_id: courseId })
                            }).catch(e => console.warn('[BankMigration] 归入默认课程失败:', e));
                        }
                        continue;
                    }
                    await uploadBank(apiBase, db, bank, courseId);
                    migratedCount++;
                } catch (e) {
                    console.warn('[BankMigration]', e);
                }
            }
            if (migratedCount > 0) {
                notify(`已把 ${migratedCount} 个本地题库迁移到默认课程`, 'success');
            }

            // 阶段 2：源文件后台慢慢传（不阻塞）
            const migrated = await db.questionBanks
                .filter(b => !!b.migratedCloudId)
                .toArray();
            for (const bank of migrated) {
                await uploadSourceFiles(apiBase, db, bank, courseId);
            }
        } catch (e) {
            console.warn('[BankMigration] 迁移失败:', e);
        } finally {
            running = false;
        }
    }

    window.BankMigration = { migrate };
})();
