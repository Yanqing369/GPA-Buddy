/**
 * DocGenerate.js - Vertex AI (Gemini) 流式题库生成前端
 */

const API_BASE = "https://moyuxiaowu.org";
const DB_NAME = 'ExamBuddyDB_Clean_v2';

// ==================== 数据库初始化 ====================
const db = new Dexie(DB_NAME);
db.version(5).stores({
    questionBanks: '++id, name, createdAt, updatedAt',
    practiceProgress: '++id, bankId, lastPracticeAt',
    sourceFiles: '++id, name, safeName, bankId, data, createdAt',
    settings: 'key'
});

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
        dropText: '拖拽文件到此处，或点击上传',
        supportFormats: '支持 PDF、Word(DOCX)、PPT(PPTX)、Excel(XLSX/XLS)、TXT 格式',
        textExtractionNotice: '📄 PPT/DOCX/XLSX 文件将自动提取文本生成题目',
        configTitle: '生成配置',
        questionCount: '题目数量',
        language: '生成语言',
        langZH: '中文',
        langEN: 'English',
        startGenerate: '开始生成',
        captchaLabel: '人机验证',
        pdfPreviewNote: 'PDF中的图表都将被读取',
        officePreviewNote: 'Office文件将只有文字可以被读取',
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
        pageTitle: '从资料生成 - GPA4.0',
        toastSuccess: '操作成功',
        streamingStatus: '实时生成中...',
        batchProgress: '批次 {0}/{1}: 已生成 {2} 题',
        stepUploading: '上传文件',
        stepGeneratingQuestions: 'AI生成题目',
        streamingPreview: '实时预览',
        waitingFirstQuestion: '等待第一道题...',
        totalQuestionsHint: '以上仅显示前20题预览，共生成 {0} 题',
        generateCostText: '生成一次题库的成本约为 0.5 元，如果本网站对你有帮助，欢迎捐款支持',
        donate: '捐款',
        donateBannerText: '生成一次题库的成本约为 0.5 元，如果本网站对你有帮助，可以捐款支持我们',
        supportUs: '支持我们'
    },
    'zh-TW': {
        appName: '請出題',
        back: '返回',
        generateHeader: '從資料生成題庫',
        dropText: '拖曳PDF檔案到此處，或點擊上傳',
        supportFormats: '支援 PDF、Word(DOCX)、PPT(PPTX)、Excel(XLSX/XLS)、TXT 格式',
        textExtractionNotice: '📄 PPT/DOCX/XLSX 檔案將自動提取文本生成題目',
        configTitle: '生成設定',
        questionCount: '題目數量',
        language: '生成語言',
        langZH: '中文',
        langEN: 'English',
        startGenerate: '開始生成',
        captchaLabel: '人機驗證',
        pdfPreviewNote: 'PDF中的圖表都將被讀取',
        officePreviewNote: 'Office文件將只有文字可以被讀取',
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
        pageTitle: '從資料生成 - GPA4.0',
        toastSuccess: '操作成功',
        streamingStatus: '實時生成中...',
        batchProgress: '批次 {0}/{1}: 已生成 {2} 題',
        stepUploading: '上傳檔案',
        stepGeneratingQuestions: 'AI生成題目',
        streamingPreview: '實時預覽',
        waitingFirstQuestion: '等待第一道題...',
        totalQuestionsHint: '以上僅顯示前20題預覽，共生成 {0} 題',
        generateCostText: '生成一次題庫的成本約為 0.5 港幣，如果本網站對你有幫助，歡迎捐款支持',
        donate: '捐款',
        donateBannerText: '生成一次題庫的成本約為 0.5 港幣，如果本網站對你有幫助，可以捐款支持我們',
        supportUs: '支持我們'
    },
    en: {
        appName: 'GPA Buddy',
        back: 'Back',
        generateHeader: 'Generate from Material',
        dropText: 'Drop files here or click to upload',
        supportFormats: 'Supports PDF, Word(DOCX), PPT(PPTX), Excel(XLSX/XLS), TXT formats',
        textExtractionNotice: '📄 PPT/DOCX/XLSX files will be converted to text for question generation',
        configTitle: 'Generation Config',
        questionCount: 'Question Count',
        language: 'Language',
        langZH: 'Chinese',
        langEN: 'English',
        startGenerate: 'Start Generation',
        captchaLabel: 'Human Verification',
        pdfPreviewNote: 'Charts and images in PDF will be read',
        officePreviewNote: 'Only text will be extracted from Office files',
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
        pageTitle: 'Generate from Material - GPA4.0',
        toastSuccess: 'Operation successful',
        streamingStatus: 'Streaming generation...',
        batchProgress: 'Batch {0}/{1}: {2} questions generated',
        stepUploading: 'Uploading File',
        stepGeneratingQuestions: 'AI Generating',
        streamingPreview: 'Live Preview',
        waitingFirstQuestion: 'Waiting for first question...',
        totalQuestionsHint: 'Showing first 20 questions preview, {0} questions generated in total',
        generateCostText: 'Each question bank generation costs about 0.5 HKD. If this site helps you, please consider donating.',
        donate: 'Donate',
        donateBannerText: 'Each generation costs 0.5 HKD. If this site helps you, please consider donating to support us.',
        supportUs: 'Support Us'
    },
    ko: {
        appName: '문제은행 도우미',
        back: '돌아가기',
        generateHeader: '자료에서 문제은행 생성',
        dropText: '파일을 여기로 끌어다 놓거나 클릭하여 업로드',
        supportFormats: 'PDF, Word(DOCX), PPT(PPTX), Excel(XLSX/XLS), TXT 형식 지원',
        textExtractionNotice: '📄 PPT/DOCX/XLSX 파일은 텍스트 추출 후 문제가 생성됩니다',
        configTitle: '생성 설정',
        questionCount: '문제 수량',
        language: '생성 언어',
        langZH: '중국어',
        langEN: '영어',
        startGenerate: '생성 시작',
        captchaLabel: '보안 인증',
        pdfPreviewNote: 'PDF의 차트와 이미지가 모두 읽힙니다',
        officePreviewNote: 'Office 파일에서는 텍스트만 추출됩니다',
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
        pageTitle: '자료에서 생성 - GPA4.0',
        toastSuccess: '작업 성공',
        streamingStatus: '실시간 생성 중...',
        batchProgress: '배치 {0}/{1}: {2}개 문제 생성됨',
        stepUploading: '파일 업로드',
        stepGeneratingQuestions: 'AI 문제 생성',
        streamingPreview: '실시간 미리보기',
        waitingFirstQuestion: '첫 번째 문제 대기 중...',
        totalQuestionsHint: '처음 20문제 미리보기, 총 {0}문제 생성됨',
        generateCostText: '문제은행 생성 1회 비용은 약 0.5 HKD입니다. 이 사이트가 도움이 된다면 기부를 고려해 주세요.',
        donate: '기부',
        donateBannerText: '생성 1회 비용은 약 0.5 HKD입니다. 이 사이트가 도움이 된다면 기부로 후원해 주세요.',
        supportUs: '후원하기'
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
    const langDisplay = document.getElementById('currentLangDisplay');
    if (langDisplay) {
        langDisplay.textContent = currentLang === 'zh' ? '简' : 
                                   currentLang === 'zh-TW' ? '繁' : 
                                   currentLang === 'ko' ? '한' : 'En';
    }
}

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

window.onclick = function(event) {
    if (!event.target.closest('.lang-dropdown')) {
        const dropdown = document.getElementById('langDropdown');
        if (dropdown && !dropdown.classList.contains('hidden')) {
            dropdown.classList.add('hidden');
        }
    }
};

// ==================== 流式生成器类 ====================
class StreamingQuestionGenerator {
    constructor() {
        this.fileUri = null;
        this.fileName = null;
        this.safeFileName = null;
        this.pageCount = 0;
        this.isGenerating = false;
        this.questions = [];
        this.batchResults = new Map();
        this.currentBatch = 0;
        this.totalBatches = 0;
        this.decoder = new TextDecoder();
        this.abortControllers = [];
    }

    setSafeFileName(safeFileName) {
        this.safeFileName = safeFileName;
    }

    setPageCount(count) {
        this.pageCount = count;
    }

    setTurnstileToken(token) {
        this.turnstileToken = token;
    }

    async uploadFile(file, turnstileToken = null) {
        const formData = new FormData();
        formData.append('file', file);

        const url = turnstileToken 
            ? `${API_BASE}/upload?turnstileToken=${encodeURIComponent(turnstileToken)}`
            : `${API_BASE}/upload`;

        const response = await fetch(url, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || t('uploadError'));
        }

        const data = await response.json();
        this.fileUri = data.fileUri;
        this.fileName = data.fileName;
        return data;
    }

    async startGeneration(config) {
        const { totalQuestions, lang } = config;
        
        if (!this.fileUri) {
            throw new Error(t('fillRequired'));
        }

        this.isGenerating = true;
        this.questions = [];
        this.batchResults.clear();
        this.totalBatches = Math.ceil(totalQuestions / 20);
        this.currentBatch = 0;
        this.abortControllers = [];

        // 计算每批的页码范围
        this.pagesPerBatch = this.pageCount > 0 
            ? Math.ceil(this.pageCount / this.totalBatches) 
            : 20;

        try {
            this.updateProgressStep(2, 'active');
            
            await this.streamBatch(0, lang);
            
            if (this.totalBatches > 1) {
                const batchPromises = [];
                for (let i = 1; i < this.totalBatches; i++) {
                    batchPromises.push(this.silentBatch(i, lang));
                }
                await Promise.allSettled(batchPromises);
            }

            this.mergeAllBatches();
            this.updateProgressStep(2, 'completed');
            this.showCompletionUI();
            
        } catch (error) {
            this.handleError(error);
        } finally {
            this.isGenerating = false;
            disableRefreshProtection();
            await this.cleanupFile();
        }
    }

    async streamBatch(batchIndex, lang) {
        const batchPrompt = this.buildBatchPrompt(batchIndex, lang);
        const controller = new AbortController();
        this.abortControllers.push(controller);
        
        const response = await fetch(`${API_BASE}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fileUris: [this.fileUri],
                prompt: batchPrompt,
                batchIndex: batchIndex,
                totalBatches: this.totalBatches
            }),
            signal: controller.signal
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || `Batch ${batchIndex} failed`);
        }

        const reader = response.body.getReader();
        let jsonBuffer = '';
        let displayedCount = 0;
        let isDone = false;

        try {
            while (!isDone) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = this.decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');
                
                for (const line of lines) {
                    if (!line.trim() || !line.startsWith('data: ')) continue;
                    
                    try {
                        const data = JSON.parse(line.replace('data: ', ''));
                        
                        if (data.type === 'chunk') {
                            jsonBuffer += data.data;
                            const newQuestions = this.extractCompleteObjects(jsonBuffer);
                            
                            if (newQuestions.length > displayedCount) {
                                for (let i = displayedCount; i < newQuestions.length; i++) {
                                    this.renderQuestionStream(newQuestions[i], i, batchIndex === 0);
                                }
                                displayedCount = newQuestions.length;
                                this.updateProgress(batchIndex, displayedCount);
                            }
                        } else if (data.type === 'error') {
                            throw new Error(data.message);
                        } else if (data.type === 'done') {
                            isDone = true;
                            const finalQuestions = this.parseCompleteJSON(jsonBuffer);
                            this.batchResults.set(batchIndex, finalQuestions);
                        }
                    } catch (e) {
                        if (e.message.includes('JSON')) continue;
                        throw e;
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
    }

    async silentBatch(batchIndex, lang) {
        try {
            const batchPrompt = this.buildBatchPrompt(batchIndex, lang);
            const controller = new AbortController();
            this.abortControllers.push(controller);
            
            const response = await fetch(`${API_BASE}/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fileUris: [this.fileUri],
                    prompt: batchPrompt,
                    batchIndex: batchIndex,
                    totalBatches: this.totalBatches
                }),
                signal: controller.signal
            });

            if (!response.ok) throw new Error(`Batch ${batchIndex} failed`);

            const reader = response.body.getReader();
            let buffer = '';
            let isDone = false;
            
            while (!isDone) {
                const { done, value } = await reader.read();
                if (done) break;
                
                const chunk = this.decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');
                
                for (const line of lines) {
                    if (!line.trim() || !line.startsWith('data: ')) continue;
                    
                    try {
                        const data = JSON.parse(line.replace('data: ', ''));
                        if (data.type === 'chunk') {
                            buffer += data.data;
                        } else if (data.type === 'done') {
                            isDone = true;
                        } else if (data.type === 'error') {
                            throw new Error(data.message);
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }

            const questions = this.parseCompleteJSON(buffer);
            this.batchResults.set(batchIndex, questions);
            this.updateTotalProgress();
            
        } catch (error) {
            console.error(`Silent batch ${batchIndex} error:`, error);
            this.batchResults.set(batchIndex, []);
        }
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
        const langInstruction = lang === 'zh' ? '使用中文' : 'Use English';
        const hardcodedFileName = this.safeFileName || 'document';
        
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
            streamingContainer.innerHTML = `<div class="text-center text-slate-400 text-sm py-8">${t('waitingFirstQuestion')}</div>`;
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
            
            showToast(t('completed'), 'success');
        }, 500);
    }

    handleError(error) {
        console.error('Generation error:', error);
        this.abortControllers.forEach(ctrl => ctrl.abort());
        
        const modal = document.getElementById('genProgress');
        if (modal) modal.classList.add('hidden');
        
        showToast(error.message, 'error');
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
    
    // 如果是非PDF文件，触发切换事件，让HTML中的脚本加载器处理
    if (ext !== 'pdf') {
        // 触发一个自定义事件，通知HTML加载docgenerate_text.js
        const switchEvent = new CustomEvent('switchToTextHandler', { 
            detail: { file: file, ext: ext } 
        });
        document.dispatchEvent(switchEvent);
        return;
    }
    
    await handlePdfFile(file);
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

async function processPdfWithPageMarkers(file) {
    const preview = document.getElementById('pdfPreview');
    if (!preview) return;
    
    preview.innerHTML = `<div class="flex items-center justify-center h-full"><div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mr-3"></div><span>${t('processingPdf')}</span></div>`;
    
    const arrayBuffer = await file.arrayBuffer();
    
    const { PDFDocument, rgb, StandardFonts } = PDFLib;
    const pdfDoc = await PDFDocument.load(arrayBuffer);
    const pages = pdfDoc.getPages();
    const helveticaFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    const baseName = file.name.replace(/\.pdf$/i, '');
    const safeFileName = baseName.replace(/[^a-zA-Z0-9\-_]/g, '_');
    
    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const { width, height } = page.getSize();
        const markerText = `-----[${safeFileName}_page${i + 1}]-----`;
        const fontSize = 12;
        const textWidth = helveticaFont.widthOfTextAtSize(markerText, fontSize);
        
        const padding = 10;
        const rectX = (width - textWidth) / 2 - padding;
        const rectY = height - 30;
        const rectWidth = textWidth + padding * 2;
        const rectHeight = fontSize + 6;
        
        page.drawRectangle({
            x: rectX,
            y: rectY - 2,
            width: rectWidth,
            height: rectHeight,
            color: rgb(1, 1, 1),
        });
        
        page.drawRectangle({
            x: rectX,
            y: rectY - 2,
            width: rectWidth,
            height: rectHeight,
            borderColor: rgb(0, 0, 0),
            borderWidth: 1,
        });
        
        page.drawText(markerText, {
            x: (width - textWidth) / 2,
            y: rectY,
            size: fontSize,
            font: helveticaFont,
            color: rgb(0, 0, 0),
        });
    }
    
    processedPdfBytes = await pdfDoc.save();
    processedFileName = file.name;
    processedPageCount = pages.length;
    
    await db.sourceFiles.where('name').equals(file.name).delete();
    await db.sourceFiles.add({
        name: file.name,
        safeFileName: safeFileName,
        bankId: null,
        data: processedPdfBytes,
        type: 'application/pdf',
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
    
    const pdfData = new Uint8Array(pdfBytes);
    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    const pagesToRender = Math.min(3, pdf.numPages);
    
    for (let i = 1; i <= pagesToRender; i++) {
        const page = await pdf.getPage(i);
        const scale = 0.5;
        const viewport = page.getViewport({ scale });
        
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        canvas.style.maxWidth = '100%';
        canvas.style.height = 'auto';
        
        const pageDiv = document.createElement('div');
        pageDiv.className = 'pdf-page-preview mb-4';
        pageDiv.appendChild(canvas);
        
        const label = document.createElement('div');
        label.className = 'text-center text-xs text-slate-500 mt-1';
        label.textContent = t('pageLabel', i);
        pageDiv.appendChild(label);
        
        preview.appendChild(pageDiv);
        
        await page.render({
            canvasContext: context,
            viewport: viewport
        }).promise;
    }
    
    if (pdf.numPages > 3) {
        const more = document.createElement('div');
        more.className = 'text-center text-slate-500 text-sm py-4';
        more.textContent = `... ${pdf.numPages - 3} more pages ...`;
        preview.appendChild(more);
    }
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
    const lang = document.querySelector('input[name="genLang"]:checked')?.value || 'zh';
    
    const resultPreview = document.getElementById('resultPreview');
    if (resultPreview) resultPreview.innerHTML = '';
    
    const baseName = processedFileName.replace(/\.pdf$/i, '');
    const safeFileName = baseName.replace(/[^a-zA-Z0-9\-_]/g, '_');
    
    streamingGenerator = new StreamingQuestionGenerator();
    streamingGenerator.setSafeFileName(safeFileName);
    streamingGenerator.setPageCount(processedPageCount);
    
    // 立即启用刷新保护并显示进度框
    enableRefreshProtection();
    streamingGenerator.showProgressModal(totalCount);
    streamingGenerator.updateProgressStep(1, 'active');
    
    try {
        // 上传文件阶段（带人机验证）
        await streamingGenerator.uploadFile(currentFiles[0], turnstileToken);
        streamingGenerator.updateProgressStep(1, 'completed');
        
        // 生成题目阶段
        await streamingGenerator.startGeneration({
            totalQuestions: totalCount,
            lang: lang,
            pageCount: processedPageCount
        });
        
    } catch (err) {
        console.error('Generation error:', err);
        showToast(err.message, 'error');
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
}

function disableRefreshProtection() {
    preventRefresh = false;
    window.removeEventListener('beforeunload', handleBeforeUnload);
}

function handleBeforeUnload(e) {
    if (preventRefresh) {
        e.preventDefault();
        e.returnValue = '';
        return '';
    }
}

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    const icon = document.getElementById('toastIcon');
    const msg = document.getElementById('toastMessage');
    
    if (!toast || !icon || !msg) return;
    
    msg.textContent = message;
    
    if (type === 'error') {
        icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>';
        toast.querySelector('div').className = 'bg-red-600 text-white px-6 py-3 rounded-lg shadow-lg flex items-center';
    } else {
        icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>';
        toast.querySelector('div').className = 'bg-slate-800 text-white px-6 py-3 rounded-lg shadow-lg flex items-center';
    }
    
    toast.classList.remove('translate-y-20', 'opacity-0');
    
    setTimeout(() => {
        toast.classList.add('translate-y-20', 'opacity-0');
    }, 3000);
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
window.i18n = i18n;
window.currentLang = currentLang;

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
    updateLanguage();
    setupDropZone();

    // 检查是否有从其他模式切换过来的待处理文件
    const pendingFile = sessionStorage.getItem('pendingFile');
    if (pendingFile) {
        try {
            const fileInfo = JSON.parse(pendingFile);
            // 检查是否在5分钟内（避免过期）
            if (Date.now() - fileInfo.timestamp < 5 * 60 * 1000) {
                // 将 base64 转换回文件
                fetch(fileInfo.data)
                    .then(res => res.blob())
                    .then(blob => {
                        const file = new File([blob], fileInfo.name, { type: fileInfo.type });
                        const dataTransfer = new DataTransfer();
                        dataTransfer.items.add(file);
                        handleFiles(dataTransfer.files);
                    });
            }
        } catch (e) {
            console.error('Error loading pending file:', e);
        }
        sessionStorage.removeItem('pendingFile');
    }
    
    if (typeof pdfjsLib !== 'undefined') {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
});
