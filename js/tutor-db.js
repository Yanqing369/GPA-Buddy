/**
 * tutor-db.js - 知识图谱 IndexedDB 操作
 * 复用 ExamBuddyDB_Clean_v2，安全升级到版本7
 */

const DB_NAME = 'ExamBuddyDB_Clean_v2';

const tutorDb = new Dexie(DB_NAME);

// 版本8：sourceFiles 增加 graphId 索引，支持 tutor 溯源
tutorDb.version(8).stores({
    questionBanks: '++id, name, createdAt, updatedAt',
    practiceProgress: '++id, bankId, lastPracticeAt',
    sourceFiles: '++id, name, fileName, markerFileName, bankId, graphId, data, createdAt, [graphId+name]',
    settings: 'key',
    knowledgeGraphs: '++id, name, createdAt, updatedAt',
    graphNodes: '++id, graphId, nodeId, [graphId+nodeId]',
    graphProgress: '++id, graphId, nodeId, [graphId+nodeId]'
}).upgrade(tx => {
    return tx.table('sourceFiles').toCollection().modify(file => {
        if (!file.graphId) file.graphId = null;
    });
});

tutorDb.open().catch(e => console.error('Tutor DB open failed:', e));

const TutorDB = {
    // ==================== 图谱 ====================
    async createGraph(name, skeleton) {
        const now = new Date().toISOString();
        const graphId = await tutorDb.knowledgeGraphs.add({
            name: name || 'Untitled Graph',
            createdAt: now,
            updatedAt: now
        });

        const nodes = skeleton.nodes.map(n => ({
            graphId,
            nodeId: n.id,
            name: n.name,
            importance: n.importance || 'normal',
            edges: skeleton.edges.filter(e => e.from === n.id)
        }));

        await tutorDb.graphNodes.bulkAdd(nodes);
        return graphId;
    },

    async getGraph(graphId) {
        let graph = await tutorDb.knowledgeGraphs.get(graphId);
        if (!graph) {
            // 兼容 ID 类型不匹配（number / string）
            graph = await tutorDb.knowledgeGraphs.get(Number(graphId));
        }
        if (!graph) {
            graph = await tutorDb.knowledgeGraphs.get(String(graphId));
        }
        if (!graph) return { graph: null, nodes: [], progress: [] };
        const nodes = await tutorDb.graphNodes.where('graphId').equals(graph.id).toArray();
        const progress = await tutorDb.graphProgress.where('graphId').equals(graph.id).toArray();
        return { graph, nodes, progress };
    },

    async getAllGraphs() {
        return tutorDb.knowledgeGraphs.orderBy('updatedAt').reverse().toArray();
    },

    async deleteGraph(graphId) {
        await tutorDb.knowledgeGraphs.delete(graphId);
        await tutorDb.graphNodes.where('graphId').equals(graphId).delete();
        await tutorDb.graphProgress.where('graphId').equals(graphId).delete();
    },

    // ==================== 节点内容 ====================
    async saveNodeContent(graphId, nodeId, content) {
        await tutorDb.graphNodes.where('[graphId+nodeId]').equals([graphId, nodeId]).modify({
            content,
            updatedAt: new Date().toISOString()
        });
    },

    async getNodeContent(graphId, nodeId) {
        const node = await tutorDb.graphNodes.where('[graphId+nodeId]').equals([graphId, nodeId]).first();
        return node?.content || null;
    },

    // ==================== 进度 ====================
    async markNodeComplete(graphId, nodeId) {
        const exists = await tutorDb.graphProgress.where('[graphId+nodeId]').equals([graphId, nodeId]).first();
        if (!exists) {
            await tutorDb.graphProgress.add({
                graphId,
                nodeId,
                completedAt: new Date().toISOString()
            });
        }
        await tutorDb.knowledgeGraphs.update(graphId, {
            updatedAt: new Date().toISOString()
        });
    },

    async isNodeCompleted(graphId, nodeId) {
        const rec = await tutorDb.graphProgress.where('[graphId+nodeId]').equals([graphId, nodeId]).first();
        return !!rec;
    },

    async getCompletedNodes(graphId) {
        const recs = await tutorDb.graphProgress.where('graphId').equals(graphId).toArray();
        return new Set(recs.map(r => r.nodeId));
    },

    async resetProgress(graphId) {
        await tutorDb.graphProgress.where('graphId').equals(graphId).delete();
    },

    // ==================== 源文件 ====================
    async saveSourceFile(graphId, name, fileName, markerFileName, data, type = 'application/pdf') {
        await tutorDb.sourceFiles.where('name').equals(name).and(f => f.graphId === graphId).delete();
        if (graphId !== null) {
            await tutorDb.sourceFiles.where('name').equals(name).and(f => f.graphId === null).delete();
        }
        await tutorDb.sourceFiles.add({
            name,
            fileName,
            markerFileName,
            bankId: null,
            graphId,
            data,
            type,
            createdAt: new Date().toISOString()
        });
    },

    async getSourceFileByGraphId(graphId) {
        return tutorDb.sourceFiles.where('graphId').equals(graphId).first();
    },

    // ==================== 设置 ====================
    async getSetting(key) {
        const rec = await tutorDb.settings.get(key);
        return rec?.value;
    },

    async setSetting(key, value) {
        await tutorDb.settings.put({ key, value });
    }
};
