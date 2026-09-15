const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage();let rows=[],serial=0;const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',d=>d.accept(d.type()==='prompt'?'重命名测试':undefined));
  await page.route('**/api/strategies**',async route=>{
   const req=route.request(),id=new URL(req.url()).pathname.split('/')[3],method=req.method();let output;
   if(method==='GET')output=id?rows.find(r=>r.id===id):rows;
   if(method==='POST'){output={...req.postDataJSON(),id:String(++serial),size:100,updatedAt:'2026-09-03T12:00:00'};rows.push(output);}
   if(method==='PUT'){output=rows.find(r=>r.id===id);Object.assign(output,req.postDataJSON());}
   if(method==='DELETE'){rows=rows.filter(r=>r.id!==id);output={deleted:true};}
   await route.fulfill({json:output});
  });
  await page.goto('http://127.0.0.1:8766/?v=library-page-25#library');
  assert.equal(await page.locator('#workspacePage').isVisible(),false);
  assert.equal(await page.locator('#libraryModal').isVisible(),true);
  assert.equal(await page.locator('#libraryModal').evaluate(e=>getComputedStyle(e).position),'static');
  await page.locator('#closeLibrary').click();
  await page.locator('#newBtn').click();await page.locator('#strategyName').fill('策略甲');
  await page.locator('#saveBtn').click();await page.locator('.library-item').waitFor();assert.equal(rows.length,1);
  assert.equal(await page.locator('#workspacePage').isVisible(),false);
  assert.equal(await page.locator('#libraryNav').getAttribute('aria-current'),'page');
  await page.locator('.library-action.open').click();await page.locator('#workspacePage').waitFor({state:'visible'});await page.locator('#strategyName').fill('策略甲修改');
  await page.locator('#saveBtn').click();await page.getByText('策略甲修改 · 当前策略',{exact:true}).waitFor();assert.equal(rows.length,1);
  await page.locator('#closeLibrary').click();await page.locator('#saveAsBtn').click();
  await page.waitForFunction(()=>document.querySelectorAll('.library-item').length===2);assert.equal(rows.length,2);
  await page.locator('#librarySearch').fill('不存在');assert.equal(await page.locator('.library-item').count(),0);
  await page.locator('#librarySearch').fill('');await page.locator('.library-action.rename').first().click();
  await page.getByText('重命名测试',{exact:true}).waitFor();
  await page.locator('.library-action.delete').first().click();await page.waitForFunction(()=>document.querySelectorAll('.library-item').length===1);
  await page.locator('#closeLibrary').click();
  await page.locator('#importInput').setInputFiles({name:'import.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({name:'新导入',incantation_type:'Ticker',symbol:'QQQ'}))});
  await page.locator('#saveBtn').click();await page.waitForFunction(()=>document.querySelectorAll('.library-item').length===2);
  assert.equal(rows.length,2);assert.deepEqual(errors,[]);
  console.log('PASS: save/list, update without duplicate, save-as, search, rename, delete, imported strategy creates new record; isolated API');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
