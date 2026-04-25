// fileViewer.js - 简化版 PPT 渲染（文本优先）
const fileViewer = (function() {
    'use strict';
    
    let currentSourceFile = { 
        data: null, 
        filename: null, 
        page: null, 
        type: null,
        zip: null,
        totalSlides: 0,
        slideFiles: [],
        slidesText: []
    };

    let translateFn = (key) => key;

    function init(t) {
        translateFn = t || ((key) => key);
    }

    function t(key) {
        return translateFn(key);
    }

    function setSource(fileRecord, sourceInfo) {
        currentSourceFile = {
            data: fileRecord.data,
            filename: fileRecord.name,
            type: fileRecord.type,
            page: sourceInfo.location,
            locationType: sourceInfo.locationType,
            zip: null,
            totalSlides: 0,
            slideFiles: [],
            slidesText: []
        };
    }

    function clear() {
        currentSourceFile = { 
            data: null, 
            filename: null, 
            page: null, 
            type: null, 
            zip: null,
            totalSlides: 0,
            slideFiles: [],
            slidesText: []
        };
    }

    // =================== PDF 渲染（使用 pdf.js canvas，支持中文 CMap） ===================
    async function renderPDF(container, controls) {
        const pdfData = new Uint8Array(currentSourceFile.data);
        const targetPage = currentSourceFile.page || 1;
        
        // 使用 pdf.js 加载 PDF，配置 CMap 以支持中文 CID 字体
        const loadingTask = pdfjsLib.getDocument({
            data: pdfData,
            cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
            cMapPacked: true,
            standardFontDataUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/standard_fonts/',
        });
        
        const pdf = await loadingTask.promise;
        const totalPages = pdf.numPages;
        let currentPage = Math.min(Math.max(1, targetPage), totalPages);
        
        // 创建 canvas 容器
        const canvas = document.createElement('canvas');
        canvas.style.display = 'block';
        canvas.style.margin = '0 auto';
        canvas.style.maxWidth = '100%';
        
        const wrapper = document.createElement('div');
        wrapper.className = 'pdf-canvas-wrapper bg-white rounded-lg overflow-auto flex justify-center';
        wrapper.style.maxHeight = '70vh';
        wrapper.style.borderRadius = '8px';
        wrapper.appendChild(canvas);
        container.appendChild(wrapper);
        
        // 页码信息
        const pageInfo = document.createElement('div');
        pageInfo.id = 'pdfPageInfo';
        pageInfo.className = 'text-center text-sm text-slate-500 mt-3';
        container.appendChild(pageInfo);
        
        // 渲染单页函数
        async function renderPage(pageNum) {
            const page = await pdf.getPage(pageNum);
            
            // 根据容器宽度计算合适的缩放比例（移动端自适应）
            const wrapperWidth = wrapper.clientWidth || 600;
            const rawViewport = page.getViewport({ scale: 1 });
            const scale = Math.min(1.5, (wrapperWidth - 32) / rawViewport.width);
            const viewport = page.getViewport({ scale });
            
            // 处理设备像素比，保证 Retina 屏幕清晰度
            const dpr = window.devicePixelRatio || 1;
            canvas.width = viewport.width * dpr;
            canvas.height = viewport.height * dpr;
            canvas.style.width = viewport.width + 'px';
            canvas.style.height = viewport.height + 'px';
            
            const context = canvas.getContext('2d');
            context.scale(dpr, dpr);
            
            await page.render({
                canvasContext: context,
                viewport: viewport
            }).promise;
            
            pageInfo.textContent = `${t('page') || '页'} ${pageNum} / ${totalPages}`;
            
            // 目标页高亮边框
            if (pageNum === targetPage && targetPage > 1) {
                wrapper.style.border = '4px solid #f59e0b';
            } else {
                wrapper.style.border = 'none';
            }
        }
        
        await renderPage(currentPage);
        
        // 添加翻页控件
        if (totalPages > 1) {
            controls.innerHTML = `
                <div class="flex items-center justify-center space-x-4">
                    <button id="pdfPrevBtn" class="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
                    </button>
                    <span id="pdfPageNumDisplay" class="font-medium text-slate-700 text-sm">${currentPage} / ${totalPages}</span>
                    <button id="pdfNextBtn" class="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                    </button>
                </div>
            `;
            
            const prevBtn = document.getElementById('pdfPrevBtn');
            const nextBtn = document.getElementById('pdfNextBtn');
            const pageDisplay = document.getElementById('pdfPageNumDisplay');
            
            prevBtn.onclick = async () => {
                if (currentPage > 1) {
                    currentPage--;
                    await renderPage(currentPage);
                    pageDisplay.textContent = `${currentPage} / ${totalPages}`;
                    prevBtn.disabled = currentPage <= 1;
                    nextBtn.disabled = currentPage >= totalPages;
                }
            };
            
            nextBtn.onclick = async () => {
                if (currentPage < totalPages) {
                    currentPage++;
                    await renderPage(currentPage);
                    pageDisplay.textContent = `${currentPage} / ${totalPages}`;
                    prevBtn.disabled = currentPage <= 1;
                    nextBtn.disabled = currentPage >= totalPages;
                }
            };
            
            prevBtn.disabled = currentPage <= 1;
            nextBtn.disabled = currentPage >= totalPages;
        } else {
            controls.innerHTML = '';
        }
    }

    // =================== 文本文件渲染 ===================
    function renderTextFile(container) {
        const decoder = new TextDecoder('utf-8');
        const text = decoder.decode(currentSourceFile.data);
        const pre = document.createElement('pre');
        pre.className = 'text-viewer bg-white p-6 rounded-lg shadow';
        if (currentSourceFile.page) {
            const lines = text.split('\n');
            const pageSize = 50;
            const startLine = (currentSourceFile.page - 1) * pageSize;
            const endLine = startLine + pageSize;
            let displayText = '';
            if (startLine > 0) displayText += `... (${startLine} lines above) ...\n\n`;
            displayText += lines.slice(startLine, endLine).join('\n');
            if (endLine < lines.length) displayText += `\n\n... (${lines.length - endLine} lines below) ...`;
            pre.textContent = displayText;
            pre.classList.add('page-highlight');
        } else {
            pre.textContent = text;
        }
        container.appendChild(pre);
    }

    // =================== Word 文件渲染 ===================
    async function renderWordFile(container) {
        const result = await mammoth.convertToHtml({ arrayBuffer: currentSourceFile.data }, {
            styleMap: ["p[style-name='Heading 1'] => h1", "p[style-name='Heading 2'] => h2", "p[style-name='Heading 3'] => h3", "p[style-name='Heading 4'] => h4"]
        });
        const wrapper = document.createElement('div');
        wrapper.className = 'word-content bg-white p-8 rounded-lg shadow max-w-4xl mx-auto overflow-auto max-h-[70vh]';
        if (currentSourceFile.page && currentSourceFile.locationType === 'section') {
            wrapper.innerHTML = `<div class="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6"><p class="text-amber-800 font-medium text-center">📍 ${t('section')} ${currentSourceFile.page} <span class="text-sm text-amber-600">(${t('approximateLocation')})</span></p></div>${result.value}`;
            setTimeout(() => {
                const headings = wrapper.querySelectorAll('h1, h2, h3, h4');
                if (headings.length >= currentSourceFile.page) {
                    const target = headings[currentSourceFile.page - 1];
                    if (target) {
                        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        target.style.backgroundColor = '#fef3c7';
                        target.style.padding = '8px';
                        target.style.borderRadius = '4px';
                    }
                }
            }, 100);
        } else {
            wrapper.innerHTML = result.value;
        }
        container.appendChild(wrapper);
    }

    // =================== Excel 文件渲染 ===================
    async function renderExcelFile(container, controls) {
        const workbook = XLSX.read(currentSourceFile.data, { type: 'array' });
        const sheetNames = workbook.SheetNames;
        const targetSheet = currentSourceFile.page ? Math.min(currentSourceFile.page - 1, sheetNames.length - 1) : 0;
        const tabsContainer = document.createElement('div');
        tabsContainer.className = 'flex space-x-2 mb-4 overflow-x-auto pb-2';
        sheetNames.forEach((name, idx) => {
            const tab = document.createElement('button');
            tab.className = `px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${idx === targetSheet ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200'}`;
            tab.textContent = name;
            tab.onclick = () => fileViewer.switchExcelSheet(idx);
            tabsContainer.appendChild(tab);
        });
        container.appendChild(tabsContainer);
        const tableContainer = document.createElement('div');
        tableContainer.id = 'excelTableContainer';
        tableContainer.className = 'excel-table-container bg-white rounded-lg shadow';
        container.appendChild(tableContainer);
        renderExcelWorkbook(workbook, targetSheet);
    }

    function renderExcelWorkbook(workbook, sheetIndex) {
        const sheetName = workbook.SheetNames[sheetIndex];
        const worksheet = workbook.Sheets[sheetName];
        const html = XLSX.utils.sheet_to_html(worksheet, { id: 'excelTable', editable: false });
        const container = document.getElementById('excelTableContainer');
        if (container) {
            container.innerHTML = html;
            const table = container.querySelector('#excelTable');
            if (table) table.className = 'excel-table';
        }
    }

    function switchExcelSheet(index) {
        const tabs = document.querySelectorAll('#viewerContent > div:first-child button');
        tabs.forEach((tab, idx) => tab.className = `px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${idx === index ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200'}`);
        const workbook = XLSX.read(currentSourceFile.data, { type: 'array' });
        renderExcelWorkbook(workbook, index);
    }

    // =================== PPT 渲染（简化版 - 文本优先） ===================
    async function renderPPTFile(container, controls) {
        if (!currentSourceFile.zip) {
            currentSourceFile.zip = await JSZip.loadAsync(currentSourceFile.data);
        }
        const zip = currentSourceFile.zip;
        
        // 获取所有幻灯片文件
        const slideFiles = Object.keys(zip.files).filter(name => 
            name.startsWith('ppt/slides/slide') && name.endsWith('.xml')
        ).sort((a, b) => {
            const numA = parseInt(a.match(/slide(\d+)\.xml/)[1]);
            const numB = parseInt(b.match(/slide(\d+)\.xml/)[1]);
            return numA - numB;
        });
        
        const targetSlide = currentSourceFile.page || 1;
        currentSourceFile.totalSlides = slideFiles.length;
        currentSourceFile.slideFiles = slideFiles;
        
        // 提取所有幻灯片的文本
        if (!currentSourceFile.slidesText || currentSourceFile.slidesText.length === 0) {
            currentSourceFile.slidesText = await extractAllSlidesText(zip, slideFiles);
        }
        
        // 导航控制 + 下载提示
        const navDiv = document.createElement('div');
        navDiv.className = 'flex items-center justify-between mb-4 bg-white p-3 rounded-lg shadow sticky top-0 z-20';
        navDiv.innerHTML = `
            <div class="flex items-center space-x-4">
                <button onclick="fileViewer.changeSlide(-1)" class="p-2 rounded hover:bg-slate-100 ${targetSlide <= 1 ? 'opacity-30 cursor-not-allowed' : ''}" ${targetSlide <= 1 ? 'disabled' : ''}>
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
                </button>
                <span class="font-medium text-slate-700">${t('slide')} <span id="currentSlideNum">${targetSlide}</span> / ${slideFiles.length}</span>
                <button onclick="fileViewer.changeSlide(1)" class="p-2 rounded hover:bg-slate-100 ${targetSlide >= slideFiles.length ? 'opacity-30 cursor-not-allowed' : ''}" ${targetSlide >= slideFiles.length ? 'disabled' : ''}>
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                </button>
            </div>
            <button onclick="fileViewer.download()" class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium flex items-center">
                <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                下载用 PowerPoint 打开
            </button>
        `;
        container.appendChild(navDiv);
        
        // PPT 文本提示
        const noticeDiv = document.createElement('div');
        noticeDiv.className = 'mb-3 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800';
        noticeDiv.textContent = t('pptTextOnly');
        container.appendChild(noticeDiv);
        
        // 幻灯片内容容器
        const contentWrapper = document.createElement('div');
        contentWrapper.id = 'pptContentWrapper';
        contentWrapper.className = 'bg-white rounded-lg shadow p-8 overflow-auto';
        contentWrapper.style.height = 'calc(90vh - 180px)';
        contentWrapper.style.minHeight = '400px';
        container.appendChild(contentWrapper);
        
        // 渲染当前幻灯片
        await renderSimpleSlide(targetSlide - 1, contentWrapper);
    }
    
    // 提取所有幻灯片的文本内容
    async function extractAllSlidesText(zip, slideFiles) {
        const slidesText = [];
        for (let i = 0; i < slideFiles.length; i++) {
            try {
                const content = await zip.files[slideFiles[i]].async('text');
                const texts = extractSlideTexts(content);
                slidesText.push(texts);
            } catch (e) {
                slidesText.push([]);
            }
        }
        return slidesText;
    }
    
    // 从幻灯片 XML 中提取所有文本
    function extractSlideTexts(xmlContent) {
        const texts = [];
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlContent, 'application/xml');
        
        // 获取所有文本元素 <a:t>
        const allElements = xmlDoc.getElementsByTagName('*');
        for (let i = 0; i < allElements.length; i++) {
            const el = allElements[i];
            const tagName = el.tagName;
            const localName = tagName.includes(':') ? tagName.split(':')[1] : tagName;
            
            if (localName === 't' && el.textContent && el.textContent.trim()) {
                // 尝试判断是否为标题（基于字体大小或位置）
                let isTitle = false;
                let parent = el.parentNode;
                
                while (parent && parent.tagName) {
                    const parentLocal = parent.tagName.includes(':') ? 
                        parent.tagName.split(':')[1] : parent.tagName;
                    
                    if (parentLocal === 'rPr') {
                        const sz = parent.getAttribute('sz') || parent.getAttributeNS('*', 'sz');
                        if (sz && parseInt(sz) > 1200) {
                            isTitle = true;
                        }
                    }
                    parent = parent.parentNode;
                }
                
                texts.push({
                    text: el.textContent.trim(),
                    isTitle: isTitle
                });
            }
        }
        
        return texts;
    }
    
    // 简化渲染幻灯片
    async function renderSimpleSlide(slideIndex, container) {
        container.innerHTML = '';
        const texts = currentSourceFile.slidesText[slideIndex] || [];
        const isTargetSlide = (slideIndex + 1) === currentSourceFile.page;
        
        if (isTargetSlide) {
            container.style.border = '4px solid #f59e0b';
            container.style.borderRadius = '8px';
        } else {
            container.style.border = 'none';
        }
        
        if (texts.length === 0) {
            container.innerHTML = '<div class="text-center text-slate-400 py-12">此幻灯片无文本内容</div>';
            return;
        }
        
        // 显示文本
        texts.forEach((item, idx) => {
            const div = document.createElement('div');
            div.className = item.isTitle ? 'text-xl font-bold text-slate-800 mb-3 mt-4' : 'text-base text-slate-600 mb-2';
            div.textContent = item.text;
            container.appendChild(div);
        });
    }
    
    // PPT 翻页
    async function changeSlide(delta) {
        const current = parseInt(document.getElementById('currentSlideNum')?.textContent || 1);
        const newIndex = current + delta;
        const total = currentSourceFile.totalSlides;
        
        if (newIndex >= 1 && newIndex <= total) {
            const contentWrapper = document.getElementById('pptContentWrapper');
            if (contentWrapper) {
                await renderSimpleSlide(newIndex - 1, contentWrapper);
                document.getElementById('currentSlideNum').textContent = newIndex;
                
                // 更新导航按钮状态
                const buttons = document.querySelectorAll('#viewerContent button');
                if (buttons[0]) {
                    buttons[0].disabled = newIndex <= 1;
                    buttons[0].classList.toggle('opacity-30', newIndex <= 1);
                }
                if (buttons[2]) {
                    buttons[2].disabled = newIndex >= total;
                    buttons[2].classList.toggle('opacity-30', newIndex >= total);
                }
            }
        }
    }

    // =================== 通用渲染 ===================
    function renderGenericFile(container) {
        renderDownloadFallback(container, null);
    }

    function renderDownloadFallback(container, errorMsg) {
        container.innerHTML = `
            <div class="bg-white rounded-lg p-8 text-center shadow max-w-md mx-auto mt-8">
                <div class="text-6xl mb-4">⚠️</div>
                <h3 class="font-bold text-lg text-slate-900 mb-2">${t('previewFailed')}</h3>
                ${errorMsg ? `<p class="text-slate-500 mb-4 text-sm">${errorMsg}</p>` : ''}
                <p class="text-slate-500 mb-6 text-sm">${t('cannotPreview')}</p>
                <button onclick="fileViewer.download()" class="px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-medium">下载文件查看</button>
            </div>
        `;
    }

    function download() {
        if (!currentSourceFile.data) return;
        const blob = new Blob([currentSourceFile.data], { type: currentSourceFile.type || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = currentSourceFile.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function close() {
        document.getElementById('sourceViewerModal')?.classList.add('hidden');
        clear();
    }

    async function render() {
        const container = document.getElementById('viewerContent');
        const controls = document.getElementById('viewerControls');
        if (!container || !controls) return;
        
        container.innerHTML = '';
        controls.innerHTML = '';
        const ext = currentSourceFile.filename.split('.').pop().toLowerCase();
        
        try {
            if (ext === 'pdf') await renderPDF(container, controls);
            else if (ext === 'txt') renderTextFile(container);
            else if (['docx', 'doc'].includes(ext)) await renderWordFile(container);
            else if (['xlsx', 'xls'].includes(ext)) await renderExcelFile(container, controls);
            else if (['pptx', 'ppt'].includes(ext)) await renderPPTFile(container, controls);
            else renderGenericFile(container);
        } catch (err) {
            console.error('Error rendering source file:', err);
            renderDownloadFallback(container, err.message);
        }
    }

    return {
        init,
        setSource,
        render,
        download,
        close,
        switchExcelSheet,
        changeSlide
    };
})();

window.fileViewer = fileViewer;
