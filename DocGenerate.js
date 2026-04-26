/**
 * DocGenerate.js - Vertex AI (Gemini) 流式题库生成前端
 */

const API_BASE = "https://moyuxiaowu.org";
const DB_NAME = 'ExamBuddyDB_Clean_v2';

// ==================== 数据库初始化 ====================
const db = new Dexie(DB_NAME);

// 版本5：旧版本
// 版本6：将 sourceFiles.safeName 改为 fileName，支持题库ID关联，添加 markerFileName
db.version(6).stores({
    questionBanks: '++id, name, createdAt, updatedAt',
    practiceProgress: '++id, bankId, lastPracticeAt',
    sourceFiles: '++id, name, fileName, markerFileName, bankId, data, createdAt',
    settings: 'key'
}).upgrade(tx => {
    // 数据迁移：将旧数据从 safeName 复制到 fileName
    return tx.table('sourceFiles').toCollection().modify(file => {
        if (file.safeName && !file.fileName) {
            file.fileName = file.safeName;
        }
        // 确保 bankId 字段存在
        if (!file.bankId) {
            file.bankId = null;
        }
    });
});

// 版本7：新增知识图谱相关表（知识导学功能）
db.version(7).stores({
    questionBanks: '++id, name, createdAt, updatedAt',
    practiceProgress: '++id, bankId, lastPracticeAt',
    sourceFiles: '++id, name, fileName, markerFileName, bankId, data, createdAt',
    settings: 'key',
    knowledgeGraphs: '++id, name, createdAt, updatedAt',
    graphNodes: '++id, graphId, nodeId, [graphId+nodeId]',
    graphProgress: '++id, graphId, nodeId, [graphId+nodeId]'
});

// 版本8：sourceFiles 增加 graphId 索引，支持 tutor 溯源
db.version(8).stores({
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

// 数据库打开时执行数据恢复检查
db.open().then(async () => {
    // 检查是否有数据丢失（题库数量为0但备份存在）
    const count = await db.questionBanks.count();
    const backupData = localStorage.getItem('exam_banks_backup_v5');
    if (count === 0 && backupData) {
        console.log('检测到数据丢失，正在恢复...');
        try {
            const banks = JSON.parse(backupData);
            await db.transaction('rw', db.questionBanks, async () => {
                for (const bank of banks) {
                    // 移除id让数据库重新分配
                    delete bank.id;
                    await db.questionBanks.add(bank);
                }
            });
            console.log(`成功恢复 ${banks.length} 个题库`);
            localStorage.removeItem('exam_banks_backup_v5');
        } catch (e) {
            console.error('数据恢复失败:', e);
        }
    }
}).catch(e => console.error('数据库打开失败:', e));

// ==================== 状态变量 ====================
let currentLang = localStorage.getItem('language') || detectBrowserLanguage();
let currentFiles = [];
let processedPdfBytes = null;
let processedFileName = '';
let processedPageCount = 0;
let generatedQuestions = [];
let preventRefresh = false;
let streamingGenerator = null;

// ==================== 国际化配置 ====================
const i18n = {
    zh: {
        appName: '请出题',
        back: '返回',
        generateHeader: '从资料生成题库',
        uploadStudyMaterial: '上传学习资料',
        dropText: '拖拽文件到此处，或点击上传',
        supportFormats: '支持 PDF、Word(DOCX)、PPT(PPTX)、Excel(XLSX/XLS)、TXT 格式',
        textExtractionNotice: '📄 PPT/DOCX/XLSX 文件将自动提取文本生成题目',
        configTitle: '出题设置',
        questionCount: '题目数量',
        language: '输出语言',
        langZH: '中文',
        langTW: '繁體中文',
        langEN: 'English',
        langKO: '한국어',
        customPrompt: '个性化要求',
        customPromptPlaceholder: '例如：请重点围绕第三章的内容出题',
        generateMode: '生成模式',
        modeMultimodal: '图文',
        modeText: '纯文本',
        customPromptTooLong: '个性化要求不能超过100个字符',
        partialGenerationNotice: '由于AI服务波动，本次仅生成{0}题，不扣除您的点数',
        startGenerate: '开始生成',
        captchaLabel: '人机验证',
        pdfPreviewNote: 'PDF中的图表都将被读取',
        officePreviewNote: 'Office文件仅提取图文，不影响出题效果',
        pdfPreview: 'PDF预览（已添加页码标记）',
        filePreview: '文件预览',
        waitingUpload: '等待上传文件...',
        generating: '正在生成题库...',
        aiProcessing: 'AI正在分析文档内容',
        warningRefresh: '⚠️ 生成过程中请勿关闭或刷新网页，否则会导致生成失败',
        generatedCount: '已生成 {0} 题，共 {1} 题',
        preparing: '准备中...',
        completed: '完成！',
        almostDone: '即将完成...',
        progress: '进度',
        previewResult: '预览生成结果',
        saveAndPractice: '保存并练习',
        discardBank: '放弃此题库',
        discardConfirm: '确定要放弃这个题库吗？',
        fillRequired: '请上传PDF文件',
        saveSuccess: '保存成功',
        parseError: '文件解析失败',
        networkError: '网络错误，请检查后端服务是否启动',
        processingPdf: '正在处理PDF...',
        uploadError: '文件上传失败',
        onlyPdf: '请上传PDF格式文件',
        pageLabel: '第 {0} 页',
        partialSuccessTitle: '生成完成（部分成功）',
        partialSuccessMessage: '由于服务器速率限制，此次实际生成 {0} 题（原计划 {1} 题），抱歉造成不便。',
        partialSuccessHint: '如需更多题目，请稍后重新生成。',
        pageTitle: '请出题',
        toastSuccess: '操作成功',
        streamingStatus: '实时生成中...',
        batchProgress: '批次 {0}/{1}: 已生成 {2} 题',
        stepUploading: '上传文件',
        stepGeneratingQuestions: 'AI生成题目',
        streamingPreview: '实时预览',
        waitingFirstQuestion: '正在琢磨怎么出题...',
        totalQuestionsHint: '以上仅显示前20题预览，共生成 {0} 题',
        generateCostText: '生成一次题库的成本约为 0.5 元，如果本网站对你有帮助，欢迎捐款支持',
        donate: '捐款',
        donateBannerText: '测试期间（2026年9月1日前）所有功能免费开放，祝大家考试顺利',
        supportUs: '支持我们',
        donateDialogTitle: '支持我们',
        donateDialogMessage: '如果你觉得本网站有用，欢迎捐款支持，帮我们活到下学期',
        donateDialogButton: '知道了',
        donateDialogLink: '前往捐款页面',
        converting: '转换中...',
        convertedToPDF: '已转换为PDF',
        loadingFont: '加载字体...',
        errVisitorBound: '该设备已绑定其他账号，请登录后使用',
        errInsufficientCredits: '积分不足，请登录或邀请好友获取更多积分',
        errVisitorBlocked: '访客账号已被限制',
        errVisitorNotFound: '访客信息不存在，请刷新页面',
        creditLoginToView: '登录查看',
        errQuotaExceeded: '额度已用完，请明日再来'
    },
    'zh-TW': {
        appName: '請出題',
        back: '返回',
        generateHeader: '從資料生成題庫',
        uploadStudyMaterial: '上傳學習資料',
        dropText: '拖曳PDF檔案到此處，或點擊上傳',
        supportFormats: '支援 PDF、Word(DOCX)、PPT(PPTX)、Excel(XLSX/XLS)、TXT 格式',
        textExtractionNotice: '📄 PPT/DOCX/XLSX 檔案將自動提取文本生成題目',
        configTitle: '出題設定',
        questionCount: '題目數量',
        language: '輸出語言',
        langZH: '中文',
        langTW: '繁體中文',
        langEN: 'English',
        langKO: '한국어',
        customPrompt: '個性化要求',
        customPromptPlaceholder: '例如：請重點圍繞第三章的內容出題',
        generateMode: '生成模式',
        modeMultimodal: '圖文',
        modeText: '純文字',
        customPromptTooLong: '個性化要求不能超過100個字符',
        partialGenerationNotice: '由於AI服務波動，本次僅生成{0}題，不扣除您的點數',
        startGenerate: '開始生成',
        captchaLabel: '人機驗證',
        pdfPreviewNote: 'PDF中的圖表都將被讀取',
        officePreviewNote: 'Office文件僅提取圖文，不影響出題效果',
        pdfPreview: 'PDF預覽（已添加頁碼標記）',
        filePreview: '檔案預覽',
        waitingUpload: '等待上傳檔案...',
        generating: '正在生成題庫...',
        aiProcessing: 'AI正在分析文件內容',
        warningRefresh: '⚠️ 生成過程中請勿關閉或重新整理網頁，否則會導致生成失敗',
        generatedCount: '已生成 {0} 題，共 {1} 題',
        preparing: '準備中...',
        completed: '完成！',
        almostDone: '即將完成...',
        progress: '進度',
        previewResult: '預覽生成結果',
        saveAndPractice: '儲存並練習',
        discardBank: '放棄此題庫',
        discardConfirm: '確定要放棄這個題庫嗎？',
        fillRequired: '請上傳PDF檔案',
        saveSuccess: '儲存成功',
        parseError: '檔案解析失敗',
        networkError: '網絡錯誤，請檢查後端服務是否啟動',
        processingPdf: '正在處理PDF...',
        uploadError: '檔案上傳失敗',
        onlyPdf: '請上傳PDF格式檔案',
        pageLabel: '第 {0} 頁',
        partialSuccessTitle: '生成完成（部分成功）',
        partialSuccessMessage: '由於伺服器速率限制，此次實際生成 {0} 題（原計劃 {1} 題），抱歉造成不便。',
        partialSuccessHint: '如需更多題目，請稍後重新生成。',
        pageTitle: '請出題',
        toastSuccess: '操作成功',
        streamingStatus: '實時生成中...',
        batchProgress: '批次 {0}/{1}: 已生成 {2} 題',
        stepUploading: '上傳檔案',
        stepGeneratingQuestions: 'AI生成題目',
        streamingPreview: '實時預覽',
        waitingFirstQuestion: '正在思考出咩題...',
        totalQuestionsHint: '以上僅顯示前20題預覽，共生成 {0} 題',
        generateCostText: '生成一次題庫的成本約為 0.5 港幣，如果本網站對你有幫助，歡迎捐款支持',
        donate: '捐款',
        donateBannerText: '測試期間（2026年9월 1일 이전）所有功能免費開放，祝大家考試順利',
        supportUs: '支持我們',
        donateDialogTitle: '支持我們',
        donateDialogMessage: '如果你覺得本網站有用，歡迎捐款支持，幫我們活到下學期',
        donateDialogButton: '知道了',
        donateDialogLink: '前往捐款頁面',
        converting: '轉換中...',
        convertedToPDF: '已轉換為PDF',
        loadingFont: '加載字體...',
        errVisitorBound: '該設備已綁定其他帳號，請登入後使用',
        errInsufficientCredits: '積分不足，請登入或邀請好友獲取更多積分',
        errVisitorBlocked: '訪客帳號已被限制',
        errVisitorNotFound: '訪客資訊不存在，請重新整理頁面',
        creditLoginToView: '登入查看',
        errQuotaExceeded: '額度已用完，請明日再來'
    },
    en: {
        appName: 'GPA4.0',
        back: 'Back',
        generateHeader: 'Generate from Material',
        uploadStudyMaterial: 'Upload Study Material',
        dropText: 'Drop files here or click to upload',
        supportFormats: 'Supports PDF, Word(DOCX), PPT(PPTX), Excel(XLSX/XLS), TXT formats',
        textExtractionNotice: '📄 PPT/DOCX/XLSX files will be converted to text for question generation',
        configTitle: 'Question Settings',
        questionCount: 'Question Count',
        language: 'Output Language',
        langZH: 'Chinese',
        langTW: 'Traditional Chinese',
        langEN: 'English',
        langKO: 'Korean',
        customPrompt: 'Personalized Request',
        customPromptPlaceholder: 'e.g. Please focus on Chapter 3 when creating questions',
        generateMode: 'Generation Mode',
        modeMultimodal: 'Multimodal',
        modeText: 'Text Only',
        customPromptTooLong: 'Custom prompt cannot exceed 100 characters',
        partialGenerationNotice: 'Due to AI service fluctuations, only {0} questions were generated this time. No credits deducted.',
        startGenerate: 'Start Generation',
        captchaLabel: 'Human Verification',
        pdfPreviewNote: 'Charts and images in PDF will be read',
        officePreviewNote: 'Office files will be extracted as text and images only, which does not affect question generation',
        pdfPreview: 'PDF Preview (with page markers)',
        filePreview: 'File Preview',
        waitingUpload: 'Waiting for file upload...',
        generating: 'Generating Question Bank...',
        aiProcessing: 'AI is analyzing document content',
        warningRefresh: '⚠️ Do not close or refresh the page during generation',
        generatedCount: 'Generated {0} of {1} questions',
        preparing: 'Preparing...',
        completed: 'Completed!',
        almostDone: 'Almost done...',
        progress: 'Progress',
        previewResult: 'Preview Results',
        saveAndPractice: 'Save & Practice',
        discardBank: 'Discard This Bank',
        discardConfirm: 'Are you sure you want to discard this question bank?',
        fillRequired: 'Please upload a PDF file',
        saveSuccess: 'Saved successfully',
        parseError: 'File parsing failed',
        networkError: 'Network error, please check if backend is running',
        processingPdf: 'Processing PDF...',
        uploadError: 'File upload failed',
        onlyPdf: 'Please upload PDF format files only',
        pageLabel: 'Page {0}',
        partialSuccessTitle: 'Generation Complete (Partial Success)',
        partialSuccessMessage: 'Due to server rate limiting, only {0} of {1} questions were generated. We apologize for the inconvenience.',
        partialSuccessHint: 'Please try again later if you need more questions.',
        pageTitle: 'GPA4.0',
        toastSuccess: 'Operation successful',
        streamingStatus: 'Streaming generation...',
        batchProgress: 'Batch {0}/{1}: {2} questions generated',
        stepUploading: 'Uploading File',
        stepGeneratingQuestions: 'AI Generating',
        streamingPreview: 'Live Preview',
        waitingFirstQuestion: 'Thinking about questions...',
        totalQuestionsHint: 'Showing first 20 questions preview, {0} questions generated in total',
        generateCostText: 'Each question bank generation costs about 0.5 HKD. If this site helps you, please consider donating.',
        donate: 'Donate',
        donateBannerText: 'All features are free during the beta period (before Sep 1, 2026). Good luck on your exams!',
        supportUs: 'Support Us',
        donateDialogTitle: 'Support Us',
        donateDialogMessage: 'If you find this site helpful, please consider donating to help us survive until next semester.',
        donateDialogButton: 'Got it',
        donateDialogLink: 'Go to Donation Page',
        converting: 'Converting...',
        convertedToPDF: 'Converted to PDF',
        loadingFont: 'Loading font...',
        errVisitorBound: 'This device is bound to another account, please login',
        errInsufficientCredits: 'Insufficient credits. Please login or invite friends to get more.',
        errVisitorBlocked: 'Visitor account has been restricted.',
        errVisitorNotFound: 'Visitor info not found, please refresh the page.',
        creditLoginToView: 'Login to view',
        errQuotaExceeded: 'Quota exhausted. Please come back tomorrow.'
    },
    ko: {
        appName: 'GPA4.0',
        back: '돌아가기',
        generateHeader: '자료에서 문제은행 생성',
        uploadStudyMaterial: '학습 자료 업로드',
        dropText: '파일을 여기로 끌어다 놓거나 클릭하여 업로드',
        supportFormats: 'PDF, Word(DOCX), PPT(PPTX), Excel(XLSX/XLS), TXT 형식 지원',
        textExtractionNotice: '📄 PPT/DOCX/XLSX 파일은 텍스트 추출 후 문제가 생성됩니다',
        configTitle: '출제 설정',
        questionCount: '문제 수량',
        language: '출력 언어',
        langZH: '중국어',
        langTW: '번체 중국어',
        langEN: '영어',
        langKO: '한국어',
        customPrompt: '개인화 요구사항',
        customPromptPlaceholder: '예: 3장 내용을 중심으로 문제를 출제해 주세요',
        generateMode: '생성 모드',
        modeMultimodal: '멀티모달',
        modeText: '텍스트 전용',
        customPromptTooLong: '개인화 요구사항은 100자를 초과할 수 없습니다',
        partialGenerationNotice: 'AI 서비스 변동으로 인해 이번에 {0}문제만 생성되었습니다. 포인트가 차감되지 않습니다.',
        startGenerate: '생성 시작',
        captchaLabel: '보안 인증',
        pdfPreviewNote: 'PDF의 차트와 이미지가 모두 읽힙니다',
        officePreviewNote: 'Office 파일은 텍스트와 이미지만 추출되며 문제 생성에는 영향이 없습니다',
        pdfPreview: 'PDF 미리보기 (페이지 표시 포함)',
        filePreview: '파일 미리보기',
        waitingUpload: '파일 업로드 대기 중...',
        generating: '문제은행 생성 중...',
        aiProcessing: 'AI가 문서 내용을 분석하는 중',
        warningRefresh: '⚠️ 생성 중에 페이지를 닫거나 새로고침하지 마세요',
        generatedCount: '{1}개 중 {0}개 생성됨',
        preparing: '준비 중...',
        completed: '완료!',
        almostDone: '거의 완료...',
        progress: '진행률',
        previewResult: '생성 결과 미리보기',
        saveAndPractice: '저장하고 풀기',
        discardBank: '이 문제은행 버리기',
        discardConfirm: '이 문제은행을 버리시겠습니까?',
        fillRequired: 'PDF 파일을 업로드하세요',
        saveSuccess: '저장 성공',
        parseError: '파일 분석 실패',
        networkError: '네트워크 오류, 백엔드 서비스가 실행 중인지 확인하세요',
        processingPdf: 'PDF 처리 중...',
        uploadError: '파일 업로드 실패',
        onlyPdf: 'PDF 형식 파일만 업로드하세요',
        pageLabel: '{0} 페이지',
        partialSuccessTitle: '생성 완료 (일부 성공)',
        partialSuccessMessage: '서버 속도 제한으로 인해 {0}개 문제 중 {1}개 문제만 생성되었습니다. 불편을 드려 죄송합니다.',
        partialSuccessHint: '더 많은 문제가 필요하면 나중에 다시 시도하세요.',
        pageTitle: 'GPA4.0',
        toastSuccess: '작업 성공',
        streamingStatus: '실시간 생성 중...',
        batchProgress: '배치 {0}/{1}: {2}개 문제 생성됨',
        stepUploading: '파일 업로드',
        stepGeneratingQuestions: 'AI 문제 생성',
        streamingPreview: '실시간 미리보기',
        waitingFirstQuestion: '문제를 생각하는 중...',
        totalQuestionsHint: '처음 20문제 미리보기, 총 {0}문제 생성됨',
        generateCostText: '문제은행 생성 1회 비용은 약 0.5 HKD입니다. 이 사이트가 도움이 된다면 기부를 고려해 주세요.',
        donate: '기부',
        donateBannerText: '테스트 기간 동안(2026년 9월 1일 이전) 모든 기능이 묵료입니다. 시험 잘 보세요!',
        supportUs: '후원하기',
        donateDialogTitle: '후원하기',
        donateDialogMessage: '이 사이트가 도움이 되셨다면 기부로 후원해 주세요. 다음 학기까지 운영할 수 있도록 도와주세요.',
        donateDialogButton: '알겠습니다',
        donateDialogLink: '기부 페이지로 이동',
        converting: '변환 중...',
        convertedToPDF: 'PDF로 변환됨',
        loadingFont: '폰트 로드 중...',
        errVisitorBound: '해당 기기가 다른 계정에 연결되어 있습니다. 로그인 후 사용하세요.',
        errInsufficientCredits: '포인트가 부족합니다. 로그인하거나 친구를 초대하여 더 많은 포인트를 받으세요.',
        errVisitorBlocked: '방문자 계정이 제한되었습니다.',
        errVisitorNotFound: '방문자 정보가 없습니다. 페이지를 새로고침하세요.',
        creditLoginToView: '로그인하여 확인',
        errQuotaExceeded: '할당량이 소진되었습니다. 내일 다시 오세요.'
    }
};

// ==================== 工具函数 ====================
function t(key, ...args) {
    let text = i18n[currentLang][key] || key;
    if (args.length > 0) {
        args.forEach((arg, index) => {
            text = text.replace(`{${index}}`, arg);
        });
    }
    return text;
}

function translateBackendError(msg) {
    if (!msg || typeof msg !== 'string') return msg;
    if (msg.includes('Visitor bound to another account')) return t('errVisitorBound');
    if (msg.includes('Insufficient credits')) return t('errInsufficientCredits');
    if (msg.includes('Visitor blocked')) return t('errVisitorBlocked');
    if (msg.includes('Visitor not found')) return t('errVisitorNotFound');
    if (msg.includes('Quota exceeded')) return t('errQuotaExceeded');
    if (msg.includes('Balance record not found')) return t('errQuotaExceeded');
    return msg;
}

function detectBrowserLanguage() {
    const browserLang = navigator.language || navigator.userLanguage || 'en';
    const lang = browserLang.toLowerCase();
    if (lang.startsWith('zh') && (lang.includes('cn') || lang.includes('sg') || lang.includes('hans') || lang === 'zh')) return 'zh';
    if (lang.startsWith('zh') && (lang.includes('tw') || lang.includes('hk') || lang.includes('mo') || lang.includes('hant'))) return 'zh-TW';
    if (lang.startsWith('ko')) return 'ko';
    if (lang.startsWith('en')) return 'en';
    return 'en';
}

function updateLanguage() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (i18n[currentLang] && i18n[currentLang][key]) {
            el.textContent = i18n[currentLang][key];
        }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (i18n[currentLang] && i18n[currentLang][key]) {
            el.placeholder = i18n[currentLang][key];
        }
    });
    const langDisplay = document.getElementById('currentLangDisplay');
    if (langDisplay) {
        langDisplay.textContent = currentLang === 'zh' ? '简' : 
                                   currentLang === 'zh-TW' ? '繁' : 
                                   currentLang === 'ko' ? '한' : 'En';
    }
    if (typeof Visitor !== 'undefined') Visitor._updateUI();
    updateLogo();
}

function updateLogo() {
    const logo = document.getElementById('navLogo');
    if (!logo) return;
    const isMobile = window.innerWidth < 768;
    if (isMobile) {
        if (currentLang === 'zh') {
            logo.src = 'resources/chineselogo.png';
        } else {
            logo.src = 'resources/ENlogo.png';
        }
    } else {
        logo.src = 'resources/logo.png';
    }
}

window.addEventListener('resize', updateLogo);

function toggleLangDropdown() {
    const dropdown = document.getElementById('langDropdown');
    if (dropdown) dropdown.classList.toggle('show');
}

function changeLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('language', currentLang);
    updateLanguage();
    const dropdown = document.getElementById('langDropdown');
    if (dropdown) dropdown.classList.remove('show');
}

const GEN_LANG_LABELS = {
    'zh': '简体中文',
    'zh-TW': '繁體中文',
    'en': 'English',
    'ko': '한국어'
};

function toggleGenLangDropdown() {
    const dropdown = document.getElementById('genLangOptions');
    if (dropdown) dropdown.classList.toggle('show');
}

function selectGenLang(lang) {
    const valueInput = document.getElementById('genLangValue');
    const display = document.getElementById('genLangDisplay');
    if (valueInput) valueInput.value = lang;
    if (display) display.textContent = GEN_LANG_LABELS[lang] || lang;
    const dropdown = document.getElementById('genLangOptions');
    if (dropdown) dropdown.classList.remove('show');
    // 更新 active 状态
    document.querySelectorAll('#genLangOptions .lang-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.lang === lang);
    });
}

window.onclick = function(event) {
    if (!event.target.closest('.lang-dropdown')) {
        const dropdown = document.getElementById('langDropdown');
        if (dropdown && !dropdown.classList.contains('hidden')) {
            dropdown.classList.add('hidden');
        }
        const genDropdown = document.getElementById('genLangOptions');
        if (genDropdown && genDropdown.classList.contains('show')) {
            genDropdown.classList.remove('show');
        }
    }
};

// ==================== 流式生成器类 ====================
class StreamingQuestionGenerator {
    constructor() {
        this.fileUri = null;
        this.fileName = null;
        this.originalFileName = null;
        this.pageCount = 0;
        this.isGenerating = false;
        this.questions = [];
        this.batchResults = new Map();
        this.currentBatch = 0;
        this.totalBatches = 0;
        this.decoder = new TextDecoder();
        this.abortControllers = [];
    }

    setOriginalFileName(originalFileName) {
        this.originalFileName = originalFileName;
    }

    setPageCount(count) {
        this.pageCount = count;
    }

    setTurnstileToken(token) {
        this.turnstileToken = token;
    }

    // 新的统一生成方法 - 使用 /pdf_generate 接口
    async generateAll(file, config) {
        const { questionCount, lang, turnstileToken, customPrompt } = config;

        this.isGenerating = true;
        this.questions = [];
        this.batchResults.clear();
        this.totalBatches = Math.ceil(questionCount / 20);
        this.totalBatches = Math.ceil(questionCount / 20);
        this.currentBatch = 0;
        this.abortControllers = [];

        // 计算每批的页码范围
        this.pagesPerBatch = this.pageCount > 0
            ? Math.ceil(this.pageCount / this.totalBatches)
            : 20;

        // 构建 form-data
        const formData = new FormData();
        formData.append('file', file);
        formData.append('questionCount', questionCount);
        formData.append('lang', lang);
        formData.append('turnstileToken', turnstileToken);
        formData.append('pageCount', this.pageCount);
        formData.append('originalFileName', this.originalFileName);
        formData.append('customPrompt', customPrompt || '');
        if (typeof Visitor !== 'undefined' && Visitor.getId()) {
            formData.append('visitorId', Visitor.getId());
        }

        try {
            this.updateProgressStep(2, 'active');

            const controller = new AbortController();
            this.abortControllers.push(controller);

            const token = localStorage.getItem('auth_token');
            const response = await fetch(`${API_BASE}/pdf_generate`, {
                method: 'POST',
                body: formData,
                signal: controller.signal,
                headers: token ? { 'Authorization': `Bearer ${token}` } : {}
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(translateBackendError(error.error) || t('uploadError'));
            }

            // 使用 SSE 读取响应
            const reader = response.body.getReader();
            let batch0Buffer = '';
            let displayedCount = 0;
            let sseBuffer = ''; // 用于累积 SSE 消息

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = this.decoder.decode(value, { stream: true });
                sseBuffer += chunk;

                // 处理 SSE 消息（以 \n\n 分隔）
                let messageEnd = sseBuffer.indexOf('\n\n');
                while (messageEnd !== -1) {
                    const message = sseBuffer.substring(0, messageEnd);
                    sseBuffer = sseBuffer.substring(messageEnd + 2);

                    // 解析 SSE 消息中的 data: 行
                    const lines = message.split('\n');
                    let dataLine = '';
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            dataLine += line.substring(6);
                        }
                    }

                    if (dataLine) {
                        try {
                            const data = JSON.parse(dataLine);

                            switch (data.type) {
                                case 'batch0_chunk':
                                    // 实时显示 batch0 的题目
                                    batch0Buffer += data.data;
                                    const newQuestions = this.extractCompleteObjects(batch0Buffer);

                                    if (newQuestions.length > displayedCount) {
                                        for (let i = displayedCount; i < newQuestions.length; i++) {
                                            this.renderQuestionStream(newQuestions[i], i, true);
                                        }
                                        displayedCount = newQuestions.length;
                                        this.updateProgress(0, displayedCount);
                                    }
                                    break;

                                case 'batch0_done':
                                    console.log('[DEBUG] Batch 0 done:', data.count);
                                    break;

                                case 'final_result':
                                    // 接收所有批次的最终结果
                                    console.log('[DEBUG] Received final_result');
                                    console.log('[DEBUG] data.data type:', typeof data.data);
                                    console.log('[DEBUG] data.data is array:', Array.isArray(data.data));
                                    console.log('[DEBUG] data.data length:', data.data?.length);
                                    if (data.data && data.data.length > 0) {
                                        console.log('[DEBUG] First question:', data.data[0].question?.substring(0, 50));
                                    }
                                    this.questions = data.data || [];
                                    generatedQuestions = this.questions;
                                    this.partialResult = data.partial || false;
                                    this.generatedCount = data.generatedCount || this.questions.length;
                                    this.requestedCount = data.requestedCount || this.questions.length;
                                    console.log('[DEBUG] generatedQuestions set, length:', generatedQuestions.length);
                                    // 显示 token 消耗数量
                                    if (data.tokenCount) {
                                        console.log(`[DEBUG] Total token count: ${data.tokenCount}`);
                                        console.log(`本次生成共消耗 ${data.tokenCount} 个 token`);
                                    }
                                    // 将结果存储到 batchResults 以便兼容旧代码
                                    this.batchResults.set(0, this.questions.slice(0, 20));
                                    for (let i = 1; i < this.totalBatches; i++) {
                                        this.batchResults.set(i, this.questions.slice(i * 20, (i + 1) * 20));
                                    }
                                    break;

                                case 'done':
                                    console.log('[DEBUG] Received done');
                                    this.updateProgressStep(2, 'completed');
                                    this.showCompletionUI();
                                    break;

                                case 'error':
                                    console.error('[DEBUG] Received error:', data.message);
                                    this.handleError(new Error(data.message));
                                    return;
                            }
                        } catch (e) {
                            console.error('[DEBUG] Error parsing SSE data:', e);
                            console.error('[DEBUG] Data line length:', dataLine.length);
                            console.error('[DEBUG] Data line (first 200 chars):', dataLine.substring(0, 200));
                            // 对于 final_result 之外的消息，继续处理；对于 final_result，可能需要特殊处理
                            if (!dataLine.includes('"type":"final_result"')) {
                                // 不是 final_result，可以忽略解析错误
                            } else {
                                console.error('[DEBUG] final_result parse error, trying to recover...');
                            }
                        }
                    }

                    messageEnd = sseBuffer.indexOf('\n\n');
                }

                // 如果缓冲区太大但没有完整消息，防止内存溢出
                if (sseBuffer.length > 1000000) {
                    console.warn('[DEBUG] SSE buffer too large, clearing');
                    sseBuffer = '';
                }
            }

            // 处理剩余的数据（可能没有 \n\n 结尾）
            if (sseBuffer.trim()) {
                console.log('[DEBUG] Processing remaining SSE buffer');
                const lines = sseBuffer.split('\n');
                let dataLine = '';
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        dataLine += line.substring(6);
                    }
                }
                if (dataLine) {
                    try {
                        const data = JSON.parse(dataLine);
                        if (data.type === 'final_result') {
                            console.log('[DEBUG] Processing final_result from remaining buffer');
                            this.questions = data.data || [];
                            generatedQuestions = this.questions;
                        }
                    } catch (e) {
                        console.error('[DEBUG] Error parsing remaining buffer:', e);
                    }
                }
            }

        } catch (error) {
            this.handleError(error);
        } finally {
            this.isGenerating = false;
            disableRefreshProtection();
        }
    }

    async extractPdfText(file, originalFileName) {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        let text = '';
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            const pageText = content.items.map(item => item.str).join(' ');
            text += `-----[${originalFileName}_page${i}]-----\n${pageText}\n\n`;
        }
        return text;
    }

    async generateAllWithDeepSeek(file, config) {
        const { questionCount, lang, turnstileToken, customPrompt } = config;

        this.isGenerating = true;
        this.questions = [];
        this.batchResults.clear();
        this.totalBatches = Math.ceil(questionCount / 20);

        try {
            this.updateProgressStep(2, 'active');

            const controller = new AbortController();
            this.abortControllers.push(controller);

            const originalFileName = file.name.replace(/\.pdf$/i, '');
            const text = await this.extractPdfText(file, originalFileName);

            const token = localStorage.getItem('auth_token');
            const fallbackForm = new FormData();
            fallbackForm.append('text', text);
            fallbackForm.append('questionCount', questionCount);
            fallbackForm.append('lang', lang);
            fallbackForm.append('originalFileName', originalFileName);
            fallbackForm.append('customPrompt', customPrompt || '');
            fallbackForm.append('turnstileToken', turnstileToken);
            if (Visitor && Visitor.getId()) {
                fallbackForm.append('visitorId', Visitor.getId());
            }

            const response = await fetch(`${API_BASE}/fallback/pdf_generate`, {
                method: 'POST',
                body: fallbackForm,
                signal: controller.signal,
                headers: token ? { 'Authorization': `Bearer ${token}` } : {}
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(translateBackendError(error.error) || t('uploadError'));
            }

            const reader = response.body.getReader();
            let batch0Buffer = '';
            let displayedCount = 0;
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

                    const lines = message.split('\n');
                    let dataLine = '';
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            dataLine += line.substring(6);
                        }
                    }

                    if (dataLine) {
                        try {
                            const data = JSON.parse(dataLine);
                            switch (data.type) {
                                case 'batch0_chunk':
                                    batch0Buffer += data.data;
                                    const newQuestions = this.extractCompleteObjects(batch0Buffer);
                                    if (newQuestions.length > displayedCount) {
                                        for (let i = displayedCount; i < newQuestions.length; i++) {
                                            this.renderQuestionStream(newQuestions[i], i, true);
                                        }
                                        displayedCount = newQuestions.length;
                                        this.updateProgress(0, displayedCount);
                                    }
                                    break;
                                case 'batch0_done':
                                    console.log('[DEBUG] Batch 0 done:', data.count);
                                    break;
                                case 'final_result':
                                    this.questions = data.data || [];
                                    generatedQuestions = this.questions;
                                    this.partialResult = data.partial || false;
                                    this.generatedCount = data.generatedCount || this.questions.length;
                                    this.requestedCount = data.requestedCount || this.questions.length;
                                    this.batchResults.set(0, this.questions.slice(0, 20));
                                    for (let i = 1; i < this.totalBatches; i++) {
                                        this.batchResults.set(i, this.questions.slice(i * 20, (i + 1) * 20));
                                    }
                                    break;
                                case 'done':
                                    this.updateProgressStep(2, 'completed');
                                    this.showCompletionUI();
                                    break;
                                case 'error':
                                    console.error('[DEBUG] Received error:', data.message);
                                    this.handleError(new Error(data.message));
                                    return;
                            }
                        } catch (e) {
                            console.error('[DEBUG] Error parsing SSE data:', e);
                        }
                    }
                    messageEnd = sseBuffer.indexOf('\n\n');
                }
            }

            if (sseBuffer.trim()) {
                const lines = sseBuffer.split('\n');
                let dataLine = '';
                for (const line of lines) {
                    if (line.startsWith('data: ')) dataLine += line.substring(6);
                }
                if (dataLine) {
                    try {
                        const data = JSON.parse(dataLine);
                        if (data.type === 'final_result') {
                            this.questions = data.data || [];
                            generatedQuestions = this.questions;
                        }
                    } catch (e) {
                        console.error('[DEBUG] Error parsing remaining buffer:', e);
                    }
                }
            }

        } catch (error) {
            this.handleError(error);
        } finally {
            this.isGenerating = false;
            disableRefreshProtection();
        }
    }

    // 保留旧方法以兼容（但内部使用新方法）
    async uploadFile(file, turnstileToken = null) {
        // 新的流程中不再需要单独上传，标记为已设置
        this.turnstileToken = turnstileToken;
        return { fileUri: 'unified', fileName: file.name };
    }

    async startGeneration(config) {
        // 新的流程直接使用 generateAll
        console.warn('startGeneration is deprecated, use generateAll instead');
    }

    async cleanupFile() {
        // 新的流程中后端自动清理，无需前端处理
        console.log('Cleanup handled by backend');
    }

    extractCompleteObjects(buffer) {
        const questions = [];
        const regex = /\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g;
        let match;
        
        while ((match = regex.exec(buffer)) !== null) {
            try {
                const obj = JSON.parse(match[0]);
                if (obj.question && obj.options && obj.correctAnswer) {
                    if (!questions.find(q => q.question === obj.question)) {
                        questions.push(obj);
                    }
                }
            } catch (e) {
                // 不完整的对象，跳过
            }
        }
        return questions;
    }

    parseCompleteJSON(buffer) {
        try {
            const arrayMatch = buffer.match(/\[[\s\S]*\]/);
            if (arrayMatch) {
                return JSON.parse(arrayMatch[0]);
            }
            return this.extractCompleteObjects(buffer);
        } catch (e) {
            return this.extractCompleteObjects(buffer);
        }
    }

    buildBatchPrompt(batchIndex, lang) {
        const startId = batchIndex * 20 + 1;
        const endId = startId + 19;
        const langInstruction =
            lang === 'zh' ? '使用中文' :
            lang === 'zh-TW' ? '使用繁體中文' :
            lang === 'ko' ? '한국어를 사용하세요' :
            'Use English';
        const hardcodedFileName = this.originalFileName || 'document';
        
        // 计算当前批次的页码范围
        const startPage = batchIndex * this.pagesPerBatch + 1;
        const endPage = Math.min((batchIndex + 1) * this.pagesPerBatch, this.pageCount);
        
        return `You are an expert exam question creator. Create exactly 20 multiple-choice questions based on the study material in the uploaded PDF file.

CRITICAL REQUIREMENTS:
1. ${langInstruction} ONLY
2. Each question MUST have exactly 4 options: A, B, C, D
3. Include explanation for each correct answer
4. Return ONLY a JSON array. No markdown, no code blocks, no explanations before or after.
5. The response must start with [ and end with ]

6. **CRITICAL - PAGE RANGE REQUIREMENT**:
   This is batch ${batchIndex + 1} of ${this.totalBatches}.
   You MUST ONLY use content from pages ${startPage} to ${endPage} of the PDF.
   - Start page: ${startPage}
   - End page: ${endPage}
   - Do NOT use content from pages outside this range
   - Create questions evenly distributed across these pages

7. **CRITICAL - SOURCE FIELD FORMAT**:
   You MUST use the EXACT format: "-----[${hardcodedFileName}_pageX]-----"
   - X is the page number (between ${startPage} and ${endPage})
   - The filename part MUST be exactly: "${hardcodedFileName}"
   - Example of CORRECT format: "-----[${hardcodedFileName}_page3]-----"
   - Example of INCORRECT format: "[page3]", "${hardcodedFileName}_page3", "page 3"

8. The "id" field MUST start from ${startId} and increment by 1 for each question

9. **CRITICAL - CONTENT REQUIREMENT**:
   - Focus ONLY on the substantive knowledge, concepts, theories, facts, and details within the document content
   - DO NOT create questions about document metadata or basic information such as:
     * Teacher/professor name, instructor information
     * Course name, course code, or course title
     * Syllabus information, course schedule, or assignment deadlines
     * Document title, file name, or page numbers
     * University/institution name, department information
     * Publication dates, version numbers, or copyright information
   - Questions should test understanding of the actual subject matter, not memorization of document headers or administrative details

Required JSON format:
[
  {
    "id": ${startId},
    "question": "question text here",
    "options": {
      "A": "first option",
      "B": "second option", 
      "C": "third option",
      "D": "fourth option"
    },
    "correctAnswer": "A",
    "explanation": "explanation text",
    "source": "-----[${hardcodedFileName}_page3]-----"
  }
]

Generate exactly 20 questions from pages ${startPage}-${endPage}. Use the EXACT source format with the hardcoded filename "${hardcodedFileName}". Output valid JSON only.`;
    }

    mergeAllBatches() {
        this.questions = [];
        let currentId = 1;
        
        for (let i = 0; i < this.totalBatches; i++) {
            const batch = this.batchResults.get(i) || [];
            batch.forEach((q) => {
                q.id = currentId++;
                this.questions.push(q);
            });
        }
        
        generatedQuestions = this.questions;
        console.log(`合并完成：共 ${this.questions.length} 题`);
        return this.questions;
    }

    // ==================== UI 更新方法 ====================
    
    showProgressModal(totalQuestions) {
        const modal = document.getElementById('genProgress');
        if (modal) {
            modal.classList.remove('hidden');
        }
        
        // 重置进度条
        document.getElementById('progressBar').style.width = '0%';
        document.getElementById('questionProgressText').textContent = 
            `0 / ${totalQuestions}`;
        
        // 初始化实时题目显示区域
        const streamingContainer = document.getElementById('streamingQuestions');
        if (streamingContainer) {
            streamingContainer.innerHTML = `
                <div class="flex flex-col items-center justify-center py-8">
                    <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mb-3"></div>
                    <div class="text-center text-slate-400 text-sm">${t('waitingFirstQuestion')}</div>
                </div>
            `;
        }
        
        // 重置步骤显示
        this.resetSteps();
    }

    resetSteps() {
        const step1 = document.getElementById('step1');
        const step2 = document.getElementById('step2');
        
        if (step1) {
            step1.className = 'step-item text-slate-400';
            step1.querySelector('.step-number').textContent = '1';
        }
        if (step2) {
            step2.className = 'step-item text-slate-400';
            step2.querySelector('.step-number').textContent = '2';
        }
    }

    updateProgressStep(stepNumber, status) {
        const step = document.getElementById(`step${stepNumber}`);
        if (!step) return;
        
        const circle = step.querySelector('.step-number');
        
        if (status === 'active') {
            step.className = 'step-item active';
            circle.textContent = stepNumber;
        } else if (status === 'completed') {
            step.className = 'step-item completed';
            circle.innerHTML = '✓';
        }
    }

    updateProgress(batchIndex, count) {
        const totalCount = this.totalBatches * 20;
        const currentCount = batchIndex * 20 + count;
        const percent = Math.min((currentCount / totalCount) * 100, 99);
        
        document.getElementById('progressBar').style.width = `${percent}%`;
        document.getElementById('questionProgressText').textContent = 
            `${currentCount} / ${totalCount}`;
    }

    updateTotalProgress() {
        const completed = Array.from(this.batchResults.values())
            .reduce((sum, arr) => sum + (arr?.length || 0), 0);
        this.updateProgress(0, completed);
    }

    renderQuestionStream(question, index, isBatch0 = false) {
        // batch0 实时显示在进度弹窗的 streamingQuestions 区域 - 仅显示题目问题
        if (isBatch0) {
            const streamingContainer = document.getElementById('streamingQuestions');
            if (streamingContainer) {
                // 如果是第一道题，清空等待提示
                if (index === 0) {
                    streamingContainer.innerHTML = '';
                }
                
                const item = document.createElement('div');
                item.className = 'py-2 px-3 bg-white rounded border-l-4 border-indigo-500 slide-in';
                item.style.animationDelay = `${index * 0.05}s`;
                
                item.innerHTML = `
                    <div class="text-sm text-slate-700">
                        <span class="font-medium text-indigo-600 mr-2">${question.id || index + 1}.</span>
                        ${escapeHtml(question.question)}
                    </div>
                `;
                
                streamingContainer.appendChild(item);
                streamingContainer.scrollTop = streamingContainer.scrollHeight;
            }
        }
        
        // 同时渲染到最终结果预览区域（完整信息）
        const container = document.getElementById('resultPreview');
        if (!container) return;

        const card = document.createElement('div');
        card.className = 'border border-slate-200 rounded-lg p-4 bg-slate-50 slide-in';
        card.style.animationDelay = `${index * 0.05}s`;
        
        const sourceInfo = question.source 
            ? `<div class="text-xs text-indigo-600 mt-1">📄 ${question.source}</div>` 
            : '';

        card.innerHTML = `
            <div class="font-medium text-slate-900 mb-2">Q${question.id || index + 1}: ${escapeHtml(question.question)}</div>
            <div class="space-y-1 text-sm text-slate-600 mb-2">
                ${Object.entries(question.options).map(([k, v]) => 
                    `<div class="${question.correctAnswer === k ? 'text-emerald-600 font-medium' : ''}">${k}. ${escapeHtml(v)}</div>`
                ).join('')}
            </div>
            <div class="text-sm text-emerald-600 font-medium">Answer: ${question.correctAnswer}</div>
            ${question.explanation ? `<div class="text-xs text-slate-500 mt-1">${escapeHtml(question.explanation)}</div>` : ''}
            ${sourceInfo}
        `;
        
        container.appendChild(card);
        container.scrollTop = container.scrollHeight;
    }

    showCompletionUI() {
        setTimeout(() => {
            const modal = document.getElementById('genProgress');
            if (modal) modal.classList.add('hidden');
            
            const resultModal = document.getElementById('resultModal');
            if (resultModal) resultModal.classList.remove('hidden');
            
            // 显示总题数提示
            const totalHint = document.getElementById('totalQuestionsHint');
            if (totalHint) {
                const totalCount = this.questions.length;
                if (totalCount > 20) {
                    totalHint.textContent = t('totalQuestionsHint', totalCount);
                    totalHint.classList.remove('hidden');
                } else {
                    totalHint.classList.add('hidden');
                }
            }
            
            // 题目数量不足提示（5秒）
            if (this.partialResult) {
                const partialMsg = t('partialGenerationNotice', this.generatedCount);
                showToast(partialMsg, 'warning', 5000);
            } else {
                showToast(t('completed'), 'success');
            }
        }, 500);
    }

    handleError(error) {
        console.error('Generation error:', error);
        this.abortControllers.forEach(ctrl => ctrl.abort());
        
        const modal = document.getElementById('genProgress');
        if (modal) modal.classList.add('hidden');
        
        // 尝试解析 Google API 错误格式
        const googleError = parseGoogleApiError(error.message);
        if (googleError) {
            showErrorModal(googleError.code, googleError.status, googleError.message);
        } else {
            showToast(translateBackendError(error.message), 'error');
        }
    }

    async cleanupFile() {
        if (!this.fileUri) return;
        try {
            await fetch(`${API_BASE}/cleanup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileUri: this.fileUri })
            });
        } catch (err) {
            console.error('Cleanup error:', err);
        }
    }
}

// ==================== 文件处理函数 ====================
function setupDropZone() {
    const dropZone = document.getElementById('dropZone');
    const input = document.getElementById('fileInput');
    
    if (!dropZone || !input) return;
    
    dropZone.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        input.click();
    });
    
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('dragover');
    });
    
    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('dragover');
    });
    
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            handleFiles(e.dataTransfer.files);
        }
    });
    
    input.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFiles(e.target.files);
        }
    });
}

async function handleFiles(files) {
    currentFiles = Array.from(files).slice(0, 1);
    
    const file = currentFiles[0];
    const ext = file.name.split('.').pop().toLowerCase();
    
    // 支持的非PDF格式
    const officeExts = ['docx', 'pptx', 'xlsx', 'xls', 'txt'];
    
    if (ext !== 'pdf' && officeExts.includes(ext)) {
        // 使用 document-converter.js 将 Office 文件转换为 PDF
        try {
            await handleOfficeFile(file);
        } catch (err) {
            console.error('Office conversion error:', err);
            showToast(t('parseError') + ': ' + err.message, 'error');
        }
        return;
    }
    
    await handlePdfFile(file);
}

// 用于存储转换后的 PDF Blob
let convertedPdfBlob = null;
let originalFileName = '';

async function handleOfficeFile(file) {
    const fileList = document.getElementById('fileList');
    if (!fileList) return;
    
    fileList.innerHTML = '';
    fileList.classList.remove('hidden');
    
    // 显示 Office 文件预览提示
    const previewNote = document.getElementById('previewNote');
    if (previewNote) {
        previewNote.textContent = t('officePreviewNote');
        previewNote.classList.remove('hidden');
    }
    
    originalFileName = file.name;
    
    // 显示文件信息（显示转换中状态）
    const div = document.createElement('div');
    div.id = 'officeFileItem';
    div.className = 'flex items-center justify-between bg-slate-50 p-3 rounded-lg border border-slate-200';
    div.innerHTML = `
        <div class="flex items-center overflow-hidden">
            <svg class="w-5 h-5 text-slate-400 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
            <span class="text-sm text-slate-700 truncate">${file.name}</span>
            <span class="text-xs text-slate-400 ml-2 flex-shrink-0">${(file.size/1024/1024).toFixed(2)}MB</span>
            <span id="conversionStatus" class="text-xs text-indigo-600 ml-2 flex-shrink-0">(${t('converting')})</span>
        </div>
        <button onclick="removeFile(0)" class="text-red-500 hover:text-red-700 ml-2">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
        </button>
    `;
    fileList.appendChild(div);
    
    let statusEl = document.getElementById('conversionStatus');
    
    try {
        // 使用 document-converter.js 转换文件
        const converter = new DocumentConverter({
            onProgress: (current, total, status) => {
                console.log(`Conversion progress: ${current}/${total} - ${status}`);
            }
        });
        
        // 先加载中文字体
        if (statusEl) statusEl.textContent = `(${t('loadingFont')})`;
        await converter.loadFont();
        
        if (!converter.isFontLoaded || !converter.fontBytes) {
            throw new Error('字体加载失败，无法转换中文内容');
        }
        
        if (statusEl) statusEl.textContent = `(${t('converting')})`;
        
        // 转换文件
        convertedPdfBlob = await converter.convert(file, { download: false });
        
        // 调试模式：下载转换后的 PDF
        const isDebugMode = new URLSearchParams(window.location.search).get('debug') === '1' || 
                           localStorage.getItem('debugPdf') === 'true';
        if (isDebugMode && convertedPdfBlob) {
            const debugFileName = file.name.replace(/\.[^/.]+$/, '_converted.pdf');
            const url = URL.createObjectURL(convertedPdfBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = debugFileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            console.log('[DEBUG] PDF downloaded:', debugFileName);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        if (statusEl) {
            statusEl.textContent = `(${t('convertedToPDF')})`;
            statusEl.className = 'text-xs text-emerald-600 ml-2 flex-shrink-0';
        }
        
        // 创建 File 对象
        const pdfFileName = file.name.replace(/\.[^/.]+$/, '.pdf');
        const pdfFile = new File([convertedPdfBlob], pdfFileName, { type: 'application/pdf' });
        
        // 替换 currentFiles 中的文件
        currentFiles[0] = pdfFile;
        
        // 像处理普通 PDF 一样处理：添加页码标记并保存
        // 使用 iframe 原生渲染，即使 ToUnicode CMap 被破坏也能正确显示
        await processPdfWithPageMarkers(pdfFile, true);
        
        const genBtn = document.getElementById('genBtn');
        if (genBtn) genBtn.disabled = false;
        
    } catch (err) {
        console.error('Office conversion error:', err);
        if (statusEl) {
            statusEl.textContent = '(转换失败)';
            statusEl.className = 'text-xs text-red-600 ml-2 flex-shrink-0';
        }
        throw err;
    }
}

async function handlePdfFile(file) {
    const fileList = document.getElementById('fileList');
    if (!fileList) return;
    
    fileList.innerHTML = '';
    fileList.classList.remove('hidden');
    
    // 显示 PDF 预览提示
    const previewNote = document.getElementById('previewNote');
    if (previewNote) {
        previewNote.textContent = t('pdfPreviewNote');
        previewNote.classList.remove('hidden');
    }
    
    currentFiles.forEach((file, index) => {
        const div = document.createElement('div');
        div.className = 'flex items-center justify-between bg-slate-50 p-3 rounded-lg border border-slate-200';
        div.innerHTML = `
            <div class="flex items-center overflow-hidden">
                <svg class="w-5 h-5 text-slate-400 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
                <span class="text-sm text-slate-700 truncate">${file.name}</span>
                <span class="text-xs text-slate-400 ml-2 flex-shrink-0">${(file.size/1024/1024).toFixed(2)}MB</span>
            </div>
            <button onclick="removeFile(${index})" class="text-red-500 hover:text-red-700 ml-2">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                </svg>
            </button>
        `;
        fileList.appendChild(div);
    });

    try {
        await processPdfWithPageMarkers(file);
        const genBtn = document.getElementById('genBtn');
        if (genBtn) genBtn.disabled = false;
    } catch (err) {
        console.error('PDF processing error:', err);
        showToast(t('parseError') + ': ' + err.message, 'error');
    }
}

// 生成随机文件名（纯字母数字，用于PDF页码标记）
function generateRandomFileName() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = 'doc_';
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

async function processPdfWithPageMarkers(file, isConverted = false) {
    const preview = document.getElementById('pdfPreview');
    if (!preview) return;
    
    preview.innerHTML = `<div class="flex items-center justify-center h-full"><div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mr-3"></div><span>${t('processingPdf')}</span></div>`;
    
    const arrayBuffer = await file.arrayBuffer();
    
    const { PDFDocument, rgb, StandardFonts } = PDFLib;
    const pdfDoc = await PDFDocument.load(arrayBuffer);
    const pages = pdfDoc.getPages();
    const helveticaFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    // 生成随机文件名用于页码标记（避免中文编码问题）
    const markerFileName = generateRandomFileName();
    // 保存原始文件名用于显示
    const originalFileName = file.name.replace(/\.pdf$/i, '');
    
    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const { width, height } = page.getSize();
        const markerText = `-----[${markerFileName}_page${i + 1}]-----`;
        const fontSize = 6; // 小字号，不易察觉
        const textWidth = helveticaFont.widthOfTextAtSize(markerText, fontSize);
        
        // 放在右下角角落，尽可能不显眼
        const margin = 5;
        const x = width - textWidth - margin;
        const y = margin; // 底部边缘
        
        // 白色文字，无背景，无边框，给AI看而不是给人看
        page.drawText(markerText, {
            x: x,
            y: y,
            size: fontSize,
            font: helveticaFont,
            color: rgb(1, 1, 1), // 白色
        });
    }
    
    processedPdfBytes = await pdfDoc.save();
    processedFileName = file.name;
    processedPageCount = pages.length;
    
    await db.sourceFiles.where('name').equals(file.name).delete();
    await db.sourceFiles.add({
        name: file.name,
        fileName: originalFileName, // 存储原始文件名（不含扩展名）
        markerFileName: markerFileName, // 存储用于页码标记的随机文件名
        bankId: null,
        data: processedPdfBytes,
        type: 'application/pdf',
        isConverted,
        createdAt: new Date().toISOString()
    });
    
    await renderPdfPreview(processedPdfBytes);
    
    const pageStats = document.getElementById('pageStats');
    if (pageStats) pageStats.textContent = `${pages.length} pages`;
}

async function renderPdfPreview(pdfBytes) {
    const preview = document.getElementById('pdfPreview');
    if (!preview) return;
    
    preview.innerHTML = '';
    
    // 使用 iframe 让浏览器原生 PDF 引擎渲染
    // 浏览器内置引擎（Chrome PDFium/Firefox PDF.js 内置版）能正确解析嵌入字体
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    
    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.style.width = '100%';
    iframe.style.height = '580px';
    iframe.style.border = 'none';
    iframe.style.borderRadius = '8px';
    
    preview.appendChild(iframe);
    
    // 清理 URL 对象（iframe 加载完成后）
    iframe.onload = () => {
        // 延迟清理，确保资源已加载
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
}

async function removeFile(index) {
    const removedFile = currentFiles[index];
    currentFiles.splice(index, 1);
    
    if (removedFile) {
        try {
            await db.sourceFiles.where('name').equals(removedFile.name).delete();
        } catch (err) {
            console.error('Failed to remove cached file:', err);
        }
    }
    
    if (currentFiles.length === 0) {
        const fileList = document.getElementById('fileList');
        if (fileList) fileList.classList.add('hidden');
        
        const pdfPreview = document.getElementById('pdfPreview');
        if (pdfPreview) {
            pdfPreview.innerHTML = `<div class="flex items-center justify-center h-full text-slate-400 py-20">${t('waitingUpload')}</div>`;
        }
        
        // 隐藏预览提示
        const previewNote = document.getElementById('previewNote');
        if (previewNote) previewNote.classList.add('hidden');
        
        processedPdfBytes = null;
        processedFileName = '';
        processedPageCount = 0;
        convertedPdfBlob = null;
        originalFileName = '';
        
        const genBtn = document.getElementById('genBtn');
        if (genBtn) genBtn.disabled = true;
        
        const pageStats = document.getElementById('pageStats');
        if (pageStats) pageStats.textContent = '';
    } else {
        await handleFiles(currentFiles);
    }
}

// ==================== 生成控制 ====================
async function startGeneration() {
    if (!processedPdfBytes || currentFiles.length === 0) {
        showToast(t('fillRequired'), 'error');
        return;
    }

    // 获取 Turnstile token
    const turnstileToken = typeof turnstile !== 'undefined' ? turnstile.getResponse() : null;
    if (!turnstileToken) {
        showToast('请先完成人机验证 / Please complete the CAPTCHA', 'error');
        return;
    }

    const totalCount = parseInt(document.getElementById('questionCount')?.value) || 20;
    const lang = document.getElementById('genLangValue')?.value || 'zh';
    const mode = document.getElementById('genModeValue')?.value || 'multimodal';
    const customPrompt = document.getElementById('customPrompt')?.value.trim() || '';
    
    // 自定义提示词长度限制（100 Unicode 字符）
    if (customPrompt.length > 100) {
        showToast(t('customPromptTooLong'), 'error');
        return;
    }
    
    const resultPreview = document.getElementById('resultPreview');
    if (resultPreview) resultPreview.innerHTML = '';
    
    const baseName = processedFileName.replace(/\.pdf$/i, '');
    // 使用原始文件名，不再进行safeName处理
    const originalFileName = baseName;
    
    streamingGenerator = new StreamingQuestionGenerator();
    streamingGenerator.setOriginalFileName(originalFileName);
    streamingGenerator.setPageCount(processedPageCount);
    
    // 立即启用刷新保护并显示进度框
    enableRefreshProtection();
    streamingGenerator.showProgressModal(totalCount);
    streamingGenerator.updateProgressStep(1, 'active');
    
    try {
        // 使用新的统一接口，一次性完成上传、生成和清理
        // 步骤1和步骤2合并
        streamingGenerator.updateProgressStep(1, 'completed');
        streamingGenerator.updateProgressStep(2, 'active');
        
        if (mode === 'text') {
            await streamingGenerator.generateAllWithDeepSeek(currentFiles[0], {
                questionCount: totalCount,
                lang: lang,
                turnstileToken: turnstileToken,
                customPrompt: customPrompt
            });
        } else {
            await streamingGenerator.generateAll(currentFiles[0], {
                questionCount: totalCount,
                lang: lang,
                turnstileToken: turnstileToken,
                customPrompt: customPrompt
            });
        }
        
    } catch (err) {
        console.error('Generation error:', err);
        showToast(translateBackendError(err.message), 'error');
        const modal = document.getElementById('genProgress');
        if (modal) modal.classList.add('hidden');
        disableRefreshProtection();
    }
}

function discardResult() {
    if (confirm(t('discardConfirm'))) {
        generatedQuestions = [];
        const modal = document.getElementById('resultModal');
        if (modal) modal.classList.add('hidden');
        showToast('Discarded', 'success');
    }
}

async function saveAndPractice() {
    console.log('[DEBUG] saveAndPractice called');
    console.log('[DEBUG] generatedQuestions:', generatedQuestions);
    console.log('[DEBUG] generatedQuestions type:', typeof generatedQuestions);
    console.log('[DEBUG] generatedQuestions is array:', Array.isArray(generatedQuestions));
    console.log('[DEBUG] generatedQuestions length:', generatedQuestions?.length);
    if (!generatedQuestions || generatedQuestions.length === 0) {
        showToast('No questions to save', 'error');
        return;
    }
    
    const name = prompt(
        currentLang === 'zh' ? '请输入题库名称:' : 
        currentLang === 'zh-TW' ? '請輸入題庫名稱:' : 
        currentLang === 'ko' ? '문제은행 이름을 입력하세요:' :
        'Enter question bank name:', 
        processedFileName.replace(/\.pdf$/i, '') || 'New Bank'
    );
    
    if (!name) return;
    
    const bank = {
        name: name,
        questions: generatedQuestions,
        favorites: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    
    try {
        const id = await db.questionBanks.add(bank);
        
        if (processedFileName) {
            await db.sourceFiles.where('name').equals(processedFileName).modify({ bankId: id });
        }
        
        const modal = document.getElementById('resultModal');
        if (modal) modal.classList.add('hidden');
        
        showToast(t('saveSuccess'), 'success');
        
        // 跳转到练习页面
        window.location.href = `practice.html?id=${id}`;
    } catch (err) {
        console.error('Save error:', err);
        showToast('Save failed: ' + err.message, 'error');
    }
}



// ==================== 工具函数 ====================
function enableRefreshProtection() {
    preventRefresh = true;
    window.addEventListener('beforeunload', handleBeforeUnload);
    // 播放音频保持页面活跃
    if (!window._genAudio) window._genAudio = new Audio('resources/audio.mp3');
    window._genAudio.loop = true;
    window._genAudio.play().catch(() => {});
}

function disableRefreshProtection() {
    preventRefresh = false;
    window.removeEventListener('beforeunload', handleBeforeUnload);
    // 停止音频
    if (window._genAudio) {
        window._genAudio.pause();
        window._genAudio.currentTime = 0;
    }
}

function handleBeforeUnload(e) {
    if (preventRefresh) {
        e.preventDefault();
        e.returnValue = '';
        return '';
    }
}

function showToast(message, type = 'success', duration = 3000) {
    const toast = document.getElementById('toast');
    const icon = document.getElementById('toastIcon');
    const msg = document.getElementById('toastMessage');
    
    if (!toast || !icon || !msg) return;
    
    msg.textContent = message;
    
    if (type === 'error') {
        icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>';
        toast.querySelector('div').className = 'bg-red-600 text-white px-6 py-3 rounded-lg shadow-lg flex items-center';
    } else if (type === 'warning') {
        icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>';
        toast.querySelector('div').className = 'bg-amber-500 text-white px-6 py-3 rounded-lg shadow-lg flex items-center';
    } else {
        icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>';
        toast.querySelector('div').className = 'bg-slate-800 text-white px-6 py-3 rounded-lg shadow-lg flex items-center';
    }
    
    toast.classList.remove('translate-y-20', 'opacity-0');
    
    setTimeout(() => {
        toast.classList.add('translate-y-20', 'opacity-0');
    }, duration);
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function parseGoogleApiError(message) {
    if (!message) return null;
    try {
        const errorIdx = message.indexOf('"error"');
        if (errorIdx === -1) return null;
        const bracketStart = message.lastIndexOf('[', errorIdx);
        const bracketEnd = message.indexOf(']', errorIdx);
        if (bracketStart !== -1 && bracketEnd !== -1 && bracketEnd > bracketStart) {
            const jsonStr = message.substring(bracketStart, bracketEnd + 1);
            const parsed = JSON.parse(jsonStr);
            if (Array.isArray(parsed) && parsed[0] && parsed[0].error) {
                return parsed[0].error;
            }
        }
    } catch (e) {
        // ignore parsing errors
    }
    return null;
}

function showErrorModal(code, status, message) {
    const modal = document.getElementById('errorModal');
    const content = document.getElementById('errorModalContent');
    if (!modal || !content) return;
    
    content.innerHTML = `
        <p><span class="font-semibold text-slate-800">错误码：</span>${escapeHtml(String(code))}</p>
        <p><span class="font-semibold text-slate-800">状态：</span>${escapeHtml(status)}</p>
        <p><span class="font-semibold text-slate-800">信息：</span>${escapeHtml(message)}</p>
    `;
    modal.classList.remove('hidden');
}

function closeErrorModal() {
    const modal = document.getElementById('errorModal');
    if (modal) modal.classList.add('hidden');
}

// ==================== 捐款横幅控制 ====================
function closeDonateBanner() {
    const banner = document.getElementById('donateBanner');
    if (banner) {
        banner.style.display = 'none';
    }
}

// ==================== 全局暴露 ====================
window.toggleLangDropdown = toggleLangDropdown;
window.changeLanguage = changeLanguage;
window.removeFile = removeFile;
window.startGeneration = startGeneration;
window.discardResult = discardResult;
window.saveAndPractice = saveAndPractice;
window.closeDonateBanner = closeDonateBanner;
window.setupDropZone = setupDropZone;
window.handleFiles = handleFiles;
window.handleOfficeFile = handleOfficeFile;
window.handlePdfFile = handlePdfFile;
window.i18n = i18n;
window.currentLang = currentLang;

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
    updateLanguage();
    setupDropZone();
});
