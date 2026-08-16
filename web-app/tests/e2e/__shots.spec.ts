import { test, expect, type Page } from '@playwright/test';
const SID='demo-session', SPATH='/home/u/purple-lab-projects/demo-session';
const PRD=['# Add rate limiting to the public API','','## Acceptance Criteria','- [ ] Requests over the limit return 429','- [ ] The limit is configurable per key'].join('\n');
async function mock(page:Page,f:any={}){
 await page.addInitScript(()=>{localStorage.setItem('pl_onboarding_complete','1');localStorage.setItem('pl_auth_token','t');
  class S extends EventTarget{readyState=1;onopen:any=null;onmessage:any=null;onclose:any=null;onerror:any=null;
   constructor(){super();setTimeout(()=>this.onopen?.(new Event('open')),0);} send(){} close(){}}
  (window as any).WebSocket=S;});
 await page.route('**/api/auth/me',r=>r.fulfill({json:{authenticated:true,local_mode:true}}));
 await page.route(`**/api/sessions/${SID}`,r=>r.fulfill({json:{id:SID,path:SPATH,status:f.detailStatus??'completed',prd:PRD,files:[{name:'app.ts',path:'app.ts',type:'file'}],logs:['[runner] iteration 1','[runner] wrote src/limit.ts']}}));
 await page.route('**/api/session/status',r=>r.fulfill({json:{running:f.running??false,paused:false,phase:f.phase??'idle',iteration:f.running?3:0,complexity:'standard',mode:'autonomous',provider:'claude',current_task:'',pending_tasks:0,running_agents:0,uptime:f.running?184:0,version:'',pid:'',projectDir:f.running?SPATH:'',max_iterations:10,cost:f.running?0.42:0,start_time:0,exit_code:null,last_output:[]}}));
 await page.route('**/api/session/checklist',r=>r.fulfill({json:f.checklist??{total:0,passed:0,failed:0,skipped:0,pending:0,items:[]}}));
 await page.route(`**/api/sessions/${SID}/git/status`,r=>r.fulfill({json:{branch:'loki/rate-limit',clean:!(f.gitFiles??[]).length,ahead:0,behind:0,files:f.gitFiles??[]}}));
 await page.route(`**/api/sessions/${SID}/checkpoints`,r=>r.fulfill({json:f.checkpoints??[]}));
}
const FILES=[{path:'src/limit.ts',status:'modified',staged:true},{path:'src/limit.ts',status:'modified',staged:false},{path:'src/config.ts',status:'added',staged:true},{path:'tests/limit.test.ts',status:'added',staged:false}];
const GATES={total:4,passed:3,failed:1,skipped:0,pending:0,items:[{id:'g1',label:'Static analysis',status:'pass'},{id:'g2',label:'Test suite',status:'fail',details:'2 failing in tests/limit.test.ts'},{id:'g3',label:'Blind 3-reviewer code review',status:'pass'},{id:'g4',label:'Documentation coverage',status:'pass'}]};
const CPS=[{id:'cp-1',timestamp:'2026-08-16T10:00:00Z',description:'before rate limit edits',iteration:2,files_changed:4,is_current:false}];
async function go(page:Page){await page.goto(`http://127.0.0.1:57380/lab/project/${SID}/cockpit`);await expect(page.getByRole('heading',{level:1})).toBeVisible();await page.waitForTimeout(400);}
test('desktop running',async({page})=>{await page.setViewportSize({width:1440,height:1000});await mock(page,{running:true,phase:'ACT',gitFiles:FILES,checklist:GATES,checkpoints:CPS});await go(page);await page.screenshot({path:'../artifacts/execution-cockpit-screens/01-desktop-running.png',fullPage:true});});
test('desktop completed',async({page})=>{await page.setViewportSize({width:1440,height:1000});await mock(page,{gitFiles:FILES,checklist:GATES,checkpoints:CPS});await go(page);await page.screenshot({path:'../artifacts/execution-cockpit-screens/02-desktop-completed.png',fullPage:true});});
test('desktop empty',async({page})=>{await page.setViewportSize({width:1440,height:900});await mock(page,{detailStatus:'empty'});await page.route(`**/api/sessions/${SID}`,r=>r.fulfill({json:{id:SID,path:SPATH,status:'empty',prd:'',files:[],logs:[]}}));await go(page);await page.screenshot({path:'../artifacts/execution-cockpit-screens/03-desktop-empty.png',fullPage:true});});
test('mobile running',async({page})=>{await page.setViewportSize({width:390,height:844});await mock(page,{running:true,phase:'VERIFY',gitFiles:FILES,checklist:GATES,checkpoints:CPS});await go(page);await page.screenshot({path:'../artifacts/execution-cockpit-screens/04-mobile-running.png',fullPage:true});});
test('desktop dark',async({page})=>{await page.setViewportSize({width:1440,height:1000});await mock(page,{gitFiles:FILES,checklist:GATES,checkpoints:CPS});await page.addInitScript(()=>document.documentElement.classList.add('dark'));await go(page);await page.evaluate(()=>document.documentElement.classList.add('dark'));await page.waitForTimeout(200);await page.screenshot({path:'../artifacts/execution-cockpit-screens/05-desktop-dark.png',fullPage:true});});
