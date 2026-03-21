/**
 * GPA4.0 智能刷题助手 - 题库生成模块
 * 从PDF文件生成标准化题库
 */

// ==================== 配置 ====================
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
let progressInterval = null;
let preventRefresh = false;

// ==================== 国际化配置 ====================
const i18n = {
    zh: {
        appName: '刷题考试助手',
        back: '返回',
        generateHeader: '从资料生成题库',
        dropText: '拖拽PDF文件到此处，或点击上传',
        supportFormats: '支持 PDF 格式（将自动添加页码标记）',
        configTitle: '生成配置',
        questionCount: '题目数量',
        language: '生成语言',
        langZH: '中文',
        langEN: 'English',
        startGenerate: '开始生成',
        pdfPreview: 'PDF预览（已添加页码标记）',
        waitingUpload: '等待上传文件...',
        generating: '正在生成题库...',
        aiProcessing: 'AI正在处理PDF文件',
        warningRefresh: '⚠️ 生成过程中请勿关闭或刷新网页，否则会导致生成失败',
        estimatedTime: '预计需要等待 {0} 秒',
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
        donateHint: '生成一次题库成本约为1元，如果你觉得好用，可以捐款支持本网站',
        donateButton: '❤️ 支持开发者',
        processingPdf: '正在处理PDF...',
        uploadError: '文件上传失败',
        onlyPdf: '请上传PDF格式文件',
        pageLabel: '第 {0} 页',
        stepUpload: '上传文件到服务器',
        stepTransfer: '服务器传输给AI',
        stepProcessing: 'AI提取文件内容',
        stepGenerating: 'AI生成题目中',
        stepCompleted: '✓ 完成',
        partialSuccessTitle: '生成完成（部分成功）',
        partialSuccessMessage: '由于服务器速率限制，此次实际生成 {0} 题（原计划 {1} 题），抱歉造成不便。',
        partialSuccessHint: '如需更多题目，请稍后重新生成。',
        pageTitle: '从资料生成 - GPA4.0',
        toastSuccess: '操作成功'
    },
    'zh-TW': {
        appName: '刷題考試助手',
        back: '返回',
        generateHeader: '從資料生成題庫',
        dropText: '拖曳PDF檔案到此處，或點擊上傳',
        supportFormats: '支援 PDF 格式（將自動添加頁碼標記）',
        configTitle: '生成設定',
        questionCount: '題目數量',
        language: '生成語言',
        langZH: '中文',
        langEN: 'English',
        startGenerate: '開始生成',
        pdfPreview: 'PDF預覽（已添加頁碼標記）',
        waitingUpload: '等待上傳檔案...',
        generating: '正在生成題庫...',
        aiProcessing: 'AI正在處理PDF檔案',
        warningRefresh: '⚠️ 生成過程中請勿關閉或重新整理網頁，否則會導致生成失敗',
        estimatedTime: '預計需要等待 {0} 秒',
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
        donateHint: '生成一次題庫成本約為1港幣，如果你覺得好用，可以捐款支持本網站',
        donateButton: '❤️ 支持開發者',
        pageTitle: '從資料生成 - GPA4.0',
        toastSuccess: '操作成功',
        processingPdf: '正在處理PDF...',
        uploadError: '檔案上傳失敗',
        onlyPdf: '請上傳PDF格式檔案',
        pageLabel: '第 {0} 頁',
        stepUpload: '上傳檔案到伺服器',
        stepTransfer: '伺服器傳輸給AI',
        stepProcessing: 'AI提取檔案內容',
        stepGenerating: 'AI生成題目中',
        stepCompleted: '✓ 完成',
        partialSuccessTitle: '生成完成（部分成功）',
        partialSuccessMessage: '由於伺服器速率限制，此次實際生成 {0} 題（原計劃 {1} 題），抱歉造成不便。',
        partialSuccessHint: '如需更多題目，請稍後重新生成。'
    },
    en: {
        appName: 'Exam Study Buddy',
        back: 'Back',
        generateHeader: 'Generate from Material',
        dropText: 'Drop PDF files here or click to upload',
        supportFormats: 'Supports PDF format (page numbers will be added automatically)',
        configTitle: 'Generation Config',
        questionCount: 'Question Count',
        language: 'Language',
        langZH: 'Chinese',
        langEN: 'English',
        startGenerate: 'Start Generation',
        pdfPreview: 'PDF Preview (with page markers)',
        waitingUpload: 'Waiting for file upload...',
        generating: 'Generating Question Bank...',
        aiProcessing: 'AI is processing PDF file',
        warningRefresh: '⚠️ Do not close or refresh the page during generation',
        estimatedTime: 'Estimated wait: {0} seconds',
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
        donateHint: 'Generating a question bank costs about 1 HKD. If you find it helpful, please consider donating',
        donateButton: '❤️ Support Developer',
        processingPdf: 'Processing PDF...',
        uploadError: 'File upload failed',
        onlyPdf: 'Please upload PDF format files only',
        pageLabel: 'Page {0}',
        stepUpload: 'Uploading file to server',
        stepTransfer: 'Server transferring to AI',
        stepProcessing: 'AI extracting file content',
        stepGenerating: 'AI generating questions',
        stepCompleted: '✓ Completed',
        partialSuccessTitle: 'Generation Complete (Partial Success)',
        partialSuccessMessage: 'Due to server rate limiting, only {0} of {1} questions were generated. We apologize for the inconvenience.',
        partialSuccessHint: 'Please try again later if you need more questions.',
        pageTitle: 'Generate from Material - GPA4.0',
        toastSuccess: 'Operation successful'
    },
    ko: {
        appName: '문제은행 도우미',
        back: '돌아가기',
        generateHeader: '자료에서 문제은행 생성',
        dropText: 'PDF 파일을 여기로 끌어다 놓거나 클릭하여 업로드',
        supportFormats: 'PDF 형식 지원 (페이지 번호가 자동으로 추가됨)',
        configTitle: '생성 설정',
        questionCount: '문제 수량',
        language: '생성 언어',
        langZH: '중국어',
        langEN: '영어',
        startGenerate: '생성 시작',
        pdfPreview: 'PDF 미리보기 (페이지 표시 포함)',
        waitingUpload: '파일 업로드 대기 중...',
        generating: '문제은행 생성 중...',
        aiProcessing: 'AI가 PDF 파일을 처리하는 중',
        warningRefresh: '⚠️ 생성 중에 페이지를 닫거나 새로고침하지 마세요',
        estimatedTime: '예상 대기 시간: {0}초',
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
        donateHint: '문제은행 생성 비용은 약 1 홍콩달러입니다',
        donateButton: '❤️ 개발자 후원',
        processingPdf: 'PDF 처리 중...',
        uploadError: '파일 업로드 실패',
        onlyPdf: 'PDF 형식 파일만 업로드하세요',
        pageLabel: '{0} 페이지',
        stepUpload: '서버에 파일 업로드 중',
        stepTransfer: '서버가 AI에 전송 중',
        stepProcessing: 'AI가 파일 내용 추출 중',
        stepGenerating: 'AI가 문제 생성 중',
        stepCompleted: '✓ 완료',
        partialSuccessTitle: '생성 완료 (일부 성공)',
        partialSuccessMessage: '서버 속도 제한으로 인해 {0}개 문제 중 {1}개 문제만 생성되었습니다. 불편을 드려 죄송합니다.',
        partialSuccessHint: '더 많은 문제가 필요하면 나중에 다시 시도하세요.',
        pageTitle: '자료에서 생성 - GPA4.0',
        toastSuccess: '작업 성공'
    }
};

// ==================== 工具函数 ====================

/**
 * 获取翻译文本
 */
function t(key, ...args) {
    let text = i18n[currentLang][key] || key;
    if (args.length > 0) {
        args.forEach((arg, index) => {
            text = text.replace(`{${index}}`, arg);
        });
    }
    return text;
}

/**
 * 检测浏览器语言
 */
function detectBrowserLanguage() {
    const browserLang = navigator.language || navigator.userLanguage || 'en';
    const lang = browserLang.toLowerCase();
    if (lang.startsWith('zh') && (lang.includes('cn') || lang.includes('sg') || lang.includes('hans') || lang === 'zh')) return 'zh';
    if (lang.startsWith('zh') && (lang.includes('tw') || lang.includes('hk') || lang.includes('mo') || lang.includes('hant'))) return 'zh-TW';
    if (lang.startsWith('ko')) return 'ko';
    if (lang.startsWith('en')) return 'en';
    return 'en';
}

/**
 * 更新页面语言
 */
function updateLanguage() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (i18n[currentLang] && i18n[currentLang][key]) {
            el.textContent = i18n[currentLang][key];
        }
    });
    document.getElementById('currentLangDisplay').textContent = 
        currentLang === 'zh' ? '简体中文' : 
        currentLang === 'zh-TW' ? '繁體中文' : 
        currentLang === 'ko' ? '한국어' : 'English';
}

/**
 * 切换语言下拉菜单
 */
function toggleLangDropdown() {
    const dropdown = document.getElementById('langDropdown');
    dropdown.classList.toggle('show');
}

/**
 * 切换语言
 */
function changeLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('language', currentLang);
    updateLanguage();
    document.getElementById('langDropdown').classList.remove('show');
}

// 点击外部关闭下拉菜单
window.onclick = function(event) {
    if (!event.target.matches('.lang-dropdown button') && !event.target.closest('.lang-dropdown')) {
        const dropdown = document.getElementById('langDropdown');
        if (dropdown.classList.contains('show')) {
            dropdown.classList.remove('show');
        }
    }
};

// ==================== 刷新保护 ====================

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

// ==================== 文件处理 ====================

/**
 * 设置拖拽区域
 */
function setupDropZone() {
    const dropZone = document.getElementById('dropZone');
    const input = document.getElementById('fileInput');
    
    if (!dropZone || !input) {
        console.error('dropZone or fileInput not found!');
        return;
    }
    
    // 点击整个 dropZone 区域触发文件选择
    dropZone.addEventListener('click', (e) => {
        // 防止点击删除按钮时也触发文件选择
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

/**
 * 处理上传的文件
 */
async function handleFiles(files) {
    // 只取第一个文件
    currentFiles = Array.from(files).slice(0, 1);
    
    // 只支持PDF
    for (const file of currentFiles) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (ext !== 'pdf') {
            alert(t('onlyPdf'));
            document.getElementById('fileInput').value = '';
            currentFiles = [];
            return;
        }
    }
    
    const fileList = document.getElementById('fileList');
    fileList.innerHTML = '';
    fileList.classList.remove('hidden');
    
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
        // 处理PDF，添加页码标记
        await processPdfWithPageMarkers(currentFiles[0]);
        document.getElementById('genBtn').disabled = false;
    } catch (err) {
        console.error('PDF processing error:', err);
        showToast(t('parseError') + ': ' + err.message, 'error');
    }
}

/**
 * 处理PDF文件，添加页码标记
 */
async function processPdfWithPageMarkers(file) {
    const preview = document.getElementById('pdfPreview');
    preview.innerHTML = `<div class="flex items-center justify-center h-full"><div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mr-3"></div><span>${t('processingPdf')}</span></div>`;
    
    const arrayBuffer = await file.arrayBuffer();
    
    // 使用pdf-lib加载PDF
    const { PDFDocument, rgb, StandardFonts } = PDFLib;
    const pdfDoc = await PDFDocument.load(arrayBuffer);
    const pages = pdfDoc.getPages();
    const helveticaFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    const baseName = file.name.replace(/\.pdf$/i, '');
    // 将文件名中的空格和特殊字符替换为下划线，确保 AI 不会误处理
    const safeFileName = baseName.replace(/[^a-zA-Z0-9\-_]/g, '_');
    
    // 为每一页添加页眉标记
    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const { width, height } = page.getSize();
        
        // 页眉标记文本（使用安全的文件名，不含空格和特殊字符）
        const markerText = `-----[${safeFileName}_page${i + 1}]-----`;
        
        // 字体大小
        const fontSize = 12;
        const textWidth = helveticaFont.widthOfTextAtSize(markerText, fontSize);
        
        // 在页眉中央位置绘制白色背景矩形（遮盖原有内容）
        const padding = 10;
        const rectX = (width - textWidth) / 2 - padding;
        const rectY = height - 30;
        const rectWidth = textWidth + padding * 2;
        const rectHeight = fontSize + 6;
        
        // 绘制白色背景矩形遮盖原有内容
        page.drawRectangle({
            x: rectX,
            y: rectY - 2,
            width: rectWidth,
            height: rectHeight,
            color: rgb(1, 1, 1),
        });
        
        // 绘制黑色边框
        page.drawRectangle({
            x: rectX,
            y: rectY - 2,
            width: rectWidth,
            height: rectHeight,
            borderColor: rgb(0, 0, 0),
            borderWidth: 1,
        });
        
        // 绘制页码标记文本
        page.drawText(markerText, {
            x: (width - textWidth) / 2,
            y: rectY,
            size: fontSize,
            font: helveticaFont,
            color: rgb(0, 0, 0),
        });
    }
    
    // 保存处理后的PDF
    processedPdfBytes = await pdfDoc.save();
    processedFileName = file.name;
    processedPageCount = pages.length;
    
    // 保存到IndexedDB（同时保存原始文件名和安全文件名用于匹配）
    await db.sourceFiles.where('name').equals(file.name).delete();
    await db.sourceFiles.add({
        name: file.name,
        safeName: safeFileName,  // 用于匹配 AI 返回的 source
        bankId: null,
        data: processedPdfBytes,
        type: 'application/pdf',
        createdAt: new Date().toISOString()
    });
    
    // 渲染预览
    await renderPdfPreview(processedPdfBytes);
    
    document.getElementById('pageStats').textContent = `${pages.length} pages`;
}

/**
 * 渲染PDF预览
 */
async function renderPdfPreview(pdfBytes) {
    const preview = document.getElementById('pdfPreview');
    preview.innerHTML = '';
    
    const pdfData = new Uint8Array(pdfBytes);
    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    
    // 只渲染前3页作为预览
    const pagesToRender = Math.min(3, pdf.numPages);
    
    for (let i = 1; i <= pagesToRender; i++) {
        const page = await pdf.getPage(i);
        const scale = 0.5;
        const viewport = page.getViewport({ scale });
        
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        
        const pageDiv = document.createElement('div');
        pageDiv.className = 'pdf-page-preview';
        pageDiv.appendChild(canvas);
        
        // 添加页码标签
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

/**
 * 移除文件
 */
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
        document.getElementById('fileList').classList.add('hidden');
        document.getElementById('pdfPreview').innerHTML = `<span class="text-slate-400 italic flex items-center justify-center h-full">${t('waitingUpload')}</span>`;
        processedPdfBytes = null;
        processedFileName = '';
        processedPageCount = 0;
        document.getElementById('genBtn').disabled = true;
        document.getElementById('pageStats').textContent = '';
    } else {
        await handleFiles(currentFiles);
    }
}

// ==================== 题库生成 ====================

/**
 * 获取生成提示词
 */
function getGeneratePrompt(count, lang) {
    const langInstruction = lang === 'zh' ? '使用中文' : 'Use English';
    
    return `You are an expert exam question creator. Create exactly ${count} multiple-choice questions based on the study material in the uploaded PDF file. 请按照页码顺序出题，题目出现的先后顺序应该对应文档中出现的先后顺序。

CRITICAL REQUIREMENTS:
1. ${langInstruction} ONLY
2. Each question MUST have exactly 4 options: A, B, C, D
3. Include explanation for each correct answer
4. Return ONLY a JSON array. No markdown, no code blocks, no explanations before or after.
5. The response must start with [ and end with ]
6. CRITICAL: For the "source" field, you MUST use the EXACT page marker format shown in the PDF header (e.g., "-----[filename_page1]-----")
7. CRITICAL: The "id" field MUST start from 1 and increment by 1 for each question (1, 2, 3, ..., ${count})

Required JSON format:
[
  {
    "id": 1,
    "question": "question text here",
    "options": {
      "A": "first option",
      "B": "second option", 
      "C": "third option",
      "D": "fourth option"
    },
    "correctAnswer": "A",
    "explanation": "explanation text",
    "source": "EXACT page marker from PDF header, e.g., -----[filename_page3]-----"
  }
]

Generate exactly ${count} questions with ids from 1 to ${count}. Use the page markers in the PDF headers to indicate source location. Output valid JSON only.`;
}

/**
 * 从文本中提取JSON
 */
function extractJSON(text) {
    let jsonStr = text.trim();
    jsonStr = jsonStr.replace(/```json\s*/gi, '');
    jsonStr = jsonStr.replace(/```\s*/g, '');
    
    const startIdx = jsonStr.indexOf('[');
    const endIdx = jsonStr.lastIndexOf(']');
    
    if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
        throw new Error('No JSON array found in response');
    }
    
    jsonStr = jsonStr.substring(startIdx, endIdx + 1);
    
    try {
        return JSON.parse(jsonStr);
    } catch (e) {
        let repaired = jsonStr;
        repaired = repaired.replace(/,\s*]/g, ']');
        repaired = repaired.replace(/,\s*}/g, '}');
        repaired = repaired.replace(/'/g, '"');
        repaired = repaired.replace(/\n/g, ' ');
        
        try {
            return JSON.parse(repaired);
        } catch (e2) {
            throw new Error('Invalid JSON format after repair attempts');
        }
    }
}

/**
 * 开始生成题库
 */
async function startGeneration() {
    if (!processedPdfBytes) {
        showToast(t('fillRequired'), 'error');
        return;
    }

    enableRefreshProtection();
    
    const totalCount = parseInt(document.getElementById('questionCount').value) || 20;
    const lang = document.querySelector('input[name="genLang"]:checked').value;
    
    document.getElementById('genProgress').classList.remove('hidden');
    
    const batchCount = Math.ceil(totalCount / 20);
    const estimatedSecondsPerBatch = 30;  // 每批约30秒
    const totalSeconds = Math.max(60, batchCount * estimatedSecondsPerBatch);
    let elapsedSeconds = 0;
    
    document.getElementById('timeEstimate').textContent = t('estimatedTime', totalSeconds);
    document.getElementById('questionProgressText').textContent = t('generatedCount', 0, totalCount);
    document.getElementById('progressBar').style.width = '0%';
    
    // 重置步骤显示
    resetProgressSteps();
    
    progressInterval = setInterval(() => {
        elapsedSeconds++;
        const remainingSeconds = totalSeconds - elapsedSeconds;
        const rawProgress = (elapsedSeconds / totalSeconds) * 100;
        const progressPercent = Math.min(rawProgress, 95);
        document.getElementById('progressBar').style.width = progressPercent + '%';
        document.getElementById('timeEstimate').textContent = remainingSeconds > 0 ? t('estimatedTime', remainingSeconds) : t('almostDone');
        const simulatedQuestionCount = Math.min(Math.floor((elapsedSeconds / totalSeconds) * totalCount), totalCount);
        document.getElementById('questionProgressText').textContent = t('generatedCount', simulatedQuestionCount, totalCount);
    }, 1000);
    
    try {
        // 上传PDF文件并生成题目
        const prompt = getGeneratePrompt(20, lang);  // 提示词固定20题，实际数量由count参数控制
        const result = await generateWithFile(processedPdfBytes, processedFileName, prompt, totalCount, processedPageCount, lang);
        
        generatedQuestions = result.questions.slice(0, totalCount);
        
        clearInterval(progressInterval);
        document.getElementById('progressBar').style.width = '100%';
        document.getElementById('questionProgressText').textContent = t('generatedCount', result.actualCount || totalCount, totalCount);
        document.getElementById('timeEstimate').textContent = t('estimatedTime', 0);
        document.getElementById('statusText').textContent = t('completed');
        
        setTimeout(() => {
            document.getElementById('genProgress').classList.add('hidden');
            disableRefreshProtection();
            
            // 如果是部分成功，显示警告
            if (result.partialSuccess && result.warning) {
                showPartialSuccessWarning(result.actualCount, result.requestedCount);
            }
            
            showResultModal(generatedQuestions);
        }, 500);
        
    } catch (err) {
        console.error('=== Generation Error Details ===');
        console.error('Error message:', err.message);
        console.error('Error name:', err.name);
        console.error('Error stack:', err.stack);
        console.error('Full error object:', err);
        console.error('=== End Error Details ===');
        clearInterval(progressInterval);
        document.getElementById('genProgress').classList.add('hidden');
        disableRefreshProtection();
        showToast(err.message, 'error');
    }
}

/**
 * 重置进度步骤显示
 */
function resetProgressSteps() {
    for (let i = 1; i <= 4; i++) {
        const step = document.getElementById(`step${i}`);
        step.className = 'flex items-center text-slate-400';
        const circle = step.querySelector('span');
        circle.className = 'w-5 h-5 rounded-full border-2 border-slate-300 flex items-center justify-center mr-2 text-xs';
        circle.textContent = i;
    }
}

/**
 * 更新进度步骤状态
 */
function updateProgressStep(stepNumber, status) {
    const step = document.getElementById(`step${stepNumber}`);
    const circle = step.querySelector('span:first-child');
    const text = step.querySelector('span:last-child');
    
    if (status === 'active') {
        step.className = 'flex items-center text-indigo-600 font-medium';
        circle.className = 'w-5 h-5 rounded-full border-2 border-indigo-600 flex items-center justify-center mr-2 text-xs bg-indigo-600 text-white';
    } else if (status === 'completed') {
        step.className = 'flex items-center text-emerald-600';
        circle.className = 'w-5 h-5 rounded-full border-2 border-emerald-600 flex items-center justify-center mr-2 text-xs bg-emerald-600 text-white';
        circle.textContent = '✓';
        text.textContent = t('stepCompleted');
    }
}

/**
 * 上传文件并生成题目
 */
async function generateWithFile(pdfBytes, fileName, prompt, totalCount, pageCount, lang) {
    // 第1步：上传文件到服务器
    updateProgressStep(1, 'active');
    
    // 创建FormData
    const formData = new FormData();
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    formData.append('file', blob, fileName);
    formData.append('prompt', prompt);
    formData.append('count', totalCount.toString());
    formData.append('pageCount', pageCount.toString());
    formData.append('lang', lang);
    
    // 第2步：服务器传输给AI
    updateProgressStep(1, 'completed');
    updateProgressStep(2, 'active');
    
    const response = await fetch(`${API_BASE}/generate-with-file`, {
        method: 'POST',
        body: formData
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${t('uploadError')}: ${response.status} - ${errorText}`);
    }

    // 第3步：AI处理文件
    updateProgressStep(2, 'completed');
    updateProgressStep(3, 'active');
    
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    
    // 第4步：AI生成题目完成
    updateProgressStep(3, 'completed');
    updateProgressStep(4, 'completed');
    
    const questions = extractJSON(data.content);
    
    // 确保ID正确
    questions.forEach((q, idx) => {
        q.id = idx + 1;
    });
    
    // 返回题目和可能的警告信息
    return {
        questions: questions,
        partialSuccess: data.partialSuccess,
        requestedCount: data.requestedCount,
        actualCount: data.actualCount,
        warning: data.warning,
    };
}

// ==================== 结果处理 ====================

/**
 * 显示结果模态框
 */
function showResultModal(questions) {
    const container = document.getElementById('resultPreview');
    container.innerHTML = '';
    
    questions.slice(0, 3).forEach((q, idx) => {
        const div = document.createElement('div');
        div.className = 'border border-slate-200 rounded-lg p-4 bg-slate-50';
        div.innerHTML = `
            <div class="font-medium text-slate-900 mb-2">Q${q.id}: ${q.question}</div>
            <div class="space-y-1 text-sm text-slate-600 mb-2">
                ${Object.entries(q.options).map(([k, v]) => `<div>${k}. ${v}</div>`).join('')}
            </div>
            <div class="text-sm font-medium text-emerald-600">Answer: ${q.correctAnswer}</div>
            <div class="text-xs text-slate-400 mt-1">Source: ${q.source}</div>
        `;
        container.appendChild(div);
    });
    
    if (questions.length > 3) {
        const more = document.createElement('div');
        more.className = 'text-center text-slate-500 text-sm';
        more.textContent = `... and ${questions.length - 3} more questions`;
        container.appendChild(more);
    }
    
    document.getElementById('resultModal').classList.remove('hidden');
}

/**
 * 显示部分成功警告
 */
function showPartialSuccessWarning(actualCount, requestedCount) {
    // 创建警告框
    const warningDiv = document.createElement('div');
    warningDiv.className = 'fixed top-20 left-1/2 transform -translate-x-1/2 z-50 bg-amber-50 border-2 border-amber-400 text-amber-800 px-6 py-4 rounded-xl shadow-xl max-w-md';
    warningDiv.innerHTML = `
        <div class="flex items-start">
            <svg class="w-6 h-6 mr-3 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
            </svg>
            <div>
                <p class="font-semibold mb-1">${t('partialSuccessTitle')}</p>
                <p class="text-sm">${t('partialSuccessMessage', actualCount, requestedCount)}</p>
                <p class="text-xs mt-2 text-amber-600">${t('partialSuccessHint')}</p>
            </div>
            <button onclick="this.parentElement.parentElement.remove()" class="ml-3 text-amber-600 hover:text-amber-800">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                </svg>
            </button>
        </div>
    `;
    document.body.appendChild(warningDiv);
    
    // 10秒后自动消失
    setTimeout(() => {
        if (warningDiv.parentElement) {
            warningDiv.remove();
        }
    }, 10000);
}

/**
 * 放弃生成结果
 */
function discardResult() {
    if (confirm(t('discardConfirm'))) {
        generatedQuestions = [];
        document.getElementById('resultModal').classList.add('hidden');
        showToast('Discarded', 'success');
    }
}

/**
 * 保存题库并开始练习
 */
async function saveAndPractice() {
    const name = prompt(currentLang === 'zh' ? '请输入题库名称:' : 
                       currentLang === 'zh-TW' ? '請輸入題庫名稱:' : 
                       currentLang === 'ko' ? '문제은행 이름을 입력하세요:' :
                       'Enter question bank name:', 
        processedFileName.replace(/\.pdf$/i, '') || 'New Bank');
    
    if (!name) return;
    
    const bank = {
        name: name,
        questions: generatedQuestions,
        favorites: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    
    const id = await db.questionBanks.add(bank);
    
    if (processedFileName) {
        try {
            await db.sourceFiles.where('name').equals(processedFileName).modify({ bankId: id });
        } catch (err) {
            console.error('Failed to update bankId for file:', processedFileName, err);
        }
    }
    
    document.getElementById('resultModal').classList.add('hidden');
    showToast(t('saveSuccess'), 'success');
    
    window.location.href = `practice.html?id=${id}`;
}

// ==================== UI 工具 ====================

/**
 * 显示提示消息
 */
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    const icon = document.getElementById('toastIcon');
    const msg = document.getElementById('toastMessage');
    
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

// ==================== 初始化 ====================

// 将需要在 HTML 内联事件处理器中调用的函数挂载到 window 对象
window.toggleLangDropdown = toggleLangDropdown;
window.changeLanguage = changeLanguage;
window.removeFile = removeFile;
window.startGeneration = startGeneration;
window.discardResult = discardResult;
window.saveAndPractice = saveAndPractice;
window.showPartialSuccessWarning = showPartialSuccessWarning;

document.addEventListener('DOMContentLoaded', () => {
    updateLanguage();
    setupDropZone();
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
});
