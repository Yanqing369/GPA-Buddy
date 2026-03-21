# 提交文件解析任务：

const form = new FormData();

form.append('file', '1 alcohol.pdf');

form.append('tool\_type', 'expert');

form.append('file\_type', 'PDF');



const options = {

&#x20; method: 'POST',

&#x20; headers: {Authorization: 'Bearer <token>'}

};



options.body = form;



fetch('https://open.bigmodel.cn/api/paas/v4/files/parser/create', options)

&#x20; .then(res => res.json())

&#x20; .then(res => console.log(res))

&#x20; .catch(err => console.error(err));



# 返回的提交结果：

## （如果成功）

{

&#x20; "success": true,

&#x20; "message": "任务创建成功",

&#x20; "task\_id": "task\_123456789"

}

## （如果失败）

{

&#x20; "error": {

&#x20;   "code": "<string>",

&#x20;   "message": "<string>"

&#x20; }

}



# 查看文件解析结果（约有10秒的延迟）

const options = {

&#x20; method: 'GET',

&#x20; headers: {Authorization: 'Bearer 1394f0f9b9f54264a37c84d583e9a8a2.yPXtwOi1OHwpNEz2'}

};



fetch('https://open.bigmodel.cn/api/paas/v4/files/parser/result/{taskId}/text', options)

&#x20; .then(res => res.json())

&#x20; .then(res => console.log(res))

&#x20; .catch(err => console.error(err));

# 返回的解析结果

## （如果成功）

{

&#x20; "status": "succeeded",

&#x20; "message": "结果获取成功",

&#x20; "task\_id": "task\_123456789",

&#x20; "content": "这是解析后的文本内容...",

&#x20; "parsing\_result\_url": "https://example.com/download/result.zip"

}

## （如果失败）

{

&#x20; "error": {

&#x20;   "code": "<string>",

&#x20;   "message": "<string>"

&#x20; }

}



