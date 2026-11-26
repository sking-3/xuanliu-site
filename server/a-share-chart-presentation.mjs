import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

export const presentationVersion='bs-v1';
export const presentationSchema='books.a-share.chart-presentation.v1';
export const presentationDirectory=join('presentation',presentationVersion);
export const samePresentationSource=(a,b)=>['generation','sourceId','day','asOf','historyGeneration'].every(key=>a?.[key]===b?.[key]);
const generation=value=>/^[0-9TZ-]{1,80}$/.test(value||'');
export function validChartPath(path){return typeof path==='string'&&/^[A-Za-z0-9./-]+\.svg$/.test(path)&&!path.startsWith('/')&&!path.split('/').some(part=>!part||part==='.'||part==='..');}

/** Called only after the original route's source, eligibility and path guards. */
export async function readPresentedChart({dir,binding,path,compressed=false}){
  if(!generation(binding?.generation)||!validChartPath(path))return null;
  const root=join(dir,presentationDirectory,binding.generation);
  try{
    const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
    if(manifest.schema!==presentationSchema||manifest.version!==presentationVersion||manifest.completed!==true||!samePresentationSource(manifest,binding)||!Array.isArray(manifest.files)||!manifest.files.includes(path))return null;
    return await readFile(join(root,path+(compressed?'.gz':'')));
  }catch{return null;}
}
