/**
 * docgenerate_text.js - 非PDF文件文本提取 + 分批生成题库
 * 支持: DOCX, PPTX, XLSX, XLS, TXT 等文件
 */

var API_BASE_TEXT = "https://moyuxiaowu.org";
var DB_NAME_TEXT = 'ExamBuddyDB_Clean_v2';

// ==================== 数据库初始化 ====================
var dbText = new Dexie(DB_NAME_TEXT);
dbText.version(5).stores({
    questionBanks: '++id, name, createdAt, updatedAt',
    practiceProgress: '++id, bankId, lastPracticeAt',
    sourceFiles: '++id, name, safeName, bankId, data, createdAt',
    settings: 'key'
});

// ==================== 状态变量 ====================
var currentLangText = localStorage.getItem('language') || detectBrowserLanguageText();
var currentFilesText = [];
var currentFileTypeText = null;
var extractedTextContent = '';
var generatedQuestionsText = [];
var preventRefreshText = false;
var streamingGeneratorText = null;

// ==================== 国际化配置 ====================
var i18nText = {
    zh: {
        appName: '刷题考试助手',
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
        textPreview: '文本预览',
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
        fillRequired: '请上传文件',
        saveSuccess: '保存成功',
        parseError: '文件解析失败',
        networkError: '网络错误，请检查后端服务是否启动',
        processingFile: '正在提取文本...',
        uploadError: '文件处理失败',
        extractionError: '未能从文件中提取到文本，请检查文件内容',
        partialSuccessTitle: '生成完成（部分成功）',
        partialSuccessMessage: '由于服务器速率限制，此次实际生成 {0} 题（原计划 {1} 题），抱歉造成不便。',
        partialSuccessHint: '如需更多题目，请稍后重新生成。',
        pageTitle: '从资料生成 - GPA4.0',
        toastSuccess: '操作成功',
        streamingStatus: '实时生成中...',
        batchProgress: '批次 {0}/{1}: 已生成 {2} 题',
        stepUploading: '处理文件',
        stepGeneratingQuestions: 'AI生成题目',
        streamingPreview: '实时预览',
        waitingFirstQuestion: '等待第一道题...',
        totalQuestionsHint: '以上仅显示前20题预览，共生成 {0} 题',
        generateCostText: '生成一次题库的成本约为 0.5 元，如果本网站对你有帮助，欢迎捐款支持',
        donate: '捐款',
        donateBannerText: '生成一次题库的成本约为 0.5 元，如果本网站对你有帮助，可以捐款支持我们',
        supportUs: '支持我们',
        oldFormatDoc: '不支持旧版doc，请将文件另存为新版docx再上传',
        oldFormatPpt: '不支持旧版ppt，请将文件另存为新版pptx再上传',
        mixedFileTypes: '请上传相同类型的文件（PPT或Excel或Word/TXT），不要混合上传'
    },
    'zh-TW': {
        appName: '刷題考試助手',
        back: '返回',
        generateHeader: '從資料生成題庫',
        dropText: '拖曳檔案到此處，或點擊上傳',
        supportFormats: '支援 PDF、Word(DOCX)、PPT(PPTX)、Excel(XLSX/XLS)、TXT 格式',
        textExtractionNotice: '📄 PPT/DOCX/XLSX 檔案將自動提取文本生成題目',
        configTitle: '生成設定',
        questionCount: '題目數量',
        language: '生成語言',
        langZH: '中文',
        langEN: 'English',
        startGenerate: '開始生成',
        textPreview: '文本預覽',
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
        fillRequired: '請上傳檔案',
        saveSuccess: '儲存成功',
        parseError: '檔案解析失敗',
        networkError: '網絡錯誤，請檢查後端服務是否啟動',
        processingFile: '正在提取文本...',
        uploadError: '檔案處理失敗',
        extractionError: '未能從檔案中提取到文本，請檢查檔案內容',
        partialSuccessTitle: '生成完成（部分成功）',
        partialSuccessMessage: '由於伺服器速率限制，此次實際生成 {0} 題（原計劃 {1} 題），抱歉造成不便。',
        partialSuccessHint: '如需更多題目，請稍後重新生成。',
        pageTitle: '從資料生成 - GPA4.0',
        toastSuccess: '操作成功',
        streamingStatus: '實時生成中...',
        batchProgress: '批次 {0}/{1}: 已生成 {2} 題',
        stepUploading: '處理檔案',
        stepGeneratingQuestions: 'AI生成題目',
        streamingPreview: '實時預覽',
        waitingFirstQuestion: '等待第一道題...',
        totalQuestionsHint: '以上僅顯示前20題預覽，共生成 {0} 題',
        generateCostText: '生成一次題庫的成本約為 0.5 港幣，如果本網站對你有幫助，歡迎捐款支持',
        donate: '捐款',
        donateBannerText: '生成一次題庫的成本約為 0.5 港幣，如果本網站對你有幫助，可以捐款支持我們',
        supportUs: '支持我們',
        oldFormatDoc: '不支援舊版doc，請將檔案另存為新版docx再上傳',
        oldFormatPpt: '不支援舊版ppt，請將檔案另存為新版pptx再上傳',
        mixedFileTypes: '請上傳相同類型的檔案（PPT或Excel或Word/TXT），不要混合上傳'
    },
    en: {
        appName: 'Exam Study Buddy',
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
        textPreview: 'Text Preview',
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
        fillRequired: 'Please upload a file',
        saveSuccess: 'Saved successfully',
        parseError: 'File parsing failed',
        networkError: 'Network error, please check if backend is running',
        processingFile: 'Extracting text...',
        uploadError: 'File processing failed',
        extractionError: 'No text extracted from file, please check file content',
        partialSuccessTitle: 'Generation Complete (Partial Success)',
        partialSuccessMessage: 'Due to server rate limiting, only {0} of {1} questions were generated. We apologize for the inconvenience.',
        partialSuccessHint: 'Please try again later if you need more questions.',
        pageTitle: 'Generate from Material - GPA4.0',
        toastSuccess: 'Operation successful',
        streamingStatus: 'Streaming generation...',
        batchProgress: 'Batch {0}/{1}: {2} questions generated',
        stepUploading: 'Processing File',
        stepGeneratingQuestions: 'AI Generating',
        streamingPreview: 'Live Preview',
        waitingFirstQuestion: 'Waiting for first question...',
        totalQuestionsHint: 'Showing first 20 questions preview, {0} questions generated in total',
        generateCostText: 'Each question bank generation costs about 0.5 HKD. If this site helps you, please consider donating.',
        donate: 'Donate',
        donateBannerText: 'Each generation costs 0.5 HKD. If this site helps you, please consider donating to support us.',
        supportUs: 'Support Us',
        oldFormatDoc: 'Old .doc format not supported. Please save as .docx and re-upload.',
        oldFormatPpt: 'Old .ppt format not supported. Please save as .pptx and re-upload.',
        mixedFileTypes: 'Please upload files of the same type (PPT or Excel or Word/TXT), do not mix different types'
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
        textPreview: '텍스트 미리보기',
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
        fillRequired: '파일을 업로드하세요',
        saveSuccess: '저장 성공',
        parseError: '파일 분석 실패',
        networkError: '네트워크 오류, 백엔드 서비스가 실행 중인지 확인하세요',
        processingFile: '텍스트 추출 중...',
        uploadError: '파일 처리 실패',
        extractionError: '파일에서 텍스트를 추출하지 못했습니다. 파일 내용을 확인하세요',
        partialSuccessTitle: '생성 완료 (일부 성공)',
        partialSuccessMessage: '서버 속도 제한으로 인해 {0}개 문제 중 {1}개 문제만 생성되었습니다. 불편을 드려 죄송합니다.',
        partialSuccessHint: '더 많은 문제가 필요하면 나중에 다시 시도하세요.',
        pageTitle: '자료에서 생성 - GPA4.0',
        toastSuccess: '작업 성공',
        streamingStatus: '실시간 생성 중...',
        batchProgress: '배치 {0}/{1}: {2}개 문제 생성됨',
        stepUploading: '파일 처리',
        stepGeneratingQuestions: 'AI 문제 생성',
        streamingPreview: '실시간 미리보기',
        waitingFirstQuestion: '첫 번째 문제 대기 중...',
        totalQuestionsHint: '처음 20문제 미리보기, 총 {0}문제 생성됨',
        generateCostText: '문제은행 생성 1회 비용은 약 0.5 HKD입니다. 이 사이트가 도움이 된다면 기부를 고려해 주세요.',
        donate: '기부',
        donateBannerText: '생성 1회 비용은 약 0.5 HKD입니다. 이 사이트가 도움이 된다면 기부로 후원해 주세요.',
        supportUs: '후원하기',
        oldFormatDoc: '구형 .doc 형식은 지원하지 않습니다. .docx로 저장 후 업로드하세요.',
        oldFormatPpt: '구형 .ppt 형식은 지원하지 않습니다. .pptx로 저장 후 업로드하세요.',
        mixedFileTypes: '같은 유형의 파일만 업로드하세요(PPT 또는 Excel 또는 Word/TXT), 다른 유형을 혼합하지 마세요'
    }
};

// ==================== 工具函数 ====================
function tText(key, ...args) {
    let text = i18nText[currentLangText][key] || key;
    if (args.length > 0) {
        args.forEach((arg, index) => {
            text = text.replace(`{${index}}`, arg);
        });
    }
    return text;
}

function detectBrowserLanguageText() {
    const browserLang = navigator.language || navigator.userLanguage || 'en';
    const lang = browserLang.toLowerCase();
    if (lang.startsWith('zh') && (lang.includes('cn') || lang.includes('sg') || lang.includes('hans') || lang === 'zh')) return 'zh';
    if (lang.startsWith('zh') && (lang.includes('tw') || lang.includes('hk') || lang.includes('mo') || lang.includes('hant'))) return 'zh-TW';
    if (lang.startsWith('ko')) return 'ko';
    if (lang.startsWith('en')) return 'en';
    return 'en';
}

function updateLanguageText() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (i18nText[currentLangText] && i18nText[currentLangText][key]) {
            el.textContent = i18nText[currentLangText][key];
        }
    });
    const langDisplay = document.getElementById('currentLangDisplay');
    if (langDisplay) {
        langDisplay.textContent = currentLangText === 'zh' ? '简体中文' : 
                                   currentLangText === 'zh-TW' ? '繁體中文' : 
                                   currentLangText === 'ko' ? '한국어' : 'English';
    }
}

function toggleLangDropdownText() {
    const dropdown = document.getElementById('langDropdown');
    if (dropdown) dropdown.classList.toggle('hidden');
}

function changeLanguageText(lang) {
    currentLangText = lang;
    localStorage.setItem('language', currentLangText);
    updateLanguageText();
    const dropdown = document.getElementById('langDropdown');
    if (dropdown) dropdown.classList.add('hidden');
}

window.onclick = function(event) {
    if (!event.target.closest('.lang-dropdown')) {
        const dropdown = document.getElementById('langDropdown');
        if (dropdown && !dropdown.classList.contains('hidden')) {
            dropdown.classList.add('hidden');
        }
    }
};

function enableRefreshProtectionText() {
    preventRefreshText = true;
    window.addEventListener('beforeunload', handleBeforeUnloadText);
}

function disableRefreshProtectionText() {
    preventRefreshText = false;
    window.removeEventListener('beforeunload', handleBeforeUnloadText);
}

function handleBeforeUnloadText(e) {
    if (preventRefreshText) {
        e.preventDefault();
        e.returnValue = '';
        return '';
    }
}

function showToastText(message, type = 'success') {
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

function escapeHtmlText(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function closeDonateBannerText() {
    const banner = document.getElementById('donateBanner');
    if (banner) {
        banner.style.display = 'none';
    }
}

// ==================== 文件类型检查 ====================
function checkOldFormatText(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const formatMap = {
        'doc': 'oldFormatDoc',
        'ppt': 'oldFormatPpt'
    };
    return formatMap[ext] || null;
}

function getFileCategoryText(ext) {
    if (['pptx'].includes(ext)) return 'page-based';
    if (['xlsx', 'xls'].includes(ext)) return 'row-based';
    if (['docx', 'txt'].includes(ext)) return 'text-based';
    return 'unknown';
}

// ==================== 文本提取函数 ====================
async function extractPDFText(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let text = '';
    
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map(item => item.str).join(' ');
        text += `-------------【${file.name}_page${i}】-----------\n${pageText}\n\n`;
    }
    return text;
}

async function extractWordText(file) {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    const paragraphs = result.value.split(/\n\s*\n/);
    let text = `-------------【${file.name}】-----------\n`;
    
    paragraphs.forEach((para, idx) => {
        if (idx > 0 && idx % 5 === 0) {
            text += `-------------【${file.name}_section${Math.floor(idx/5)+1}】-----------\n`;
        }
        text += para + '\n\n';
    });
    return text;
}

async function extractExcelText(file) {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    let text = '';
    let globalRowIndex = 0;
    
    workbook.SheetNames.forEach((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        text += `-------------【${file.name}_${sheetName}_start】-----------\n`;
        
        data.forEach((row) => {
            globalRowIndex++;
            text += `-------------【${file.name}_${sheetName}_row${globalRowIndex}】-----------\n`;
            text += row.join('\t') + '\n';
        });
        
        text += '\n';
    });
    return text;
}

async function extractPPTText(file) {
    const arrayBuffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    let text = '';
    
    const slideFiles = Object.keys(zip.files)
        .filter(name => name.startsWith('ppt/slides/slide') && name.endsWith('.xml'))
        .sort((a, b) => {
            const numA = parseInt(a.match(/slide(\d+)\.xml$/)?.[1] || '0');
            const numB = parseInt(b.match(/slide(\d+)\.xml$/)?.[1] || '0');
            return numA - numB;
        });
    
    for (let i = 0; i < slideFiles.length; i++) {
        const slideFile = slideFiles[i];
        const content = await zip.files[slideFile].async('text');
        const matches = content.match(/<a:t>([^<]*)<\/a:t>/g);
        
        text += `-------------【${file.name}_slide${i+1}】-----------\n`;
        if (matches) {
            text += matches.map(m => m.replace(/<\/?a:t>/g, '')).join(' ') + '\n';
        } else {
            text += 'no text in this slide\n';
        }
        text += '\n';
    }
    return text || `[PPT text extraction limited. Please convert to PDF for better results.]`;
}

async function extractTextFromFileText(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    
    switch (ext) {
        case 'pdf':
            return await extractPDFText(file);
        case 'docx':
            return await extractWordText(file);
        case 'xlsx':
        case 'xls':
            return await extractExcelText(file);
        case 'pptx':
            return await extractPPTText(file);
        case 'txt':
            const content = await file.text();
            return `-------------【${file.name}】-----------\n${content}\n\n`;
        default:
            throw new Error(`Unsupported file type: ${ext}`);
    }
}

// ==================== 文本分割逻辑 ====================
function splitByPagesText(text, numGroups) {
    const pageRegex = /-------------【.*?_(?:page|slide)(\d+)】-----------/g;
    const matches = [...text.matchAll(pageRegex)];
    
    if (matches.length === 0) {
        return overlapSplitText(text, numGroups);
    }
    
    const totalPages = matches.length;
    const basePagesPerGroup = Math.floor(totalPages / numGroups);
    const extraPages = totalPages % numGroups;
    
    const groups = [];
    let currentMatchIndex = 0;
    
    for (let i = 0; i < numGroups; i++) {
        const pagesInThisGroup = basePagesPerGroup + (i === numGroups - 1 ? extraPages : 0);
        
        if (pagesInThisGroup === 0 || currentMatchIndex >= matches.length) {
            continue;
        }
        
        const startMatch = matches[currentMatchIndex];
        const startIndex = startMatch.index;
        
        let endIndex;
        if (i === numGroups - 1) {
            endIndex = text.length;
        } else {
            const endMatchIndex = currentMatchIndex + pagesInThisGroup;
            if (endMatchIndex < matches.length) {
                endIndex = matches[endMatchIndex].index;
            } else {
                endIndex = text.length;
            }
        }
        
        groups.push(text.substring(startIndex, endIndex));
        currentMatchIndex += pagesInThisGroup;
    }
    
    while (groups.length < numGroups) {
        groups.push('');
    }
    
    return groups;
}

function splitByRowsText(text, numGroups) {
    const rowRegex = /-------------【.*?_row(\d+)】-----------/g;
    const matches = [...text.matchAll(rowRegex)];
    
    if (matches.length === 0) {
        return overlapSplitText(text, numGroups);
    }
    
    const totalRows = matches.length;
    const baseRowsPerGroup = Math.floor(totalRows / numGroups);
    const extraRows = totalRows % numGroups;
    
    const groups = [];
    let currentMatchIndex = 0;
    
    for (let i = 0; i < numGroups; i++) {
        const rowsInThisGroup = baseRowsPerGroup + (i === numGroups - 1 ? extraRows : 0);
        
        if (rowsInThisGroup === 0 || currentMatchIndex >= matches.length) {
            continue;
        }
        
        const startMatch = matches[currentMatchIndex];
        const startIndex = startMatch.index;
        
        let endIndex;
        if (i === numGroups - 1) {
            endIndex = text.length;
        } else {
            const endMatchIndex = currentMatchIndex + rowsInThisGroup;
            if (endMatchIndex < matches.length) {
                endIndex = matches[endMatchIndex].index;
            } else {
                endIndex = text.length;
            }
        }
        
        groups.push(text.substring(startIndex, endIndex));
        currentMatchIndex += rowsInThisGroup;
    }
    
    while (groups.length < numGroups) {
        groups.push('');
    }
    
    return groups;
}

function overlapSplitText(text, numChunks, overlapChars = 500) {
    const chunks = [];
    if (numChunks > 1) {
        const baseChunkSize = Math.ceil(text.length / numChunks);
        for (let i = 0; i < numChunks; i++) {
            const start = Math.max(0, i * baseChunkSize - overlapChars);
            const end = Math.min(text.length, (i + 1) * baseChunkSize + overlapChars);
            const adjustedStart = findParagraphStartText(text, start);
            const adjustedEnd = findParagraphEndText(text, end);
            chunks.push(text.substring(adjustedStart, adjustedEnd));
        }
    } else {
        chunks.push(text);
    }
    return chunks;
}

function findParagraphStartText(text, pos) {
    const prevNewline = text.lastIndexOf('\n\n', pos);
    return prevNewline === -1 ? 0 : prevNewline + 2;
}

function findParagraphEndText(text, pos) {
    const nextNewline = text.indexOf('\n\n', pos);
    return nextNewline === -1 ? text.length : nextNewline;
}

// ==================== 流式生成器类 ====================
class StreamingTextGeneratorText {
    constructor() {
        this.chunks = [];
        this.isGenerating = false;
        this.questions = [];
        this.batchResults = new Map();
        this.currentBatch = 0;
        this.totalBatches = 0;
        this.decoder = new TextDecoder();
        this.abortControllers = [];
        this.fileName = '';
    }

    setFileName(fileName) {
        this.fileName = fileName;
    }

    setChunks(chunks) {
        this.chunks = chunks;
        this.totalBatches = chunks.length;
    }

    async startGenerationText(config) {
        const { totalQuestions, lang } = config;
        
        if (!this.chunks || this.chunks.length === 0) {
            throw new Error(tText('fillRequired'));
        }

        this.isGenerating = true;
        this.questions = [];
        this.batchResults.clear();
        this.currentBatch = 0;
        this.abortControllers = [];

        try {
            this.updateProgressStepText(2, 'active');
            
            // 第0批：流式传输，实时显示
            await this.streamBatchText(0, lang);
            
            // 其他批次：静默处理
            if (this.totalBatches > 1) {
                const batchPromises = [];
                for (let i = 1; i < this.totalBatches; i++) {
                    batchPromises.push(this.silentBatchText(i, lang));
                }
                await Promise.allSettled(batchPromises);
            }

            this.mergeAllBatches();
            this.updateProgressStepText(2, 'completed');
            this.showCompletionUIText();
            
        } catch (error) {
            this.handleErrorText(error);
        } finally {
            this.isGenerating = false;
            disableRefreshProtectionText();
        }
    }

    buildBatchPrompt(batchIndex, lang) {
        const startId = batchIndex * 20 + 1;
        const endId = startId + 19;
        const langInstruction = lang === 'zh' ? '使用中文' : 'Use English';
        const chunk = this.chunks[batchIndex] || '';
        
        return `You are an expert exam question creator. Create exactly 20 multiple-choice questions based on the study material below.

CRITICAL REQUIREMENTS:
1. ${langInstruction} ONLY
2. Each question MUST have exactly 4 options: A, B, C, D
3. Include explanation for each correct answer
4. Return ONLY a JSON array. No markdown, no code blocks, no explanations before or after.
5. The response must start with [ and end with ]
6. CRITICAL: For the "source" field, you MUST use the EXACT page marker format shown in the text (e.g., "-------------【filename_page1】-----------" or "-------------【filename_section1】-----------")

7. **CRITICAL - CONTENT REQUIREMENT**:
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
    "source": "EXACT page marker from text"
  }
]

Study Material (Part ${batchIndex + 1} of ${this.totalBatches}):
${chunk.substring(0, 15000)}

Generate exactly 20 questions. Use the page markers in the text to indicate source location. Output valid JSON only.`;
    }

    async streamBatchText(batchIndex, lang) {
        const prompt = this.buildBatchPrompt(batchIndex, lang);
        const controller = new AbortController();
        this.abortControllers.push(controller);
        
        const response = await fetch(`${API_BASE_TEXT}/generate/text`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: this.chunks[batchIndex],
                prompt: prompt,
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
                                    this.renderQuestionStreamText(newQuestions[i], i, batchIndex === 0);
                                }
                                displayedCount = newQuestions.length;
                                this.updateProgressText(batchIndex, displayedCount);
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

    async silentBatchText(batchIndex, lang) {
        try {
            const prompt = this.buildBatchPrompt(batchIndex, lang);
            const controller = new AbortController();
            this.abortControllers.push(controller);
            
            const response = await fetch(`${API_BASE_TEXT}/generate/text`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: this.chunks[batchIndex],
                    prompt: prompt,
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
            this.updateTotalProgressText();
            
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
        
        generatedQuestionsText = this.questions;
        console.log(`合并完成：共 ${this.questions.length} 题`);
        return this.questions;
    }

    // ==================== UI 更新方法 ====================
    
    showProgressModal(totalQuestions) {
        const modal = document.getElementById('genProgress');
        if (modal) {
            modal.classList.remove('hidden');
        }
        
        document.getElementById('progressBar').style.width = '0%';
        document.getElementById('questionProgressText').textContent = 
            `0 / ${totalQuestions}`;
        
        const streamingContainer = document.getElementById('streamingQuestions');
        if (streamingContainer) {
            streamingContainer.innerHTML = `<div class="text-center text-slate-400 text-sm py-8">${tText('waitingFirstQuestion')}</div>`;
        }
        
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

    updateProgressStepText(stepNumber, status) {
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

    updateProgressText(batchIndex, count) {
        const totalCount = this.totalBatches * 20;
        const currentCount = batchIndex * 20 + count;
        const percent = Math.min((currentCount / totalCount) * 100, 99);
        
        document.getElementById('progressBar').style.width = `${percent}%`;
        document.getElementById('questionProgressText').textContent = 
            `${currentCount} / ${totalCount}`;
    }

    updateTotalProgressText() {
        const completed = Array.from(this.batchResults.values())
            .reduce((sum, arr) => sum + (arr?.length || 0), 0);
        this.updateProgressText(0, completed);
    }

    renderQuestionStreamText(question, index, isBatch0 = false) {
        if (isBatch0) {
            const streamingContainer = document.getElementById('streamingQuestions');
            if (streamingContainer) {
                if (index === 0) {
                    streamingContainer.innerHTML = '';
                }
                
                const item = document.createElement('div');
                item.className = 'py-2 px-3 bg-white rounded border-l-4 border-indigo-500 slide-in';
                item.style.animationDelay = `${index * 0.05}s`;
                
                item.innerHTML = `
                    <div class="text-sm text-slate-700">
                        <span class="font-medium text-indigo-600 mr-2">${question.id || index + 1}.</span>
                        ${escapeHtmlText(question.question)}
                    </div>
                `;
                
                streamingContainer.appendChild(item);
                streamingContainer.scrollTop = streamingContainer.scrollHeight;
            }
        }
        
        const container = document.getElementById('resultPreview');
        if (!container) return;

        const card = document.createElement('div');
        card.className = 'border border-slate-200 rounded-lg p-4 bg-slate-50 slide-in';
        card.style.animationDelay = `${index * 0.05}s`;
        
        const sourceInfo = question.source 
            ? `<div class="text-xs text-indigo-600 mt-1">📄 ${question.source}</div>` 
            : '';

        card.innerHTML = `
            <div class="font-medium text-slate-900 mb-2">Q${question.id || index + 1}: ${escapeHtmlText(question.question)}</div>
            <div class="space-y-1 text-sm text-slate-600 mb-2">
                ${Object.entries(question.options).map(([k, v]) => 
                    `<div class="${question.correctAnswer === k ? 'text-emerald-600 font-medium' : ''}">${k}. ${escapeHtmlText(v)}</div>`
                ).join('')}
            </div>
            <div class="text-sm text-emerald-600 font-medium">Answer: ${question.correctAnswer}</div>
            ${question.explanation ? `<div class="text-xs text-slate-500 mt-1">${escapeHtmlText(question.explanation)}</div>` : ''}
            ${sourceInfo}
        `;
        
        container.appendChild(card);
        container.scrollTop = container.scrollHeight;
    }

    showCompletionUIText() {
        setTimeout(() => {
            const modal = document.getElementById('genProgress');
            if (modal) modal.classList.add('hidden');
            
            const resultModal = document.getElementById('resultModal');
            if (resultModal) resultModal.classList.remove('hidden');
            
            const totalHint = document.getElementById('totalQuestionsHint');
            if (totalHint) {
                const totalCount = this.questions.length;
                if (totalCount > 20) {
                    totalHint.textContent = tText('totalQuestionsHint', totalCount);
                    totalHint.classList.remove('hidden');
                } else {
                    totalHint.classList.add('hidden');
                }
            }
            
            showToastText(tText('completed'), 'success');
        }, 500);
    }

    handleErrorText(error) {
        console.error('Generation error:', error);
        this.abortControllers.forEach(ctrl => ctrl.abort());
        
        const modal = document.getElementById('genProgress');
        if (modal) modal.classList.add('hidden');
        
        showToastText(error.message, 'error');
    }
}

// ==================== 文件处理函数 ====================
function setupDropZoneText() {
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
            handleFilesText(e.dataTransfer.files);
        }
    });
    
    input.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFilesText(e.target.files);
        }
    });
}

async function handleFilesText(files) {
    currentFilesText = Array.from(files);
    
    // 检查混合类型
    const categories = new Set(currentFilesText.map(f => getFileCategoryText(f.name.split('.').pop().toLowerCase())));
    if (categories.size > 1) {
        alert(tText('mixedFileTypes'));
        document.getElementById('fileInput').value = '';
        currentFilesText = [];
        return;
    }
    
    if (currentFilesText.length > 0) {
        currentFileTypeText = currentFilesText[0].name.split('.').pop().toLowerCase();
    }
    
    // 检查旧版格式
    for (const file of currentFilesText) {
        const formatKey = checkOldFormatText(file.name);
        if (formatKey) {
            alert(tText(formatKey));
            document.getElementById('fileInput').value = '';
            currentFilesText = [];
            return;
        }
    }
    
    const fileList = document.getElementById('fileList');
    if (!fileList) return;
    
    fileList.innerHTML = '';
    fileList.classList.remove('hidden');
    
    currentFilesText.forEach((file, index) => {
        const div = document.createElement('div');
        div.className = 'flex items-center justify-between bg-slate-50 p-3 rounded-lg border border-slate-200';
        div.innerHTML = `
            <div class="flex items-center overflow-hidden">
                <svg class="w-5 h-5 text-slate-400 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
                <span class="text-sm text-slate-700 truncate">${file.name}</span>
                <span class="text-xs text-slate-400 ml-2 flex-shrink-0">${(file.size/1024).toFixed(1)}KB</span>
            </div>
            <button onclick="removeFileText(${index})" class="text-red-500 hover:text-red-700 ml-2">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                </svg>
            </button>
        `;
        fileList.appendChild(div);
    });

    try {
        await extractTextContentText();
        if (extractedTextContent && extractedTextContent.trim().length > 0) {
            document.getElementById('genBtn').disabled = false;
        } else {
            showToastText(tText('extractionError'), 'error');
        }
    } catch (err) {
        console.error('Extraction error:', err);
        showToastText(tText('parseError') + ': ' + err.message, 'error');
    }
}

async function extractTextContentText() {
    const preview = document.getElementById('pdfPreview');
    if (!preview) return;
    
    preview.innerHTML = `<div class="flex items-center justify-center h-full"><div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mr-3"></div><span>${tText('processingFile')}</span></div>`;
    
    let fullText = '';
    
    for (const file of currentFilesText) {
        try {
            fullText += await extractTextFromFileText(file) + '\n\n';
        } catch (err) {
            console.error('Extraction error:', err);
            fullText += `[Error extracting ${file.name}: ${err.message}]\n\n`;
        }
    }
    
    extractedTextContent = fullText.trim();
    
    // 显示文本预览
    preview.innerHTML = `<div class="text-sm text-slate-600 font-mono whitespace-pre-wrap p-4">${escapeHtmlText(extractedTextContent.substring(0, 5000))}${extractedTextContent.length > 5000 ? '\n\n... (' + (extractedTextContent.length - 5000) + ' more characters)' : ''}</div>`;
    
    const pageStats = document.getElementById('pageStats');
    if (pageStats) pageStats.textContent = `${extractedTextContent.length} chars | ${extractedTextContent.split(/\s+/).length} words`;
}

async function removeFileText(index) {
    const removedFile = currentFilesText[index];
    currentFilesText.splice(index, 1);
    
    if (currentFilesText.length === 0) {
        const fileList = document.getElementById('fileList');
        if (fileList) fileList.classList.add('hidden');
        
        const pdfPreview = document.getElementById('pdfPreview');
        if (pdfPreview) {
            pdfPreview.innerHTML = `<div class="flex items-center justify-center h-full text-slate-400 py-20">${tText('waitingUpload')}</div>`;
        }
        
        extractedTextContent = '';
        currentFileTypeText = null;
        
        const genBtn = document.getElementById('genBtn');
        if (genBtn) genBtn.disabled = true;
        
        const pageStats = document.getElementById('pageStats');
        if (pageStats) pageStats.textContent = '';
        
        document.getElementById('fileInput').value = '';
    } else {
        await extractTextContentText();
    }
}

// ==================== 生成控制 ====================
async function startGenerationText() {
    if (!extractedTextContent || extractedTextContent.trim().length === 0) {
        showToastText(tText('fillRequired'), 'error');
        return;
    }

    const totalCount = parseInt(document.getElementById('questionCount')?.value) || 20;
    const lang = document.querySelector('input[name="genLang"]:checked')?.value || 'zh';
    const numGroups = totalCount / 20;
    
    const resultPreview = document.getElementById('resultPreview');
    if (resultPreview) resultPreview.innerHTML = '';
    
    // 分割文本
    let chunks = [];
    const category = getFileCategoryText(currentFileTypeText);
    
    if (category === 'page-based') {
        chunks = splitByPagesText(extractedTextContent, numGroups);
    } else if (category === 'row-based') {
        chunks = splitByRowsText(extractedTextContent, numGroups);
    } else {
        chunks = overlapSplitText(extractedTextContent, numGroups, 500);
    }
    
    streamingGeneratorText = new StreamingTextGeneratorText();
    streamingGeneratorText.setFileName(currentFilesText[0]?.name || 'document');
    streamingGeneratorText.setChunks(chunks);
    
    enableRefreshProtectionText();
    streamingGeneratorText.showProgressModal(totalCount);
    streamingGeneratorText.updateProgressStepText(1, 'active');
    
    // 模拟第一步完成
    setTimeout(() => {
        streamingGeneratorText.updateProgressStepText(1, 'completed');
    }, 500);
    
    try {
        await streamingGeneratorText.startGenerationText({
            totalQuestions: totalCount,
            lang: lang
        });
    } catch (err) {
        console.error('Generation error:', err);
        showToastText(err.message, 'error');
        const modal = document.getElementById('genProgress');
        if (modal) modal.classList.add('hidden');
        disableRefreshProtectionText();
    }
}

function discardResultText() {
    if (confirm(tText('discardConfirm'))) {
        generatedQuestionsText = [];
        const modal = document.getElementById('resultModal');
        if (modal) modal.classList.add('hidden');
        showToastText('Discarded', 'success');
    }
}

async function saveAndPracticeText() {
    if (!generatedQuestionsText || generatedQuestionsText.length === 0) {
        showToastText('No questions to save', 'error');
        return;
    }
    
    const name = prompt(
        currentLangText === 'zh' ? '请输入题库名称:' : 
        currentLangText === 'zh-TW' ? '請輸入題庫名稱:' : 
        currentLangText === 'ko' ? '문제은행 이름을 입력하세요:' :
        'Enter question bank name:', 
        currentFilesText[0]?.name.replace(/\.[^/.]+$/, '') || 'New Bank'
    );
    
    if (!name) return;
    
    const bank = {
        name: name,
        questions: generatedQuestionsText,
        favorites: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    
    try {
        const id = await dbText.questionBanks.add(bank);
        
        const modal = document.getElementById('resultModal');
        if (modal) modal.classList.add('hidden');
        
        showToastText(tText('saveSuccess'), 'success');
        window.location.href = `practice.html?id=${id}`;
    } catch (err) {
        console.error('Save error:', err);
        showToastText('Save failed: ' + err.message, 'error');
    }
}

// ==================== 全局暴露 ====================
// 导出与 HTML 中期望的名称一致，但指向新的重命名函数
window.toggleLangDropdown = toggleLangDropdownText;
window.changeLanguage = changeLanguageText;
window.removeFile = removeFileText;
window.handleFilesText = handleFilesText;  // 这个只供内部使用
window.startGeneration = startGenerationText;
window.discardResult = discardResultText;
window.saveAndPractice = saveAndPracticeText;
window.closeDonateBanner = closeDonateBannerText;

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
    updateLanguageText();
    setupDropZoneText();
    
    if (typeof pdfjsLib !== 'undefined') {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
});
