import requests
import os

MOODLE_URL = "https://moodle.gpa-buddy.com"
API_TOKEN = "2b3adf96137807ab66c5cffe4041f024"
COURSE_ID = 2

download_dir = "course_files"
os.makedirs(download_dir, exist_ok=True)

def call_moodle(function, params=None):
    data = {
        'wstoken': API_TOKEN,
        'wsfunction': function,
        'moodlewsrestformat': 'json',
    }
    if params:
        data.update(params)
    response = requests.post(f"{MOODLE_URL}/webservice/rest/server.php", data=data)
    return response.json()

# 获取课程内容
contents = call_moodle('core_course_get_contents', {'courseid': COURSE_ID})

for section in contents:
    for module in section.get('modules', []):
        if 'contents' in module:
            for content in module['contents']:
                if content.get('type') == 'file':
                    fileurl = content.get('fileurl', '')
                    filename = content.get('filename', '')
                    
                    print(f"文件: {filename}")
                    print(f"URL: {fileurl}")
                    
                    # 构建下载 URL
                    import urllib.parse
                    parsed = urllib.parse.urlparse(fileurl)
                    query = urllib.parse.parse_qs(parsed.query)
                    query['token'] = [API_TOKEN]
                    query['forcedownload'] = ['1']
                    new_query = urllib.parse.urlencode(query, doseq=True)
                    download_url = urllib.parse.urlunparse((
                        parsed.scheme, parsed.netloc, parsed.path,
                        parsed.params, new_query, parsed.fragment
                    ))
                    
                    r = requests.get(download_url, timeout=30)
                    
                    if r.status_code == 200 and r.content[:4] == b'%PDF':
                        # ========== 保存文件 ==========
                        safe_name = "".join(c for c in filename if c.isalnum() or c in ' ._-').strip()
                        filepath = os.path.join(download_dir, safe_name)
                        
                        with open(filepath, 'wb') as f:
                            f.write(r.content)
                        
                        print(f"✅ 已保存: {filepath} ({len(r.content)} bytes)")
                    else:
                        print(f"❌ 下载失败")
                    print("---")