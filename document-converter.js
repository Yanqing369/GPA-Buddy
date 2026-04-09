/**
 * Universal Document Converter
 * 支持 PPTX, DOCX, XLSX, TXT 转 PDF（浏览器端）
 * @version 2.0.0
 * @license MIT
 */

(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' 
    ? module.exports = factory() 
    : typeof define === 'function' && define.amd 
    ? define(factory) 
    : (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.DocumentConverter = factory());
})(this, function () {
  'use strict';

  class UniversalConverter {
    constructor(options = {}) {
      this.options = {
        fontUrl: options.fontUrl || 'https://cdn.jsdelivr.net/gh/adobe-fonts/source-han-sans@release/SubsetOTF/CN/SourceHanSansCN-Regular.otf',
        scale: options.scale || 1,
        lineHeightRatio: options.lineHeightRatio || 1.5,
        pageSize: options.pageSize || 'A4',
        margins: options.margins || { top: 50, right: 50, bottom: 50, left: 50 },
        onProgress: options.onProgress || (() => {}),
        onError: options.onError || console.error
      };
      
      this.fontBytes = null;
      this.isFontLoaded = false;
      this._checkDependencies();
    }

    _checkDependencies() {
      const deps = {
        'PDFLib': 'pdf-lib',
        'fontkit': '@pdf-lib/fontkit',
        'pptxtojson': 'pptxtojson (for PPTX)',
        'mammoth': 'mammoth (for DOCX)',
        'XLSX': 'xlsx (for Excel)'
      };
      
      const missing = Object.keys(deps).filter(key => typeof window[key] === 'undefined');
      if (missing.length) {
        console.warn('Optional dependencies not loaded:', missing.map(k => deps[k]).join(', '));
      }
    }

    async loadFont() {
      if (this.fontBytes) return;
      try {
        this.options.onProgress(0, 100, 'loading-font');
        const res = await fetch(this.options.fontUrl, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        this.fontBytes = await res.arrayBuffer();
        this.isFontLoaded = true;
        this.options.onProgress(100, 100, 'font-loaded');
      } catch (e) {
        throw new Error(`字体加载失败: ${e.message}`);
      }
    }

    setFont(arrayBuffer) {
      this.fontBytes = arrayBuffer;
      this.isFontLoaded = true;
    }

    async convert(file, options = {}) {
      const ext = file.name.split('.').pop().toLowerCase();
      const arrayBuffer = await file.arrayBuffer();
      
      const opts = {
        filename: options.filename || file.name.replace(/\.[^/.]+$/, '.pdf'),
        download: options.download !== false,
        ...options
      };

      switch(ext) {
        case 'pptx':
          return this._convertPptx(arrayBuffer, opts);
        case 'docx':
          return this._convertDocx(arrayBuffer, opts);
        case 'xlsx':
        case 'xls':
          return this._convertExcel(arrayBuffer, opts);
        case 'txt':
          return this._convertTxt(arrayBuffer, opts);
        default:
          throw new Error(`不支持的格式: ${ext}`);
      }
    }

    async _convertPptx(buffer, options) {
      if (!window.pptxtojson) throw new Error('请加载 pptxtojson 库');
      
      const data = await window.pptxtojson.parse(buffer, {
        imageMode: 'base64', videoMode: 'none', audioMode: 'none'
      });

      const { PDFDocument, rgb } = window.PDFLib;
      const pdfDoc = await PDFDocument.create();
      
      // PPTX 转换需要中文字体，否则中文会乱码
      if (!this.fontBytes) {
        throw new Error('中文字体未加载，请先调用 loadFont()');
      }
      
      pdfDoc.registerFontkit(window.fontkit);
      const font = await pdfDoc.embedFont(this.fontBytes);

      const { width: pptW, height: pptH } = data.size;
      const scale = this.options.scale;
      
      for (let i = 0; i < data.slides.length; i++) {
        this.options.onProgress(i + 1, data.slides.length, 'converting-pptx');
        
        const page = pdfDoc.addPage([pptW * scale, pptH * scale]);
        const slide = data.slides[i];
        
        // 提取并整理当前页的所有内容
        await this._renderSlideAsDocument(page, slide, font, scale, pptW, pptH);
      }

      return this._savePdf(pdfDoc, options);
    }

    /**
     * 将单页幻灯片内容整理为文档形式输出
     * 文本按层级罗列，图片单独放置
     */
    async _renderSlideAsDocument(page, slide, font, scale, pptW, pptH) {
      const { rgb } = window.PDFLib;
      const pageWidth = page.getSize().width;
      const pageHeight = page.getSize().height;
      
      // 边距设置
      const margin = 30 * scale;
      const contentWidth = pageWidth - margin * 2;
      const contentHeight = pageHeight - margin * 2;
      
      // 分离不同类型的元素（递归处理 group）
      const textElements = [];
      const imageElements = [];
      const tableElements = [];
      
      // 递归收集元素的函数
      const collectElements = (elements) => {
        (elements || []).forEach(el => {
          if (el.type === 'group') {
            // 递归处理 group 内部的元素
            collectElements(el.elements);
          } else if (el.type === 'text' || el.type === 'shape') {
            if (el.content && el.content.trim()) {
              textElements.push(el);
            }
          } else if (el.type === 'image' && el.base64) {
            imageElements.push(el);
          } else if (el.type === 'table' && el.data) {
            tableElements.push(el);
          }
        });
      };
      
      collectElements(slide.elements);
      
      // 按垂直位置排序文本元素（从上到下）
      textElements.sort((a, b) => (a.top || 0) - (b.top || 0));
      
      // 当前绘制位置
      let currentY = pageHeight - margin;
      const fontSize = 11 * scale;
      const lineHeight = fontSize * 1.5;
      
      // 绘制所有文本内容
      for (const el of textElements) {
        // 提取纯文本（去除HTML标签）
        const plainText = this._extractPlainText(el.content);
        if (!plainText.trim()) continue;
        
        // 检查是否还有空间
        if (currentY < margin + lineHeight) {
          break; // 页面满了，停止绘制
        }
        
        // 绘制元素名称（如果有）
        if (el.name) {
          page.drawText(`[${el.name}]`, {
            x: margin,
            y: currentY - fontSize,
            size: fontSize * 0.8,
            font,
            color: rgb(0.5, 0.5, 0.5)
          });
          currentY -= lineHeight;
        }
        
        // 将文本按行分割并绘制
        const lines = this._wrapTextToLines(plainText, font, fontSize, contentWidth);
        for (const line of lines) {
          if (currentY < margin + lineHeight) break;
          
          page.drawText(line, {
            x: margin,
            y: currentY - fontSize,
            size: fontSize,
            font,
            color: rgb(0, 0, 0)
          });
          currentY -= lineHeight;
        }
        
        // 元素之间加间距
        currentY -= lineHeight * 0.5;
      }
      
      // 在右侧或底部绘制图片缩略图
      if (imageElements.length > 0) {
        await this._renderImagesCompact(page, imageElements, font, scale, pageWidth, pageHeight, margin, currentY);
      }
      
      // 绘制表格内容（文本形式）
      for (const table of tableElements) {
        if (currentY < margin + lineHeight * 3) break;
        
        page.drawText('[Table]', {
          x: margin,
          y: currentY - fontSize,
          size: fontSize * 0.9,
          font,
          color: rgb(0.3, 0.3, 0.3)
        });
        currentY -= lineHeight;
        
        // 简单输出表格文本内容
        if (table.data && Array.isArray(table.data)) {
          for (const row of table.data.slice(0, 10)) { // 最多显示10行
            if (currentY < margin + lineHeight) break;
            const rowText = row.map(cell => String(cell || '').substring(0, 20)).join(' | ');
            const displayText = rowText.length > 100 ? rowText.substring(0, 100) + '...' : rowText;
            
            page.drawText(displayText, {
              x: margin + 10,
              y: currentY - fontSize,
              size: fontSize * 0.85,
              font,
              color: rgb(0.2, 0.2, 0.2)
            });
            currentY -= lineHeight * 0.9;
          }
        }
        currentY -= lineHeight;
      }
    }

    /**
     * 紧凑地渲染图片（放在右侧或底部）
     */
    async _renderImagesCompact(page, images, font, scale, pageWidth, pageHeight, margin, availableY) {
      const { rgb } = window.PDFLib;
      
      // 图片显示在右侧栏
      const rightColumnX = pageWidth * 0.65;
      const rightColumnWidth = pageWidth * 0.35 - margin;
      let imageY = pageHeight - margin - 20;
      
      // 如果左侧文本内容很多，图片从顶部开始；否则也可以放底部
      const maxImageHeight = 80 * scale;
      const maxImageWidth = rightColumnWidth - 10;
      
      for (let i = 0; i < Math.min(images.length, 5); i++) { // 最多显示5张图
        const el = images[i];
        if (!el.base64) continue;
        
        try {
          let img;
          const mimeType = el.base64.match(/data:([^;]+);/)?.[1] || '';
          
          // 对于不支持的格式（tif, gif等），先用Canvas转换为PNG
          if (mimeType.includes('tif') || mimeType.includes('gif') || mimeType.includes('bmp') || mimeType.includes('webp')) {
            const convertedPng = await this._convertImageToPng(el.base64);
            if (convertedPng && convertedPng.tiffUnsupported) {
              // TIF无法解码，显示占位文本
              const drawWidth = 60 * scale;
              const drawHeight = 40 * scale;
              
              page.drawText('[TIF Image]', {
                x: rightColumnX + (rightColumnWidth - drawWidth) / 2,
                y: imageY - drawHeight / 2,
                size: 8 * scale,
                font,
                color: rgb(0.5, 0.5, 0.5)
              });
              
              imageY -= drawHeight + 10;
              continue;
            } else if (convertedPng) {
              const pngBase64 = convertedPng.split(',')[1];
              const pngBytes = Uint8Array.from(atob(pngBase64), c => c.charCodeAt(0));
              img = await page.doc.embedPng(pngBytes);
            } else {
              continue;
            }
          } else if (el.base64.includes('image/png')) {
            const base64 = el.base64.split(',')[1];
            const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
            img = await page.doc.embedPng(bytes);
          } else if (el.base64.includes('image/jpeg')) {
            const base64 = el.base64.split(',')[1];
            const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
            img = await page.doc.embedJpg(bytes);
          } else {
            continue;
          }
          
          // 计算缩放尺寸
          const imgSize = img.size();
          const scaleRatio = Math.min(
            maxImageWidth / imgSize.width,
            maxImageHeight / imgSize.height,
            1
          );
          const drawWidth = imgSize.width * scaleRatio;
          const drawHeight = imgSize.height * scaleRatio;
          
          // 检查空间是否足够
          if (imageY - drawHeight < margin) {
            break; // 空间不够，停止绘制图片
          }
          
          // 绘制图片
          page.drawImage(img, {
            x: rightColumnX + (rightColumnWidth - drawWidth) / 2,
            y: imageY - drawHeight,
            width: drawWidth,
            height: drawHeight
          });
          
          imageY -= drawHeight + 10;
          
        } catch (e) {
          // 图片处理失败，跳过
        }
      }
    }

    /**
     * 将不支持的图片格式（TIF, GIF等）转换为PNG
     * 使用Canvas进行转换
     */
    async _convertImageToPng(base64Data) {
      // 检测是否是TIF格式
      const isTiff = base64Data.includes('image/tiff') || base64Data.includes('image/tif');
      
      if (isTiff) {
        // TIF需要特殊处理，浏览器不支持原生解码
        return await this._convertTiffToPng(base64Data);
      }
      
      // 其他格式（GIF, BMP, WebP等）用Canvas转换
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        
        img.onload = () => {
          try {
            const pngBase64 = this._imageToCanvasPng(img);
            resolve(pngBase64);
          } catch (e) {
            resolve(null);
          }
        };
        
        img.onerror = () => {
          resolve(null);
        };
        
        img.src = base64Data;
      });
    }

    /**
     * 将图片元素转换为PNG base64
     */
    _imageToCanvasPng(img) {
      // 限制转换后的最大尺寸，防止内存爆炸
      const maxSize = 2000;
      let width = img.width;
      let height = img.height;
      
      if (width > maxSize || height > maxSize) {
        const ratio = Math.min(maxSize / width, maxSize / height);
        width = Math.floor(width * ratio);
        height = Math.floor(height * ratio);
      }
      
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      
      return canvas.toDataURL('image/png');
    }

    /**
     * TIF转PNG
     * 如果页面引入了 tiff.js 库，则使用它解码；否则返回null
     */
    async _convertTiffToPng(base64Data) {
      // 检查是否有 tiff.js 库可用
      if (typeof window.Tiff !== 'undefined') {
        try {
          const tiff = new window.Tiff({ buffer: this._base64ToArrayBuffer(base64Data) });
          const canvas = tiff.toCanvas();
          tiff.close();
          
          if (canvas) {
            return canvas.toDataURL('image/png');
          }
        } catch (e) {
          console.warn('TIF解码失败:', e);
        }
      }
      
      // 没有tiff.js或解码失败，尝试用Image直接加载（某些浏览器可能支持）
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        
        img.onload = () => {
          try {
            const pngBase64 = this._imageToCanvasPng(img);
            resolve(pngBase64);
          } catch (e) {
            resolve(null);
          }
        };
        
        img.onerror = () => {
          // TIF无法解码，返回特殊标记
          resolve({ tiffUnsupported: true, data: base64Data });
        };
        
        img.src = base64Data;
      });
    }

    /**
     * base64转ArrayBuffer（用于tiff.js）
     */
    _base64ToArrayBuffer(base64) {
      const base64Str = base64.split(',')[1] || base64;
      const binary = atob(base64Str);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes.buffer;
    }

    /**
     * 从HTML内容中提取纯文本，保留换行格式
     */
    _extractPlainText(html) {
      if (!html) return '';
      
      // 如果是纯文本（没有HTML标签），直接返回
      if (!/<[a-zA-Z][^>]*>/.test(html)) {
        return html;
      }
      
      // 使用DOM解析提取文本
      const div = document.createElement('div');
      div.innerHTML = html;
      
      // 递归遍历所有节点，在块级元素之间插入换行
      const extractWithNewlines = (node) => {
        const result = [];
        
        node.childNodes.forEach(child => {
          if (child.nodeType === Node.TEXT_NODE) {
            const text = child.textContent;
            if (text) result.push(text);
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            const tag = child.tagName.toLowerCase();
            
            // 处理 <br> 标签
            if (tag === 'br') {
              result.push('\n');
              return;
            }
            
            // 处理块级元素：段落、列表项、标题、div 等
            // 在这些元素前加换行（如果不是第一个元素）
            const blockTags = ['p', 'li', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th'];
            const isBlock = blockTags.includes(tag);
            
            if (isBlock && result.length > 0) {
              // 如果前一个不是换行，添加换行
              const last = result[result.length - 1];
              if (!last.endsWith('\n')) {
                result.push('\n');
              }
            }
            
            // 递归处理子节点
            const childText = extractWithNewlines(child);
            if (childText) result.push(childText);
            
            // 块级元素后加换行
            if (isBlock) {
              const last = result[result.length - 1];
              if (last && !last.endsWith('\n')) {
                result.push('\n');
              }
            }
          }
        });
        
        return result.join('');
      };
      
      let text = extractWithNewlines(div);
      
      // 清理多余换行：多个连续换行保留为单个
      text = text.replace(/\n{3,}/g, '\n\n');
      
      // 合并多个连续空格为单个空格，但保留换行符
      // 把 \n 暂时保护起来
      text = text.replace(/\n/g, '\x00');
      text = text.replace(/\s+/g, ' ');
      text = text.replace(/\x00/g, '\n');
      text = text.trim();
      
      return text;
    }

    /**
     * 将文本按宽度分割成多行，保留原有的换行符
     */
    _wrapTextToLines(text, font, fontSize, maxWidth) {
      const lines = [];
      
      // 先按原有换行符分割段落
      const paragraphs = text.split('\n');
      
      for (let p = 0; p < paragraphs.length; p++) {
        const para = paragraphs[p];
        
        // 空段落（连续换行）保留为空行
        if (!para) {
          lines.push('');
          continue;
        }
        
        // 对每一段按宽度自动换行
        const chars = para.split('');
        let currentLine = '';
        let currentWidth = 0;
        
        for (const char of chars) {
          const charWidth = font.widthOfTextAtSize(char, fontSize);
          
          // 检查是否需要自动换行
          if (currentWidth + charWidth > maxWidth && currentLine) {
            lines.push(currentLine);
            currentLine = char;
            currentWidth = charWidth;
          } else {
            currentLine += char;
            currentWidth += charWidth;
          }
        }
        
        // 添加段落的最后一行
        if (currentLine || currentLine === '') {
          lines.push(currentLine);
        }
      }
      
      return lines.length > 0 ? lines : [text];
    }

    async _drawPptxImage(page, el, scale, pageHeight) {
      try {
        const x = (el.left || 0) * scale;
        const y = (el.top || 0) * scale;
        const w = (el.width || 100) * scale;
        const h = (el.height || 100) * scale;
        const pdfY = pageHeight - y - h;
        
        const base64 = el.base64.split(',')[1];
        if (!base64) return;
        
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        let img;
        if (el.base64.includes('image/png')) img = await page.doc.embedPng(bytes);
        else if (el.base64.includes('image/jpeg')) img = await page.doc.embedJpg(bytes);
        else return;
        
        page.drawImage(img, { x, y: pdfY, width: w, height: h });
      } catch(e) { console.warn('图片渲染失败', e); }
    }

    _drawPptxText(page, el, font, scale, pageHeight) {
      if (!el.content) return;
      const { rgb } = window.PDFLib;
      
      const x = (el.left || 0) * scale;
      const y = (el.top || 0) * scale;
      const w = (el.width || 100) * scale;
      const h = (el.height || 50) * scale;
      
      const topY = pageHeight - y;
      const bottomY = pageHeight - y - h;
      const maxWidth = w - 10; // 左右各留 5px 边距
      
      // 解析 HTML 内容，保留所有样式信息
      const paragraphs = this._parseHtmlContent(el.content);
      
      // 对长文本进行自动换行处理
      const wrappedParagraphs = this._wrapParagraphs(paragraphs, font, scale, maxWidth);
      
      // 计算垂直对齐的起始位置
      const contentHeight = this._calculateContentHeight(wrappedParagraphs, scale);
      let currentY;
      const vAlign = el.vAlign || 'top';
      
      if (vAlign === 'mid' || vAlign === 'middle') {
        // 垂直居中：起始位置 = 顶部 - (元素高度 - 内容高度) / 2
        // 但要确保不会超出元素底部
        currentY = topY - (h - contentHeight) / 2;
        // 保护：如果内容高度超过元素高度，从顶部开始画
        if (contentHeight > h) {
          currentY = topY - 5;
        }
      } else if (vAlign === 'bottom') {
        // 底部对齐：起始位置 = 底部 + 内容高度
        currentY = bottomY + contentHeight;
      } else {
        // 顶部对齐：从顶部留一点边距开始
        currentY = topY - 5;
      }
      
      // 确保不超出顶部边界（防止负数或超出页面）
      currentY = Math.min(currentY, topY - 5);
      // 确保不低于底部（至少能画一行）
      currentY = Math.max(currentY, bottomY + 20);
      
      for (const para of wrappedParagraphs) {
        if (currentY < bottomY + 5) break;
        
        const fontSize = Math.max((para.fontSize || 12) * scale, 8);
        const lineHeight = fontSize * this.options.lineHeightRatio;
        
        // 处理每一行文本
        for (const line of para.lines) {
          if (currentY < bottomY + 5) break;
          
          // 空行处理
          if (line.segments.length === 0 || (line.segments.length === 1 && !line.segments[0].text)) {
            currentY -= lineHeight;
            continue;
          }
          
          // 计算整行宽度用于对齐
          let lineWidth = 0;
          for (const seg of line.segments) {
            const segFontSize = Math.max((seg.fontSize || para.fontSize || 12) * scale, 8);
            lineWidth += font.widthOfTextAtSize(seg.text || '', segFontSize);
          }
          
          // 根据对齐方式计算起始 X
          let drawX = x + 5;
          if (para.align === 'center') {
            drawX = x + (w - lineWidth) / 2;
          } else if (para.align === 'right') {
            drawX = x + w - lineWidth - 5;
          }
          
          // 绘制行内的每个样式片段
          let segX = drawX;
          for (const seg of line.segments) {
            const segFontSize = Math.max((seg.fontSize || para.fontSize || 12) * scale, 8);
            const text = seg.text || '';
            
            if (text && currentY - segFontSize * 0.8 > bottomY + 5) {
              // 解析颜色
              const color = this._parseColor(seg.color);
              
              page.drawText(text, {
                x: segX,
                y: currentY - segFontSize * 0.8,
                size: segFontSize,
                font,
                color: rgb(color.r, color.g, color.b)
              });
              
              segX += font.widthOfTextAtSize(text, segFontSize);
            }
          }
          
          currentY -= lineHeight;
        }
        
        // 段落间距
        currentY -= lineHeight * 0.3;
      }
    }

    /**
     * 对段落进行自动换行处理
     */
    _wrapParagraphs(paragraphs, font, scale, maxWidth) {
      const wrapped = [];
      
      for (const para of paragraphs) {
        const wrappedPara = {
          fontSize: para.fontSize,
          align: para.align,
          lines: []
        };
        
        for (const line of para.lines) {
          // 合并行内所有片段的文本以进行换行计算
          const wrappedLines = this._wrapLine(line, font, scale, maxWidth, para.fontSize);
          wrappedPara.lines.push(...wrappedLines);
        }
        
        if (wrappedPara.lines.length > 0) {
          wrapped.push(wrappedPara);
        }
      }
      
      return wrapped;
    }

    /**
     * 对单行进行自动换行
     */
    _wrapLine(line, font, scale, maxWidth, defaultFontSize) {
      const wrappedLines = [];
      let currentLine = { segments: [] };
      let currentLineWidth = 0;
      
      // 处理空行（没有片段或所有片段都是空文本）
      const isEmptyLine = line.segments.length === 0 || 
                          line.segments.every(seg => !seg.text || seg.text === '');
      if (isEmptyLine) {
        return [{ segments: [] }];
      }
      
      for (const seg of line.segments) {
        const segFontSize = Math.max((seg.fontSize || defaultFontSize || 12) * scale, 8);
        const text = seg.text || '';
        
        // 处理空文本片段（保留样式信息，用于空行）
        if (text === '') {
          currentLine.segments.push({
            ...seg,
            text: '',
            fontSize: seg.fontSize
          });
          continue;
        }
        
        // 按字符分割处理（支持中文和英文）
        let currentText = '';
        
        for (let i = 0; i < text.length; i++) {
          const char = text[i];
          const charWidth = font.widthOfTextAtSize(char, segFontSize);
          
          // 检查是否需要在当前字符前换行
          if (currentLineWidth + charWidth > maxWidth && currentText) {
            // 保存当前片段到当前行
            currentLine.segments.push({
              ...seg,
              text: currentText,
              fontSize: seg.fontSize
            });
            
            // 保存当前行并开始新行
            wrappedLines.push(currentLine);
            currentLine = { segments: [] };
            
            // 开始新片段
            currentText = char;
            currentLineWidth = charWidth;
          } else {
            currentText += char;
            currentLineWidth += charWidth;
          }
        }
        
        // 保存最后一个片段（即使是空字符串也要保存，以保持样式连贯性）
        currentLine.segments.push({
          ...seg,
          text: currentText,
          fontSize: seg.fontSize
        });
      }
      
      // 添加最后一行
      if (currentLine.segments.length > 0) {
        wrappedLines.push(currentLine);
      }
      
      // 如果没有任何内容，返回空行
      if (wrappedLines.length === 0) {
        return [{ segments: [] }];
      }
      
      return wrappedLines;
    }

    async _convertDocx(buffer, options) {
      if (!window.mammoth) throw new Error('请加载 mammoth 库');
      
      const result = await window.mammoth.convertToHtml({
        arrayBuffer: buffer
      }, {
        convertImage: mammoth.images.imgElement(function(image) {
          return image.readAsBase64String().then(base64 => ({
            src: 'data:' + image.contentType + ';base64,' + base64
          }));
        })
      });

      const html = result.value;
      
      const div = document.createElement('div');
      div.innerHTML = html;
      div.style.cssText = 'position:absolute;left:-9999px;top:0;';
      document.body.appendChild(div);
      
      try {
        return await this._htmlToPdf(div, options);
      } finally {
        document.body.removeChild(div);
      }
    }

    async _htmlToPdf(container, options) {
      const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
      const pdfDoc = await PDFDocument.create();
      
      // DOCX 转换需要中文字体，否则中文会乱码
      if (!this.fontBytes) {
        throw new Error('中文字体未加载，请先调用 loadFont()');
      }
      
      pdfDoc.registerFontkit(window.fontkit);
      const font = await pdfDoc.embedFont(this.fontBytes);

      const pageSize = this._getPageSize();
      const margins = this.options.margins;
      
      let page = pdfDoc.addPage(pageSize);
      let pageHeight = page.getSize().height;
      let y = pageHeight - margins.top;
      
      const fontSize = 11;
      const lineHeight = fontSize * this.options.lineHeightRatio;
      const maxWidth = page.getSize().width - margins.left - margins.right;
      
      const traverse = async (node) => {
        if (y < margins.bottom) {
          page = pdfDoc.addPage(pageSize);
          pageHeight = page.getSize().height;
          y = pageHeight - margins.top;
        }
        
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent;
          if (!text.trim()) return;
          
          const lines = this._wrapText(text, font, fontSize, maxWidth);
          for (const line of lines) {
            if (y < margins.bottom) {
              page = pdfDoc.addPage(pageSize);
              pageHeight = page.getSize().height;
              y = pageHeight - margins.top;
            }
            page.drawText(line, {
              x: margins.left,
              y: y - fontSize,
              size: fontSize,
              font,
              color: rgb(0,0,0)
            });
            y -= lineHeight;
          }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const tag = node.tagName.toLowerCase();
          
          if (tag === 'img') {
            const src = node.getAttribute('src');
            if (src && src.startsWith('data:image')) {
              try {
                const base64 = src.split(',')[1];
                const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
                let img;
                if (src.includes('image/png')) img = await pdfDoc.embedPng(bytes);
                else if (src.includes('image/jpeg')) img = await pdfDoc.embedJpg(bytes);
                
                if (img) {
                  const imgSize = img.size();
                  const maxImgWidth = maxWidth;
                  const scale = Math.min(1, maxImgWidth / imgSize.width);
                  const drawWidth = imgSize.width * scale;
                  const drawHeight = imgSize.height * scale;
                  
                  if (y - drawHeight < margins.bottom) {
                    page = pdfDoc.addPage(pageSize);
                    pageHeight = page.getSize().height;
                    y = pageHeight - margins.top;
                  }
                  
                  page.drawImage(img, {
                    x: margins.left,
                    y: y - drawHeight,
                    width: drawWidth,
                    height: drawHeight
                  });
                  y -= drawHeight + 10;
                }
              } catch(e) { console.warn('图片嵌入失败', e); }
            }
            return;
          }
          
          let currentFontSize = fontSize;
          if (/^h[1-6]$/.test(tag)) {
            const sizes = { h1: 24, h2: 20, h3: 16, h4: 14, h5: 12, h6: 11 };
            currentFontSize = sizes[tag] || fontSize;
            y -= 10;
          } else if (tag === 'p') {
            y -= 5;
          } else if (tag === 'br') {
            y -= lineHeight;
            return;
          }
          
          for (const child of node.childNodes) {
            await traverse(child);
          }
          
          if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'].includes(tag)) {
            y -= lineHeight;
          }
        }
      };
      
      await traverse(container);
      return this._savePdf(pdfDoc, options);
    }

    async _convertExcel(buffer, options) {
      if (!window.XLSX) throw new Error('请加载 xlsx 库 (SheetJS)');
      
      const workbook = window.XLSX.read(buffer, { type: 'array' });
      const sheetName = options.sheetName || workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      
      const data = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      if (!data.length) throw new Error('空表格');
      
      const { PDFDocument, rgb } = window.PDFLib;
      const pdfDoc = await PDFDocument.create();
      
      // Excel 转换需要中文字体，否则中文会乱码
      if (!this.fontBytes) {
        throw new Error('中文字体未加载，请先调用 loadFont()');
      }
      
      pdfDoc.registerFontkit(window.fontkit);
      const font = await pdfDoc.embedFont(this.fontBytes);
      
      const pageSize = this._getPageSize();
      const margins = this.options.margins;
      const pageWidth = pageSize[0];
      const pageHeight = pageSize[1];
      
      const colWidths = [];
      const fontSize = 12;
      const charWidth = font.widthOfTextAtSize('中', fontSize);
      
      data.forEach(row => {
        row.forEach((cell, colIndex) => {
          const len = String(cell).length;
          const needWidth = len * charWidth + 20;
          colWidths[colIndex] = Math.max(colWidths[colIndex] || 0, needWidth, 60);
        });
      });
      
      const totalWidth = colWidths.reduce((a, b) => a + b, 0);
      const availableWidth = pageWidth - margins.left - margins.right;
      
      let scale = 1;
      if (totalWidth > availableWidth) {
        scale = availableWidth / totalWidth;
      }
      
      let page = pdfDoc.addPage(pageSize);
      let y = pageHeight - margins.top;
      // 行高设为字体的1.4倍，让文字占单元格高度更多
      const rowHeight = fontSize * 1.4;
      
      for (let rowIndex = 0; rowIndex < data.length; rowIndex++) {
        const row = data[rowIndex];
        
        if (y - rowHeight < margins.bottom) {
          page = pdfDoc.addPage(pageSize);
          y = pageHeight - margins.top;
        }
        
        let x = margins.left;
        
        page.drawLine({
          start: { x: margins.left, y: y },
          end: { x: margins.left + totalWidth * scale, y: y },
          thickness: 0.5,
          color: rgb(0.8, 0.8, 0.8)
        });
        
        for (let colIndex = 0; colIndex < row.length; colIndex++) {
          const cell = String(row[colIndex] || '');
          const colWidth = (colWidths[colIndex] || 60) * scale;
          
          page.drawLine({
            start: { x: x, y: y },
            end: { x: x, y: y - rowHeight },
            thickness: 0.5,
            color: rgb(0.8, 0.8, 0.8)
          });
          
          const maxChars = Math.floor((colWidth - 10) / (charWidth * scale));
          const displayText = cell.length > maxChars ? cell.substring(0, maxChars - 2) + '..' : cell;
          
          // 计算文字垂直居中位置
          const actualFontSize = fontSize * scale;
          const textY = y - (rowHeight + actualFontSize * 0.8) / 2;
          
          page.drawText(displayText, {
            x: x + 5,
            y: textY,
            size: actualFontSize,
            font,
            color: rgb(0, 0, 0)
          });
          
          x += colWidth;
        }
        
        page.drawLine({
          start: { x: x, y: y },
          end: { x: x, y: y - rowHeight },
          thickness: 0.5,
          color: rgb(0.8, 0.8, 0.8)
        });
        
        y -= rowHeight;
      }
      
      page.drawLine({
        start: { x: margins.left, y: y },
        end: { x: margins.left + totalWidth * scale, y: y },
        thickness: 0.5,
        color: rgb(0.8, 0.8, 0.8)
      });
      
      return this._savePdf(pdfDoc, options);
    }

    async _convertTxt(buffer, options) {
      const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
      
      const text = new TextDecoder(options.encoding || 'utf-8').decode(buffer);
      const lines = text.split(/\r?\n/);
      
      const pdfDoc = await PDFDocument.create();
      
      // TXT 转换需要中文字体，否则中文会乱码
      if (!this.fontBytes) {
        throw new Error('中文字体未加载，请先调用 loadFont()');
      }
      
      pdfDoc.registerFontkit(window.fontkit);
      const font = await pdfDoc.embedFont(this.fontBytes);
      
      const pageSize = this._getPageSize();
      const margins = this.options.margins;
      const fontSize = options.fontSize || 11;
      const lineHeight = fontSize * this.options.lineHeightRatio;
      const maxWidth = pageSize[0] - margins.left - margins.right;
      
      let page = pdfDoc.addPage(pageSize);
      let pageHeight = page.getSize().height;
      let y = pageHeight - margins.top;
      
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        
        const wrappedLines = this._wrapText(line, font, fontSize, maxWidth);
        
        for (const wrapped of wrappedLines) {
          if (y < margins.bottom + lineHeight) {
            page = pdfDoc.addPage(pageSize);
            pageHeight = page.getSize().height;
            y = pageHeight - margins.top;
          }
          
          page.drawText(wrapped, {
            x: margins.left,
            y: y - fontSize,
            size: fontSize,
            font,
            color: rgb(0, 0, 0)
          });
          
          y -= lineHeight;
        }
      }
      
      return this._savePdf(pdfDoc, options);
    }

    _getPageSize() {
      if (Array.isArray(this.options.pageSize)) return this.options.pageSize;
      const sizes = {
        'A4': [595.28, 841.89],
        'Letter': [612, 792],
        'A3': [841.89, 1190.55]
      };
      return sizes[this.options.pageSize] || sizes['A4'];
    }

    _wrapText(text, font, fontSize, maxWidth) {
      if (!text) return [''];
      const lines = [];
      const chars = text.split('');
      let line = '';
      let width = 0;
      
      for (const char of chars) {
        const cw = font.widthOfTextAtSize(char, fontSize);
        if (width + cw > maxWidth && line !== '') {
          lines.push(line);
          line = char;
          width = cw;
        } else {
          line += char;
          width += cw;
        }
      }
      lines.push(line);
      return lines;
    }

    _alignX(x, width, text, align, font, fontSize) {
      const tw = font.widthOfTextAtSize(text, fontSize);
      const pad = 5;
      if (align === 'center') return x + (width - tw) / 2;
      if (align === 'right') return x + width - tw - pad;
      return x + pad;
    }

    _parseHtmlContent(content) {
      const result = [];
      if (!content) return result;
      
      // 处理纯文本（无 HTML 标签）
      // 匹配常见的 HTML 标签，如 <p>, <br>, <span>, <div> 等
      const hasHtmlTags = /<\/?[a-zA-Z][^>]*>/i.test(content);
      if (!hasHtmlTags) {
        // 纯文本：按换行符分割，保留空行
        const lines = content.split('\n');
        return [{
          fontSize: 12,
          align: 'left',
          lines: lines.map(l => ({ segments: [{ text: l, fontSize: 12 }] }))
        }];
      }
      
      // 创建临时容器解析 HTML
      const container = document.createElement('div');
      container.innerHTML = content;
      
      // 处理 <br> 标签为换行符，便于后续处理
      const brElements = container.querySelectorAll('br');
      brElements.forEach(br => {
        br.replaceWith(document.createTextNode('\n'));
      });
      
      // 遍历所有段落（<p> 标签）
      const paragraphs = container.querySelectorAll('p');
      
      if (paragraphs.length === 0) {
        // 没有 <p> 标签，将整个内容作为一个段落
        const text = container.textContent || '';
        // 即使 text 全是空白也要处理，因为可能有换行
        result.push({
          fontSize: 12,
          align: 'left',
          lines: this._splitIntoLines(text, 12)
        });
        return result;
      }
      
      paragraphs.forEach(p => {
        // 获取段落对齐方式
        const align = p.style.textAlign || p.getAttribute('align') || 'left';
        
        // 获取段落基础字体大小
        let baseFontSize = 12;
        if (p.style.fontSize) {
          const m = p.style.fontSize.match(/(\d+)/);
          if (m) baseFontSize = parseInt(m[1]);
        }
        
        // 递归提取文本片段及其样式
        const segments = this._extractTextSegments(p, baseFontSize);
        
        // 将连续的文本片段按换行符分割成行
        const lines = this._segmentsToLines(segments);
        
        if (lines.length > 0) {
          result.push({
            fontSize: baseFontSize,
            align,
            lines
          });
        }
      });
      
      return result;
    }

    /**
     * 递归提取文本片段及其样式
     */
    _extractTextSegments(node, baseFontSize, inheritedStyle = {}) {
      const segments = [];
      
      node.childNodes.forEach(child => {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.textContent;
          if (text || text === '') {
            segments.push({
              text: text,
              fontSize: inheritedStyle.fontSize || baseFontSize,
              bold: inheritedStyle.bold || false,
              italic: inheritedStyle.italic || false,
              underline: inheritedStyle.underline || false,
              color: inheritedStyle.color || null
            });
          }
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = child.tagName.toLowerCase();
          const style = { ...inheritedStyle };
          
          // 解析内联样式
          if (child.style) {
            if (child.style.fontSize) {
              const m = child.style.fontSize.match(/(\d+)/);
              if (m) style.fontSize = parseInt(m[1]);
            }
            if (child.style.color) {
              style.color = child.style.color;
            }
            if (child.style.fontWeight === 'bold' || child.style.fontWeight >= 600) {
              style.bold = true;
            }
            if (child.style.fontStyle === 'italic') {
              style.italic = true;
            }
            if (child.style.textDecoration === 'underline') {
              style.underline = true;
            }
          }
          
          // 处理标签固有的样式
          if (['b', 'strong'].includes(tag)) {
            style.bold = true;
          }
          if (['i', 'em'].includes(tag)) {
            style.italic = true;
          }
          if (tag === 'u') {
            style.underline = true;
          }
          if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
            style.bold = true;
            const sizes = { h1: 32, h2: 24, h3: 19, h4: 16, h5: 14, h6: 12 };
            style.fontSize = sizes[tag] || baseFontSize;
          }
          
          // 递归处理子节点
          const childSegments = this._extractTextSegments(child, baseFontSize, style);
          segments.push(...childSegments);
        }
      });
      
      return segments;
    }

    /**
     * 将文本片段按换行符分割成行
     */
    _segmentsToLines(segments) {
      const lines = [];
      let currentLine = { segments: [] };
      
      for (const seg of segments) {
        const parts = seg.text.split('\n');
        
        parts.forEach((part, index) => {
          if (index > 0) {
            // 遇到换行符，保存当前行并开始新行
            if (currentLine.segments.length > 0 || part === '') {
              lines.push(currentLine);
              currentLine = { segments: [] };
            }
          }
          
          // 添加文本片段到当前行（即使为空字符串也要保留用于空行）
          if (part !== undefined) {
            currentLine.segments.push({
              ...seg,
              text: part
            });
          }
        });
      }
      
      // 添加最后一行
      if (currentLine.segments.length > 0) {
        lines.push(currentLine);
      }
      
      return lines;
    }

    /**
     * 计算内容总高度（用于垂直对齐）
     */
    _calculateContentHeight(paragraphs, scale) {
      let height = 0;
      
      for (let i = 0; i < paragraphs.length; i++) {
        const para = paragraphs[i];
        const fontSize = Math.max((para.fontSize || 12) * scale, 8);
        const lineHeight = fontSize * this.options.lineHeightRatio;
        
        // 段落内行高
        height += para.lines.length * lineHeight;
        
        // 段落间距（最后一个段落不加）
        if (i < paragraphs.length - 1) {
          height += lineHeight * 0.3;
        }
      }
      
      return height;
    }

    /**
     * 简单地将文本分割成行（用于纯文本情况）
     */
    _splitIntoLines(text, fontSize) {
      const lines = text.split('\n');
      return lines.map(line => ({
        segments: [{ text: line, fontSize }]
      }));
    }

    /**
     * 解析颜色值为 RGB
     */
    _parseColor(colorStr) {
      if (!colorStr) return { r: 0, g: 0, b: 0 };
      
      // 处理 #RRGGBB 格式
      if (colorStr.startsWith('#')) {
        const hex = colorStr.slice(1);
        if (hex.length === 6) {
          return {
            r: parseInt(hex.slice(0, 2), 16) / 255,
            g: parseInt(hex.slice(2, 4), 16) / 255,
            b: parseInt(hex.slice(4, 6), 16) / 255
          };
        }
        if (hex.length === 3) {
          return {
            r: parseInt(hex[0] + hex[0], 16) / 255,
            g: parseInt(hex[1] + hex[1], 16) / 255,
            b: parseInt(hex[2] + hex[2], 16) / 255
          };
        }
      }
      
      // 处理 rgb(r, g, b) 格式
      const rgbMatch = colorStr.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
      if (rgbMatch) {
        return {
          r: parseInt(rgbMatch[1]) / 255,
          g: parseInt(rgbMatch[2]) / 255,
          b: parseInt(rgbMatch[3]) / 255
        };
      }
      
      // 默认黑色
      return { r: 0, g: 0, b: 0 };
    }

    async _savePdf(pdfDoc, options) {
      const bytes = await pdfDoc.save();
      const blob = new Blob([bytes], { type: 'application/pdf' });
      
      if (options.download) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = options.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
      
      return blob;
    }
  }

  return UniversalConverter;
});