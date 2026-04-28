/**
 * tutor-panel.js - 节点学习弹窗：步骤向导式交互
 */

const TutorPanel = {
    currentNodeId: null,
    currentGraphId: null,
    currentContent: null,
    currentStep: 0,
    steps: [],
    isCompleted: false,
    onComplete: null,

    elements: {
        title: null,
        landmarkBadge: null,
        stepIndicator: null,
        progress: null,
        content: null,
        prevBtn: null,
        nextBtn: null,
        completeBtn: null,
    },

    init() {
        this.elements.title = document.getElementById('learnModalTitle');
        this.elements.landmarkBadge = document.getElementById('landmarkBadgeModal');
        this.elements.stepIndicator = document.getElementById('stepIndicator');
        this.elements.progress = document.getElementById('learnModalProgress');
        this.elements.content = document.getElementById('learnModalContent');
        this.elements.prevBtn = document.getElementById('prevStepBtn');
        this.elements.nextBtn = document.getElementById('nextStepBtn');
        this.elements.completeBtn = document.getElementById('completeNodeBtn');

        if (this.elements.prevBtn) {
            this.elements.prevBtn.onclick = () => this.prevStep();
        }
        if (this.elements.nextBtn) {
            this.elements.nextBtn.onclick = () => this.nextStep();
        }
        if (this.elements.completeBtn) {
            this.elements.completeBtn.onclick = () => this.handleAction();
        }
    },

    async startLearning(graphId, nodeId, nodeName, content, isCompleted, isAvailable) {
        this.currentGraphId = graphId;
        this.currentNodeId = nodeId;
        this.currentContent = content;
        this.isCompleted = isCompleted;
        this.currentStep = 0;

        this.elements.title.textContent = nodeName;
        this.elements.landmarkBadge.classList.toggle('hidden', content.importance !== 'landmark');

        const prereqHooks = await this.getPrerequisiteExitHooks(graphId, nodeId);
        this.steps = this.buildSteps(prereqHooks, content, isCompleted, isAvailable);
        this.renderStep(0);
    },

    buildSteps(prereqHooks, content, isCompleted, isAvailable) {
        const steps = [];

        if (prereqHooks.length > 0) {
            steps.push({ type: 'prerequisite', data: prereqHooks });
        }

        if (content.introQuestion) {
            steps.push({ type: 'intro', data: content.introQuestion });
        }

        if (content.coreConcepts && content.coreConcepts.length > 0) {
            content.coreConcepts.forEach(c => {
                steps.push({ type: 'concept', data: c });
            });
        }

        // landmark 节点跳过检验活动
        if (content.importance !== 'landmark' && content.checkActivities && content.checkActivities.length > 0) {
            steps.push({ type: 'activities', data: content.checkActivities });
        }

        steps.push({ type: 'finish', data: { isCompleted, importance: content.importance || 'normal' } });
        return steps;
    },

    renderStep(index) {
        if (index < 0 || index >= this.steps.length) return;
        this.currentStep = index;
        const step = this.steps[index];
        const total = this.steps.length;

        // 进度条
        const percent = total > 1 ? ((index + 1) / total) * 100 : 100;
        this.elements.progress.style.width = `${percent}%`;
        this.elements.stepIndicator.textContent = TutorApp.t('stepProgress', index + 1, total);

        // 内容渲染（带动画）
        const container = this.elements.content;
        container.innerHTML = '';
        const wrapper = document.createElement('div');
        wrapper.className = 'step-content animate-fade-in';

        switch (step.type) {
            case 'prerequisite':
                wrapper.innerHTML = this.renderPrerequisiteStep(step.data);
                break;
            case 'intro':
                wrapper.innerHTML = this.renderIntroStep(step.data);
                break;
            case 'concept':
                wrapper.innerHTML = this.renderConceptStep(step.data, index);
                break;
            case 'activities':
                wrapper.innerHTML = this.renderActivitiesStep(step.data);
                break;
            case 'finish':
                wrapper.innerHTML = this.renderFinishStep(step.data);
                break;
        }

        container.appendChild(wrapper);

        // 渲染 LaTeX
        renderTutorMath();

        // 活动步骤初始化交互
        if (step.type === 'activities') {
            this.initActivities(step.data);
        }

        this.updateNavigation();
    },

    renderPrerequisiteStep(hooks) {
        const items = hooks.map(h => `
            <div class="mb-4 last:mb-0 p-4 bg-purple-50/60 rounded-xl border border-purple-100">
                <div class="text-xs font-semibold text-purple-700 mb-1">${this.escapeHtml(h.name)}</div>
                <div class="text-slate-700 text-sm leading-relaxed">${this.safeMarkedParse(h.exitHook)}</div>
            </div>
        `).join('');
        return `
            <div class="max-w-2xl mx-auto">
                <div class="text-sm font-medium text-slate-500 mb-4 uppercase tracking-wide">${TutorApp.t('prerequisiteReview')}</div>
                ${items}
            </div>
        `;
    },

    renderIntroStep(question) {
        return `
            <div class="max-w-2xl mx-auto">
                <div class="text-sm font-medium text-slate-500 mb-4 uppercase tracking-wide">${TutorApp.t('introQuestion')}</div>
                <div class="p-6 bg-indigo-50/60 rounded-2xl border border-indigo-100">
                    <div class="text-xl text-slate-800 font-medium leading-relaxed text-center">${this.safeMarkedParse(question)}</div>
                </div>
                <p class="text-center text-sm text-slate-400 mt-6">${TutorApp.t('nextStep')} →</p>
            </div>
        `;
    },

    renderConceptStep(concept, idx) {
        const sourceBtn = concept.source ? `
            <button onclick="TutorApp.openSourceViewer('${this.escapeHtml(concept.source)}')" class="mt-3 inline-flex items-center text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors">
                <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
                ${TutorApp.t('viewSource')}
            </button>
        ` : '';
        return `
            <div class="max-w-2xl mx-auto">
                <div class="p-6 bg-white/70 rounded-2xl border border-white/60 shadow-sm">
                    <div class="flex items-center gap-3 mb-4">
                        <span class="w-8 h-8 rounded-full bg-emerald-100 text-emerald-600 text-sm flex items-center justify-center font-bold">${idx}</span>
                        <h3 class="text-lg font-bold text-slate-900">${this.escapeHtml(concept.title)}</h3>
                    </div>
                    <div class="text-slate-700 text-base leading-relaxed">${this.safeMarkedParse(concept.content)}</div>
                    ${sourceBtn}
                </div>
            </div>
        `;
    },

    renderActivitiesStep(activities) {
        const html = activities.map((act, idx) => {
            let inner = `<div class="text-base font-medium text-slate-800 mb-4">${idx + 1}. ${this.safeMarkedParse(act.question)}</div>`;
            if (act.type === 'choice') {
                inner += `<div class="space-y-2">`;
                act.options.forEach((opt, oidx) => {
                    inner += `
                        <label class="activity-option flex items-center gap-3 p-3 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer transition-colors" data-value="${oidx}">
                            <input type="radio" name="act-${idx}" value="${oidx}" class="w-4 h-4 text-indigo-600">
                            <span class="text-sm text-slate-700">${this.safeMarkedParse(opt)}</span>
                        </label>
                    `;
                });
                inner += `</div>`;
            } else if (act.type === 'sort') {
                inner += `<div class="text-xs text-slate-500 mb-2">${TutorApp.t('sortHint')}</div>`;
                inner += `<div class="space-y-2 sort-list" data-index="${idx}" data-correct="${JSON.stringify(act.correctOrder || [])}">`;
                (act.items || []).forEach((item) => {
                    inner += `
                        <div class="sort-item flex items-center gap-2 p-2.5 rounded-lg bg-slate-50 border border-slate-200 cursor-move" draggable="true" data-value="${this.escapeHtml(item)}">
                            <svg class="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8h16M4 16h16"/></svg>
                            <span class="text-sm text-slate-700">${this.safeMarkedParse(item)}</span>
                        </div>
                    `;
                });
                inner += `</div>`;
            } else if (act.type === 'highlight') {
                inner += `<div class="text-xs text-slate-500 mb-2">${TutorApp.t('highlightHint')}</div>`;
                inner += `<div class="p-3 rounded-lg bg-slate-50 border border-slate-200 text-sm text-slate-700 leading-relaxed highlight-text cursor-text">${this.safeMarkedParse(act.text)}</div>`;
            }
            return `<div class="activity-item mb-6 last:mb-0 p-5 bg-white/70 rounded-xl border border-white/60 shadow-sm" data-index="${idx}">${inner}</div>`;
        }).join('');

        return `
            <div class="max-w-2xl mx-auto">
                <div class="text-sm font-medium text-slate-500 mb-4 uppercase tracking-wide">${TutorApp.t('checkActivities')}</div>
                ${html}
            </div>
        `;
    },

    renderFinishStep(data) {
        const isLandmark = data.importance === 'landmark';
        const emoji = isLandmark ? '🏔️' : data.isCompleted ? '✅' : '🎉';
        const title = isLandmark ? TutorApp.t('landmarkHint')
            : data.isCompleted ? TutorApp.t('alreadyCompleted')
            : TutorApp.t('markComplete');
        return `
            <div class="max-w-2xl mx-auto text-center py-10">
                <div class="text-6xl mb-4">${emoji}</div>
                <h3 class="text-2xl font-bold text-slate-900 mb-2">${this.escapeHtml(title)}</h3>
                <p class="text-slate-500">${isLandmark ? '' : (data.isCompleted ? '' : TutorApp.t('checkAnswers'))}</p>
            </div>
        `;
    },

    initActivities(activities) {
        // 选择题实时反馈
        this.elements.content.querySelectorAll('.activity-item').forEach((wrapper, idx) => {
            const act = activities[idx];
            if (!act) return;

            if (act.type === 'choice') {
                wrapper.querySelectorAll('input[type="radio"]').forEach(radio => {
                    radio.addEventListener('change', () => {
                        const selected = parseInt(radio.value);
                        const isCorrect = selected === act.correct;
                        const optionLabel = radio.closest('.activity-option');
                        this.setActivityFeedback(optionLabel, isCorrect);
                        // 禁用其他选项
                        wrapper.querySelectorAll('input[type="radio"]').forEach(r => r.disabled = true);
                        this.updateNavigation();
                    });
                });
            } else if (act.type === 'sort') {
                this.initSortable(wrapper.querySelector('.sort-list'));
            }
        });
    },

    initSortable(listEl) {
        if (!listEl) return;
        let dragged = null;
        listEl.querySelectorAll('.sort-item').forEach(item => {
            item.addEventListener('dragstart', e => {
                dragged = item;
                item.classList.add('opacity-50');
            });
            item.addEventListener('dragend', () => {
                item.classList.remove('opacity-50');
                dragged = null;
            });
            item.addEventListener('dragover', e => {
                e.preventDefault();
                if (!dragged || dragged === item) return;
                const rect = item.getBoundingClientRect();
                const offset = e.clientY - rect.top - rect.height / 2;
                if (offset < 0) item.parentNode.insertBefore(dragged, item);
                else item.parentNode.insertBefore(dragged, item.nextSibling);
            });
        });
    },

    updateNavigation() {
        const { prevBtn, nextBtn, completeBtn } = this.elements;
        const total = this.steps.length;
        const isLast = this.currentStep === total - 1;

        prevBtn.classList.toggle('hidden', this.currentStep === 0);

        if (isLast) {
            nextBtn.classList.add('hidden');
            completeBtn.classList.remove('hidden');
            const finishData = this.steps[this.currentStep].data;
            if (finishData.importance === 'landmark') {
                completeBtn.textContent = TutorApp.t('markKnown');
                completeBtn.disabled = finishData.isCompleted;
                completeBtn.className = finishData.isCompleted
                    ? 'px-6 py-2.5 rounded-xl text-sm font-medium bg-slate-200 text-slate-500 cursor-not-allowed'
                    : 'px-6 py-2.5 rounded-xl text-sm font-medium liquid-btn-emerald text-white spring-active';
            } else {
                completeBtn.textContent = finishData.isCompleted ? TutorApp.t('alreadyCompleted') : TutorApp.t('markComplete');
                completeBtn.disabled = finishData.isCompleted;
                completeBtn.className = finishData.isCompleted
                    ? 'px-6 py-2.5 rounded-xl text-sm font-medium bg-slate-200 text-slate-500 cursor-not-allowed'
                    : 'px-6 py-2.5 rounded-xl text-sm font-medium liquid-btn-emerald text-white spring-active';
            }
        } else {
            nextBtn.classList.remove('hidden');
            completeBtn.classList.add('hidden');
            nextBtn.textContent = TutorApp.t('nextStep');
            // 如果当前是 activities 步骤，检查是否已全对
            const step = this.steps[this.currentStep];
            if (step.type === 'activities') {
                const allValid = this.validateActivities(step.data, false);
                nextBtn.disabled = !allValid;
                nextBtn.className = allValid
                    ? 'px-6 py-2.5 rounded-xl text-sm font-medium liquid-btn-emerald text-white spring-active'
                    : 'px-6 py-2.5 rounded-xl text-sm font-medium bg-slate-200 text-slate-400 cursor-not-allowed';
            } else {
                nextBtn.disabled = false;
                nextBtn.className = 'px-6 py-2.5 rounded-xl text-sm font-medium liquid-btn-emerald text-white spring-active';
            }
        }
    },

    nextStep() {
        const step = this.steps[this.currentStep];
        if (step.type === 'activities') {
            const allValid = this.validateActivities(step.data, true);
            if (!allValid) {
                TutorApp.showToast(TutorApp.t('checkAnswers'), 'error');
                return;
            }
        }
        if (this.currentStep < this.steps.length - 1) {
            this.renderStep(this.currentStep + 1);
        }
    },

    prevStep() {
        if (this.currentStep > 0) {
            this.renderStep(this.currentStep - 1);
        }
    },

    validateActivities(activities, showFeedback = true) {
        if (!activities || activities.length === 0) return true;
        let allCorrect = true;
        const wrappers = this.elements.content.querySelectorAll('.activity-item');

        wrappers.forEach((wrapper, idx) => {
            const act = activities[idx];
            if (!act) return;

            if (act.type === 'choice') {
                const selected = wrapper.querySelector('input[type="radio"]:checked');
                const correct = selected && parseInt(selected.value) === act.correct;
                if (showFeedback) {
                    const optionLabel = selected?.closest('.activity-option');
                    if (optionLabel) this.setActivityFeedback(optionLabel, correct);
                }
                if (!correct) allCorrect = false;
            } else if (act.type === 'sort') {
                const items = Array.from(wrapper.querySelectorAll('.sort-item')).map(el => el.dataset.value);
                const correct = JSON.stringify(items) === JSON.stringify(act.correctOrder || []);
                if (showFeedback) this.setActivityFeedback(wrapper, correct);
                if (!correct) allCorrect = false;
            } else if (act.type === 'highlight') {
                if (showFeedback) this.setActivityFeedback(wrapper, true);
            }
        });

        return allCorrect;
    },

    setActivityFeedback(element, isCorrect) {
        element.classList.remove('border-red-200', 'bg-red-50', 'border-emerald-200', 'bg-emerald-50');
        if (isCorrect) {
            element.classList.add('border-emerald-200', 'bg-emerald-50');
        } else {
            element.classList.add('border-red-200', 'bg-red-50');
        }
    },

    async getPrerequisiteExitHooks(graphId, nodeId) {
        const skeleton = TutorApp.skeleton;
        if (!skeleton || !skeleton.edges) return [];
        const prereqIds = skeleton.edges
            .filter(e => e.type === 'hard' && e.to === nodeId)
            .map(e => e.from);
        if (prereqIds.length === 0) return [];
        const hooks = [];
        for (const pid of prereqIds) {
            const content = await TutorDB.getNodeContent(graphId, pid);
            if (content && content.exitHook) {
                const node = skeleton.nodes.find(n => n.id === pid);
                hooks.push({ name: node?.name || pid, exitHook: content.exitHook });
            }
        }
        return hooks;
    },

    handleAction() {
        if (!this.currentNodeId) return;
        if (this.currentContent && this.currentContent.importance === 'landmark') {
            if (this.onComplete) this.onComplete(this.currentNodeId);
            return;
        }
        const finishData = this.steps[this.steps.length - 1]?.data;
        if (finishData && finishData.isCompleted) return;
        if (this.onComplete) this.onComplete(this.currentNodeId);
    },

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    formatText(text) {
        if (!text) return '';
        return this.escapeHtml(text).replace(/\n/g, '<br>');
    },

    safeMarkedParse(text) {
        if (!text) return '';
        text = this.wrapBareLatex(text);
        const mathBlocks = [];
        function placeholder(match) {
            mathBlocks.push(match);
            return `<span data-math-ph="${mathBlocks.length - 1}"></span>`;
        }
        let protectedText = text.replace(/\$\$[\s\S]*?\$\$/g, placeholder);
        protectedText = protectedText.replace(/\$[\s\S]*?\$/g, placeholder);
        let html = '';
        if (typeof marked !== 'undefined') {
            html = marked.parse(protectedText);
        } else {
            html = this.escapeHtml(protectedText).replace(/\n/g, '<br>');
        }
        mathBlocks.forEach((math, i) => {
            const ph = `<span data-math-ph="${i}"></span>`;
            html = html.split(ph).join(math);
        });
        return html;
    },

    wrapBareLatex(text) {
        // 不再自动识别裸 LaTeX 或 ASCII math，仅保留已由 $ 包裹的公式
        return text;
    },

    getAsciiMathParser() {
        if (!window._tutorAsciiMathParser && typeof AsciiMathParser !== 'undefined') {
            window._tutorAsciiMathParser = new AsciiMathParser();
        }
        return window._tutorAsciiMathParser || null;
    }
};

function renderTutorMath() {
    if (window.renderMathInElement) {
        const container = document.getElementById('learnModalContent');
        if (container) {
            renderMathInElement(container, {
                delimiters: [
                    {left: '$$', right: '$$', display: true},
                    {left: '$', right: '$', display: false}
                ],
                throwOnError: false,
                strict: false
            });
        }
    }
}
