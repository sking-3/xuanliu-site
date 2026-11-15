'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const html=fs.readFileSync('research.html','utf8');
assert.match(html,/五层数据接入矩阵/);
for(const layer of ['行情层','研报层','新闻层','基础数据层','公告层']) assert.match(html,new RegExp(layer));
for(const source of ['mootdx','腾讯财经','AKShare','iWenCai','Tushare \/ Ashare']) assert.match(html,new RegExp(source));
assert.match(html,/公开只读/);assert.match(html,/不在公开站保存密钥/);assert.match(html,/不自动排程/);
assert.doesNotMatch(html,/API_SECRET|PRIVATE_KEY|Bearer /i);
console.log('PASS research layer matrix: 5 layers and 5 source audit rows');
