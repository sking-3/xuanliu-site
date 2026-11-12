import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const dir=fileURLToPath(new URL('.',import.meta.url));
const shared=existsSync(dir+'shared')?dir+'shared/':dir+'../trader/';
const assets={};for(const name of ['source-policy.js','trade-replay-model.js','trade-replay-data.js','public-executions.js','paper-engine.js','paper-acceptance.js','paper-data.js','paper-copy.js','trade-analysis.css','paper-copy.css'])assets['/assets/'+name]=await readFile(shared+name,'utf8');
assets['/assets/public-executions.js']=assets['/assets/public-executions.js'].replace("URL='https://raw.githubusercontent.com/sking-3/xuanliu-site/binance-public-orders-state/monitor-state/'+ID+'.json'","URL='/api/checkpoint'").replace("credentials:'omit'","credentials:'same-origin'");
let source='';for(const name of ['security','connectors','markets','ui','paper','checkpoint','index']){let s=await readFile(dir+'worker/'+name+'.mjs','utf8');s=s.replace(/^import .*;\n/gm,'').replace(/export (async function|function|const) /g,'$1 ');if(name==='index')s=s.replace('const protectedAssets={};','const protectedAssets='+JSON.stringify(assets)+';');source+=s+'\n';}
await mkdir(dir+'dist/server',{recursive:true});await writeFile(dir+'dist/server/index.js',source);
try{const manifest=await readFile(dir+'.openai/hosting.json','utf8');await mkdir(dir+'dist/.openai',{recursive:true});await writeFile(dir+'dist/.openai/hosting.json',manifest);}catch(e){if(e.code!=='ENOENT')throw e;}
console.log('Built authenticated Worker; no credentials included');
