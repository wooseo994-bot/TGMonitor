const app=document.querySelector('#app'),notice=document.querySelector('#notice');
let state,weekly=false,day='',timer;
const menu={overview:'概览看板',batches:'抽查批次',members:'成员与班次',reviews:'异常复核',rules:'规则与权限',integration:'Telegram 接入',password:'账户与密码'};
const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const route=()=>location.hash.slice(1)||'overview';
const date=(x,zone=state.rule.timezone)=>new Intl.DateTimeFormat('sv-SE',{timeZone:zone,dateStyle:'short'}).format(x);
const clock=(x,zone=state.rule.timezone)=>x?new Intl.DateTimeFormat('zh-CN',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(x):'—';
const status={sending:'发送中',sent:'进行中',done:'已结束',uncertain:'待核对',failed:'发送失败'};
const input=(name,label,value='',type='text',extra='')=>`<label>${label}<input name="${name}" type="${type}" value="${e(value)}" ${extra}></label>`;
const button=(label,primary=false)=>`<button class="${primary?'primary':''}">${label}</button>`;
const form=(action,fields,label)=>`<form data-action="${action}">${fields}<div>${button(label,true)}</div></form>`;
const card=(title,content,desc='')=>`<section class="card"><h2>${title}</h2>${desc?'<p>'+desc+'</p>':''}${content}</section>`;
const table=(headers,rows)=>rows.length?`<div class="table"><table><thead><tr>${headers.map(x=>'<th>'+x+'</th>').join('')}</tr></thead><tbody>${rows.map(r=>'<tr>'+r.map(x=>'<td>'+x+'</td>').join('')+'</tr>').join('')}</tbody></table></div>`:'<p class="empty">暂无记录</p>';
const tag=s=>`<span class="tag">${e(s)}</span>`;
async function request(path,data){
  const res=await fetch('/api/'+path,data===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  const v=await res.json();if(!res.ok)throw Object.assign(Error(v.error),{status:res.status});return v;
}
function announce(s){notice.textContent=s;notice.hidden=false;clearTimeout(timer);timer=setTimeout(()=>notice.hidden=true,6000);}
function auth(){
  const invite=route().startsWith('register/')?route().split('/')[1]:null;
  const fields=invite?input('invite','一次性凭证',invite,'hidden')+input('password','设置新密码','','password','minlength="12" required'):input('email','工作邮箱',location.search.includes('demo')?'admin@example.com':'','email','required')+input('password','密码',location.search.includes('demo')?'demo-password-123':'','password','required');
  app.innerHTML=`<div class="auth"><aside><strong>◈ 远程协作台</strong><h1>在岗确认与<br>团队协作记录</h1><small>面向已授权工作群的协作工具。</small></aside><main>${card(invite?'设置后台账户密码':'登录远程协作台',form(invite?'register':'login',fields,invite?'保存密码':'登录')+'<small>'+(invite?'<a href="#">返回登录</a>':'注册或忘记密码时，请联系管理员获取一次性链接。')+'</small>')}</main></div>`;
}
function range(){
  const first=new Date(day+'T00:00:00Z');
  if(weekly)first.setUTCDate(first.getUTCDate()-(first.getUTCDay()+6)%7);
  return Array.from({length:weekly?7:1},(_,i)=>new Date(+first+i*86400000).toISOString().slice(0,10));
}
function overview(){
  const days=range(),rows=state.rows.filter(r=>r.sent&&days.includes(date(r.sent,JSON.parse(r.policy).timezone)));
  const eligible=state.members.filter(m=>m.active&&m.eligible&&!m.away).length;
  const valid=rows.filter(r=>!r.exempt&&['sent','done'].includes(r.status));
  const covered=new Set(valid.map(r=>r.id)).size;
  const ended=valid.filter(r=>r.status==='done'),yes=ended.filter(r=>r.result==='按时确认').length;
  const review=rows.filter(r=>!r.review&&['未按时确认','迟到确认'].includes(r.result));
  const values=[['当前可抽查成员',eligible,'已匹配 · 排除请假'],['有效抽查覆盖',covered,'期间去重人数'],['按时响应',ended.length?yes+' / '+ended.length:'—','分母为已结束有效抽查'],['待复核',review.length,'逾期记录待主管核实']];
  const trend=days.map(d=>{const count=valid.filter(r=>date(r.sent,JSON.parse(r.policy).timezone)===d&&r.result==='按时确认').length;return `<div><small>${d.slice(5)}</small><br><strong>${count} 人次</strong><progress value="${count}" max="${Math.max(1,valid.length)}"></progress></div>`;}).join('');
  return `<div class="bar"><button data-mode="daily" class="${weekly?'':'primary'}">每日</button><button data-mode="weekly" class="${weekly?'primary':''}">每周</button><input aria-label="报表日期" id="report-day" type="date" value="${e(day)}"><a class="button" href="/api/export?date=${encodeURIComponent(day)}&weekly=${weekly}">导出报表</a></div>
  <div class="metrics">${values.map(([k,v,n])=>`<section class="card metric"><small>${k}</small><strong>${v}</strong><small>${n}</small></section>`).join('')}</div>
  ${card('抽查响应趋势','<div class="trend">'+trend+'</div>','按时确认人次')}
  ${card('待处理提醒',table(['人员','抽查记录','状态','截止'],review.map(r=>[e(r.name),e(r.batch),tag(r.result),clock(r.deadline,JSON.parse(r.policy).timezone)])))}`;
}
function batches(){
  const rows=state.batches.map(b=>{
    const targets=state.rows.filter(r=>r.batch===b.id);
    const detail=targets.map(r=>e(r.name)+' '+tag(r.result)+(state.demo&&b.status==='sent'?form('demo-click',input('batch','',b.id,'hidden')+input('id','',r.id,'hidden'),'模拟本人点击'):'')).join('<br>');
    return [e(b.id),clock(b.sent??b.created,JSON.parse(b.policy).timezone),targets.length,targets.filter(r=>r.result==='按时确认').length,tag(status[b.status]),detail?`<details><summary>查看名单</summary>${detail}</details>`:'—'];
  });
  return card('抽查批次',form('batch','',state.demo?'发起模拟抽查':'发起抽查')+table(['批次','时间','目标人数','按时确认','状态','明细'],rows),'发送成功后统一计时 · 群内共用一个确认按钮');
}
function roster(){
  const admin=state.user.role==='admin';
  const rows=state.members.map(m=>[e(m.name),e(m.username?'@'+m.username:'—'),e(m.id),tag(m.active?'在群／待校验':'已退群'),tag(m.away?'请假':m.eligible?'纳入抽查':'待确认'),admin?form('member',input('id','',m.id,'hidden')+`<label><select name="mode"><option value="active">纳入抽查</option><option value="away">标为请假</option><option value="exclude">排除</option></select></label>`,'更新'):'—']);
  return card('成员名单',table(['成员','用户名','Telegram ID','群成员状态','抽查资格','操作'],rows))+ (admin?card('导入名单',form('members','<label>每行填写 Telegram ID,姓名,用户名<textarea name="rows" rows="4" required placeholder="12345678,Fisher,fisher"></textarea></label>','导入成员')):'');
}
function reviews(){
  const rows=state.rows.filter(r=>['未按时确认','迟到确认'].includes(r.result));
  return card('异常复核',table(['员工','批次','状态','复核'],rows.map(r=>[e(r.name),e(r.batch),tag(r.result),r.review?e(r.note):form('review',input('batch','',r.batch,'hidden')+input('id','',r.id,'hidden')+'<select name="result"><option value="verified">标记已核实</option><option value="excluded">排除记录</option></select>'+input('note','复核原因','','text','required maxlength="1000"'),'保存')])),'记录可结合员工向主管提供的说明复核。');
}
function rules(){
  const r=state.rule,admin=state.user.role==='admin';
  return card('班次与抽查策略',admin?form('rule','<div class="form-grid">'+input('timezone','时区',r.timezone)+input('start','开始',r.start,'time')+input('end','结束',r.end,'time')+input('minutes','确认时限（分钟）',r.minutes,'number')+input('size','每批人数',r.size,'number')+input('frequency','每日批次',r.frequency,'number')+'</div>','保存规则'):`<p>${e(r.start)}–${e(r.end)} · ${e(r.timezone)} · ${e(r.minutes)} 分钟</p>`,'工作日为周一至周五')+
  card('角色权限',table(['角色','权限'],[['管理员','机器人接入、名单、规则、后台账户'],['主管','查看报表、发起抽查、复核与导出']])+(admin?form('invite',input('email','工作邮箱','','email','required')+'<label>操作<select name="role"><option value="supervisor">邀请主管</option><option value="admin">邀请管理员</option><option value="reset">生成重置链接</option></select></label>','生成一次性链接')+'<output id="invite-link"></output>':''));
}
function integration(){
  if(state.user.role!=='admin')return card('Telegram 接入','<p>仅管理员可配置。</p>');
  const t=state.integration;
  return card('Telegram Bot API',form('integration',input('token',t.token?'Bot Token · 已加密配置':'Bot Token','','password','autocomplete="off"')+input('group','工作群 ID',t.group)+'<p>Webhook 接收地址　'+e(t.webhook||'部署时设置 HTTPS 地址')+'</p>','保存配置')+`<div class="bar">${tag(t.verified?'已通过验证':'待验证')}${tag(t.enabled?'自动抽查已启用':'自动抽查未启用')}${form('verify','','发送验证消息')}${t.verified?form('enable',input('enabled','',t.enabled?'false':'true','hidden'),t.enabled?'暂停自动抽查':'启用自动抽查'):''}</div>`,'验证连接后，在群内点击测试按钮，再启用规则。');
}
const views={overview,batches,members:roster,reviews,rules,integration,password:()=>card('修改你的账户密码',form('password',input('current','当前密码','','password','required')+input('password','新密码','','password','required minlength="12"')+input('repeat','确认新密码','','password','required'),'保存新密码'))};
function render(){
  if(!state)return auth();
  const page=Object.hasOwn(views,route())?route():'overview';
  const nav=Object.entries(menu).map(([id,title])=>`<a href="#${id}" ${id===page?'aria-current="page"':''}>${title}</a>`).join('');
  app.innerHTML=`<div class="shell"><aside><strong>◈ 远程协作台</strong><small>TELEGRAM · 协作管理</small>${nav}</aside><main><div class="top"><small>工作区 / ${e(state.integration.group||'待接入')}</small><div class="bar"><small>${e(state.rule.timezone)} · ${state.demo?'模拟数据':e(state.user.email)}</small>${form('logout','','退出登录')}</div></div><h1>${menu[page]}</h1>${views[page]()}</main></div>`;
}
async function refresh(){try{state=await request('state');day||=date(Date.now());}catch(err){if(err.status!==401)announce(err.message);state=null;}render();}
document.addEventListener('submit',async event=>{
  const f=event.target;if(!f.matches('[data-action]'))return;event.preventDefault();
  const action=f.dataset.action,d=Object.fromEntries(new FormData(f)),submit=f.querySelector('button');submit.disabled=true;
  if(action==='member'){d.away=d.mode==='away';d.eligible=d.mode!=='exclude';}
  if(action==='enable')d.enabled=d.enabled==='true';
  try{
    if(action==='password'&&d.password!==d.repeat)throw Error('两次密码不一致');
    const result=await request(action,d);
    if(action==='register')location.hash='';
    await refresh();
    if(result.link){const out=document.querySelector('#invite-link');out.textContent=new URL(result.link,location.origin).href;}
    announce(result.message||(action==='verify'?'已发出群内测试消息，请完成回调':'操作完成'));
  }catch(err){announce(err.message);}finally{submit.disabled=false;}
});
document.addEventListener('click',ev=>{if(ev.target.dataset.mode){weekly=ev.target.dataset.mode==='weekly';render();}});
document.addEventListener('change',ev=>{if(ev.target.id==='report-day'&&ev.target.value){day=ev.target.value;render();}});
window.addEventListener('hashchange',render);
await refresh();
