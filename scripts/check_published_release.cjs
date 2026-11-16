'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const base=new URL(process.env.RELEASE_BASE_URL||'https://sking-3.github.io/xuanliu-site/');
const expected=process.env.EXPECTED_SHA;
async function read(file){
  const url=new URL(file,base);url.searchParams.set('_release',expected);
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok){const error=Error('Published '+file+' returned '+response.status);error.refused=[401,403,429].includes(response.status);throw error;}
  return Buffer.from(await response.arrayBuffer());
}
async function main(){
  if(!/^[0-9a-f]{40}$/.test(expected||'')||base.protocol!=='https:'||base.hostname!=='sking-3.github.io'||base.pathname!=='/xuanliu-site/')throw Error('Invalid release target');
  let manifest;
  for(const wait of [0,3000,8000]){
    if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
    try{manifest=JSON.parse(await read('release-manifest.json'));if(manifest.revision===expected)break;}
    catch(error){if(error.refused||wait===8000)throw error;}
  }
  if(manifest?.revision!==expected||manifest.schema!==1)throw Error('Deployed revision does not match');
  const critical=['index.html','screening/index.html','us.html','trader/index.html','tools.html','crypto.html','research.html','quant-research/index.html','quant-research/app.mjs','quant-research/engine.mjs','books-shell.js','books-ui.css','market-calendar.js','market-strip.html','market-strip.js','crypto-market.js','crypto-full.js','stock-workspace.js','screening/stock-selection.js','screening/selection-shell.js','screening/technical-screen.js'];
  for(const file of critical){
    const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
    const local=hash(fs.readFileSync(path.join(root,file)));
    if(manifest.assets[file]!==local||hash(await read(file))!==local)throw Error('Published asset mismatch: '+file);
  }
  console.log('Verified deployed revision and '+critical.length+' critical asset hashes: '+expected);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
