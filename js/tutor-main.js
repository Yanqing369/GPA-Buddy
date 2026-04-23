/**
 * tutor-main.js - 知识图谱导学主逻辑
 */

const API_BASE = 'https://moyuxiaowu.org';

let tutorPreventRefresh = false;

function enableTutorRefreshProtection() {
    tutorPreventRefresh = true;
    window.addEventListener('beforeunload', handleTutorBeforeUnload);
}

function disableTutorRefreshProtection() {
    tutorPreventRefresh = false;
    window.removeEventListener('beforeunload', handleTutorBeforeUnload);
}

function handleTutorBeforeUnload(e) {
    if (tutorPreventRefresh) {
        e.preventDefault();
        e.returnValue = '';
        return '';
    }
}

const TutorApp = {
    currentLang: localStorage.getItem('language') || detectBrowserLanguage(),
    currentGraphId: null,
    currentFile: null,
    skeleton: null,
    completedNodes: new Set(),
    isGenerating: false,
    miniNetwork: null,
    miniNodes: null,
    miniEdges: null,
    processedPdfBytes: null,
    processedFileName: '',
    processedPageCount: 0,
    markerFileName: '',

    i18n: {
        zh: {
            appName: '知识导学',
            back: '返回',
            uploadTitle: '上传学习资料',
            dropText: '拖拽 PDF 或文本文件到此处，或点击上传',
            supportFormats: '支持 PDF、Word(DOCX)、PPT(PPTX)、TXT 格式',
            startGenerate: '开始生成知识图谱',
            generating: '正在生成知识图谱...',
            fileProcessing: '处理文件',
            skeletonStep: '构建知识骨架',
            nodeStep: '填充节点内容 ({0}/{1})',
            completed: '生成完成！',
            graphTitle: '知识图谱',
            selectNode: '点击节点开始学习',
            introQuestion: '引子',
            prerequisiteReview: '前置回顾',
            coreConcepts: '核心概念',
            checkActivities: '检验活动',
            prevStep: '上一步',
            nextStep: '下一步',
            stepProgress: '第 {0} / {1} 步',
            startLearning: '开始学习',
            markComplete: '标记完成',
            alreadyCompleted: '已完成',
            markKnown: '知道了',
            landmarkHint: '这是一个关键里程碑节点。阅读后即可标记完成。',
            noContent: '该节点暂无学习内容',
            noActivities: '无检验活动',
            sortHint: '拖拽排序',
            highlightHint: '高亮你认为正确的部分',
            checkAnswers: '请检查你的答案',
            noRecent: '暂无知识图谱',
            loadGraph: '加载',
            deleteGraph: '删除',
            confirmDelete: '确定要删除这个知识图谱吗？',
            newGraph: '新建图谱',
            myGraphs: '我的知识图谱',
            captchaLabel: '人机验证',
            uploadError: '上传失败',
            networkError: '网络错误',
            refreshWarning: '⚠️ 生成过程中请勿关闭或刷新网页',
            unlockPrerequisite: '请先学习：{0}',
            pageTitle: '知识导学',
            language: '输出语言',
            langZH: '中文',
            langTW: '繁體中文',
            langEN: 'English',
            langKO: '한국어',
            generateMode: '生成模式',
            modeFast: '快速',
            modeExpert: '精研',
            customPrompt: '个性化要求',
            customPromptPlaceholder: '例如：请重点围绕第三章的内容构建图谱',
            customPromptTooLong: '个性化要求不能超过100个字符',
            viewSource: '查看原文',
            sourceNotFound: '未找到源文件，可能已被删除',
            unknownSource: '未知来源',
            page: '页',
            slide: '幻灯片',
            section: '章节',
            sheet: '工作表',
            errVisitorBound: '该设备已绑定其他账号，请登录后使用',
            errInsufficientCredits: '积分不足，请登录或邀请好友获取更多积分',
            errVisitorBlocked: '访客账号已被限制',
            errVisitorNotFound: '访客信息不存在，请刷新页面',
            errQuotaExceeded: '额度已用完，请明日再来',
            uploadStudyMaterial: '上传学习资料',
            creditLoginToView: '登录查看'
        },
        'zh-TW': {
            appName: '知識導學',
            back: '返回',
            uploadTitle: '上傳學習資料',
            dropText: '拖曳 PDF 或文字檔案到此處，或點擊上傳',
            supportFormats: '支援 PDF、Word(DOCX)、PPT(PPTX)、TXT 格式',
            startGenerate: '開始生成知識圖譜',
            generating: '正在生成知識圖譜...',
            fileProcessing: '處理檔案',
            skeletonStep: '構建知識骨架',
            nodeStep: '填充節點內容 ({0}/{1})',
            completed: '生成完成！',
            graphTitle: '知識圖譜',
            selectNode: '點擊節點開始學習',
            introQuestion: '引子',
            prerequisiteReview: '前置回顧',
            coreConcepts: '核心概念',
            checkActivities: '檢驗活動',
            prevStep: '上一步',
            nextStep: '下一步',
            stepProgress: '第 {0} / {1} 步',
            startLearning: '開始學習',
            markComplete: '標記完成',
            alreadyCompleted: '已完成',
            markKnown: '知道了',
            landmarkHint: '這是一個關鍵里程碑節點。閱讀後即可標記完成。',
            noContent: '該節點暫無學習內容',
            noActivities: '無檢驗活動',
            sortHint: '拖曳排序',
            highlightHint: '高亮你認為正確的部分',
            checkAnswers: '請檢查你的答案',
            noRecent: '暫無知識圖譜',
            loadGraph: '載入',
            deleteGraph: '刪除',
            confirmDelete: '確定要刪除這個知識圖譜嗎？',
            newGraph: '新建圖譜',
            myGraphs: '我的知識圖譜',
            captchaLabel: '人機驗證',
            uploadError: '上傳失敗',
            networkError: '網絡錯誤',
            refreshWarning: '⚠️ 生成過程中請勿關閉或重新整理網頁',
            unlockPrerequisite: '請先學習：{0}',
            pageTitle: '知識導學',
            language: '輸出語言',
            langZH: '中文',
            langTW: '繁體中文',
            langEN: 'English',
            langKO: '한국어',
            generateMode: '生成模式',
            modeFast: '快速',
            modeExpert: '精研',
            customPrompt: '個性化要求',
            customPromptPlaceholder: '例如：請重點圍繞第三章的內容構建圖譜',
            customPromptTooLong: '個性化要求不能超過100個字符',
            viewSource: '查看原文',
            sourceNotFound: '未找到來源檔案，可能已被刪除',
            unknownSource: '未知來源',
            page: '頁',
            slide: '投影片',
            section: '章節',
            sheet: '工作表',
            errVisitorBound: '該設備已綁定其他帳號，請登入後使用',
            errInsufficientCredits: '積分不足，請登入或邀請好友獲取更多積分',
            errVisitorBlocked: '訪客帳號已被限制',
            errVisitorNotFound: '訪客資訊不存在，請重新整理頁面',
            errQuotaExceeded: '額度已用完，請明日再來',
            uploadStudyMaterial: '上傳學習資料',
            creditLoginToView: '登入查看'
        },
        en: {
            appName: 'Knowledge Tutor',
            back: 'Back',
            uploadTitle: 'Upload Study Material',
            dropText: 'Drop PDF or text file here, or click to upload',
            supportFormats: 'Supports PDF, Word(DOCX), PPT(PPTX), TXT formats',
            startGenerate: 'Generate Knowledge Graph',
            generating: 'Generating knowledge graph...',
            fileProcessing: 'Processing file',
            skeletonStep: 'Building knowledge skeleton',
            nodeStep: 'Filling node content ({0}/{1})',
            completed: 'Generation complete!',
            graphTitle: 'Knowledge Graph',
            selectNode: 'Click a node to start learning',
            introQuestion: 'Warm-up Question',
            prerequisiteReview: 'Prerequisite Review',
            coreConcepts: 'Core Concepts',
            checkActivities: 'Check Activities',
            prevStep: 'Previous',
            nextStep: 'Next',
            stepProgress: 'Step {0} / {1}',
            startLearning: 'Start Learning',
            markComplete: 'Mark Complete',
            alreadyCompleted: 'Completed',
            markKnown: 'Got it',
            landmarkHint: 'This is a key milestone node. Mark as complete after reading.',
            noContent: 'No learning content for this node yet',
            noActivities: 'No activities',
            sortHint: 'Drag to sort',
            highlightHint: 'Highlight the correct parts',
            checkAnswers: 'Please check your answers',
            noRecent: 'No knowledge graphs yet',
            loadGraph: 'Load',
            deleteGraph: 'Delete',
            confirmDelete: 'Are you sure you want to delete this knowledge graph?',
            newGraph: 'New Graph',
            myGraphs: 'My Graphs',
            captchaLabel: 'Human Verification',
            uploadError: 'Upload failed',
            networkError: 'Network error',
            refreshWarning: '⚠️ Do not close or refresh the page during generation',
            unlockPrerequisite: 'Please learn first: {0}',
            pageTitle: 'Knowledge Tutor',
            language: 'Output Language',
            langZH: 'Chinese',
            langTW: 'Traditional Chinese',
            langEN: 'English',
            langKO: 'Korean',
            generateMode: 'Generation Mode',
            modeFast: 'Fast',
            modeExpert: 'Deep Study',
            customPrompt: 'Personalized Request',
            customPromptPlaceholder: 'e.g. Please focus on Chapter 3 when building the graph',
            customPromptTooLong: 'Custom prompt cannot exceed 100 characters',
            viewSource: 'View Source',
            sourceNotFound: 'Source file not found, may have been deleted',
            unknownSource: 'Unknown source',
            page: 'Page',
            slide: 'Slide',
            section: 'Section',
            sheet: 'Sheet',
            errVisitorBound: 'This device is bound to another account, please login',
            errInsufficientCredits: 'Insufficient credits. Please login or invite friends to get more.',
            errVisitorBlocked: 'Visitor account has been restricted.',
            errVisitorNotFound: 'Visitor info not found, please refresh the page.',
            errQuotaExceeded: 'Quota exhausted. Please come back tomorrow.'
        },
        ko: {
            appName: '지식 가이드',
            back: '돌아가기',
            uploadTitle: '학습 자료 업로드',
            dropText: 'PDF 또는 텍스트 파일을 여기에 끌어다 놓거나 클릭하여 업로드',
            supportFormats: 'PDF, Word(DOCX), PPT(PPTX), TXT 형식 지원',
            startGenerate: '지식 그래프 생성',
            generating: '지식 그래프 생성 중...',
            fileProcessing: '파일 처리 중',
            skeletonStep: '지식 골조 구축',
            nodeStep: '노드 내용 채우기 ({0}/{1})',
            completed: '생성 완료!',
            graphTitle: '지식 그래프',
            selectNode: '노드를 클릭하여 학습 시작',
            introQuestion: '웜업 질문',
            prerequisiteReview: '선행 복습',
            coreConcepts: '핵심 개념',
            checkActivities: '확인 활동',
            prevStep: '이전',
            nextStep: '다음',
            stepProgress: '단계 {0} / {1}',
            startLearning: '학습 시작',
            markComplete: '완료 표시',
            alreadyCompleted: '완료됨',
            markKnown: '알겠습니다',
            landmarkHint: '이것은 중요한 마일스톤 노드입니다. 읽은 후 완료로 표시하세요.',
            noContent: '이 노드에는 아직 학습 내용이 없습니다',
            noActivities: '활동 없음',
            sortHint: '드래그하여 정렬',
            highlightHint: '올바른 부분을 강조 표시',
            checkAnswers: '답안을 확인해 주세요',
            noRecent: '아직 지식 그래프가 없습니다',
            loadGraph: '불러오기',
            deleteGraph: '삭제',
            confirmDelete: '이 지식 그래프를 삭제하시겠습니까?',
            newGraph: '새 그래프',
            myGraphs: '내 그래프',
            captchaLabel: '보안 인증',
            uploadError: '업로드 실패',
            networkError: '네트워크 오류',
            refreshWarning: '⚠️ 생성 중에 페이지를 닫거나 새로고침하지 마세요',
            unlockPrerequisite: '먼저 학습하세요: {0}',
            pageTitle: '지식 가이드',
            language: '출력 언어',
            langZH: '중국어',
            langTW: '번체 중국어',
            langEN: '영어',
            langKO: '한국어',
            generateMode: '생성 모드',
            modeFast: '빠르게',
            modeExpert: '심도연구',
            customPrompt: '개인화 요구사항',
            customPromptPlaceholder: '예: 3장 내용을 중심으로 그래프를 구성해 주세요',
            customPromptTooLong: '개인화 요구사항은 100자를 초과할 수 없습니다',
            viewSource: '원문 보기',
            sourceNotFound: '원본 파일을 찾을 수 없습니다. 삭제되었을 수 있습니다.',
            unknownSource: '출처 불명',
            page: '페이지',
            slide: '슬라이드',
            section: '섹션',
            sheet: '시트',
            errVisitorBound: '해당 기기가 다른 계정에 연결되어 있습니다. 로그인 후 사용하세요.',
            errInsufficientCredits: '포인트가 부족합니다. 로그인하거나 친구를 초대하여 더 많은 포인트를 받으세요.',
            errVisitorBlocked: '방문자 계정이 제한되었습니다.',
            errVisitorNotFound: '방문자 정보가 없습니다. 페이지를 새로고침하세요.',
            errQuotaExceeded: '할당량이 소진되었습니다. 내일 다시 오세요.'
        }
    },

    t(key, ...args) {
        const texts = this.i18n[this.currentLang] || this.i18n.en;
        let text = texts[key] || key;
        if (args.length > 0) {
            args.forEach((arg, index) => {
                text = text.replace(`{${index}}`, arg);
            });
        }
        return text;
    },

    translateBackendError(msg) {
        if (!msg || typeof msg !== 'string') return msg;
        if (msg.includes('Visitor bound to another account')) return this.t('errVisitorBound');
        if (msg.includes('Insufficient credits')) return this.t('errInsufficientCredits');
        if (msg.includes('Visitor blocked')) return this.t('errVisitorBlocked');
        if (msg.includes('Visitor not found')) return this.t('errVisitorNotFound');
        if (msg.includes('Quota exceeded')) return this.t('errQuotaExceeded');
        if (msg.includes('Balance record not found')) return this.t('errQuotaExceeded');
        return msg;
    },

    init() {
        this.updateLanguage();
        updateLogo();
        this.setupDropZone();
        this.setupEventListeners();
        TutorGraph.init('graphContainer');
        TutorPanel.init();
        TutorPanel.onComplete = (nodeId) => this.markNodeComplete(nodeId);
        TutorGraph.onNodeSelect = (nodeId) => this.selectNode(nodeId);
        this.loadRecentGraphs();

        if (window.fileViewer) {
            window.fileViewer.init((key) => this.t(key));
        }

        document.addEventListener('click', (event) => {
            if (!event.target || !event.target.closest) return;
            if (!event.target.closest('.lang-dropdown')) {
                const dropdown = document.getElementById('langDropdown');
                if (dropdown && dropdown.classList.contains('show')) {
                    dropdown.classList.remove('show');
                }
            }
        });

        // 自定义提示词字符计数
        const customPromptEl = document.getElementById('customPrompt');
        const customPromptCountEl = document.getElementById('customPromptCount');
        if (customPromptEl && customPromptCountEl) {
            customPromptEl.addEventListener('input', function() {
                customPromptCountEl.textContent = this.value.length;
            });
        }
        window.addEventListener('resize', updateLogo);
    },

    updateLanguage() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (this.t(key)) el.textContent = this.t(key);
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            if (this.t(key)) el.placeholder = this.t(key);
        });
        const langDisplay = document.getElementById('currentLangDisplay');
        if (langDisplay) {
            langDisplay.textContent = this.currentLang === 'zh' ? '简体中文' :
                                      this.currentLang === 'zh-TW' ? '繁體中文' :
                                      this.currentLang === 'ko' ? '한국어' : 'English';
        }
        document.querySelectorAll('.lang-option').forEach(opt => {
            opt.classList.toggle('active', opt.getAttribute('data-lang') === this.currentLang);
        });
        if (typeof Visitor !== 'undefined') Visitor._updateUI();
        updateLogo();
    },

    setupDropZone() {
        const dropZone = document.getElementById('dropZone');
        const input = document.getElementById('fileInput');
        if (!dropZone || !input) return;

        dropZone.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            input.click();
        });
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });
        dropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) {
                this.handleFile(e.dataTransfer.files[0]);
            }
        });
        input.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.handleFile(e.target.files[0]);
            }
        });
    },

    setupEventListeners() {
        const startBtn = document.getElementById('startGenerateBtn');
        if (startBtn) startBtn.addEventListener('click', () => this.startGeneration());

        const closeModalBtn = document.getElementById('closeLearnModal');
        if (closeModalBtn) closeModalBtn.addEventListener('click', () => this.closeLearnModal());

        const modal = document.getElementById('nodeLearnModal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) this.closeLearnModal();
            });
        }
    },

    openLearnModal() {
        const modal = document.getElementById('nodeLearnModal');
        if (modal) modal.classList.remove('hidden');
    },

    closeLearnModal() {
        const modal = document.getElementById('nodeLearnModal');
        if (modal) modal.classList.add('hidden');
    },

    async handleFile(file) {
        this.currentFile = file;
        const fileList = document.getElementById('fileList');
        if (fileList) {
            fileList.innerHTML = `
                <div class="flex items-center justify-between bg-slate-50 p-3 rounded-lg border border-slate-200">
                    <div class="flex items-center overflow-hidden">
                        <svg class="w-5 h-5 text-slate-400 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                        </svg>
                        <span class="text-sm text-slate-700 truncate">${file.name}</span>
                        <span class="text-xs text-slate-400 ml-2 flex-shrink-0">${(file.size / 1024 / 1024).toFixed(2)}MB</span>
                    </div>
                    <button onclick="clearFile()" class="text-red-500 hover:text-red-700 ml-2" title="清除">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                        </svg>
                    </button>
                </div>
            `;
            fileList.classList.remove('hidden');
        }
        this.fileProcessPromise = this.processFile(file).catch(err => {
            console.error('File processing error:', err);
            this.fileProcessError = err;
        });
    },

    async processFile(file) {
        const ext = file.name.split('.').pop().toLowerCase();
        const officeExts = ['docx', 'pptx', 'xlsx', 'xls', 'txt'];

        if (ext !== 'pdf' && officeExts.includes(ext)) {
            try {
                await this.handleOfficeFile(file);
            } catch (err) {
                console.error('Office conversion error:', err);
                this.showToast(this.t('parseError') || 'File parse error', 'error');
            }
            return;
        }

        await this.handlePdfFile(file);
    },

    async handleOfficeFile(file) {
        const converter = new DocumentConverter();
        await converter.loadFont();
        const pdfBlob = await converter.convert(file, { download: false });
        const pdfFileName = file.name.replace(/\.[^/.]+$/, '.pdf');
        const pdfFile = new File([pdfBlob], pdfFileName, { type: 'application/pdf' });
        await this.handlePdfFile(pdfFile);
    },

    async handlePdfFile(file) {
        await this.processPdfWithPageMarkers(file);
    },

    generateRandomFileName() {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let result = 'doc_';
        for (let i = 0; i < 8; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    },

    async processPdfWithPageMarkers(file) {
        const arrayBuffer = await file.arrayBuffer();
        const { PDFDocument, rgb, StandardFonts } = PDFLib;
        const pdfDoc = await PDFDocument.load(arrayBuffer);
        const pages = pdfDoc.getPages();
        const helveticaFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

        const markerFileName = this.generateRandomFileName();
        const originalFileName = file.name.replace(/\.pdf$/i, '');

        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            const { width, height } = page.getSize();
            const markerText = `-----[${markerFileName}_page${i + 1}]-----`;
            const fontSize = 6;
            const textWidth = helveticaFont.widthOfTextAtSize(markerText, fontSize);
            const margin = 5;
            const x = width - textWidth - margin;
            const y = margin;
            page.drawText(markerText, {
                x, y, size: fontSize, font: helveticaFont, color: rgb(1, 1, 1)
            });
        }

        this.processedPdfBytes = await pdfDoc.save();
        this.processedFileName = file.name;
        this.processedPageCount = pages.length;
        this.markerFileName = markerFileName;

        // 先保存到数据库，待 graphId 生成后再更新关联
        await TutorDB.saveSourceFile(null, file.name, originalFileName, markerFileName, this.processedPdfBytes, 'application/pdf');
    },

    async startGeneration() {
        if (!this.currentFile) {
            this.showToast(this.t('uploadTitle'), 'error');
            return;
        }

        // Get Turnstile token
        let turnstileToken = '';
        if (typeof turnstile !== 'undefined') {
            turnstileToken = turnstile.getResponse();
        }

        this.isGenerating = true;
        enableTutorRefreshProtection();
        this.showProgressModal();

        // 等待文件处理完成（PDF 很快，Office 转换可能需要几秒）
        if (!this.processedPdfBytes) {
            this.updateProgressStep(0, 'active');
            if (this.fileProcessPromise) {
                await this.fileProcessPromise;
            }
            if (this.fileProcessError || !this.processedPdfBytes) {
                this.isGenerating = false;
                disableTutorRefreshProtection();
                this.hideProgressModal();
                this.showToast(this.t('parseError') || 'File processing failed', 'error');
                return;
            }
        }
        this.updateProgressStep(0, 'completed');

        const lang = document.getElementById('tutorLangValue')?.value || 'en';
        const mode = document.getElementById('tutorModeValue')?.value || 'expert';
        const customPrompt = document.getElementById('customPrompt')?.value.trim() || '';

        // 自定义提示词长度限制（100 Unicode 字符）
        if (customPrompt.length > 100) {
            this.showToast(typeof t === 'function' ? t('customPromptTooLong') : 'Custom prompt too long (max 100 characters)', 'error');
            return;
        }

        const uploadFile = new File([this.processedPdfBytes], this.processedFileName || this.currentFile.name, { type: 'application/pdf' });

        const formData = new FormData();
        formData.append('file', uploadFile);
        formData.append('turnstileToken', turnstileToken);
        formData.append('lang', lang);
        formData.append('mode', mode);
        formData.append('customPrompt', customPrompt);
        if (Visitor && Visitor.getId()) {
            formData.append('visitorId', Visitor.getId());
        }

        let skeleton = null;
        let graphId = null;
        let nodeCount = 0;
        let completedCount = 0;
        const pendingContents = []; // 用于暂存 graphId 还没准备好时的节点内容

        await TutorSSE.stream(formData, {
            onSkeleton: (data) => {
                skeleton = data;
                nodeCount = skeleton?.nodes?.length || 1;
                this.updateProgressStep(1, 'completed');
                this.updateProgressStep(2, 'active');
                this.renderMiniSkeleton(skeleton);
                this.createGraphFromSkeleton(skeleton).then(async id => {
                    graphId = id;
                    this.currentGraphId = graphId;
                    this.skeleton = skeleton;
                    // 关联源文件到 graphId（先清理旧的 null 记录）
                    if (this.processedPdfBytes && this.processedFileName) {
                        const originalFileName = this.processedFileName.replace(/\.pdf$/i, '');
                        await TutorDB.saveSourceFile(graphId, this.processedFileName, originalFileName, this.markerFileName, this.processedPdfBytes, 'application/pdf');
                    }
                    // 把暂存的节点内容写入数据库
                    while (pendingContents.length > 0) {
                        const { nodeId, content } = pendingContents.shift();
                        TutorDB.saveNodeContent(graphId, nodeId, content);
                    }
                });
            },
            onNodeStart: (nodeId, name) => {
                // Optional: show which node is being generated
            },
            onNodeDone: (nodeId, content) => {
                completedCount++;
                if (graphId) {
                    TutorDB.saveNodeContent(graphId, nodeId, content);
                } else {
                    pendingContents.push({ nodeId, content });
                }
                this.lightUpMiniNode(nodeId);
                this.updateNodeStep(completedCount, nodeCount || 1);
            },
            onComplete: () => {
                this.isGenerating = false;
                disableTutorRefreshProtection();
                this.hideProgressModal();
                if (graphId) {
                    this.showGraphView();
                    this.loadGraph(graphId);
                    this.showToast(this.t('completed'), 'success');
                } else {
                    // 骨架保存极慢或失败时的兜底
                    this.showToast(this.t('networkError'), 'error');
                }
            },
            onError: (msg) => {
                this.isGenerating = false;
                disableTutorRefreshProtection();
                this.hideProgressModal();
                this.showToast(this.translateBackendError(msg) || this.t('networkError'), 'error');
            },
            onProgress: (current, total) => {
                if (total && !nodeCount) nodeCount = total;
            }
        });
    },

    async createGraphFromSkeleton(skeleton) {
        const graphId = await TutorDB.createGraph(this.processedFileName || this.currentFile?.name || 'Untitled Graph', skeleton);
        return graphId;
    },

    showProgressModal() {
        const modal = document.getElementById('genProgress');
        if (modal) modal.classList.remove('hidden');
        this.updateProgressStep(0, 'active');
        this.updateProgressStep(1, 'pending');
        this.updateProgressStep(2, 'pending');
        document.getElementById('progressBar').style.width = '3%';
    },

    hideProgressModal() {
        const modal = document.getElementById('genProgress');
        if (modal) modal.classList.add('hidden');
        const preview = document.getElementById('genSkeletonPreview');
        if (preview) preview.classList.add('hidden');
        if (this.miniNetwork) {
            this.miniNetwork.destroy();
            this.miniNetwork = null;
            this.miniNodes = null;
            this.miniEdges = null;
        }
    },

    renderMiniSkeleton(skeleton) {
        const container = document.getElementById('genSkeletonContainer');
        const preview = document.getElementById('genSkeletonPreview');
        if (!container || !preview) return;
        preview.classList.remove('hidden');

        this.miniNodes = new vis.DataSet(
            skeleton.nodes.map(n => ({
                id: n.id,
                label: n.name,
                color: { background: '#9ca3af', border: '#ffffff' },
                font: { color: '#ffffff', size: 12 },
                shape: 'dot',
                size: 16
            }))
        );
        this.miniEdges = new vis.DataSet(
            skeleton.edges.map((e, idx) => ({
                id: `me-${idx}`,
                from: e.from,
                to: e.to,
                dashes: e.type === 'soft',
                arrows: { to: { enabled: true, scaleFactor: 0.6 } },
                color: { color: '#cbd5e1' },
                width: 1.5
            }))
        );

        this.miniNetwork = new vis.Network(container, {
            nodes: this.miniNodes,
            edges: this.miniEdges
        }, {
            physics: {
                stabilization: true,
                barnesHut: { gravitationalConstant: -2000, springLength: 80, springConstant: 0.05 }
            },
            interaction: { dragNodes: false, dragView: false, zoomView: false }
        });
    },

    lightUpMiniNode(nodeId) {
        if (!this.miniNodes) return;
        this.miniNodes.update({
            id: nodeId,
            color: { background: '#22c55e', border: '#ffffff' },
            font: { color: '#ffffff' }
        });
    },

    updateProgressStep(stepNumber, status) {
        const step = document.getElementById(`step${stepNumber}`);
        if (!step) return;
        const circle = step.querySelector('.step-number');
        if (status === 'active') {
            step.className = 'step-item active';
            circle.textContent = stepNumber + 1;
        } else if (status === 'completed') {
            step.className = 'step-item completed';
            circle.innerHTML = '✓';
        } else if (status === 'pending') {
            step.className = 'step-item text-slate-400';
            circle.textContent = stepNumber + 1;
        }
    },

    updateNodeStep(current, total) {
        const percent = Math.min(5 + (current / total) * 90, 95);
        document.getElementById('progressBar').style.width = `${percent}%`;
        const text = document.getElementById('progressText');
        if (text) text.textContent = this.t('nodeStep', current, total);
    },

    showGraphView() {
        document.getElementById('uploadSection').classList.add('hidden');
        document.getElementById('graphSection').classList.remove('hidden');
        const newGraphBtn = document.getElementById('newGraphBtn');
        if (newGraphBtn) newGraphBtn.classList.remove('hidden');
        // Vis.js 在 hidden 容器中初始化时 canvas 尺寸为 0，显示后需要重绘
        setTimeout(() => {
            TutorGraph.fit();
        }, 50);
    },

    showUploadView() {
        document.getElementById('uploadSection').classList.remove('hidden');
        document.getElementById('graphSection').classList.add('hidden');
        const newGraphBtn = document.getElementById('newGraphBtn');
        if (newGraphBtn) newGraphBtn.classList.add('hidden');
        this.currentGraphId = null;
        this.skeleton = null;
        this.completedNodes = new Set();
        this.processedPdfBytes = null;
        this.processedFileName = '';
        this.processedPageCount = 0;
        this.markerFileName = '';
        this.currentFile = null;
        const fileList = document.getElementById('fileList');
        if (fileList) fileList.classList.add('hidden');
    },

    clearFile() {
        this.currentFile = null;
        this.processedPdfBytes = null;
        this.processedFileName = '';
        this.processedPageCount = 0;
        this.markerFileName = '';
        this.fileProcessError = null;
        this.fileProcessPromise = null;
        const fileList = document.getElementById('fileList');
        if (fileList) fileList.classList.add('hidden');
        const input = document.getElementById('fileInput');
        if (input) input.value = '';
    },

    async loadGraph(graphId) {
        graphId = Number(graphId);
        console.log('[TutorApp] loadGraph called with id:', graphId);
        const data = await TutorDB.getGraph(graphId);
        if (!data || !data.graph) {
            console.error('[TutorApp] Graph not found for id:', graphId);
            this.showToast(this.t('networkError'), 'error');
            return;
        }
        this.currentGraphId = graphId;
        this.skeleton = {
            nodes: data.nodes.map(n => ({ id: n.nodeId, name: n.name, importance: n.importance })),
            edges: data.nodes.flatMap(n => n.edges || [])
        };
        this.completedNodes = await TutorDB.getCompletedNodes(graphId);
        TutorGraph.loadGraph(this.skeleton, this.completedNodes);
        this.showGraphView();
        this.loadRecentGraphs();
    },

    getMissingPrerequisites(nodeId) {
        if (!this.skeleton) return [];
        const hardPrereqs = new Map();
        this.skeleton.nodes.forEach(n => hardPrereqs.set(n.id, new Set()));
        this.skeleton.edges.forEach(e => {
            if (e.type === 'hard' && hardPrereqs.has(e.to)) {
                hardPrereqs.get(e.to).add(e.from);
            }
        });
        const prereqs = hardPrereqs.get(nodeId);
        if (!prereqs || prereqs.size === 0) return [];
        return Array.from(prereqs)
            .filter(p => !this.completedNodes.has(p))
            .map(p => {
                const node = this.skeleton.nodes.find(n => n.id === p);
                return node?.name || p;
            });
    },

    async selectNode(nodeId) {
        if (!this.currentGraphId) return;
        const isAvailable = this.isNodeAvailable(nodeId);
        const isCompleted = this.completedNodes.has(nodeId);

        if (!isAvailable && !isCompleted) {
            const missing = this.getMissingPrerequisites(nodeId);
            const msg = missing.length > 0
                ? this.t('unlockPrerequisite', missing.join('、'))
                : this.t('selectNode');
            this.showToast(msg, 'error');
            return;
        }

        TutorGraph.selectNode(nodeId);
        const content = await TutorDB.getNodeContent(this.currentGraphId, nodeId);
        const node = this.skeleton.nodes.find(n => n.id === nodeId);
        const importance = node?.importance || 'normal';
        const fullContent = content ? { ...content, importance } : { importance };
        this.openLearnModal();
        TutorPanel.startLearning(this.currentGraphId, nodeId, node?.name || nodeId, fullContent, isCompleted, isAvailable);
    },

    isNodeAvailable(nodeId) {
        if (!this.skeleton) return false;
        const hardPrereqs = new Map();
        this.skeleton.nodes.forEach(n => hardPrereqs.set(n.id, new Set()));
        this.skeleton.edges.forEach(e => {
            if (e.type === 'hard' && hardPrereqs.has(e.to)) {
                hardPrereqs.get(e.to).add(e.from);
            }
        });
        const prereqs = hardPrereqs.get(nodeId);
        return !prereqs || prereqs.size === 0 || Array.from(prereqs).every(p => this.completedNodes.has(p));
    },

    async markNodeComplete(nodeId) {
        if (!this.currentGraphId) return;
        await TutorDB.markNodeComplete(this.currentGraphId, nodeId);
        this.completedNodes.add(nodeId);
        TutorGraph.updateNodeStatus(nodeId, this.completedNodes);
        this.closeLearnModal();
        this.showToast(this.t('completed'), 'success');
    },

    parseSource(sourceStr) {
        if (!sourceStr) return null;
        let match = sourceStr.match(/【([^】]+)】/);
        if (!match) match = sourceStr.match(/\[([^\]]+)\]/);
        if (!match) return null;
        const content = match[1];
        const patterns = [
            { regex: /^(.+)_page(\d+)$/, type: 'page' },
            { regex: /^(.+)_slide(\d+)$/, type: 'slide' },
            { regex: /^(.+)_section(\d+)$/, type: 'section' },
            { regex: /^(.+)_sheet(\d+)$/, type: 'sheet' }
        ];
        let filename = content, location = null, locationType = 'page';
        for (const pattern of patterns) {
            const locMatch = content.match(pattern.regex);
            if (locMatch) {
                filename = locMatch[1];
                location = parseInt(locMatch[2]);
                locationType = pattern.type;
                break;
            }
        }
        return { filename, location, locationType, original: sourceStr };
    },

    async openSourceViewer(sourceStr) {
        if (!this.currentGraphId || !sourceStr) return;
        const sourceInfo = this.parseSource(sourceStr);
        if (!sourceInfo) {
            this.showToast(this.t('unknownSource') || 'Unknown source', 'error');
            return;
        }
        const fileRecord = await TutorDB.getSourceFileByGraphId(this.currentGraphId);
        if (!fileRecord) {
            this.showToast(this.t('sourceNotFound') || 'Source file not found', 'error');
            return;
        }
        window.fileViewer.setSource(fileRecord, sourceInfo);
        document.getElementById('viewerTitle').textContent = fileRecord.name;
        const locationText = sourceInfo.location ? `${this.t(sourceInfo.locationType) || sourceInfo.locationType} ${sourceInfo.location}` : (this.t('unknownSource') || 'Unknown source');
        document.getElementById('viewerLocation').textContent = locationText;
        document.getElementById('viewerFileInfo').textContent = `Size: ${(fileRecord.data.byteLength / 1024).toFixed(1)} KB`;
        document.getElementById('sourceViewerModal').classList.remove('hidden');
        await window.fileViewer.render();
    },

    async loadRecentGraphs() {
        const container = document.getElementById('recentGraphs');
        if (!container) return;
        const graphs = await TutorDB.getAllGraphs();
        if (graphs.length === 0) {
            container.innerHTML = `<div class="text-slate-400 text-center py-4 text-sm">${this.t('noRecent')}</div>`;
            return;
        }
        container.innerHTML = graphs.map(g => `
            <div class="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-200">
                <div class="overflow-hidden">
                    <div class="text-sm font-medium text-slate-700 truncate">${g.name}</div>
                    <div class="text-xs text-slate-400">${new Date(g.updatedAt).toLocaleString()}</div>
                </div>
                <div class="flex items-center gap-2 ml-2">
                    <button onclick="TutorApp.loadGraph(${g.id})" class="px-3 py-1 text-xs font-medium rounded-lg liquid-btn text-slate-700">${this.t('loadGraph')}</button>
                    <button onclick="TutorApp.deleteGraph(${g.id})" class="px-3 py-1 text-xs font-medium rounded-lg text-red-600 hover:bg-red-50">${this.t('deleteGraph')}</button>
                </div>
            </div>
        `).join('');
    },

    async deleteGraph(graphId) {
        if (!confirm(this.t('confirmDelete'))) return;
        await TutorDB.deleteGraph(graphId);
        if (this.currentGraphId === graphId) {
            this.showUploadView();
        }
        this.loadRecentGraphs();
    },

    showToast(message, type = 'info') {
        const toast = document.createElement('div');
        const bg = type === 'error' ? 'bg-red-500' : type === 'success' ? 'bg-emerald-500' : 'bg-slate-700';
        toast.className = `fixed top-20 left-1/2 transform -translate-x-1/2 ${bg} text-white px-6 py-3 rounded-xl shadow-xl z-50 text-sm font-medium modal-enter`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }
};

function toggleLangDropdown() {
    const dropdown = document.getElementById('langDropdown');
    if (dropdown) dropdown.classList.toggle('show');
}

function changeLanguage(lang) {
    TutorApp.currentLang = lang;
    localStorage.setItem('language', lang);
    TutorApp.updateLanguage();
    const dropdown = document.getElementById('langDropdown');
    if (dropdown) dropdown.classList.remove('show');
}

const TUTOR_LANG_LABELS = {
    'zh': '简体中文',
    'zh-TW': '繁體中文',
    'en': 'English',
    'ko': '한국어'
};

function toggleTutorLangDropdown() {
    const dropdown = document.getElementById('tutorLangOptions');
    if (dropdown) dropdown.classList.toggle('show');
}

function selectTutorLang(lang) {
    const valueInput = document.getElementById('tutorLangValue');
    const display = document.getElementById('tutorLangDisplay');
    if (valueInput) valueInput.value = lang;
    if (display) display.textContent = TUTOR_LANG_LABELS[lang] || lang;
    const dropdown = document.getElementById('tutorLangOptions');
    if (dropdown) dropdown.classList.remove('show');
    document.querySelectorAll('#tutorLangOptions .lang-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.lang === lang);
    });
}

function selectTutorMode(mode) {
    const valueInput = document.getElementById('tutorModeValue');
    if (valueInput) valueInput.value = mode;
    const fastBtn = document.getElementById('btnModeFast');
    const expertBtn = document.getElementById('btnModeExpert');
    if (!fastBtn || !expertBtn) return;
    if (mode === 'fast') {
        fastBtn.className = 'px-4 py-1.5 rounded-lg text-sm font-medium text-white bg-gradient-to-r from-emerald-400 to-green-500 shadow-sm transition-all flex items-center gap-1.5';
        expertBtn.className = 'px-4 py-1.5 rounded-lg text-sm font-medium text-slate-600 transition-all flex items-center gap-1.5';
    } else {
        fastBtn.className = 'px-4 py-1.5 rounded-lg text-sm font-medium text-slate-600 transition-all flex items-center gap-1.5';
        expertBtn.className = 'px-4 py-1.5 rounded-lg text-sm font-medium text-white bg-gradient-to-r from-emerald-400 to-green-500 shadow-sm transition-all flex items-center gap-1.5';
    }
}

// 初始化 tutor 语言下拉高亮
(function initTutorLangActive() {
    const current = document.getElementById('tutorLangValue')?.value || 'en';
    document.querySelectorAll('#tutorLangOptions .lang-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.lang === current);
    });
})();

// 点击空白区域关闭 tutor 语言下拉
window.addEventListener('click', (event) => {
    if (!event.target.closest('#tutorLangDropdown')) {
        const dropdown = document.getElementById('tutorLangOptions');
        if (dropdown && dropdown.classList.contains('show')) {
            dropdown.classList.remove('show');
        }
    }
});

function detectBrowserLanguage() {
    const browserLang = navigator.language || navigator.userLanguage || 'en';
    const lang = browserLang.toLowerCase();
    if (lang.startsWith('zh') && (lang.includes('tw') || lang.includes('hk') || lang.includes('hant'))) return 'zh-TW';
    if (lang.startsWith('zh')) return 'zh';
    if (lang.startsWith('en')) return 'en';
    return 'en';
}

document.addEventListener('DOMContentLoaded', () => {
    TutorApp.init();
});

function updateLogo() {
    const logo = document.getElementById('navLogo');
    if (!logo) return;
    const isMobile = window.innerWidth < 768;
    if (isMobile) {
        logo.src = TutorApp.currentLang === 'zh' ? 'resources/chineselogo.png' : 'resources/ENlogo.png';
    } else {
        logo.src = 'resources/logo.png';
    }
}

// Global helpers
function t(key, ...args) {
    return TutorApp.t(key, ...args);
}
window.clearFile = function() {
    TutorApp.clearFile();
};
