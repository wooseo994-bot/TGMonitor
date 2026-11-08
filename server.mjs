import {createServer} from 'node:http';
import {readFileSync,mkdirSync} from 'node:fs';
import {randomInt, timingSafeEqual} from 'node:crypto';
import {defaults,key,hash,matches,vault,database,localTime,minutes,within,outcome} from './core.mjs';

const demo=process.env.DEMO==='1', host=process.env.HOST||'127.0.0.1', port=Number(process.env.PORT||3000);
const publicUrl=process.env.PUBLIC_URL?.replace(/\/$/,'');
if(publicUrl&&new URL(publicUrl).protocol!=='https:') throw Error('PUBLIC_URL 必须是 HTTPS');
const crypt=vault(process.env.APP_KEY||(demo?key().padEnd(64,'0'):''));
mkdirSync('data',{recursive:true,mode:0o700});
const db=database(process.env.DB_PATH||(demo?':memory:':'data/app.sqlite'));
const get=(s,...v)=>db.prepare(s).get(...v), all=(s,...v)=>db.prepare(s).all(...v), run=(s,...v)=>db.prepare(s).run(...v);
const config=(k,f)=>{const r=get('SELECT v FROM config WHERE k=?',k);return r?JSON.parse(r.v):f;};
const save=(k,v)=>run('INSERT OR REPLACE INTO config VALUES(?,?)',k,JSON.stringify(v));
const audit=(who,action,detail='')=>run('INSERT INTO audit(ts,actor,action,detail) VALUES(?,?,?,?)',Date.now(),who,action,detail);
const rule=()=>config('rule',defaults);
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const validId=s=>/^\d{1,16}$/.test(s);
const emailOf=s=>String(s??'').trim().toLowerCase();
const validEmail=s=>s.length<=254&&/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const validPassword=s=>typeof s==='string'&&s.length>=12&&s.length<=200;
const adminEmail=emailOf(process.env.ADMIN_EMAIL||(demo?'admin@example.com':''));
const adminPassword=process.env.ADMIN_PASSWORD||(demo?'demo-password-123':'');
if(!get('SELECT email FROM users LIMIT 1')){
  if(!validEmail(adminEmail)||!validPassword(adminPassword)) throw Error('首次启动需设置 ADMIN_EMAIL 和至少 12 位的 ADMIN_PASSWORD');
  run('INSERT INTO users VALUES(?,?,?)',adminEmail,hash(adminPassword),'admin');
}
if(demo){
  save('group','-1001234567890'); save('verified',true);
  ['Fisher','Lin','Alex','Kai','Wei','Jo'].forEach((name,i)=>run('INSERT INTO members(id,name,username,eligible) VALUES(?,?,?,1)',String(i+1),name,name.toLowerCase()+'_demo'));
}
const allowed=['callback_query','chat_member','my_chat_member','message'];
const token=()=>config('token')?crypt.open(config('token')):null;
async function telegram(method,data={},credential=token()){
  if(demo) return {id:99,message_id:randomInt(1000,100000),status:'administrator',url:publicUrl?publicUrl+'/telegram/webhook':''};
  if(!credential) fail('请先配置 Bot Token');
  const response=await fetch('https://api.telegram.org/bot'+credential+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(10000)});
  const result=await response.json();
  if(!result.ok) fail('Telegram 请求失败（'+method+' / '+response.status+'）',502);
  return result.result;
}
function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
function members(){return all('SELECT * FROM members ORDER BY active DESC,name');}
function updateMember(u, active, refreshOnly=false){
  if(!u||u.is_bot||!validId(String(u.id))) return;
  const id=String(u.id),old=get('SELECT * FROM members WHERE id=?',id);
  if(!old&&refreshOnly)return;
  run(`INSERT INTO members(id,name,username,active) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,username=excluded.username,active=excluded.active,
    eligible=CASE WHEN members.active=0 OR excluded.active=0 THEN 0 ELSE members.eligible END`,
    id,[u.first_name,u.last_name].filter(Boolean).join(' ')||id,u.username||null,active);
  if(!active)run('UPDATE targets SET exempt=1 WHERE id=? AND confirmed IS NULL AND batch IN (SELECT id FROM batches WHERE status IN (\'sending\',\'sent\'))',id);
}
function candidates(size){
  const eligible=all(`SELECT * FROM members m WHERE active=1 AND eligible=1 AND away=0 AND NOT EXISTS
    (SELECT 1 FROM targets t JOIN batches b ON b.id=t.batch WHERE t.id=m.id AND b.status IN ('sending','sent'))`);
  return eligible.map(m=>({m,random:randomInt(1_000_000)})).sort((a,b)=>(a.m.last_picked??0)-(b.m.last_picked??0)||a.random-b.random).slice(0,size).map(x=>x.m);
}
async function batch(actor,{test=false,automatic=false}={}){
  const r=rule(),at=Date.now(),chat=config('group');
  if(!chat)fail('请先配置目标群');
  if(!test&&(!config('enabled',false)&&!demo))fail('请先验证并启用 Telegram 接入');
  if(!test&&!demo&&!within(at,r))fail('当前不在允许发起抽查的时段');
  const id=key().slice(0,12);
  const selected=transaction(()=>{
    const roster=test?[]:candidates(r.size);
    if(!test&&!roster.length)fail('没有可抽查的成员');
    run('INSERT INTO batches(id,status,chat,created,kind,policy) VALUES(?,?,?,?,?,?)',id,'sending',chat,at,test?'test':automatic?'auto':'manual',JSON.stringify(r));
    for(const m of roster)run('INSERT INTO targets(batch,id,name,username) VALUES(?,?,?,?)',id,m.id,m.name,m.username);
    return roster;
  });
  const mentions=selected.map(m=>'<a href="tg://user?id='+m.id+'">'+esc(m.name)+'</a>').join(' ');
  const label=test?'【接入测试】请群管理员点击下方按钮。':'【在岗确认 · '+id+'】'+mentions+'，请在 '+r.minutes+' 分钟内点击「确认在岗」。如遇会议、请假或网络问题，请联系主管。谢谢。';
  try{
    const sent=await telegram('sendMessage',{chat_id:chat,text:label,parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:test?'测试回调':'确认在岗',callback_data:'ck:'+id}]]}});
    const now=Date.now();
    transaction(()=>{
      run('UPDATE batches SET status=?,message=?,sent=?,deadline=? WHERE id=?','sent',String(sent.message_id),now,now+r.minutes*60000,id);
      for(const m of selected)run('UPDATE members SET last_picked=? WHERE id=?',now,m.id);
      audit(actor,test?'test_sent':'batch_sent',id);
    });
    return {id};
  }catch(e){
    run('UPDATE batches SET status=? WHERE id=?',e.status===502?'failed':'uncertain',id);
    audit(actor,'batch_send_failed',id);fail('群消息发送失败或结果待核对，请检查机器人权限及连接',502);
  }
}
function click(id,user,chat,message,now=Date.now()){
  const b=get('SELECT * FROM batches WHERE id=?',id);
  if(!b||b.chat!==chat||b.message!==message||!['sent','done'].includes(b.status))return '抽查不存在或已失效';
  if(b.kind==='test')return '测试消息已收到';
  const t=get('SELECT * FROM targets WHERE batch=? AND id=?',id,user);
  if(!t||t.exempt)return '你无需参与本次抽查';
  if(t.confirmed)return '你已确认';
  run('UPDATE targets SET confirmed=? WHERE batch=? AND id=? AND confirmed IS NULL',now,id,user);
  return now<=b.deadline?'确认成功':'已记录迟到确认';
}
async function webhook(data){
  if(!Number.isSafeInteger(data.update_id))fail('无效事件');
  const q=data.callback_query;
  const candidate=q?.data?.startsWith('ck:')&&get('SELECT * FROM batches WHERE id=?',q.data.slice(3));
  if(candidate?.kind==='test'&&candidate.status==='sent'&&String(q.message?.chat?.id)===candidate.chat&&String(q.message?.message_id)===candidate.message){
    const member=await telegram('getChatMember',{chat_id:candidate.chat,user_id:q.from.id});
    if(!['administrator','creator'].includes(member.status)){
      await telegram('answerCallbackQuery',{callback_query_id:q.id,text:'请群管理员完成接入验证'});
      return;
    }
  }
  const result=transaction(()=>{
    if(!run('INSERT OR IGNORE INTO updates VALUES(?,?)',data.update_id,Date.now()).changes)return null;
    const change=data.chat_member;
    if(change&&String(change.chat.id)===config('group')){
      const m=change.new_chat_member,active=!['left','kicked'].includes(m.status)&&(m.status!=='restricted'||m.is_member);
      updateMember(m.user,active?1:0);
    }
    const own=data.my_chat_member;
    if(own&&String(own.chat.id)===config('group')&&own.new_chat_member.status!=='administrator'){save('enabled',false);save('verified',false);save('interrupted',true);}
    const msg=data.message;
    if(msg&&String(msg.chat.id)===config('group'))updateMember(msg.from,1,true);
    if(!q?.data?.startsWith('ck:')||!q.message)return null;
    const id=q.data.slice(3),chat=String(q.message.chat.id),message=String(q.message.message_id),b=get('SELECT * FROM batches WHERE id=?',id);
    if(b?.kind==='test'&&b.chat===chat&&b.message===message&&b.status==='sent'&&Date.now()<=b.deadline){
      save('verified',true);run("UPDATE batches SET status='done' WHERE id=?",id);
    }
    return click(id,String(q.from.id),chat,message);
  });
  if(q&&result)await telegram('answerCallbackQuery',{callback_query_id:q.id,text:result}).catch(()=>{});
}
function sweep(now=Date.now()){
  const expired=all("SELECT * FROM batches WHERE status='sent' AND deadline<?",now);
  for(const b of expired){
    const status=config('interrupted',false)?'uncertain':'done';
    run('UPDATE batches SET status=? WHERE id=?',status,b.id);
    if(!demo)telegram('editMessageReplyMarkup',{chat_id:b.chat,message_id:Number(b.message),reply_markup:{inline_keyboard:[]}}).catch(()=>{});
  }
}
function schedule(){
  sweep();
  if(demo||!config('enabled',false))return;
  const now=Date.now(),r=rule(),local=localTime(now,r.timezone);
  if(!within(now,r))return;
  let day=get('SELECT times FROM schedule WHERE day=?',local.day);
  if(!day){
    const start=minutes(r.start),end=minutes(r.end)-r.minutes,slots=end-start+1;
    const count=Math.min(r.frequency,slots);
    const times=[];for(let i=0;i<count;i++){const lo=Math.floor(i*slots/count),hi=Math.floor((i+1)*slots/count);times.push(start+lo+randomInt(hi-lo));}
    run('INSERT OR IGNORE INTO schedule VALUES(?,?)',local.day,JSON.stringify(times));
    day=get('SELECT times FROM schedule WHERE day=?',local.day);
  }
  const times=JSON.parse(day.times),minute=minutes(local.clock),i=times.indexOf(minute);
  if(i<0)return;
  times.splice(i,1);run('UPDATE schedule SET times=? WHERE day=?',JSON.stringify(times),local.day);
  batch('scheduler',{automatic:true}).catch(()=>{});
}
const reportRows=()=>all(`SELECT t.*,b.status,b.deadline,b.sent,b.chat,b.message,b.policy FROM targets t JOIN batches b ON b.id=t.batch ORDER BY b.created DESC`).map(x=>({...x,result:outcome(x)}));
function state(){return {demo,rule:rule(),members:members(),batches:all('SELECT * FROM batches ORDER BY created DESC LIMIT 150'),rows:reportRows(),integration:{group:config('group',''),token:!!config('token'),enabled:config('enabled',false),verified:config('verified',false),webhook:publicUrl?publicUrl+'/telegram/webhook':''}};}
function json(res,status,value){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));}
async function body(req){let n=0;const chunks=[];for await(const c of req){n+=c.length;if(n>250000)fail('请求太大',413);chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{fail('无效 JSON');}}
const cookie=(id='',age=0)=>'sid='+id+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+age+(publicUrl?'; Secure':'');
function requireAdmin(u){if(u.role!=='admin')fail('仅管理员可操作',403);}
function safeEqual(a,b){return typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
const attempts=new Map();
function loginLimit(req){
  const now=Date.now(),ip=req.socket.remoteAddress,current=attempts.get(ip);
  if(!current||current.until<now){attempts.set(ip,{n:1,until:now+60000});return;}
  if(++current.n>15)fail('尝试过多，请稍后再试',429);
}
const server=createServer(async(req,res)=>{
  try{
    res.setHeader('x-content-type-options','nosniff');
    res.setHeader('content-security-policy',"default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const path=new URL(req.url,'http://local').pathname,method=req.method;
    const sid=(req.headers.cookie??'').match(/(?:^|;\s*)sid=([a-f0-9]+)/)?.[1];
    const user=sid&&get('SELECT u.email,u.role FROM users u JOIN sessions s ON s.email=u.email WHERE s.id=? AND s.expires>?',sid,Date.now());
    if(method==='GET'&&['/','/app.js','/style.css'].includes(path)){
      const file=path==='/'?'index.html':path.slice(1),type=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html';
      res.writeHead(200,{'content-type':type+'; charset=utf-8'});return res.end(readFileSync(new URL('./public/'+file,import.meta.url)));
    }
    if(path==='/telegram/webhook'&&method==='POST'){
      if(!safeEqual(req.headers['x-telegram-bot-api-secret-token'],config('webhookSecret')))fail('无效回调密钥',403);
      await webhook(await body(req));return json(res,200,{ok:true});
    }
    if(method==='POST'&&!req.headers['content-type']?.startsWith('application/json'))fail('需要 JSON 请求',415);
    if(path==='/api/login'&&method==='POST'){
      loginLimit(req);const d=await body(req),u=get('SELECT * FROM users WHERE email=?',emailOf(d.email));
      if(typeof d.password!=='string'||d.password.length>200||!u||!matches(d.password,u.password))fail('邮箱或密码错误',401);
      const id=key();run('INSERT INTO sessions VALUES(?,?,?)',id,u.email,Date.now()+86400000);
      res.setHeader('set-cookie',cookie(id,86400));return json(res,200,{email:u.email,role:u.role});
    }
    if(path==='/api/register'&&method==='POST'){
      loginLimit(req);const d=await body(req);
      if(!validPassword(d.password))fail('密码须为 12–200 位');
      transaction(()=>{const invite=get('SELECT * FROM invites WHERE id=? AND expires>?',String(d.invite??''),Date.now());
        if(!invite)fail('邀请无效或已过期');
        if(invite.role==='reset'){run('UPDATE users SET password=? WHERE email=?',hash(d.password),invite.email);run('DELETE FROM sessions WHERE email=?',invite.email);}
        else if(!run('INSERT OR IGNORE INTO users VALUES(?,?,?)',invite.email,hash(d.password),invite.role).changes)fail('账户已经存在');
        run('DELETE FROM invites WHERE id=?',invite.id);
      });return json(res,200,{ok:true});
    }
    if(!user)fail('请先登录',401);
    if(method==='GET'&&path==='/api/state')return json(res,200,{...state(),user});
    if(method==='GET'&&path==='/api/export'){
      const date=new URL(req.url,'http://local').searchParams.get('date'),weekly=new URL(req.url,'http://local').searchParams.get('weekly')==='true';
      const start=new Date((date||localTime(Date.now(),rule().timezone).day)+'T00:00:00Z');
      if(!Number.isFinite(+start))fail('日期无效');
      if(weekly)start.setUTCDate(start.getUTCDate()-(start.getUTCDay()+6)%7);
      const end=new Date(+start+(weekly?7:1)*86400000),day=d=>d.toISOString().slice(0,10);
      const encode=v=>'"'+String(v??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
      const csv=[['批次','员工','结果','确认时间'],...reportRows().filter(r=>r.sent&&localTime(r.sent,JSON.parse(r.policy).timezone).day>=day(start)&&localTime(r.sent,JSON.parse(r.policy).timezone).day<day(end)).map(r=>[r.batch,r.name,r.result,r.confirmed?new Date(r.confirmed).toISOString():''])].map(row=>row.map(encode).join(',')).join('\r\n');
      audit(user.email,'export');res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="checkins.csv"'});return res.end('\ufeff'+csv);
    }
    if(method!=='POST')fail('页面不存在',404);
    const d=await body(req);
    let output={ok:true};
    switch(path){
      case '/api/logout':run('DELETE FROM sessions WHERE id=?',sid);res.setHeader('set-cookie',cookie());break;
      case '/api/password':{
        const u=get('SELECT password FROM users WHERE email=?',user.email);
        if(typeof d.current!=='string'||d.current.length>200||!matches(d.current,u.password)||!validPassword(d.password))fail('当前密码错误，或新密码不足 12 位');
        transaction(()=>{run('UPDATE users SET password=? WHERE email=?',hash(d.password),user.email);run('DELETE FROM sessions WHERE email=? AND id<>?',user.email,sid);});break;
      }
      case '/api/invite':{
        requireAdmin(user);const email=emailOf(d.email);
        if(!validEmail(email)||!['admin','supervisor','reset'].includes(d.role))fail('邮箱或角色无效');
        if(d.role==='reset'&&!get('SELECT email FROM users WHERE email=?',email))fail('账户不存在');
        const id=key();run('INSERT INTO invites VALUES(?,?,?,?)',id,email,d.role,Date.now()+3600000);output={link:'/#register/'+id};break;
      }
      case '/api/members':{
        requireAdmin(user);const lines=String(d.rows??'').trim().split(/\r?\n/).map(l=>l.split(',').map(x=>x.trim()));
        if(lines.length>1000||lines.some(([id,name])=>!validId(id)||!name||name.length>100))fail('请按每行「Telegram ID,姓名,用户名」输入');
        transaction(()=>{for(const [id,name,username] of lines)run(`INSERT INTO members(id,name,username,eligible) VALUES(?,?,?,1)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,username=excluded.username,eligible=members.active`,id,name,username?.replace(/^@/,'')||null);});
        break;
      }
      case '/api/member':{
        requireAdmin(user);
        if(!validId(d.id))fail('员工 ID 无效');
        run('UPDATE members SET away=?,eligible=? WHERE id=?',d.away?1:0,d.eligible?1:0,d.id);
        if(d.away||!d.eligible)run("UPDATE targets SET exempt=1 WHERE id=? AND confirmed IS NULL AND batch IN (SELECT id FROM batches WHERE status IN ('sending','sent'))",d.id);
        break;
      }
      case '/api/rule':{
        requireAdmin(user);
        const r={timezone:String(d.timezone),start:String(d.start),end:String(d.end),minutes:Number(d.minutes),size:Number(d.size),frequency:Number(d.frequency),weekdays:defaults.weekdays};
        try{localTime(Date.now(),r.timezone);}catch{fail('时区无效');}
        if(![r.start,r.end].every(x=>/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(x))||![[r.minutes,1,120],[r.size,1,100],[r.frequency,1,10]].every(([v,a,b])=>Number.isInteger(v)&&v>=a&&v<=b)||minutes(r.end)-minutes(r.start)<r.minutes)fail('抽查规则无效');
        transaction(()=>{save('rule',r);run('DELETE FROM schedule WHERE day=?',localTime(Date.now(),r.timezone).day);});break;
      }
      case '/api/integration':{
        requireAdmin(user);const group=String(d.group??''),value=String(d.token??'');
        if(!/^-\d{1,16}$/.test(group)||(!value&&!token()&&!demo)||value&&!/^\d{4,20}:[A-Za-z0-9_-]{20,}$/.test(value))fail('请填写有效的群 ID 和 Bot Token');
        const previous=config('group');
        if(previous&&previous!==group&&get('SELECT id FROM members LIMIT 1'))fail('当前版本一个实例只支持一个工作群；有成员数据时请使用新实例接入其他群');
        transaction(()=>{if(value)save('token',crypt.seal(value));save('group',group);save('verified',false);save('enabled',false);save('interrupted',true);run("UPDATE batches SET status='uncertain' WHERE status IN ('sending','sent')");});break;
      }
      case '/api/verify':{
        requireAdmin(user);if(!publicUrl&&!demo)fail('部署后请设置可访问的 HTTPS PUBLIC_URL');
        const bot=await telegram('getMe'), group=config('group');
        if(!group)fail('请先配置工作群');
        const m=await telegram('getChatMember',{chat_id:group,user_id:bot.id});
        if(m.status!=='administrator')fail('请先将机器人设为群管理员');
        save('enabled',false);save('verified',false);
        const secret=key();save('webhookSecret',secret);
        await telegram('setWebhook',{url:publicUrl?publicUrl+'/telegram/webhook':'https://example.com/test',secret_token:secret,allowed_updates:allowed});
        output=await batch(user.email,{test:true});
        if(demo)save('verified',true);break;
      }
      case '/api/enable':{
        requireAdmin(user);if(d.enabled&&!config('verified',false))fail('请先完成群内测试回调');
        if(d.enabled)save('interrupted',false);
        save('enabled',!!d.enabled);break;
      }
      case '/api/batch':output=await batch(user.email);break;
      case '/api/demo-click':{
        if(!demo)fail('演示接口不可用',404);
        const b=get('SELECT * FROM batches WHERE id=?',String(d.batch));
        output={message:b?click(b.id,String(d.id),b.chat,b.message):'批次不存在'};break;
      }
      case '/api/review':{
        if(!['verified','excluded'].includes(d.result)||typeof d.note!=='string'||!d.note.trim()||d.note.length>1000)fail('请填写复核原因');
        const target=reportRows().find(r=>r.batch===d.batch&&r.id===d.id&&['未按时确认','迟到确认'].includes(r.result));
        if(!target)fail('此记录无需复核');
        run('UPDATE targets SET review=?,note=? WHERE batch=? AND id=?',d.result,d.note.trim(),d.batch,d.id);break;
      }
      default:fail('页面不存在',404);
    }
    audit(user.email,path);json(res,200,output);
  }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'服务暂时无法处理请求'});if(!e.status)console.error(e.name);}
});
run("UPDATE batches SET status='uncertain' WHERE status IN ('sending','sent') AND kind<>'test'");
setInterval(schedule,10000).unref();
server.listen(port,host,()=>console.log('远程协作台 http://'+host+':'+port+(demo?' · 模拟模式':'')));
