'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {decode,save}=require('../scripts/archive_aoying_records.cjs');
const source=require('../trader/public-executions.js');
const model=require('../trader/trade-replay-model.js');
const archivePath=path.resolve(__dirname,'../trader/replay-seed.js');
const archive=decode(fs.readFileSync(archivePath,'utf8'));
const records=Object.values(archive.records);
function fixture(rows){
  return {schemaVersion:1,portfolioId:source.ID,scope:'public_execution_records_only',hiddenPositionsRequested:false,stopped:false,lastSuccessAt:archive.lastSuccessAt,records:Object.fromEntries(rows.map(r=>[r.fingerprint,r]))};
}
test('the previously saved baseline, public operations and official history remain accessible',()=>{
  const historic=source.parseArchive(archive);
  assert.ok(historic.retainedRecords>=64);
  assert.equal(historic.retainedRecords,new Set(historic.allRows.map(r=>r.id)).size);
  const context={};
  require('node:vm').runInNewContext(fs.readFileSync(path.resolve(__dirname,'../trader/aoying-history.js'),'utf8'),context);
  const h=context.BooksAoyingHistory,r=require('../trader/reference-data.js');
  const cycles=model.cycles(model.binanceEvents(historic.allRows),h.rows);
  assert.equal(cycles.filter(c=>c.official).length,110);
  assert.equal(cycles.flatMap(c=>c.events).length,historic.retainedRecords);
  for(const period of r.PERIODS){
    assert.ok(Number.isFinite(r.performance(h,source.ID,period).roi),period);
    assert.ok(r.chart(h,source.ID,period).pointCount>=2,period);
  }
});
test('materializes raw events missed by the rolling window, preserves fingerprints, no churn on retry or partial failure',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aoying-archive-'));
 try{
  const old=fixture(records.slice(0,2)),window={...fixture(records.slice(1,3)),initialized:true,
    events:[{id:records[3].fingerprint,record:records[3]}]};
  const file=path.join(dir,'replay-seed.js'),checkpoint=path.join(dir,'checkpoint.json');
  fs.writeFileSync(file,'globalThis.BooksPublicRecordSeed='+JSON.stringify(old)+';');
  fs.writeFileSync(checkpoint,JSON.stringify(window));
  const saved=save(checkpoint,'a'.repeat(40),file);
  assert.deepEqual(saved,{added:2,retained:4});
  const published=fs.readFileSync(file,'utf8'),data=decode(published);
  assert.equal(data.archiveReceipts[0].commit,'a'.repeat(40));
  assert.deepEqual(Object.keys(data.records).sort(),records.slice(0,4).map(r=>r.fingerprint).sort());
  assert.deepEqual(save(checkpoint,'a'.repeat(40),file),{added:0,retained:4});
  assert.equal(fs.readFileSync(file,'utf8'),published);
  const invalid=structuredClone(window);invalid.records[records[2].fingerprint].avgPrice='42';
  fs.writeFileSync(checkpoint,JSON.stringify(invalid));
  assert.throws(()=>save(checkpoint,null,file),/fingerprint/);
  assert.equal(fs.readFileSync(file,'utf8'),published);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
