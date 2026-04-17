/**
 * tutor-graph.js - Vis.js 知识图谱渲染与交互
 */

const TutorGraph = {
    network: null,
    nodes: null,
    edges: null,
    selectedNodeId: null,
    onNodeSelect: null, // callback(nodeId)
    breathInterval: null,
    breathPhase: 0,

    COLORS: {
        locked: '#9ca3af',      // gray-400
        available: '#3b82f6',   // blue-500
        completed: '#22c55e',   // green-500
        selectedBorder: '#f97316' // orange-500
    },

    init(containerId) {
        this.nodes = new vis.DataSet([]);
        this.edges = new vis.DataSet([]);

        const options = {
            nodes: {
                shape: 'dot',
                size: 24,
                borderWidth: 2,
                shadow: { enabled: true, color: 'rgba(0,0,0,0.15)', size: 10, x: 0, y: 4 },
                font: {
                    background: '#1e293b',
                    strokeWidth: 2,
                    strokeColor: '#1e293b',
                    color: '#ffffff',
                    size: 12
                }
            },
            edges: {
                width: 2,
                color: { color: '#cbd5e1', highlight: '#94a3b8' },
                arrows: { to: { enabled: true, scaleFactor: 0.8 } },
                smooth: { type: 'continuous' }
            },
            layout: {
                hierarchical: {
                    direction: 'LR',
                    sortMethod: 'directed',
                    levelSeparation: 220,
                    nodeSpacing: 160,
                    treeSpacing: 240,
                    shakeTowards: 'roots'
                }
            },
            physics: {
                enabled: true,
                stabilization: {
                    iterations: 150,
                    updateInterval: 25
                },
                hierarchicalRepulsion: {
                    centralGravity: 0.0,
                    springLength: 120,
                    springConstant: 0.01,
                    nodeDistance: 160,
                    damping: 0.09
                }
            },
            interaction: { hover: true, tooltipDelay: 200 }
        };

        const container = document.getElementById(containerId);
        this.network = new vis.Network(container, { nodes: this.nodes, edges: this.edges }, options);

        this.network.on('click', (params) => {
            if (params.nodes.length > 0) {
                const nodeId = params.nodes[0];
                if (this.onNodeSelect) this.onNodeSelect(nodeId);
            }
        });
    },

    loadGraph(skeleton, completedNodes = new Set()) {
        this.stopBreathing();
        this.nodes.clear();
        this.edges.clear();
        this.selectedNodeId = null;

        // Compute availability using hard edges only
        const hardPrereqs = new Map(); // nodeId -> Set of hard prereq ids
        skeleton.nodes.forEach(n => hardPrereqs.set(n.id, new Set()));
        skeleton.edges.forEach(e => {
            if (e.type === 'hard' && hardPrereqs.has(e.to)) {
                hardPrereqs.get(e.to).add(e.from);
            }
        });

        const available = new Set();
        skeleton.nodes.forEach(n => {
            const prereqs = hardPrereqs.get(n.id);
            const isAvailable = !prereqs || prereqs.size === 0 || Array.from(prereqs).every(p => completedNodes.has(p));
            if (isAvailable) available.add(n.id);
        });

        const visNodes = skeleton.nodes.map(n => {
            const isCompleted = completedNodes.has(n.id);
            const isAvailable = available.has(n.id);
            let color = this.COLORS.locked;
            if (isCompleted) color = this.COLORS.completed;
            else if (isAvailable) color = this.COLORS.available;

            return {
                id: n.id,
                label: n.name,
                title: n.name,
                color: {
                    background: color,
                    border: '#ffffff',
                    highlight: { background: color, border: this.COLORS.selectedBorder }
                }
            };
        });

        const visEdges = skeleton.edges.map((e, idx) => ({
            id: `e-${idx}`,
            from: e.from,
            to: e.to,
            dashes: e.type === 'soft',
            color: { color: e.type === 'hard' ? '#94a3b8' : '#cbd5e1' }
        }));

        this.nodes.add(visNodes);
        this.edges.add(visEdges);
        this.startBreathing();
    },

    startBreathing() {
        this.stopBreathing();
        this.breathPhase = 0;
        const periodMs = 3000;
        const intervalMs = 60;

        this.breathInterval = setInterval(() => {
            this.breathPhase += (2 * Math.PI * intervalMs) / periodMs;
            const t = (Math.sin(this.breathPhase) + 1) / 2; // 0 ~ 1

            this.nodes.forEach(n => {
                if (n.color.background === this.COLORS.available) {
                    const size = 20 + t * 36; // 10 ~ 26
                    const alpha = 0.15 + t * 0.35; // 0.15 ~ 0.5
                    this.nodes.update({
                        id: n.id,
                        shadow: {
                            enabled: true,
                            color: `rgba(16, 185, 129, ${alpha})`,
                            size: size,
                            x: 0,
                            y: 0
                        }
                    });
                }
            });
        }, intervalMs);
    },

    stopBreathing() {
        if (this.breathInterval) {
            clearInterval(this.breathInterval);
            this.breathInterval = null;
        }
        // 重置所有节点 shadow 为基础值
        this.nodes.forEach(n => {
            this.nodes.update({
                id: n.id,
                shadow: { enabled: true, color: 'rgba(0,0,0,0.15)', size: 10, x: 0, y: 4 }
            });
        });
    },

    updateNodeStatus(nodeId, completedNodes) {
        this.stopBreathing();
        // Recompute availability
        const allEdges = this.edges.get();
        const hardPrereqs = new Map();
        this.nodes.forEach(n => hardPrereqs.set(n.id, new Set()));
        allEdges.forEach(e => {
            if (!e.dashes && hardPrereqs.has(e.to)) {
                hardPrereqs.get(e.to).add(e.from);
            }
        });

        this.nodes.forEach(n => {
            const prereqs = hardPrereqs.get(n.id);
            const isCompleted = completedNodes.has(n.id);
            const isAvailable = !prereqs || prereqs.size === 0 || Array.from(prereqs).every(p => completedNodes.has(p));
            let color = this.COLORS.locked;
            if (isCompleted) color = this.COLORS.completed;
            else if (isAvailable) color = this.COLORS.available;

            this.nodes.update({
                id: n.id,
                color: {
                    background: color,
                    border: n.id === this.selectedNodeId ? this.COLORS.selectedBorder : '#ffffff',
                    highlight: { background: color, border: this.COLORS.selectedBorder }
                }
            });
        });
        this.startBreathing();
    },

    selectNode(nodeId) {
        this.selectedNodeId = nodeId;
        const n = this.nodes.get(nodeId);
        if (n) {
            this.nodes.update({
                id: nodeId,
                color: {
                    background: n.color.background,
                    border: this.COLORS.selectedBorder,
                    highlight: { background: n.color.background, border: this.COLORS.selectedBorder }
                }
            });
            this.network.focus(nodeId, { animation: true, scale: 1.1 });
        }
    },

    fit() {
        if (this.network) {
            this.network.fit({ animation: true });
        }
    }
};
