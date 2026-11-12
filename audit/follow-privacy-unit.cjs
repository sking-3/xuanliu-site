'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('public detail cannot load a paper or API management panel through an old link',()=>{const html=read('trader/index.html'),js=read('trader/plaza.js');assert.doesNotMatch(html,/data-tab="paper"|follow-settings\.(js|css)|paper-(engine|data|copy)\.js/);assert.doesNotMatch(js,/openFollow|BooksFollowSettings|BooksPaperCopy|跟单设置|选择执行账户/);});
test('public website has no credential input or public JSON configuration publisher',()=>{const html=read('trader/index.html');assert.doesNotMatch(html,/type="password"|API_KEY|API_SECRET|PASSPHRASE|settings\/secrets|copy-config/);assert.equal(fs.existsSync(path.join(root,'trader/follow-settings.js')),false);});
test('retired public configuration workflow runs offline tests only',()=>{const yaml=read('.github/workflows/copy-signal-dry-run.yml');assert.match(yaml,/unittest discover/);assert.doesNotMatch(yaml,/config_path|actions\/cache|upload-artifact|GITHUB_TOKEN|secrets\.|plan\.py --/);});
