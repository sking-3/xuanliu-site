'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
function stage(target,expected){
  const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  if(!/^[0-9a-f]{40}$/.test(expected||'')||revision!==expected)throw Error('Release commit mismatch');
  execFileSync('git',['diff','--exit-code','HEAD','--'],{cwd:root,stdio:'pipe'});
  if(!target||!path.isAbsolute(target)||target===root||target.startsWith(root+path.sep))throw Error('Stage outside the checkout');
  fs.mkdirSync(target); // A reused/nonempty staging directory is rejected.
  execFileSync('tar',['-x','-C',target],{input:execFileSync('git',['archive','--format=tar',revision],{cwd:root,maxBuffer:100*1024*1024})});
  for(const p of ['copy-config','tools/copy_plan','private-follow','audit','.github'])fs.rmSync(path.join(target,p),{recursive:true,force:true});
  // Keep historical source records in the repository and outside the public artifact.
  for(const p of ['trader/binance/aoying-public-archive.json','trader/aoying-public-archive.js','scripts/collect_aoying_public_archive.cjs','trader/COPY-RESEARCH.md']){
    fs.rmSync(path.join(target,p),{force:true});
  }
  for(const file of fs.readdirSync(path.join(target,'trader')))if(/^paper-.*\.js$/.test(file)||file==='paper-copy.css')fs.rmSync(path.join(target,'trader',file));
  const assets={};
  function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const file=path.join(dir,entry.name),rel=path.relative(target,file).split(path.sep).join('/');
    if(entry.isDirectory())walk(file);
    else if(/\.(html|js|mjs|css)$/.test(rel)||rel==='research-data/a-active-stocks.json')assets[rel]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }}
  walk(target);
  for(const file of ['index.html','research.html','quant-research/index.html','screening/index.html','market-calendar.js'])if(!assets[file])throw Error('Missing public asset '+file);
  const {releaseMetadata}=require(path.join(target,'home-active-stocks.js'));
  const activeStocks=releaseMetadata(JSON.parse(fs.readFileSync(path.join(target,'research-data/a-active-stocks.json'),'utf8')));
  fs.writeFileSync(path.join(target,'release-manifest.json'),JSON.stringify({schema:1,revision,assets,activeStocks},null,2)+'\n');
  return {revision,assets:Object.keys(assets).length};
}
if(require.main===module){try{console.log(JSON.stringify(stage(process.env.BOOKS_STAGE_DIR,process.env.EXPECTED_SHA)));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={stage};
