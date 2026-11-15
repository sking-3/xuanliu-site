'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const html=fs.readFileSync('agent-studio.html','utf8'),js=fs.readFileSync('agent-studio.js','utf8'),css=fs.readFileSync('agent-studio.css','utf8');
for(const role of ['多方研究员','空方研究员','研究经理','风控审查','组合经理']) assert.match(html,new RegExp(role));
assert.match(html,/仅本机推演/);assert.match(html,/不主动调用外部模型/);assert.match(html,/不读取或保存 API Key/);assert.match(html,/agent-mode/);assert.match(html,/agent-layer-market/);assert.match(html,/agent-layer-research/);assert.match(html,/agent-layer-news/);assert.match(html,/agent-layer-fundamentals/);assert.match(html,/agent-layer-disclosure/);assert.match(html,/AI 增强/);
assert.doesNotMatch(html,/API_SECRET|PRIVATE_KEY|Bearer /i);assert.doesNotMatch(js,/fetch\(|WebSocket|XMLHttpRequest|https?:\/\//);assert.match(js,/localStorage/);assert.match(js,/BooksAgentBridge/);assert.match(js,/books\.agent\.request\.v1/);assert.match(js,/rules-v3/);assert.match(js,/readLayers/);assert.match(js,/withTimeout/);assert.match(js,/hasSourceTime/);assert.match(js,/五层规则底线/);assert.match(js,/AI.*规则/);assert.match(css,/max-width:760px/);assert.match(html,/agent-studio\.css\?v=[0-9a-f]{8}/);assert.match(html,/agent-studio\.js\?v=[0-9a-f]{8}/);
console.log('PASS five-agent dual-mode studio: rules baseline, optional AI bridge, safety boundary and mobile UI');
