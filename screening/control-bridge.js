'use strict';
(async()=>{
 try{
  const response=await fetch('/api/research-control/state',{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error'});
  if(!response.ok)return;
  const {activeConfig}=await response.json();
  if(!activeConfig)return;
  const apply=()=>window.BooksTrendControllerApp.applyConfiguration(activeConfig);
  if(window.BooksTrendControllerApp)apply();
  else window.addEventListener('books:trend-mounted',apply,{once:true});
 }catch{}
})();
